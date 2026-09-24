import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeAtomic } from "../src/main/atomicWrite.ts";

/**
 * What these tests exist to catch.
 *
 * KYB-580: `saveState` wrote a temp file and renamed it over the target, which
 * is the right shape — but if the RENAME failed, the temp file stayed. The
 * failure was swallowed, so the only evidence anything had gone wrong was a
 * `.tmp` nobody looks in `userData` to find.
 *
 * These run against a real directory rather than a mock filesystem, because the
 * thing being tested is what the filesystem does — a fake rename that throws on
 * request would be asserting that this file's own stub behaves as this file's
 * own stub was written to behave.
 *
 * The failing case is produced by making the target a NON-EMPTY DIRECTORY.
 * `rename(file, dir)` cannot succeed, and it fails at exactly the step this
 * change is about: after the temp file exists, before it is published. No
 * monkey-patching, and nothing that stops being true if node's error codes
 * change.
 *
 * NOT covered here, deliberately, and recorded so it is not mistaken for
 * coverage: the other half of KYB-580 — that the save dialog's default folder
 * comes from the OS rather than a hard-coded `~/Downloads`. That property is
 * "we asked the OS", which cannot be observed without running Electron;
 * asserting it by reading the source would be a text scan that a later edit
 * walks straight past. It was verified by UAT instead — Linux Mint, with
 * XDG_DOWNLOAD_DIR redirected, dialog confirmed opening at the redirected
 * folder — and the ticket carries that run as the evidence.
 *
 * The PUBLISH MECHANISM is pinned, by inode. A rename gives the target a new
 * inode; copying over it writes through the existing one. So an implementation
 * that publishes with `copyFileSync` and then deletes the temp — the
 * truncate-in-place behaviour the rename exists to prevent — turns test 2 red.
 *
 * That check exists because an earlier version of this header said catching it
 * "needs a concurrent reader, which this suite does not have". That was wrong,
 * and wrong in the direction that keeps a gap open: it told the next reader not
 * to bother. Review closed it in three synchronous lines. The claim is recorded
 * here because being confidently wrong about what cannot be tested is the same
 * failure as claiming coverage that does not exist — the defect this file has
 * been corrected for three times.
 *
 * What is STILL not covered: durability, which needs a power cut, and genuine
 * concurrency, which needs a second process. Neither is reachable here, and the
 * module's doc comment says as much rather than implying otherwise.
 */

function scratch() {
  return mkdtempSync(join(tmpdir(), "kyber-atomic-"));
}

test("the data lands, and no temp file is left beside it", () => {
  const dir = scratch();
  const target = join(dir, "state.json");

  // Non-ASCII deliberately: this is state for transcripts and project names, so
  // the encoding is load-bearing. With an ASCII payload, switching the write
  // from utf8 to latin1 survives every test in this file.
  writeAtomic(target, '{"open":"Téléchargements ✓"}');

  assert.equal(readFileSync(target, "utf8"), '{"open":"Téléchargements ✓"}');
  assert.equal(existsSync(`${target}.tmp`), false, "the temp file should have been renamed away");
});

test("an existing file is replaced by a rename, not written through in place", () => {
  const dir = scratch();
  const target = join(dir, "state.json");
  writeFileSync(target, '{"old":true}', "utf8");
  const before = statSync(target).ino;

  writeAtomic(target, '{"new":true}');

  assert.equal(readFileSync(target, "utf8"), '{"new":true}');
  assert.equal(existsSync(`${target}.tmp`), false);
  // The inode is the whole atomicity claim, and it is cheap to check. renameSync
  // puts a NEW inode at this path; copyFileSync would write through the old one,
  // truncating it first — which is exactly the window where a crash leaves
  // invalid JSON for loadState to silently discard.
  assert.notEqual(
    statSync(target).ino,
    before,
    "the target must be replaced by a rename, not overwritten in place",
  );
});

test("a publish that cannot happen reports the failure AND clears the temp file", () => {
  // The whole of KYB-580's second half. Before the fix this assertion on the
  // temp file failed: the write succeeded, the rename did not, and the leftover
  // stayed on disk with nothing to report it.
  const dir = scratch();
  const target = join(dir, "state.json");
  mkdirSync(target);
  // The occupant is not strictly needed: on POSIX, rename onto an EMPTY
  // directory already fails. It is kept because a directory with something in
  // it is unambiguous under any implementation.
  //
  // It does NOT help on Windows, and an earlier version of this comment claimed
  // it did — twice, in two different wrong ways. MoveFileExW with
  // MOVEFILE_REPLACE_EXISTING cannot target a directory at all, empty or not.
  // The likely Windows error is EACCES rather than EISDIR, so the matcher below
  // will need revisiting when KYB-500's Windows lane turns CI on.
  writeFileSync(join(target, "occupant"), "x", "utf8");

  assert.throws(
    () => writeAtomic(target, '{"doomed":true}'),
    { code: "EISDIR" },
    "a write that never reached the target must not be reported as a success",
  );
  assert.equal(
    existsSync(`${target}.tmp`),
    false,
    "the temp file must not survive a failed rename — this is the defect",
  );
});

test("the temp file is the one derived from the target, not a name of its own choosing", () => {
  // Occupy EXACTLY `${target}.tmp` with something that cannot be written over.
  // An implementation that derives the temp name from the target fails here; one
  // that randomises it, or shares a single temp name across every target, sails
  // straight past and turns this test red — which is the whole point.
  //
  // Review found the previous version of this test asserted only that two files
  // it never created did not exist. It passed 4/4 against both of those mutants,
  // while carrying a name that claimed to rule them out.
  const dir = scratch();
  const target = join(dir, "state.json");
  mkdirSync(`${target}.tmp`);

  assert.throws(
    () => writeAtomic(target, '{"x":1}'),
    { code: "EISDIR" },
    "the temp file must be `${target}.tmp` — note this pins the literal suffix, " +
      "so renaming it to .temp fails here even though that is also derived",
  );
});

/**
 * KYB-582 — the mode, and what each of the three steps is holding up.
 *
 * A rename publishes the TEMP's inode, so an atomic write hands the target the
 * temp file's permissions. The three callers moved onto this helper hold
 * consent decisions and MCP provider credentials at `0600`, so becoming atomic
 * would have widened all three to the umask default. These tests pin the mode
 * on the PUBLISHED file, which is the only place it can be checked honestly:
 * asserting it on the temp would assert an implementation detail that no longer
 * exists by the time the function returns.
 *
 * Which test kills which step:
 *
 *   - restrictive umask          -> kills dropping the `chmod`
 *   - stale temp, symlink        -> kills dropping the `rmSync`
 *   - stale temp, inherited mode -> kills removing the stale temp UNconditionally
 *   - observer, clean directory  -> kills creating the temp unrestricted
 *   - observer, stale temp there -> kills dropping the `rmSync` again, without
 *                                   needing the symlink privilege the test
 *                                   above it self-disables without
 *
 * ONE MUTANT SURVIVES: chmod'ing the TARGET after the rename instead of the
 * temp before it. Its window is two adjacent metadata syscalls with no I/O
 * between them, and the observer below does not catch it. Disclosed rather
 * than left for a reader to find, and NOT claimed as equivalent — unobserved
 * from here is a different thing from harmless.
 *
 * A SECOND MUTANT WAS DISCLOSED AS A SURVIVOR AND WAS NOT ONE. An earlier
 * version of this file argued that dropping `mode` from the `writeFileSync`
 * call — creating unrestricted and relying on the `chmod` — was an unobservable
 * window because "this suite has one process". Review killed it with a worker
 * thread and a large payload: that window lasts as long as the WRITE, so it
 * grows with the data, and a concurrent reader sees `0644` on the temp. The
 * test is below. The lesson is recorded because the reasoning, not the code,
 * was the defect: "my test cannot see it" had been rounded up to "nothing can".
 *
 * NOT COVERED, deliberately and recorded so it is not mistaken for coverage:
 * Windows. `statSync().mode & 0o777` reports 0666 or 0444 there regardless of
 * what was asked for, so every mode assertion in this section is skipped on
 * win32. CI runs Linux only, so those guards are themselves unexercised — they
 * are there to stop a future Windows lane going red for a reason nobody can
 * find, not because they have been seen to work.
 */

test("the published file carries the mode the caller asked for", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are not reported on win32");
    return;
  }

  const dir = scratch();
  const target = join(dir, "local-mcp.json");

  // Non-ASCII on this path too: the mode branch is a second writeFileSync call
  // with a different signature, so an encoding mistake there is invisible to
  // the tests above.
  writeAtomic(target, '{"env":{"KEY":"Téléchargements ✓"}}', { mode: 0o600 });

  assert.equal(readFileSync(target, "utf8"), '{"env":{"KEY":"Téléchargements ✓"}}');
  assert.equal((statSync(target).mode & 0o777).toString(8), "600");
  assert.equal(existsSync(`${target}.tmp`), false);
});

test("a restrictive umask does not narrow the mode the caller asked for", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are not reported on win32");
    return;
  }

  // Creation modes are masked by the umask: under 0o277 a requested 0600 is
  // created as 0400, and the caller ends up with a file it cannot rewrite in
  // place. `chmod` is not masked. Dropping the chmod turns this red at 400.
  const dir = scratch();
  const target = join(dir, "local-permissions.json");
  const previous = process.umask(0o277);
  try {
    writeAtomic(target, '{"read-file":"never"}', { mode: 0o600 });
  } finally {
    process.umask(previous);
  }

  assert.equal((statSync(target).mode & 0o777).toString(8), "600");
  assert.equal(readFileSync(target, "utf8"), '{"read-file":"never"}');
});

test("a stale temp of a wider mode still publishes at the requested mode", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are not reported on win32");
    return;
  }

  // An END-TO-END assertion, and deliberately not a discriminating one: it
  // cannot tell you WHICH step produced the 0600, and dropping either the
  // removal or the chmod leaves it green because the other one covers. Said
  // plainly because the first version of this comment claimed it pinned the
  // removal, and it does not — the chmod repairs the mode either way.
  //
  // It earns its place as the composite check: the state the module's doc
  // comment calls expected and persistent — a previous write that failed after
  // creating the temp — must not change what a caller gets.
  const dir = scratch();
  const target = join(dir, "local-mcp.json");
  writeFileSync(`${target}.tmp`, "leftover", "utf8");
  chmodSync(`${target}.tmp`, 0o644);

  writeAtomic(target, '{"servers":[]}', { mode: 0o600 });

  assert.equal((statSync(target).mode & 0o777).toString(8), "600");
  assert.equal(readFileSync(target, "utf8"), '{"servers":[]}');
});

test("a stale temp that is a symlink is removed, not written through", (t) => {
  const dir = scratch();
  const target = join(dir, "local-mcp.json");
  const elsewhere = join(dir, "elsewhere.json");
  writeFileSync(elsewhere, "untouched", "utf8");

  try {
    symlinkSync(elsewhere, `${target}.tmp`);
  } catch {
    // Windows needs a privilege for this and CI does not run there yet. Skipped
    // out loud: a silently-skipped test is the thing this repo keeps filing
    // tickets about.
    t.skip("symlinks not permitted on this platform");
    return;
  }

  writeAtomic(target, '{"servers":[{"id":"plaud"}]}', { mode: 0o600 });

  assert.equal(
    readFileSync(elsewhere, "utf8"),
    "untouched",
    "writeFileSync follows a symlink — a stale one must be unlinked, not written through",
  );
  assert.equal(readFileSync(target, "utf8"), '{"servers":[{"id":"plaud"}]}');
  assert.equal(lstatSync(target).isSymbolicLink(), false);

  // Guarded separately rather than skipping the whole test: the symlink
  // behaviour above is worth checking anywhere symlinks can be made, including
  // a Windows box with Developer Mode on, where this assertion would read 0666
  // and fail for a reason unrelated to what the test is about.
  if (process.platform !== "win32") {
    assert.equal((statSync(target).mode & 0o777).toString(8), "600");
  }
});

test("passing no mode writes THROUGH a stale temp rather than removing it", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are not reported on win32");
    return;
  }

  // Pinned by the INHERITED MODE, and the choice of 0o777 is the whole point:
  // writing through a stale temp keeps its permissions, whereas creating a
  // fresh one cannot produce 777 under any umask. So the two paths are
  // distinguishable by the published mode alone.
  //
  // This replaces an inode comparison, which could not fail: inode numbers are
  // reused after an unlink — measured 200/200 on the overlayfs that backs
  // os.tmpdir() here — so the published file had the stale file's inode either
  // way. That assertion carried the message "making the removal unconditional
  // turns this red" and it did not. Third time in this file that a comment
  // claimed a check it could not perform; recorded so it stops happening.
  const dir = scratch();
  const target = join(dir, "state.json");
  writeFileSync(`${target}.tmp`, "leftover", "utf8");
  chmodSync(`${target}.tmp`, 0o777);

  writeAtomic(target, '{"projects":[]}');

  assert.equal(readFileSync(target, "utf8"), '{"projects":[]}');
  assert.equal(existsSync(`${target}.tmp`), false);
  assert.equal(
    (statSync(target).mode & 0o777).toString(8),
    "777",
    "the no-mode path writes through the stale temp and inherits its mode; " +
      "making the removal unconditional publishes a fresh 644 and turns this red",
  );
});

test("a target that already exists at a wider mode is republished at the requested one", (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are not reported on win32");
    return;
  }

  // The one benefit the cross-platform note advertises: the old in-place write
  // set its mode only when the file was first created, so a file that reached
  // 0644 by any route stayed there forever. Every publish now re-establishes it.
  const dir = scratch();
  const target = join(dir, "local-permissions.json");
  writeFileSync(target, '{"run-command":"ask"}', "utf8");
  chmodSync(target, 0o644);

  writeAtomic(target, '{"run-command":"never"}', { mode: 0o600 });

  assert.equal((statSync(target).mode & 0o777).toString(8), "600");
  assert.equal(readFileSync(target, "utf8"), '{"run-command":"never"}');
});

/**
 * The mutant review killed that this suite had written off as unobservable.
 *
 * Creating the temp unrestricted and tightening it afterwards ends at the same
 * 0600, so nothing single-threaded can tell the two apart. The difference is
 * WHEN: the bytes are on disk at 0644 for as long as the write takes. A big
 * payload makes that window wide enough for another thread to walk into.
 *
 * The observer reports every mode it managed to sample. Two assertions, and the
 * first one matters more than it looks: if the poll never catches the temp at
 * all, this FAILS rather than passing vacuously. A timing-dependent test that
 * can go quietly green is the thing this repo keeps filing tickets about — so
 * this one is built to go red when it stops working.
 */
/**
 * Watch the temp path from another thread for the duration of one write, and
 * report the modes seen while the file was PART-WRITTEN.
 *
 * The size filter is what makes the result mean anything. Samples are only
 * counted when the file is larger than whatever was sitting there before and
 * smaller than the finished payload — so a sample cannot be the stale file, and
 * cannot be the finished article after the chmod has run. Without it the
 * "at least one sample" guard proves only that the poll fired, not that it
 * fired during the window the test is about.
 */
async function modesDuringWrite(target, payload, stale) {
  const tmp = `${target}.tmp`;
  let floor = 0;
  if (stale) {
    writeFileSync(tmp, stale.contents, "utf8");
    chmodSync(tmp, stale.mode);
    floor = Buffer.byteLength(stale.contents);
  }

  const observer = new Worker(
    `
    const { parentPort, workerData } = require("node:worker_threads");
    const { statSync } = require("node:fs");
    const seen = [];
    let stopping = false;
    parentPort.on("message", () => { stopping = true; });
    const poll = () => {
      try {
        const st = statSync(workerData.tmp);
        const last = seen[seen.length - 1];
        // Only on change: the poll fires thousands of times to express a
        // handful of distinct states, and every one of them would otherwise be
        // structured-cloned back to the test.
        if (!last || last[0] !== (st.mode & 0o777) || last[1] !== st.size) {
          seen.push([st.mode & 0o777, st.size]);
        }
      } catch { /* not there yet, or already renamed */ }
      if (stopping) { parentPort.postMessage(seen); return; }
      setImmediate(poll);
    };
    parentPort.postMessage("ready");
    poll();
    `,
    { eval: true, workerData: { tmp } },
  );

  try {
    await once(observer, "message");
    writeAtomic(target, payload, { mode: 0o600 });
    observer.postMessage("stop");
    const [seen] = await once(observer, "message");

    // Hoisted deliberately: this is O(payload) and the filter runs once per
    // sample. Evaluated inside the predicate it cost 118 seconds for this file.
    const finished = Buffer.byteLength(payload);
    const mid = seen.filter(([, size]) => size > floor && size < finished);
    return { midCount: mid.length, modes: [...new Set(mid.map(([m]) => m.toString(8)))].sort() };
  } finally {
    await observer.terminate();
  }
}

// Big enough that the write is not instantaneous. The real callers write a few
// hundred bytes; the window exists at any size, and this only widens it enough
// to be caught every time rather than sometimes.
const BIG = JSON.stringify({ servers: [{ id: "plaud", env: { KEY: "x".repeat(40_000_000) } }] });

test("a concurrent reader never sees the temp under wider permissions", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are not reported on win32");
    return;
  }

  const target = join(scratch(), "local-mcp.json");
  const { midCount, modes } = await modesDuringWrite(target, BIG);

  assert.ok(
    midCount > 0,
    "the observer never caught the temp mid-write — this test proves nothing in that state; enlarge the payload",
  );
  assert.deepEqual(modes, ["600"], "the temp was readable at a wider mode while it was being written");
});

test("nor when a stale temp of a wider mode was there first", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX modes are not reported on win32");
    return;
  }

  // The second killer for step 1, and the one that does not need symlink
  // privilege to work. Without the removal, `mode` is ignored on the existing
  // file and the payload is written into a 0644 inode — so the bytes are
  // world-readable for the whole write, and only the closing chmod tightens
  // them. That is exactly the guarantee step 2 claims and cannot keep alone.
  const target = join(scratch(), "local-permissions.json");
  const { midCount, modes } = await modesDuringWrite(target, BIG, {
    contents: "leftover",
    mode: 0o644,
  });

  assert.ok(midCount > 0, "the observer never caught the temp mid-write; enlarge the payload");
  assert.deepEqual(
    modes,
    ["600"],
    "a stale temp's permissions survived into the write — the removal in step 1 is what prevents this",
  );
});
