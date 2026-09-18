import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
