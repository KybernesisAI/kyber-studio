import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";

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
 *
 * ## The mode, and why it takes three steps rather than one — KYB-582
 *
 * A rename publishes the TEMP FILE'S INODE, so the published file carries the
 * temp's permissions and not the target's. Callers that used to write their own
 * file with `{ mode: 0o600 }` — the permission store and the MCP config, which
 * hold consent decisions and provider credentials — would therefore be widened
 * to the umask default by the mere act of becoming atomic. Measured at `0644`
 * under umask 022. That is a security regression hiding inside a reliability
 * fix, which is why the mode is a parameter here rather than an afterthought at
 * the call sites.
 *
 * Passing a mode does three things, and each closes a hole the other two leave
 * open:
 *
 * 1. **Remove any stale temp first.** `writeFileSync`'s `mode` applies only when
 *    it CREATES the file and is ignored when the file already exists. A stale
 *    `foo.tmp` from a previous failed write — the state the paragraph above says
 *    is both expected and persistent — would therefore donate its own, possibly
 *    wider, permissions to the secret about to be written into it. Removing it
 *    means the write below is always a creation.
 *
 *    It also means a stale temp that is a SYMLINK is deleted rather than
 *    followed. `writeFileSync` on a symlink writes through to its destination,
 *    so without this the file's contents could be published somewhere else
 *    entirely by anything able to drop a link into `userData`.
 *
 * 2. **Create with the mode.** So the bytes are never on disk under wider
 *    permissions, not even for the instant between writing and tightening. A
 *    `chmod` after an unrestricted create would close the hole late, and "late"
 *    is a window a concurrent reader can be inside.
 *
 * 3. **Then set it explicitly.** Creation modes are masked by the process
 *    umask — a restrictive umask turns a requested `0600` into `0400`, and the
 *    next writer to that path is then fighting a read-only file it created
 *    itself. `chmod` is not umask-masked, so this makes the mode the one the
 *    caller asked for rather than the one the environment allowed.
 *
 * Callers that pass no mode keep exactly the previous behaviour, including the
 * stale temp being written through rather than removed. `saveState` is such a
 * caller: app state is not secret, wants no `0600`, and its existing tests pin
 * that path.
 */
export function writeAtomic(target: string, data: string, options: { mode?: number } = {}): void {
  const tmp = `${target}.tmp`;
  try {
    if (options.mode === undefined) {
      writeFileSync(tmp, data, "utf8");
    } else {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, data, { encoding: "utf8", mode: options.mode });
      chmodSync(tmp, options.mode);
    }
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
