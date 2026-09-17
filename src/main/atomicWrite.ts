import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Write a file so a reader sees either the old contents or the new ones, never
 * half of either — and leave nothing behind when it fails.
 *
 * @remarks
 * Write beside the file, then RENAME. Rename is atomic on the same filesystem:
 * a concurrent reader gets the old file or the new file, never a half-written
 * one. Writing over the target in place would truncate it first, so a crash
 * mid-write leaves invalid JSON — and a caller that answers invalid JSON with a
 * fallback silently discards whatever was in it.
 *
 * What this DOES guarantee is that no reader observes a partial file, and that
 * a crashed process cannot leave one. It is not a durability claim: there is no
 * fsync of the temp before the rename and none of the directory after, so a
 * power cut or a kernel panic can still lose the most recent write. That is the
 * right trade for recoverable app state and the wrong one for anything you
 * cannot reconstruct.
 *
 * The rename is what PUBLISHES the write, so a failure before it means the temp
 * file is a leftover: not the real file, never read by anything, and still
 * sitting there next launch. The failure paths that produce it are the
 * persistent kind — a full disk, a permissions change, a lock held by another
 * process — so it will not clean itself up on the next attempt either. That
 * leftover is what KYB-580 was filed about.
 *
 * The temp name is derived from the target rather than randomised, deliberately:
 * a crash between write and rename then leaves ONE stale file per target, which
 * the next successful save overwrites, instead of an unbounded pile of
 * `foo.a1b2c3.tmp` that nothing ever collects.
 *
 * That choice assumes a single writer, and the assumption is load-bearing
 * rather than cosmetic: two processes sharing one derived temp path can
 * interleave inside `writeFileSync` and then atomically publish a torn file,
 * which is the exact bug this exists to prevent. KYB-575's single-instance lock
 * is what makes it true today. It holds within one installed app — so if an
 * AppImage and a .deb of this app ever resolve the same `userData`, this needs
 * revisiting before that ships.
 *
 * Throws on failure. Callers decide whether losing this particular write is
 * survivable; this function does not decide that for them.
 */
export function writeAtomic(target: string, data: string): void {
  const tmp = `${target}.tmp`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, target);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the write failure is the one worth reporting, not the tidy-up's */
    }
    throw error;
  }
}
