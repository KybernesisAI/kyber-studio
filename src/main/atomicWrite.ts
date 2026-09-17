import { renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Write a file so a reader sees either the old contents or the new ones, never
 * half of either — and leave nothing behind when it fails.
 *
 * @remarks
 * Write beside the file, then RENAME. Rename is atomic on the same filesystem:
 * the real file is either the old one or the new one. Copying the temp over the
 * target instead (which is what `saveState` used to do) truncates the target
 * first, so a crash mid-write left invalid JSON — and a caller that answers
 * invalid JSON with a fallback silently discards whatever was in it.
 *
 * The rename is what PUBLISHES the write, so a failure before it means the temp
 * file is a leftover: not the real file, never read by anything, and still
 * sitting there next launch. The failure paths that produce it are the
 * persistent kind — a full disk, a permissions change, a lock held by another
 * process — so it will not clean itself up on the next attempt either.
 *
 * The temp name is derived from the target rather than randomised, deliberately:
 * a crash between write and rename then leaves ONE stale file per target, which
 * the next successful save overwrites, instead of an unbounded pile of
 * `foo.a1b2c3.tmp` that nothing ever collects. Only one process writes these —
 * KYB-575's single-instance lock is what makes that true — so two writers
 * cannot race for the same temp path.
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
