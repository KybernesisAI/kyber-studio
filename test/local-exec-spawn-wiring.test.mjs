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
 * It cannot prove `localExec.ts` passes that argv to `spawn`, nor that the
 * timeout path asks for the signal it used to send. This file closes that
 * seam, which is the one this repo has been bitten at before: the real defects
 * in the credential work were all in the wiring, not in the pure module.
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
      // The killer must not close the command it was spawned to kill.
      const isKiller = file.includes("taskkill");
      if (autoClose && !isKiller) setImmediate(() => child.emit("close", 0));
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

/**
 * Drive one relayed command. `hang` leaves the child running so the timeout
 * fires; the flag is restored unconditionally, so one failing assertion cannot
 * cascade into the next test.
 */
async function relay(platform, payload, { hang = false } = {}) {
  spawned.length = 0;
  autoClose = !hang;
  try {
    return await onPlatform(platform, () => executeLocalAction("run-command", payload));
  } finally {
    autoClose = true;
  }
}

test("a relayed command on POSIX goes through a login shell, with the line last", async () => {
  const result = await relay("linux", { command: "npm test && echo done" });

  assert.equal(spawned.length, 1);
  const child = spawned[0];
  assert.equal(child.file, process.env.SHELL ?? "/bin/bash");
  assert.deepEqual(child.args, ["-lc", "npm test && echo done"]);
  assert.equal(result.exitCode, 0);
});

test("a relayed command on Windows goes through cmd.exe, quoted, not /bin/bash", async () => {
  await relay("win32", { command: "npm test && echo done" });

  const child = spawned[0];
  // The defect this lane exists to fix: before it, this was literally
  // "/bin/bash" with ["-lc", ...] on a machine that has neither.
  assert.notEqual(child.file, "/bin/bash");
  assert.equal(child.file, process.env.ComSpec ?? "cmd.exe");
  // Quoted, because `/s` strips the outer pair — review found this missing.
  assert.deepEqual(child.args, ["/d", "/s", "/c", '"npm test && echo done"']);
  assert.equal(child.options.windowsVerbatimArguments, true);
});

test("a quoted Windows path reaches cmd.exe intact through the relay", async () => {
  // End to end for the case that was broken: the agent's own quotes must still
  // be there after cmd.exe strips the pair we added.
  const command = '"C:\\Program Files\\nodejs\\npm.cmd" test';
  await relay("win32", { command });

  const passed = spawned[0].args.at(-1);
  assert.equal(passed.slice(1, -1), command);
});

test("the working directory is still honoured", async () => {
  await relay("win32", { command: "dir", cwd: dir });
  assert.equal(spawned[0].options.cwd, dir);
});

test("a timed-out command on Windows kills the tree, not just cmd.exe", async () => {
  const result = await relay("win32", { command: "npm run dev", timeoutMs: 20 }, { hang: true });

  assert.equal(result.timedOut, true);
  const killer = spawned.find((c) => c.file.includes("taskkill"));
  assert.ok(killer, "a timeout on Windows must reach taskkill");
  // /T is the point: cmd.exe is not the command, so killing only the pid we
  // hold would leave the dev server running with no parent.
  assert.deepEqual(killer.args, ["/pid", "4242", "/T", "/F"]);
});

test("a timed-out command on POSIX still gets SIGKILL, as it did before killTree", async () => {
  // killTree defaults to SIGTERM for stopAll's sake. The relay must opt back
  // in to SIGKILL explicitly, or this path quietly got weaker.
  const result = await relay("linux", { command: "sleep 100", timeoutMs: 20 }, { hang: true });

  assert.equal(result.timedOut, true);
  assert.equal(spawned.length, 1, "POSIX must not spawn a killer");
  assert.deepEqual(spawned[0].signals, ["SIGKILL"]);
});
