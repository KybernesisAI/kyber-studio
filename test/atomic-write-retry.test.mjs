import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RENAME_RETRY_DELAYS_MS, renameWithRetry, writeAtomic } from "../src/main/atomicWrite.ts";

/**
 * KYB-621: on Windows, renaming onto a target that ANY other process holds open
 * fails with EPERM, whatever share mode the holder used. Measured on
 * windows-latest on 14 October 2026; the measurements are on the ticket.
 * `writeAtomic` now retries the rename there for about 0.8 s.
 *
 * The retry's decisions are tested here on every platform through the seams
 * on `renameWithRetry` — a fake rename, a recorded sleep, a stated platform —
 * because which errors are retried, how often and where, is logic, and logic
 * that only runs on one CI arm is logic most changes never exercise. The real
 * thing, a file actually held open, is the Windows-only test at the bottom.
 */

const err = (code) => Object.assign(new Error(`${code}: simulated`), { code });

/** A rename that fails with `code` for the first `failures` calls, then succeeds. */
function flakyRename(failures, code = "EPERM") {
  const calls = [];
  return {
    calls,
    rename: (from, to) => {
      calls.push([from, to]);
      if (calls.length <= failures) throw err(code);
    },
  };
}

test("on Windows a refused rename is retried, and success after a retry is told apart from first-time success", () => {
  for (const code of ["EPERM", "EBUSY", "EACCES"]) {
    const { calls, rename } = flakyRename(2, code);
    const slept = [];
    renameWithRetry("a.tmp", "a", rename, (ms) => slept.push(ms), "win32");
    assert.equal(calls.length, 3, `${code}: expected two refusals then a success`);
    assert.deepEqual(slept, RENAME_RETRY_DELAYS_MS.slice(0, 2), `${code}: wrong back-off`);
  }

  // The control: a rename that never needed a retry made exactly one call and never slept.
  const { calls, rename } = flakyRename(0);
  const slept = [];
  renameWithRetry("a.tmp", "a", rename, (ms) => slept.push(ms), "win32");
  assert.equal(calls.length, 1);
  assert.deepEqual(slept, []);
});

test("the retry is bounded: when the target stays refused, the last error is thrown after every delay", () => {
  const { calls, rename } = flakyRename(Infinity);
  const slept = [];
  assert.throws(
    () => renameWithRetry("a.tmp", "a", rename, (ms) => slept.push(ms), "win32"),
    (e) => e.code === "EPERM",
  );
  assert.equal(calls.length, RENAME_RETRY_DELAYS_MS.length + 1);
  assert.deepEqual(slept, [...RENAME_RETRY_DELAYS_MS]);
  const total = RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  assert.ok(total <= 1000, `the worst-case freeze grew to ${total} ms; it runs on the main process`);
});

test("off Windows, and for errors that are not 'in use', the rename is not retried", () => {
  // The sleep RECORDS rather than throws: a throwing sleep is caught by the
  // same assert.throws as the rename's own error, so a wrongful retry would
  // pass. Each throw is pinned to the rename's code for the same reason.
  for (const platform of ["linux", "darwin"]) {
    const { calls, rename } = flakyRename(1);
    const slept = [];
    assert.throws(() => renameWithRetry("a.tmp", "a", rename, (ms) => slept.push(ms), platform), { code: "EPERM" });
    assert.equal(calls.length, 1, `${platform} retried`);
    assert.deepEqual(slept, [], `${platform} slept`);
  }
  for (const code of ["ENOSPC", "ENOENT", "EISDIR", "EXDEV"]) {
    const { calls, rename } = flakyRename(1, code);
    const slept = [];
    assert.throws(() => renameWithRetry("a.tmp", "a", rename, (ms) => slept.push(ms), "win32"), { code });
    assert.equal(calls.length, 1, `${code} was retried`);
    assert.deepEqual(slept, [], `${code} slept`);
  }
});

const WINDOWS_ONLY = process.platform !== "win32" && "the open-handle failure is Windows-only; Linux renames over a held file";

test("a target held open by another process is still written, once the holder lets go", { skip: WINDOWS_ONLY }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-621-held-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, "local-mcp.json");
  writeFileSync(target, "OLD");

  // A second process holds the target for 300 ms: the shape of an indexer or
  // scanner glancing at a file just written. Without the retry this is EPERM.
  const holder = spawn(process.execPath, [
    "-e",
    "const fs=require('fs');const fd=fs.openSync(process.env.T,'r');console.log('held');setTimeout(()=>fs.closeSync(fd),300)",
  ], { env: { ...process.env, T: target } });
  await new Promise((resolve, reject) => {
    holder.stdout.on("data", (d) => String(d).includes("held") && resolve());
    holder.on("exit", (code) => reject(new Error(`holder exited ${code} before holding`)));
  });

  // The control: the hold really does refuse a bare rename, so the write below
  // succeeds BECAUSE of the retry, not because no retry was needed.
  const probe = join(dir, "probe");
  writeFileSync(probe, "PROBE");
  assert.throws(() => renameSync(probe, target), { code: "EPERM" }, "the hold did not refuse a bare rename");
  rmSync(probe, { force: true });

  writeAtomic(target, "NEW", { mode: 0o600 });
  await new Promise((resolve) => (holder.exitCode !== null ? resolve() : holder.on("exit", resolve)));

  assert.equal(readFileSync(target, "utf8"), "NEW");
  assert.equal(existsSync(`${target}.tmp`), false, "the temp file was left behind");
});

test("a target that can never be written still fails, after the retries, and leaves nothing behind", { skip: WINDOWS_ONLY }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), "kyb-621-readonly-"));
  const target = join(dir, "local-mcp.json");
  writeFileSync(target, "OLD");
  chmodSync(target, 0o444); // on Windows, the read-only attribute: a permanent EPERM
  t.after(() => {
    chmodSync(target, 0o666);
    rmSync(dir, { recursive: true, force: true });
  });

  const started = Date.now();
  assert.throws(() => writeAtomic(target, "NEW", { mode: 0o600 }), (e) => e.code === "EPERM");
  const elapsed = Date.now() - started;

  assert.equal(readFileSync(target, "utf8"), "OLD");
  assert.equal(existsSync(`${target}.tmp`), false, "the temp file was left behind");
  // The retries really ran, and stayed within budget (with generous slack for a busy runner).
  assert.ok(elapsed >= 700, `gave up after ${elapsed} ms: the retries did not run`);
  assert.ok(elapsed < 5000, `took ${elapsed} ms`);
});
