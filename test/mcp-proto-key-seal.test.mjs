import { test } from "node:test";
import assert from "node:assert/strict";
import { SEAL_PREFIX, sealEnv, unsealEnv } from "../src/main/mcpSecrets.ts";

/**
 * A key named `__proto__` survives `sealEnv` and `unsealEnv` (KYB-699, AC8).
 *
 * Each function has two paths. The early return builds its map with
 * `Object.fromEntries`, which defines `__proto__` as an own key. The loop
 * assigned into `{}`, where `map["__proto__"] = value` calls the prototype
 * setter, which ignores a string, so the key was dropped.
 *
 *  - `sealEnv` returns early when every value is sealed or empty, and loops
 *    when there is a value to seal.
 *  - `unsealEnv` returns early when no value is sealed, and loops when one is.
 *
 * Each fixture is built with `JSON.parse`, so `__proto__` is an own property.
 * A literal `{ __proto__: "" }` sets the prototype and has no such key, so a
 * check on it passes whatever the code does. Each test also pins which path
 * it took, from the calls the store saw.
 */

/** A safeStorage that seals to `ENC(<value>)`, and counts the calls it gets. */
function fakeStore() {
  const calls = { isEncryptionAvailable: 0, encryptString: 0, decryptString: 0 };
  return {
    calls,
    isEncryptionAvailable() {
      calls.isEncryptionAvailable += 1;
      return true;
    },
    getSelectedStorageBackend() {
      return "gnome_libsecret";
    },
    encryptString(plain) {
      calls.encryptString += 1;
      return Buffer.from(`ENC(${plain})`, "utf8");
    },
    decryptString(buf) {
      calls.decryptString += 1;
      const match = /^ENC\((.*)\)$/s.exec(buf.toString("utf8"));
      if (!match) throw new Error("not sealed by this store");
      return match[1];
    },
  };
}

/** What `fakeStore` stores for `plain`. */
const sealedAs = (plain) => SEAL_PREFIX + Buffer.from(`ENC(${plain})`, "utf8").toString("base64");

/** An env with `__proto__` as an own key holding `proto`, then `rest`, built with JSON.parse. */
function withProto(proto, rest = {}) {
  const env = JSON.parse(`{"__proto__":${JSON.stringify(proto)}${Object.keys(rest).length ? "," : ""}${JSON.stringify(rest).slice(1)}`);
  assert.equal(Object.hasOwn(env, "__proto__"), true, "precondition: the fixture has no own __proto__");
  assert.equal(Object.getPrototypeOf(env), Object.prototype, "precondition: the fixture's prototype was replaced");
  return env;
}

/** The result's own `__proto__`, asserted present. */
function ownProto(result) {
  assert.equal(result.ok, true, `the call failed: ${JSON.stringify(result)}`);
  assert.equal(Object.hasOwn(result.env, "__proto__"), true, "__proto__ was dropped");
  return Object.getOwnPropertyDescriptor(result.env, "__proto__").value;
}

// ---- sealEnv -----------------------------------------------------------------

test("AC8 (sealEnv, early return): a sealed __proto__ is kept", () => {
  const ss = fakeStore();
  const result = sealEnv(ss, withProto(sealedAs("p")));
  assert.equal(ss.calls.isEncryptionAvailable, 0, "precondition: this was not the early return");
  assert.equal(ownProto(result), sealedAs("p"));
});

test("AC8 (sealEnv, early return): an empty __proto__ is kept", () => {
  const ss = fakeStore();
  const result = sealEnv(ss, withProto("", { X: sealedAs("x") }));
  assert.equal(ss.calls.isEncryptionAvailable, 0, "precondition: this was not the early return");
  assert.equal(ownProto(result), "");
  assert.equal(result.env.X, sealedAs("x"));
});

test("AC8 (sealEnv, loop): a __proto__ holding the value to seal is kept, sealed", () => {
  const ss = fakeStore();
  const result = sealEnv(ss, withProto("p"));
  assert.equal(ss.calls.encryptString, 1, "precondition: this was not the loop");
  assert.equal(ownProto(result), sealedAs("p"));
});

test("AC8 (sealEnv, loop): an empty __proto__ beside a value to seal is kept", () => {
  const ss = fakeStore();
  const result = sealEnv(ss, withProto("", { X: "x" }));
  assert.equal(ss.calls.encryptString, 1, "precondition: this was not the loop");
  assert.equal(ownProto(result), "");
  assert.equal(result.env.X, sealedAs("x"));
});

// ---- unsealEnv ---------------------------------------------------------------

test("AC8 (unsealEnv, early return): a plain __proto__ is kept", () => {
  const ss = fakeStore();
  const result = unsealEnv(ss, withProto("p", { X: "x" }));
  assert.equal(ss.calls.isEncryptionAvailable, 0, "precondition: this was not the early return");
  assert.equal(ownProto(result), "p");
  assert.equal(result.env.X, "x");
});

test("AC8 (unsealEnv, loop): a plain __proto__ beside a sealed value is kept", () => {
  const ss = fakeStore();
  const result = unsealEnv(ss, withProto("p", { X: sealedAs("x") }));
  assert.equal(ss.calls.decryptString, 1, "precondition: this was not the loop");
  assert.equal(ownProto(result), "p");
  assert.equal(result.env.X, "x");
});

test("AC8 (unsealEnv, loop): a sealed __proto__ on its own is opened and kept", () => {
  const ss = fakeStore();
  const result = unsealEnv(ss, withProto(sealedAs("p")));
  assert.equal(ss.calls.decryptString, 1, "precondition: this was not the loop");
  assert.equal(ownProto(result), "p");
});
