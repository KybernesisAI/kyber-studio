/**
 * Whether an env value is a sealed one, decided the same way in the main
 * process and the renderer (KYB-695).
 *
 * @remarks
 * This lived in `src/main/mcpSecrets.ts` and used `Buffer`, which the renderer
 * does not have. The edit form needs the same answer to tell a server with a
 * sealed value on disk from one without, so the test moved here and uses
 * `atob`/`btoa`, which both sides have. `mcpSecrets.ts` re-exports it, so the
 * main process still has exactly one function to call.
 *
 * The answers are the same as the `Buffer` version's, and
 * `test/shared-sealed.test.mjs` holds that over a set of inputs and with
 * `globalThis.Buffer` removed. The two agree because both end in the same
 * comparison: decode however permissively, re-encode canonically, and compare
 * with what was given. `Buffer.from(x, "base64")` skips characters it does not
 * know and `atob` throws on them, but either way the re-encoded string cannot
 * equal a payload that held one, so both answer `false`.
 */

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
 * decrypt: see {@link looksSealed} for why the difference matters.
 */
export function isSealed(value: string): boolean {
  return value.startsWith(SEAL_PREFIX);
}

/**
 * A stricter test: prefixed *and* the remainder is well-formed base64.
 *
 * A user can legitimately type a value that starts with `kyb:v1:`, and nothing
 * stops them. Treating that as ciphertext would report a perfectly good key as
 * unrecoverable. Requiring the payload to survive a base64 round-trip catches
 * essentially every accidental collision, because a hand-typed string that is
 * also valid base64 of real ciphertext is not something that happens by
 * accident.
 *
 * It is not a guarantee, and it is not meant to be: a determined user can still
 * construct a string that fools this. The consequence is bounded (that one
 * value reports as needing re-entry) and the alternative, trusting the prefix
 * alone, is worse.
 *
 * **Every decision about a value must use the same test.** `localMcp.ts` once
 * filtered with {@link isSealed} when deciding which typed values to keep for
 * the session, so a key a user typed as `kyb:v1:my key` was classified as
 * ciphertext, dropped from the write, and, because the filtered set then came
 * out empty, dropped from the warning too. Silently discarded input. Use this,
 * not the prefix, anywhere the answer decides what happens to a user's value,
 * in the renderer as much as in the main process.
 */
export function looksSealed(value: string): boolean {
  if (!isSealed(value)) return false;
  const payload = value.slice(SEAL_PREFIX.length);
  if (payload.length === 0) return false;
  let decoded: string;
  try {
    decoded = atob(payload);
  } catch {
    // Not base64 at all: a character outside the alphabet, or a length no
    // padding can explain.
    return false;
  }
  // `atob` forgives missing padding and ASCII whitespace. Re-encoding and
  // comparing is what rejects a payload that is not canonical base64, exactly
  // as the `Buffer` version did.
  return decoded.length > 0 && btoa(decoded) === payload;
}
