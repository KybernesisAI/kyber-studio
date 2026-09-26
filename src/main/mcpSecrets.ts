import type { SafeStorageLike } from "./credentialStorage";

/**
 * Seal and unseal the `env` values of a local MCP server.
 *
 * @remarks
 * `local-mcp.json` holds whatever a server's README asked the user for, which
 * in practice is provider API keys and connection strings. Until KYB-590 they
 * sat on disk in the clear, protected only by `0600` — while the Add-server
 * form told the user that putting a key in the environment box keeps it out of
 * "plain sight".
 *
 * **Per value, not per file.** Each value becomes `kyb:v1:<base64>`; everything
 * else — `command`, `args`, `cwd`, `name`, `enabled` — stays legible, so the
 * file remains hand-editable, which the epic requires. The version tag is the
 * value's own prefix, so there is no file-level schema field and no migration
 * pass that has to run before a read.
 *
 * **Migration is the absence of the prefix.** An unprefixed value is plaintext:
 * used as-is, and sealed on the next save. A file written by an older build
 * keeps working, and so does a key a user pastes in by hand. Mixed files are
 * normal rather than an error.
 *
 * **Sealing is idempotent**, which is what makes the renderer round-trip safe.
 * `Plugins.tsx` holds the whole server list in React state and writes the whole
 * list back on every toggle, add and remove, so sealed values travel out to the
 * renderer and come back unchanged. Re-sealing them would produce ciphertext of
 * ciphertext and grow the file on every click. (Masking them instead — the
 * obvious way to keep secrets out of the renderer — would write the mask back
 * as the new secret and destroy every key on the first toggle. That is KYB-291,
 * already shipped once in another repo.)
 *
 * **Failure is reported, never swallowed.** The two outcomes are deliberately
 * different things, and telling them apart is the whole point:
 *
 * - `store-unavailable` — the OS credential store could not be opened at all.
 *   Measured: a locked keyring makes `decryptString` throw on a blob that
 *   opens perfectly once unlocked. **This does not mean the value is damaged**,
 *   and a value in this state must never be reported to the user as needing
 *   re-entry, or they would delete and retype keys that were never broken.
 * - `needs-re-entry` — encryption *is* available and the value still will not
 *   open. That is the narrow, genuinely unrecoverable case: a copied profile, a
 *   different machine, a reset keyring, a torn blob.
 *
 * No Electron import: `safeStorage` is passed in, the same arrangement
 * `credentialStorage.ts` uses. That is worth keeping for its own sake — the
 * logic is pure and a pure module is cheaper to test than a mocked one.
 *
 * It is NOT, as this comment used to claim, because `localMcp.ts` and
 * `localExec.ts` are "permanently untestable" for importing `electron`. They
 * are not. `mock.module("electron", { exports: ... })` loads both of them
 * under `node --test`, and `test/local-mcp-call-sites.test.mjs` and
 * `test/local-exec-relay.test.mjs` do exactly that. The real obstacle was
 * mundane and unrelated: this repo writes extensionless relative imports
 * (`./atomicWrite`), which tsc and esbuild resolve and native ESM does not.
 * `test/ts-ext-resolve.mjs` closes it, in a `resolve` hook built on node's own
 * `fs`, `url` and `path` and nothing else.
 * Verified independently by removing that hook and re-running: the failure is
 * `ERR_MODULE_NOT_FOUND` for `./atomicWrite`, not a link error on `electron`.
 *
 * CORRECTED 25 Sep. This used to say the hook "closes it in fifteen lines with
 * no dependency", and this diff made that false on both counts: the file now
 * also resolves the `@/*` and `@shared/*` aliases and transforms `.tsx`, and
 * for the second of those it imports `esbuild`. The extensionless-import fix
 * itself is still dependency-free; the FILE is not.
 */

/** The parts of Electron's `safeStorage` this module needs. */
export type SealingSafeStorage = SafeStorageLike & {
  encryptString: (plainText: string) => Buffer;
  decryptString: (ciphertext: Buffer) => string;
};

/**
 * Marks a value as sealed, and says which scheme sealed it.
 *
 * Versioned from the start so a future change of scheme can be told apart from
 * this one by inspection rather than by guessing at the payload.
 */
export const SEAL_PREFIX = "kyb:v1:";

/**
 * Does this value carry the sealed marker?
 *
 * Note this is a claim about the *shape* of the string, not proof that it will
 * decrypt — see {@link looksSealed} for why the difference matters.
 */
export function isSealed(value: string): boolean {
  return value.startsWith(SEAL_PREFIX);
}

/**
 * A stricter test: prefixed *and* the remainder is well-formed base64.
 *
 * A user can legitimately type a value that starts with `kyb:v1:` — nothing
 * stops them. Treating that as ciphertext would report a perfectly good key as
 * unrecoverable. Requiring the payload to survive a base64 round-trip catches
 * essentially every accidental collision, because a hand-typed string that is
 * also valid base64 of real ciphertext is not something that happens by
 * accident.
 *
 * It is not a guarantee, and it is not meant to be: a determined user can still
 * construct a string that fools this. The consequence is bounded — that one
 * value reports as needing re-entry — and the alternative, trusting the prefix
 * alone, is worse.
 *
 * **Exported because every decision about a value must use the same test.**
 * `localMcp.ts` once filtered with {@link isSealed} when deciding which typed
 * values to keep for the session, so a key a user typed as `kyb:v1:my key` was
 * classified as ciphertext, dropped from the write, and — because the filtered
 * set then came out empty — dropped from the warning too. Silently discarded
 * input. Use this, not the prefix, anywhere the answer decides what happens to
 * a user's value.
 */
export function looksSealed(value: string): boolean {
  if (!isSealed(value)) return false;
  const payload = value.slice(SEAL_PREFIX.length);
  if (payload.length === 0) return false;
  const decoded = Buffer.from(payload, "base64");
  // Buffer.from is famously permissive: it skips characters it does not
  // recognise rather than failing. Re-encoding and comparing is what actually
  // rejects a payload that was never base64 to begin with.
  return decoded.length > 0 && decoded.toString("base64") === payload;
}

/** What happened when we tried to seal a whole `env` map. */
export type SealResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; reason: "store-unavailable" };

/** What happened when we tried to unseal a whole `env` map. */
export type UnsealResult =
  | { ok: true; env: Record<string, string> }
  | { ok: false; reason: "store-unavailable" }
  /** `keys` names the values that would not open, for a message that can be acted on. */
  | { ok: false; reason: "needs-re-entry"; keys: string[] };

/**
 * Seal every plaintext value in `env`, leaving already-sealed ones alone.
 *
 * Returns `store-unavailable` rather than throwing, and rather than falling
 * back to plaintext. Writing the values out unsealed here would be the silent
 * downgrade this ticket exists to remove — the caller decides what to do about
 * it, and the caller is the only thing that knows whether there is a user
 * watching.
 */
export function sealEnv(
  safeStorage: SealingSafeStorage,
  env: Record<string, string>,
): SealResult {
  const entries = Object.entries(env);
  // Nothing to protect: do not ask the OS, because asking is what raises the
  // keyring prompt. A user with no secrets should never see one.
  if (entries.length === 0) return { ok: true, env: {} };

  const alreadyDone = entries.every(([, value]) => looksSealed(value));
  if (alreadyDone) return { ok: true, env: { ...env } };

  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: "store-unavailable" };

  const sealed: Record<string, string> = {};
  for (const [key, value] of entries) {
    sealed[key] = looksSealed(value)
      ? value
      : SEAL_PREFIX + safeStorage.encryptString(value).toString("base64");
  }
  return { ok: true, env: sealed };
}

/**
 * Open every sealed value in `env`, passing plaintext ones through untouched.
 *
 * The availability check comes **first and deliberately**. A locked keyring
 * makes `decryptString` throw on a blob that is completely intact, so deciding
 * "this value is unrecoverable" from a thrown decrypt alone would tell users to
 * delete and retype working credentials. Availability is what separates the
 * environment being shut from the value being broken.
 */
export function unsealEnv(
  safeStorage: SealingSafeStorage,
  env: Record<string, string>,
): UnsealResult {
  const entries = Object.entries(env);
  if (entries.length === 0) return { ok: true, env: {} };

  // A file that predates this change, or one hand-edited by the user, needs no
  // keyring at all. Checking first keeps the prompt away from the common case.
  const anySealed = entries.some(([, value]) => looksSealed(value));
  if (!anySealed) return { ok: true, env: { ...env } };

  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: "store-unavailable" };

  const opened: Record<string, string> = {};
  const failed: string[] = [];
  for (const [key, value] of entries) {
    if (!looksSealed(value)) {
      opened[key] = value;
      continue;
    }
    try {
      opened[key] = safeStorage.decryptString(Buffer.from(value.slice(SEAL_PREFIX.length), "base64"));
    } catch {
      failed.push(key);
    }
  }

  if (failed.length > 0) return { ok: false, reason: "needs-re-entry", keys: failed.sort() };
  return { ok: true, env: opened };
}
