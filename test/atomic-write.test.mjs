import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
 */

function scratch() {
  return mkdtempSync(join(tmpdir(), "kyber-atomic-"));
}

test("the data lands, and no temp file is left beside it", () => {
  const dir = scratch();
  const target = join(dir, "state.json");

  writeAtomic(target, '{"open":"project"}');

  assert.equal(readFileSync(target, "utf8"), '{"open":"project"}');
  assert.equal(existsSync(`${target}.tmp`), false, "the temp file should have been renamed away");
});

test("an existing file is replaced rather than appended to", () => {
  const dir = scratch();
  const target = join(dir, "state.json");
  writeFileSync(target, '{"old":true}', "utf8");

  writeAtomic(target, '{"new":true}');

  assert.equal(readFileSync(target, "utf8"), '{"new":true}');
  assert.equal(existsSync(`${target}.tmp`), false);
});

test("a publish that cannot happen reports the failure AND clears the temp file", () => {
  // The whole of KYB-580's second half. Before the fix this assertion on the
  // temp file failed: the write succeeded, the rename did not, and the leftover
  // stayed on disk with nothing to report it.
  const dir = scratch();
  const target = join(dir, "state.json");
  mkdirSync(target);
  // Not needed on POSIX — rename onto an empty directory already fails — but it
  // keeps the case unambiguous on Windows, where an empty directory can be
  // replaced.
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
    "the derived temp path is what the implementation must use",
  );
});

test("one target's temp file never collides with another's", () => {
  const dir = scratch();
  const first = join(dir, "session.json");
  const second = join(dir, "projects.json");

  writeAtomic(first, '{"a":1}');
  writeAtomic(second, '{"b":2}');

  assert.equal(readFileSync(first, "utf8"), '{"a":1}');
  assert.equal(readFileSync(second, "utf8"), '{"b":2}');
});
