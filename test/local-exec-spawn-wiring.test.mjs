import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The relay's spawn, wired — not the invocation module in isolation.
 *
 * `platform-shell.test.mjs` proves `shellInvocation` returns the right argv.
 * It cannot prove `localExec.ts` passes that argv to `spawn` rather than, say,
 * handing it the args array as the file. This file closes that seam, which is
 * the one the repo has been bitten at before: every real defect in the
 * credential work was in the wiring, not in the pure module.
 *
 * `executeLocalAction` is the dispatcher and does not itself gate on
 * permissions — consent is enforced by the caller above it — so a `run-command`
 * can be driven here directly.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-spawn-wiring-"));

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    shell: { openExternal: async () => {} },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (s) => Buffer.from(`ENC(${s})`, "utf8"),
      decryptString: (b) => {
        const match = /^ENC\((.*)\)$/s.exec(b.toString("utf8"));
        if (!match) throw new Error("not sealed by this store");
        return match[1];
      },
    },
  },
});

const spawned = [];
/** Whether a spawned child should close on its own, or hang until killed. */
let autoClose = true;

mock.module("node:child_process", {
  exports: {
    spawn: (file, args, options) => {
      const child = new EventEmitter();
      child.file = file;
      child.args = args;
      child.options = options;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4242;
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal);
        return true;
      };
      child.unref = () => {};
      spawned.push(child);
      // `taskkill` is spawned by killTree and must not itself close the command.
      if (autoClose && file !== "taskkill") setImmediate(() => child.emit("close", 0));
      return child;
    },
  },
});

const { executeLocalAction } = await import("../src/main/localExec.ts");

async function onPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

test("a relayed command on POSIX goes through a login shell, with the line last", async () => {
  spawned.length = 0;
  autoClose = true;
  const result = await onPlatform("linux", () =>
    executeLocalAction("run-command", { command: "npm test && echo done" }),
  );

  assert.equal(spawned.length, 1);
  const child = spawned[0];
  assert.equal(child.file, process.env.SHELL ?? "/bin/bash");
  assert.deepEqual(child.args, ["-lc", "npm test && echo done"]);
  assert.equal(result.exitCode, 0);
});

test("a relayed command on Windows goes through cmd.exe, not /bin/bash", async () => {
  spawned.length = 0;
  autoClose = true;
  await onPlatform("win32", () =>
    executeLocalAction("run-command", { command: "npm test && echo done" }),
  );

  const child = spawned[0];
  // The defect this lane exists to fix: before it, this was literally
  // "/bin/bash" with ["-lc", ...] on a machine that has neither.
  assert.notEqual(child.file, "/bin/bash");
  assert.equal(child.file, process.env.ComSpec ?? "cmd.exe");
  assert.deepEqual(child.args, ["/d", "/s", "/c", "npm test && echo done"]);
  // Without this the line is quoted twice and a command containing quotes
  // arrives at cmd.exe mangled.
  assert.equal(child.options.windowsVerbatimArguments, true);
});

test("the file is the program and the args are the args, not swapped", async () => {
  // Guards the dullest possible wiring mistake, which a typecheck does not
  // catch because both are strings/arrays either way.
  spawned.length = 0;
  autoClose = true;
  await onPlatform("win32", () => executeLocalAction("run-command", { command: "dir" }));
  const child = spawned[0];
  assert.equal(typeof child.file, "string");
  assert.ok(Array.isArray(child.args));
  assert.ok(!child.file.includes("/d"), "the switches must not end up in the file");
  assert.ok(child.args.includes("dir"), "the command must be in the args");
});

test("the working directory is still honoured", async () => {
  spawned.length = 0;
  autoClose = true;
  await onPlatform("win32", () => executeLocalAction("run-command", { command: "dir", cwd: dir }));
  assert.equal(spawned[0].options.cwd, dir);
});

test("a timed-out command on Windows kills the tree, not just cmd.exe", async () => {
  spawned.length = 0;
  autoClose = false; // hang, so the timeout fires
  const result = await onPlatform("win32", () =>
    executeLocalAction("run-command", { command: "npm run dev", timeoutMs: 20 }),
  );

  assert.equal(result.timedOut, true);
  const killer = spawned.find((c) => c.file === "taskkill");
  assert.ok(killer, "a timeout on Windows must reach taskkill");
  // /T is the point: cmd.exe is not the command, so killing only the pid we
  // hold would leave the dev server running with no parent.
  assert.deepEqual(killer.args, ["/pid", "4242", "/T", "/F"]);
  autoClose = true;
});

test("a timed-out command on POSIX is signalled directly, with no helper process", async () => {
  spawned.length = 0;
  autoClose = false;
  const result = await onPlatform("linux", () =>
    executeLocalAction("run-command", { command: "sleep 100", timeoutMs: 20 }),
  );

  assert.equal(result.timedOut, true);
  assert.equal(spawned.length, 1, "POSIX must not spawn a killer");
  assert.deepEqual(spawned[0].signals, ["SIGKILL"]);
  autoClose = true;
});
