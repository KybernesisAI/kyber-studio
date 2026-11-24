import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The shared sealed-value test (KYB-695).
 *
 * `looksSealed` moved from `src/main/mcpSecrets.ts` to `src/shared/sealed.ts`
 * so the renderer can make the same decision the main process makes: whether a
 * server has a sealed value on disk. The old one used `Buffer`, which the
 * renderer does not have, and the DOM tests run in Node where `Buffer` does
 * exist, so they cannot show the renderer avoids it. These can:
 *
 *  - the shared function runs with `globalThis.Buffer` removed, and the old
 *    one, run the same way, cannot (so the removal is real);
 *  - over a fixed set of inputs and a seeded random set, the shared function
 *    gives exactly the old one's answers;
 *  - `mcpSecrets.ts` hands out the shared function itself, not a copy.
 */

const { SEAL_PREFIX, isSealed, looksSealed } = await import("../src/shared/sealed.ts");
const secrets = await import("../src/main/mcpSecrets.ts");

/** `looksSealed` exactly as `src/main/mcpSecrets.ts` had it before KYB-695. */
function bufferLooksSealed(value) {
  if (!value.startsWith("kyb:v1:")) return false;
  const payload = value.slice("kyb:v1:".length);
  if (payload.length === 0) return false;
  const decoded = Buffer.from(payload, "base64");
  return decoded.length > 0 && decoded.toString("base64") === payload;
}

const seal = (plain) => `kyb:v1:${Buffer.from(plain, "utf8").toString("base64")}`;

/** Inputs named for what they test. */
const NAMED = {
  "a valid seal": seal("ENC(sk-live-1)"),
  "a valid seal, one padding character": seal("ab"),
  "a valid seal, two padding characters": seal("a"),
  "a valid seal, no padding": seal("abc"),
  "an empty payload": "kyb:v1:",
  "a non-base64 payload with a space": "kyb:v1:my key",
  "a payload with a character outside the alphabet": "kyb:v1:abc!",
  "padding missing": "kyb:v1:YWI",
  "too much padding": "kyb:v1:YWI==",
  "padding alone": "kyb:v1:====",
  "one padding character alone": "kyb:v1:=",
  "padding in the middle": "kyb:v1:YQ==YQ==",
  "non-zero trailing bits": "kyb:v1:YR==",
  "URL-safe alphabet": "kyb:v1:-_-_",
  "standard alphabet with + and /": "kyb:v1:+/+/",
  "whitespace inside": "kyb:v1:YW Jj",
  "a newline at the end": "kyb:v1:YWJj\n",
  "a single character payload": "kyb:v1:Y",
  "a non-Latin-1 payload": "kyb:v1:YWJj€",
  "plain text": "sk-live-1",
  "the prefix in capitals": "KYB:V1:YWJj",
  "an older prefix": "kyb:v0:YWJj",
  "empty string": "",
};

/** A small seeded generator, so a failure names an input that comes back. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomInputs(count) {
  const next = seeded(695);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=-_ \n!é";
  const inputs = [];
  for (let i = 0; i < count; i += 1) {
    const kind = next();
    if (kind < 0.4) {
      // A real seal of random bytes: the common case on disk.
      const bytes = Buffer.alloc(Math.floor(next() * 40) + 1);
      for (let j = 0; j < bytes.length; j += 1) bytes[j] = Math.floor(next() * 256);
      inputs.push(`kyb:v1:${bytes.toString("base64")}`);
    } else {
      // Anything at all after the prefix, which is what a person might type.
      let payload = "";
      const length = Math.floor(next() * 14);
      for (let j = 0; j < length; j += 1) payload += alphabet[Math.floor(next() * alphabet.length)];
      inputs.push(next() < 0.9 ? `kyb:v1:${payload}` : payload);
    }
  }
  return inputs;
}

/** Run `fn` with `globalThis.Buffer` gone, and put it back whatever happens. */
function withoutBuffer(fn) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  delete globalThis.Buffer;
  try {
    return fn();
  } finally {
    Object.defineProperty(globalThis, "Buffer", descriptor);
  }
}

test("AC1 (looksSealed): the shared looksSealed runs with globalThis.Buffer removed, and the old one cannot", () => {
  const inputs = Object.values(NAMED);
  const expected = inputs.map(bufferLooksSealed);

  const got = withoutBuffer(() => {
    assert.equal(typeof globalThis.Buffer, "undefined", "precondition: Buffer was not removed");
    assert.throws(() => bufferLooksSealed(NAMED["a valid seal"]), ReferenceError, "the removal is not real: the Buffer version still ran");
    return inputs.map((value) => looksSealed(value));
  });

  assert.deepEqual(got, expected);
});

test("AC1 (looksSealed): the shared looksSealed gives the Buffer version's answer for every named input", () => {
  for (const [what, value] of Object.entries(NAMED)) {
    assert.equal(looksSealed(value), bufferLooksSealed(value), `${what}: ${JSON.stringify(value)}`);
  }
  // And the answers are the ones the ticket's cases need, not merely equal.
  assert.equal(looksSealed(NAMED["a valid seal"]), true);
  assert.equal(looksSealed(NAMED["an empty payload"]), false);
  assert.equal(looksSealed(NAMED["a non-base64 payload with a space"]), false);
  assert.equal(looksSealed(NAMED["plain text"]), false);
});

test("AC1 (looksSealed): the shared looksSealed gives the Buffer version's answer for 5000 seeded inputs", () => {
  const inputs = randomInputs(5000);
  const sealedCount = inputs.filter(bufferLooksSealed).length;
  assert.ok(sealedCount > 1000 && sealedCount < 4000, `precondition: the set is lopsided (${sealedCount} sealed)`);
  for (const value of inputs) {
    assert.equal(looksSealed(value), bufferLooksSealed(value), JSON.stringify(value));
  }
});

test("AC1 (looksSealed): mcpSecrets hands out the shared functions, so the main process has one looksSealed", () => {
  assert.equal(secrets.looksSealed, looksSealed);
  assert.equal(secrets.isSealed, isSealed);
  assert.equal(secrets.SEAL_PREFIX, SEAL_PREFIX);
  assert.equal(SEAL_PREFIX, "kyb:v1:");
});
