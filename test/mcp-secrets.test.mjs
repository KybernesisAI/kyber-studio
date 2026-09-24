import { test } from "node:test";
import assert from "node:assert/strict";

// No Electron imports in the module under test — the safeStorage object is
// passed in — so node --test can load it directly under --experimental-strip-types.
// This matters more here than usual: localMcp.ts and localExec.ts both import
// electron and can never be unit-tested, so this module is the only place the
// sealing logic is reachable by a test at all.
import {
  SEAL_PREFIX,
  isSealed,
  sealEnv,
  unsealEnv,
} from "../src/main/mcpSecrets.ts";

/**
 * What these tests exist to catch.
 *
 * Three failures are possible here and only one of them is obvious.
 *
 * The obvious one is "the key does not survive a round trip".
 *
 * The second is the renderer round-trip. Plugins.tsx holds the whole server
 * list in React state and writes the whole list back on every toggle, so sealed
 * values leave the main process and come back. Anything that is not idempotent
 * corrupts them on the first click.
 *
 * The third is the one that would have done real damage, and it is not about
 * cryptography at all. A LOCKED KEYRING makes decryptString throw on a value
 * that is completely intact — measured on Electron 34.5.8, where the same
 * ciphertext threw at 09:00 and opened at 09:01 after an unlock. If a thrown
 * decrypt is read as "this credential is broken", every user who locks their
 * keyring is told to delete and retype every key they own. The availability
 * check is what separates the two, and several tests below exist only to pin
 * that ordering down.
 *
 * A fourth concern runs through all of it: asking safeStorage a question is
 * what RAISES the keyring prompt. Detection is lazy by decision (KYB-590), so
 * the tests assert not merely the answers but that the question went unasked
 * whenever it did not need to be.
 */

/**
 * A safeStorage that records what it was asked.
 *
 * The call counters are load-bearing, not decoration: "did not prompt" is a
 * property of this module and cannot be observed any other way from a test.
 */
function fakeSafeStorage({ available = true, failOn = [] } = {}) {
  const calls = { isEncryptionAvailable: 0, encryptString: 0, decryptString: 0 };
  return {
    calls,
    isEncryptionAvailable() {
      calls.isEncryptionAvailable += 1;
      return available;
    },
    getSelectedStorageBackend() {
      return "gnome_libsecret";
    },
    encryptString(plain) {
      calls.encryptString += 1;
      return Buffer.from(`sealed(${plain})`, "utf8");
    },
    decryptString(buf) {
      calls.decryptString += 1;
      const text = buf.toString("utf8");
      const match = /^sealed\((.*)\)$/s.exec(text);
      if (!match) throw new Error("not sealed by this store");
      if (failOn.includes(match[1])) throw new Error("decrypt failed");
      return match[1];
    },
  };
}

test("seals a plaintext value, and the plaintext is gone from the output", () => {
  const ss = fakeSafeStorage();
  const result = sealEnv(ss, { API_KEY: "sk-live-secret" });

  assert.equal(result.ok, true);
  assert.ok(isSealed(result.env.API_KEY));
  assert.ok(
    !result.env.API_KEY.includes("sk-live-secret"),
    "the sealed value still contains the plaintext",
  );
});

test("round-trips a value through seal and unseal", () => {
  const ss = fakeSafeStorage();
  const sealed = sealEnv(ss, { API_KEY: "sk-live-secret", DATABASE_URL: "postgres://x" });
  assert.equal(sealed.ok, true);

  const opened = unsealEnv(ss, sealed.env);
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.env, { API_KEY: "sk-live-secret", DATABASE_URL: "postgres://x" });
});

test("sealing is idempotent — the renderer round-trip does not re-seal or grow the value", () => {
  const ss = fakeSafeStorage();
  const once = sealEnv(ss, { API_KEY: "sk-live-secret" });
  assert.equal(once.ok, true);

  // This is the toggle: the sealed list went to the renderer and came back.
  const twice = sealEnv(ss, once.env);
  assert.equal(twice.ok, true);
  assert.deepEqual(twice.env, once.env, "a second save changed the stored bytes");

  const thrice = sealEnv(ss, twice.env);
  assert.equal(thrice.ok, true);
  assert.equal(
    thrice.env.API_KEY.length,
    once.env.API_KEY.length,
    "the value grows on repeated saves — ciphertext of ciphertext",
  );
});

test("an already-sealed env never asks whether encryption is available — no prompt on a toggle", () => {
  const ss = fakeSafeStorage();
  const sealed = sealEnv(ss, { API_KEY: "sk-live-secret" });
  assert.equal(sealed.ok, true);

  const before = ss.calls.isEncryptionAvailable;
  sealEnv(ss, sealed.env);
  assert.equal(
    ss.calls.isEncryptionAvailable,
    before,
    "toggling a server asked the OS for the keyring and would raise a prompt",
  );
});

test("an empty env asks the OS nothing at all", () => {
  const ss = fakeSafeStorage();
  assert.deepEqual(sealEnv(ss, {}), { ok: true, env: {} });
  assert.deepEqual(unsealEnv(ss, {}), { ok: true, env: {} });
  assert.equal(ss.calls.isEncryptionAvailable, 0, "a user with no secrets was prompted");
});

test("a plaintext value from an older build or a hand edit is passed through, and prompts nobody", () => {
  const ss = fakeSafeStorage();
  const opened = unsealEnv(ss, { API_KEY: "typed-by-hand" });

  assert.equal(opened.ok, true);
  assert.deepEqual(opened.env, { API_KEY: "typed-by-hand" });
  assert.equal(ss.calls.isEncryptionAvailable, 0, "reading a plaintext file touched the keyring");
});

test("a mixed file — one sealed value, one plaintext — opens both", () => {
  const ss = fakeSafeStorage();
  const sealed = sealEnv(ss, { SEALED: "secret" });
  assert.equal(sealed.ok, true);

  const opened = unsealEnv(ss, { ...sealed.env, PLAIN: "added-by-hand" });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.env, { SEALED: "secret", PLAIN: "added-by-hand" });
});

test("a plaintext value that merely looks prefixed is treated as plaintext, not as broken ciphertext", () => {
  const ss = fakeSafeStorage();
  // A user is allowed to type this. It is not base64 after the prefix.
  const opened = unsealEnv(ss, { API_KEY: `${SEAL_PREFIX}not base64 at all!!` });

  assert.equal(opened.ok, true, "a hand-typed value was reported as unrecoverable");
  assert.deepEqual(opened.env, { API_KEY: `${SEAL_PREFIX}not base64 at all!!` });
});

test("sealing refuses rather than writing plaintext when the store is unavailable", () => {
  const ss = fakeSafeStorage({ available: false });
  const result = sealEnv(ss, { API_KEY: "sk-live-secret" });

  assert.deepEqual(result, { ok: false, reason: "store-unavailable" });
  assert.equal(ss.calls.encryptString, 0);
});

test("a locked store reports store-unavailable and NEVER attempts a decrypt", () => {
  // The single most important test here. A locked keyring throws on a value
  // that is perfectly intact; interpreting that as damage is what would tell a
  // user to delete working credentials.
  const ss = fakeSafeStorage();
  const sealed = sealEnv(ss, { API_KEY: "sk-live-secret" });
  assert.equal(sealed.ok, true);

  const locked = fakeSafeStorage({ available: false });
  const opened = unsealEnv(locked, sealed.env);

  assert.deepEqual(opened, { ok: false, reason: "store-unavailable" });
  assert.equal(
    locked.calls.decryptString,
    0,
    "attempted a decrypt with the store shut, which cannot distinguish locked from broken",
  );
});

test("needs-re-entry is reachable ONLY when encryption is available and the value still will not open", () => {
  const ss = fakeSafeStorage();
  const sealed = sealEnv(ss, { GOOD: "keep-me", BAD: "cannot-open" });
  assert.equal(sealed.ok, true);

  const available = fakeSafeStorage({ failOn: ["cannot-open"] });
  const opened = unsealEnv(available, sealed.env);

  assert.equal(opened.ok, false);
  assert.equal(opened.reason, "needs-re-entry");
  assert.deepEqual(opened.keys, ["BAD"], "named the wrong key, or failed to name it");

  // And the same input with the store merely shut is a different answer.
  const shut = fakeSafeStorage({ available: false });
  assert.equal(unsealEnv(shut, sealed.env).reason, "store-unavailable");
});

test("a value sealed by a different machine's key reports needs-re-entry, not silence", () => {
  const ss = fakeSafeStorage();
  const foreign = `${SEAL_PREFIX}${Buffer.from("sealed-by-someone-else", "utf8").toString("base64")}`;
  const opened = unsealEnv(ss, { API_KEY: foreign });

  assert.equal(opened.ok, false);
  assert.equal(opened.reason, "needs-re-entry");
  assert.deepEqual(opened.keys, ["API_KEY"]);
});

test("a mixed env — one value already sealed, one newly typed — does not re-seal the first", () => {
  // Found by mutation, not by design. sealEnv short-circuits when EVERY value
  // is already sealed, so the whole-env idempotence test above passes without
  // ever exercising the per-value guard. The realistic case that does exercise
  // it is a user adding a second key to a server that already has one: the
  // existing value is sealed, the new one is not, and the loop has to tell them
  // apart. Dropping the per-value guard corrupts the existing key here while
  // every other test stays green.
  const ss = fakeSafeStorage();
  const first = sealEnv(ss, { API_KEY: "sk-live-secret" });
  assert.equal(first.ok, true);

  const second = sealEnv(ss, { API_KEY: first.env.API_KEY, DATABASE_URL: "postgres://x" });
  assert.equal(second.ok, true);
  assert.equal(
    second.env.API_KEY,
    first.env.API_KEY,
    "an already-sealed value was sealed a second time when a new key was added beside it",
  );

  const opened = unsealEnv(ss, second.env);
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.env, { API_KEY: "sk-live-secret", DATABASE_URL: "postgres://x" });
});
