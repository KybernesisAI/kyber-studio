import type { SafeStorageLike } from "./credentialStorage";
import { SEAL_PREFIX, isSealed, looksSealed } from "../shared/sealed";

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
 * The sealed-value tests live in `src/shared/sealed.ts` (KYB-695), so the
 * renderer can ask the same question with the same answer: the edit form tells
 * a server with a sealed value on disk from one without. They are re-exported
 * here so every caller in the main process keeps using this module, and so
 * there is one `looksSealed` and not two that can drift.
 */
export { SEAL_PREFIX, isSealed, looksSealed };

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
 * A value stored as the bare prefix, read as the empty value it was (KYB-698).
 *
 * Sealing `""` used to call `encryptString("")`, which on Linux returns an
 * empty buffer, so the stored value was `kyb:v1:` with nothing after it.
 * {@link looksSealed} rejects an empty payload on purpose, so that value read
 * back as the 7-character plain text `kyb:v1:`, which the child was given and
 * the next save sealed for good. `sealEnv` no longer writes it, and this reads
 * one an older build wrote, on open and on save.
 *
 * Exact equality, not a prefix test: sealing `""` is the only way the bare
 * prefix reaches the file, and a value a person typed that merely starts with
 * `kyb:v1:` is theirs and is kept as it is. The cost is a real value of
 * exactly `kyb:v1:`, which is not a credential anyone has. A value already
 * re-sealed as the literal cannot be told from a typed one, and is left alone.
 */
function withoutBarePrefix(value: string): string {
  return value === SEAL_PREFIX ? "" : value;
}

/**
 * Whether a value needs nothing from the OS to be stored: it is sealed
 * already, or it is empty and so holds no secret (KYB-698).
 */
function needsNoSealing(value: string): boolean {
  return value === "" || looksSealed(value);
}

/**
 * Seal every plaintext value in `env`, leaving already-sealed ones alone.
 *
 * An empty value is stored as `""` and never sealed (KYB-698): it holds no
 * secret, and sealing it is what wrote the bare prefix. A value stored as the
 * bare prefix by an older build is stored as `""` too, see
 * {@link withoutBarePrefix}.
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
  // The bare prefix is read as `""` before anything else looks at it, so every
  // check below sees an empty value and not a 7-character one (KYB-698).
  const entries = Object.entries(env).map(([key, value]) => [key, withoutBarePrefix(value)] as const);
  // Nothing to protect: do not ask the OS, because asking is what raises the
  // keyring prompt. A user with no secrets should never see one.
  if (entries.length === 0) return { ok: true, env: {} };

  // The same rule for a map whose values are all sealed or empty: an empty
  // value holds nothing to protect, so it asks nothing (KYB-698).
  const alreadyDone = entries.every(([, value]) => needsNoSealing(value));
  if (alreadyDone) return { ok: true, env: Object.fromEntries(entries) };

  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: "store-unavailable" };

  const sealed: Record<string, string> = {};
  for (const [key, value] of entries) {
    sealed[key] = needsNoSealing(value)
      ? value
      : SEAL_PREFIX + safeStorage.encryptString(value).toString("base64");
  }
  return { ok: true, env: sealed };
}

/**
 * Open every sealed value in `env`, passing plaintext ones through untouched,
 * except a value stored as the bare prefix, which opens as `""` (KYB-698).
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
  // A value stored as the bare prefix opens as `""` on this path too (KYB-698).
  const anySealed = entries.some(([, value]) => looksSealed(value));
  if (!anySealed) {
    return { ok: true, env: Object.fromEntries(entries.map(([key, value]) => [key, withoutBarePrefix(value)])) };
  }

  if (!safeStorage.isEncryptionAvailable()) return { ok: false, reason: "store-unavailable" };

  const opened: Record<string, string> = {};
  const failed: string[] = [];
  for (const [key, value] of entries) {
    if (!looksSealed(value)) {
      opened[key] = withoutBarePrefix(value);
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
