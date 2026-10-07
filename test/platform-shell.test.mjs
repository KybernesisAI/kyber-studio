import { test, mock } from "node:test";
import assert from "node:assert/strict";

/**
 * The argv two command-execution paths actually spawn, on both platforms.
 *
 * This file exists because nothing pinned it. `local-exec-relay.test.mjs` and
 * `local-mcp-call-sites.test.mjs` both load the modules that spawn, but neither
 * mocks `node:child_process` — they assert on the projections and the
 * credential handling AROUND the spawn. So every argument handed to the shell
 * was unverified, and a mutation to any of them left the whole suite green.
 *
 * That gap matters more than usual here: the Windows half of this cannot be
 * observed from the machine this suite runs on, so the argv is the only
 * pre-merge evidence there is. What this file does NOT claim is that `cmd.exe`
 * then behaves as Microsoft documents — that needs Windows, and it is recorded
 * on the ticket as the observation still outstanding.
 */

// Mocked before the module under test loads, because it imports `spawn` once at
// load time; `killTree` is the only consumer.
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

test("POSIX runs the command line through a login shell", () => {
  const got = onPlatform("linux", () =>
    withEnv("SHELL", "/usr/bin/zsh", () => shellInvocation("npm test")),
  );
  assert.equal(got.file, "/usr/bin/zsh");
  assert.deepEqual(got.args, ["-lc", "npm test"]);
  // `-l` is the whole point: without it an Electron app's minimal PATH is what
  // the agent gets, and `npx` installed by nvm is not on it.
  assert.ok(got.args[0].includes("l"), "the shell must be a LOGIN shell");
  assert.equal(got.windowsVerbatimArguments, undefined);
});

test("POSIX falls back to bash when SHELL is unset", () => {
  const got = onPlatform("darwin", () =>
    withEnv("SHELL", undefined, () => shellInvocation("ls")),
  );
  assert.equal(got.file, "/bin/bash");
  assert.deepEqual(got.args, ["-lc", "ls"]);
});

test("Windows runs the command line through cmd.exe with /d /s /c", () => {
  const got = onPlatform("win32", () =>
    withEnv("ComSpec", "C:\\Windows\\System32\\cmd.exe", () => shellInvocation("npm test")),
  );
  assert.equal(got.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(got.args, ["/d", "/s", "/c", "npm test"]);
  // Both halves of the pair, together. `/s` without the verbatim flag lets node
  // quote the line a second time; the flag without `/s` leaves cmd.exe to
  // re-parse it. Either alone mangles a command containing quotes.
  assert.equal(got.windowsVerbatimArguments, true);
  assert.ok(got.args.includes("/d"), "/d must be present: it skips registry AutoRun");
});

test("Windows falls back to the bare cmd.exe name when ComSpec is unset", () => {
  const got = onPlatform("win32", () =>
    withEnv("ComSpec", undefined, () => shellInvocation("dir")),
  );
  assert.equal(got.file, "cmd.exe");
  assert.deepEqual(got.args, ["/d", "/s", "/c", "dir"]);
});

test("the command line is the last argument, unmodified, on both platforms", () => {
  // A line this app will really see: quotes, an operator and a glob.
  const line = 'git commit -m "fix: don\'t break" && ls *.ts';
  for (const platform of ["linux", "darwin", "win32"]) {
    const got = onPlatform(platform, () => shellInvocation(line));
    assert.equal(got.args.at(-1), line, `${platform} must pass the line through untouched`);
    assert.equal(
      got.args.filter((a) => a === line).length,
      1,
      `${platform} must pass the line exactly once`,
    );
  }
});

test("nothing is escaped or quoted by us", () => {
  // We hand the line to a shell and let the shell parse it. If this module ever
  // starts escaping, the relay stops being able to run compound commands.
  const got = onPlatform("win32", () => shellInvocation('echo "a b" & echo c'));
  assert.equal(got.args.at(-1), 'echo "a b" & echo c');
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

test("POSIX signals the child directly", () => {
  spawned.length = 0;
  const child = fakeChild(4321);
  onPlatform("linux", () => killTree(child));
  assert.deepEqual(child.signals, ["SIGKILL"]);
  assert.equal(spawned.length, 0, "POSIX must not shell out to anything");
});

test("Windows kills the whole tree, because cmd.exe is not the command", () => {
  spawned.length = 0;
  const child = fakeChild(1234);
  onPlatform("win32", () => killTree(child));

  assert.equal(spawned.length, 1, "Windows must spawn a killer");
  const killer = spawned[0];
  assert.equal(killer.file, "taskkill");
  // /T is the reason this function exists: without it only cmd.exe dies and the
  // build or dev server it started keeps running with no parent.
  assert.deepEqual(killer.args, ["/pid", "1234", "/T", "/F"]);
  assert.equal(killer.options.detached, true);
  assert.equal(killer.options.stdio, "ignore");
  assert.equal(killer.unrefCalled, true, "we must not wait on the killer");
  assert.deepEqual(child.signals, [], "the handle itself is not signalled when taskkill runs");
});

test("Windows falls back to the handle when the child has no pid", () => {
  spawned.length = 0;
  const child = fakeChild(undefined);
  onPlatform("win32", () => killTree(child));
  assert.equal(spawned.length, 0);
  // No signal name: on Windows a signal argument is meaningless, and passing
  // SIGKILL there is how you get an ERR_UNKNOWN_SIGNAL instead of a dead child.
  assert.deepEqual(child.signals, [undefined]);
});

test("Windows falls back to the handle when taskkill cannot start", () => {
  spawned.length = 0;
  const child = fakeChild(99);
  onPlatform("win32", () => killTree(child));
  const killer = spawned[0];
  assert.ok(killer.listeners.error, "the killer must have an error listener");
  assert.deepEqual(child.signals, []);
  killer.listeners.error(new Error("taskkill: not found"));
  assert.deepEqual(child.signals, [undefined], "a failed taskkill must still stop what we hold");
});
