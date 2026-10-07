import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

/**
 * The argv two command-execution paths actually spawn, on both platforms.
 *
 * This file exists because nothing pinned it. `local-exec-relay.test.mjs` and
 * `local-mcp-call-sites.test.mjs` both load the modules that spawn, but neither
 * mocks `node:child_process` — they assert on the projections and the
 * credential handling AROUND the spawn. So every argument handed to the shell
 * was unverified, and a mutation to any of them left the whole suite green.
 *
 * That gap matters more than usual here: the Windows half cannot be observed
 * from the machine this suite runs on, so the argv is the only pre-merge
 * evidence there is. What this file does NOT claim is that `cmd.exe` then
 * behaves as Microsoft documents — that needs Windows, and it is the UAT.
 *
 * An earlier version of this file asserted that the command line was passed
 * through "unmodified" on every platform, and that nothing was ever quoted by
 * us. Both were wrong for Windows, and being wrong in a test is worse than
 * being wrong in the code: they made the missing quote wrap look correct.
 */

const spawned = [];
mock.module("node:child_process", {
  exports: {
    spawn: (file, args, options) => {
      const handle = {
        file,
        args,
        options,
        unrefCalled: false,
        listeners: {},
        unref() {
          this.unrefCalled = true;
        },
        on(event, fn) {
          this.listeners[event] = fn;
          return this;
        },
      };
      spawned.push(handle);
      return handle;
    },
  },
});

const { shellInvocation, killTree } = await import("../src/main/platformShell.ts");

/** Run `fn` with `process.platform` pinned, restoring it afterwards. */
function onPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/** Run `fn` with one env var set or deleted, restoring it afterwards. */
function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (had) process.env[key] = previous;
    else delete process.env[key];
  }
}

// ── shellInvocation ─────────────────────────────────────────────────────────

test("POSIX runs the command line through a login shell, untouched", () => {
  const got = onPlatform("linux", () =>
    withEnv("SHELL", "/usr/bin/zsh", () => shellInvocation("npm test")),
  );
  assert.equal(got.file, "/usr/bin/zsh");
  // `-l` is the whole point: without it an Electron app's minimal PATH is what
  // the agent gets, and `npx` installed by nvm is not on it.
  assert.deepEqual(got.args, ["-lc", "npm test"]);
  assert.equal(got.windowsVerbatimArguments, undefined);
});

test("POSIX falls back to bash when SHELL is unset", () => {
  const got = onPlatform("darwin", () =>
    withEnv("SHELL", undefined, () => shellInvocation("ls")),
  );
  assert.equal(got.file, "/bin/bash");
  assert.deepEqual(got.args, ["-lc", "ls"]);
});

test("Windows wraps the command line in quotes, because /s strips a pair", () => {
  const got = onPlatform("win32", () =>
    withEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe", () => shellInvocation("npm test")),
  );
  assert.equal(got.file, "C:\\Windows\\System32\\cmd.exe");
  // The wrap is the finding this test exists for. `/s` strips the first and
  // last quote of the string after `/c`; the pair it strips has to be ours or
  // it is the caller's.
  assert.deepEqual(got.args, ["/d", "/s", "/c", '"npm test"']);
  assert.equal(got.windowsVerbatimArguments, true);
});

test("Windows falls back to the bare cmd.exe name when ComSpec is unset", () => {
  const got = onPlatform("win32", () =>
    withEnv("ComSpec", undefined, () => shellInvocation("dir")),
  );
  assert.equal(got.file, "cmd.exe");
  assert.deepEqual(got.args, ["/d", "/s", "/c", '"dir"']);
});

test("a command line already beginning with a quote survives on Windows", () => {
  // The case that was broken. Without our wrap, cmd.exe strips the caller's
  // own quotes and tries to run `C:\Program`.
  const line = '"C:\\Program Files\\nodejs\\npm.cmd" test';
  const got = onPlatform("win32", () => shellInvocation(line));
  const passed = got.args.at(-1);

  assert.equal(passed, `"${line}"`);
  // Strip exactly what `/s` will strip, and the caller's line must be back.
  assert.equal(passed.slice(1, -1), line, "removing one outer pair must restore the line exactly");
  assert.ok(passed.startsWith('""'), "ours goes outside the caller's, not instead of it");
});

test("exactly one pair is added on Windows, and none on POSIX", () => {
  const line = 'git commit -m "fix: don\'t break" && ls *.ts';

  const win = onPlatform("win32", () => shellInvocation(line));
  assert.equal(win.args.at(-1), `"${line}"`);
  assert.equal(
    win.args.at(-1).length - line.length,
    2,
    "one pair of quotes, not two and not none",
  );

  for (const platform of ["linux", "darwin"]) {
    const got = onPlatform(platform, () => shellInvocation(line));
    assert.equal(got.args.at(-1), line, `${platform} must pass the line through untouched`);
  }
});

test("inner characters are never escaped, on either platform", () => {
  // We wrap on Windows; we do not escape. If this module ever starts escaping,
  // the relay stops being able to run compound commands.
  const line = 'echo "a b" & echo c | sort';
  assert.equal(onPlatform("win32", () => shellInvocation(line)).args.at(-1), `"${line}"`);
  assert.equal(onPlatform("linux", () => shellInvocation(line)).args.at(-1), line);
});

// ── killTree ────────────────────────────────────────────────────────────────

function fakeChild(pid) {
  return {
    pid,
    signals: [],
    kill(signal) {
      this.signals.push(signal);
      return true;
    },
  };
}

test("POSIX defaults to SIGTERM, which is what stopAll relies on", () => {
  // `stopAll` passes no signal. Before killTree it called a bare
  // `child.kill()`, which is SIGTERM — an MCP server's only chance to flush
  // state or drop a lockfile. Defaulting to SIGKILL silently took that away.
  spawned.length = 0;
  const child = fakeChild(4321);
  onPlatform("linux", () => killTree(child));
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(spawned.length, 0, "POSIX must not shell out to anything");
});

test("POSIX honours an explicit signal, which is what the relay timeout needs", () => {
  spawned.length = 0;
  const child = fakeChild(4321);
  onPlatform("linux", () => killTree(child, "SIGKILL"));
  assert.deepEqual(child.signals, ["SIGKILL"]);
});

test("Windows kills the whole tree, because cmd.exe is not the command", () => {
  spawned.length = 0;
  const child = fakeChild(1234);
  onPlatform("win32", () => withEnv("SystemRoot", "/fake/winroot", () => killTree(child)));

  assert.equal(spawned.length, 1, "Windows must spawn a killer");
  const killer = spawned[0];
  // Resolved under SystemRoot rather than found on PATH: this is the
  // process-control path of a component that runs agent-supplied commands.
  assert.equal(killer.file, join("/fake/winroot", "System32", "taskkill.exe"));
  // /T is the reason this function exists: without it only cmd.exe dies and the
  // build or dev server it started keeps running with no parent.
  assert.deepEqual(killer.args, ["/pid", "1234", "/T", "/F"]);
  assert.equal(killer.options.detached, true);
  assert.equal(killer.options.stdio, "ignore");
  assert.equal(killer.unrefCalled, true, "we must not wait on the killer");
  assert.deepEqual(child.signals, [], "the handle itself is not signalled when taskkill runs");
});

test("Windows ignores the signal argument, having no graceful one to send", () => {
  spawned.length = 0;
  const child = fakeChild(77);
  onPlatform("win32", () => withEnv("SystemRoot", "/fake/winroot", () => killTree(child, "SIGTERM")));
  // taskkill /F regardless: the asymmetry is real and documented rather than
  // papered over.
  assert.deepEqual(spawned[0].args, ["/pid", "77", "/T", "/F"]);
});

test("Windows falls back to the handle when the child has no pid", () => {
  spawned.length = 0;
  const child = fakeChild(undefined);
  onPlatform("win32", () => killTree(child));
  assert.equal(spawned.length, 0);
  assert.equal(child.signals.length, 1, "the handle must still be stopped");
});

test("Windows falls back to the handle when taskkill cannot start", () => {
  spawned.length = 0;
  const child = fakeChild(99);
  onPlatform("win32", () => withEnv("SystemRoot", "/fake/winroot", () => killTree(child)));
  const killer = spawned[0];
  assert.ok(killer.listeners.error, "the killer must have an error listener");
  assert.deepEqual(child.signals, []);
  killer.listeners.error(new Error("taskkill: not found"));
  assert.equal(child.signals.length, 1, "a failed taskkill must still stop what we hold");
});
