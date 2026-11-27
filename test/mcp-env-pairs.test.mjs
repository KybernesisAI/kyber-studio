import { test } from "node:test";
import assert from "node:assert/strict";
import { contextBridgeCopy } from "./helpers/context-bridge.mjs";
import { MALFORMED_ENVS } from "./helpers/mcp-wire.mjs";
import {
  decodeEnv,
  decodeHeldKeys,
  encodeEnv,
  encodeHeldKeys,
  replyFromWire,
  replyToWire,
  serversFromWire,
  serversToWire,
} from "../src/shared/envPairs.ts";

/**
 * `env` and `heldKeys` cross the context bridge as pairs (KYB-700), and the
 * fake bridge copies as the real one was measured to. This file holds the two
 * pieces on their own: the copy the DOM tests' fake makes, against the
 * measurements in the ticket, and the codec both sides use.
 *
 *  - AC1: the copy drops an own `__proto__` from every object, nested ones
 *    included, whatever its value, re-parents to `Object.prototype`, touches
 *    no other key, and leaves arrays as arrays, so pairs cross intact.
 *  - AC2, AC3: decoding keeps `__proto__` as an own property with its value.
 *  - AC4: for anything else, encoding then decoding gives back the same keys,
 *    values and order, as an ordinary object with `Object.prototype`.
 *  - AC5: decoding refuses anything but a list of `[string, string]` pairs
 *    with no key twice, and says so without naming a key or a value.
 *  - AC7: `heldKeys` decodes a server id of `__proto__` as an own entry.
 *
 * The handler and the panel are `mcp-env-pairs-main`, `-held` and `-dom`.
 */

/** An object with an own enumerable `__proto__` set to `value`, built three ways the probe sent it. */
const withProto = {
  "Object.create(null), key assigned": (value) => {
    const map = Object.create(null);
    map.__proto__ = value;
    map.NORMAL = "ok";
    return map;
  },
  "JSON.parse": (value) => JSON.parse(`{"__proto__":${JSON.stringify(value)},"NORMAL":"ok"}`),
  "Object.defineProperty, enumerable": (value) => {
    const map = {};
    Object.defineProperty(map, "__proto__", { value, enumerable: true, writable: true, configurable: true });
    map.NORMAL = "ok";
    return map;
  },
};

/** The value under `__proto__` if it is an own property, read without the accessor. */
const ownProto = (object) => Object.getOwnPropertyDescriptor(object, "__proto__")?.value;

// ---- AC1: the copy ----------------------------------------------------------

for (const [shape, build] of Object.entries(withProto)) {
  test(`AC1 copy (${shape}): an env nested in a server record arrives with no own __proto__, NORMAL kept, and Object.prototype`, () => {
    const sent = { id: "s", env: build("x") };
    assert.equal(Object.hasOwn(sent.env, "__proto__"), true, "precondition: the fixture has no own __proto__");
    const arrived = contextBridgeCopy(sent);
    assert.deepEqual(Reflect.ownKeys(arrived.env), ["NORMAL"]);
    assert.equal(Object.getPrototypeOf(arrived.env), Object.prototype);
    assert.equal(Object.getPrototypeOf(arrived), Object.prototype);
    assert.equal(arrived.env.NORMAL, "ok");
  });
}

for (const [label, value] of [
  ["a string", "x"],
  ["an object", { polluted: true }],
  ["null", null],
  ["a number", 42],
]) {
  test(`AC1 copy: __proto__ set to ${label} is dropped, nothing is re-parented, and nothing is polluted`, () => {
    const arrived = contextBridgeCopy({ env: withProto["JSON.parse"](value) });
    assert.deepEqual(Reflect.ownKeys(arrived.env), ["NORMAL"]);
    assert.equal(Object.getPrototypeOf(arrived.env), Object.prototype);
    assert.equal({}.polluted, undefined);
  });
}

test("AC1 copy: of seven own keys only __proto__ is dropped, and the rest keep their order", () => {
  const keys = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf", "NORMAL"];
  const sent = Object.create(null);
  for (const key of keys) sent[key] = `v-${key}`;
  const arrived = contextBridgeCopy(sent);
  assert.deepEqual(Object.keys(arrived), keys.slice(1));
  for (const key of keys.slice(1)) assert.equal(Object.getOwnPropertyDescriptor(arrived, key)?.value, `v-${key}`);
});

test("AC1 copy: pairs cross unchanged, as arrays", () => {
  const pairs = [["__proto__", "x"], ["constructor", "c"], ["NORMAL", "ok"], ["WITH SPACE", " v "]];
  const arrived = contextBridgeCopy({ env: pairs });
  assert.equal(Array.isArray(arrived.env), true);
  assert.equal(arrived.env.every((pair) => Array.isArray(pair)), true);
  assert.deepEqual(arrived.env, pairs);
});

test("AC1 copy: structuredClone is not this copy, because it keeps an own __proto__", () => {
  // Why the fake bridge stopped using it: KYB-699's renderer tests passed on a
  // structuredClone while the app lost the key.
  assert.equal(ownProto(structuredClone(withProto["JSON.parse"]("x"))), "x");
  assert.equal(ownProto(contextBridgeCopy(withProto["JSON.parse"]("x"))), undefined);
});

// ---- AC2, AC3: __proto__ survives the codec ---------------------------------

test("AC2, AC3: a map holding __proto__, encoded, copied and decoded, holds it as an own property with its value", () => {
  for (const [shape, build] of Object.entries(withProto)) {
    const decoded = decodeEnv(contextBridgeCopy(encodeEnv(build("x"))));
    assert.equal(Object.hasOwn(decoded, "__proto__"), true, `${shape}: no own __proto__ after decoding`);
    assert.equal(ownProto(decoded), "x", shape);
    assert.equal(decoded.NORMAL, "ok", shape);
    assert.deepEqual(Object.keys(decoded), ["__proto__", "NORMAL"], shape);
  }
});

test("AC2, AC3: a decoded map with __proto__ is an ordinary object, not re-parented by it", () => {
  const decoded = decodeEnv([["__proto__", "x"]]);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.equal(typeof decoded.hasOwnProperty, "function");
});

// ---- AC4: nothing else changes ----------------------------------------------

/** An env with no `__proto__`, in an order sorting would change. */
const ordinaryEnv = () => ({ Z_LAST: "1", A_FIRST: "2", constructor: "c", M_MIDDLE: " spaced ", EMPTY: "" });

test("AC4: encoding keeps the map's own order, and does not sort", () => {
  assert.deepEqual(encodeEnv(ordinaryEnv()), Object.entries(ordinaryEnv()));
  assert.deepEqual(
    encodeEnv(ordinaryEnv()).map(([key]) => key),
    ["Z_LAST", "A_FIRST", "constructor", "M_MIDDLE", "EMPTY"],
  );
});

test("AC4: an env without __proto__, encoded, copied and decoded, has the same keys, values and order, and Object.prototype", () => {
  for (const env of [ordinaryEnv(), Object.assign(Object.create(null), ordinaryEnv())]) {
    const decoded = decodeEnv(contextBridgeCopy(encodeEnv(env)));
    assert.deepEqual(Object.entries(decoded), Object.entries(ordinaryEnv()));
    assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  }
});

test("AC4: a server crosses with env as pairs in env's own place, and comes back as it was", () => {
  const server = { id: "a", name: "A", command: "npx", args: ["-y", "x"], env: ordinaryEnv(), cwd: "/w", enabled: true };
  const [wire] = serversToWire([server]);
  assert.deepEqual(Object.keys(wire), Object.keys(server));
  assert.deepEqual(wire.env, Object.entries(ordinaryEnv()));
  const [back] = serversFromWire(contextBridgeCopy([wire]));
  assert.deepEqual(Object.keys(back), Object.keys(server));
  assert.deepEqual(back, server);
  assert.equal(Object.getPrototypeOf(back.env), Object.prototype);
});

test("AC4: a server with no env crosses with none, both ways", () => {
  const server = { id: "a", name: "A", command: "npx", args: [], enabled: true };
  const [wire] = serversToWire([server]);
  assert.equal(Object.hasOwn(wire, "env"), false);
  const [back] = serversFromWire([wire]);
  assert.equal(Object.hasOwn(back, "env"), false);
  assert.deepEqual(back, server);
});

test("AC4: heldKeys, encoded, copied and decoded, keeps its entries, their order and Object.prototype", () => {
  const held = { b: ["Y_KEY", "X_KEY"], a: ["K"] };
  const decoded = decodeHeldKeys(contextBridgeCopy(encodeHeldKeys(held)));
  assert.deepEqual(Object.entries(decoded), Object.entries(held));
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
});

test("AC4: a reply crosses and decodes to the result it was built from", () => {
  const result = { ok: true, servers: [{ id: "a", name: "A", command: "c", args: [], env: ordinaryEnv(), enabled: true }], heldKeys: { a: ["K"] } };
  assert.deepEqual(replyFromWire(contextBridgeCopy(replyToWire(result))), result);
  const unreadable = { ok: false, code: "MCP_CONFIG_UNREADABLE", path: "/p" };
  assert.deepEqual(replyToWire(unreadable), unreadable);
  assert.deepEqual(replyFromWire(unreadable), unreadable);
  assert.equal(replyFromWire(undefined), undefined);
});

// ---- AC5: malformed input is refused ----------------------------------------


for (const [label, env] of Object.entries(MALFORMED_ENVS)) {
  test(`AC5: decoding refuses an env that is ${label}, naming no key or value`, () => {
    assert.throws(() => decodeEnv(env), (error) => {
      assert.ok(error instanceof TypeError, `not a TypeError: ${error}`);
      assert.equal(/KYB_A|SECRET|OTHER/.test(error.message), false, `the error names a key or value: ${error.message}`);
      return true;
    });
  });
}

test("AC5: decoding refuses the same server id twice in heldKeys, and a key list that is not strings", () => {
  assert.throws(() => decodeHeldKeys([["a", ["K"]], ["a", ["L"]]]), TypeError);
  assert.throws(() => decodeHeldKeys([["a", "K"]]), TypeError);
  assert.throws(() => decodeHeldKeys([["a", ["K", 1]]]), TypeError);
  assert.throws(() => decodeHeldKeys({ a: ["K"] }), TypeError);
});

test("AC5: serversFromWire refuses a list that is not an array, and an entry that is not an object", () => {
  for (const servers of [{}, "s", null, undefined, 3]) assert.throws(() => serversFromWire(servers), TypeError);
  for (const entry of [null, "s", 3, []]) assert.throws(() => serversFromWire([entry]), TypeError);
});

// ---- AC7: a server id of __proto__ in heldKeys ------------------------------

test("AC7: heldKeys with a server id of __proto__, encoded, copied and decoded, holds it as an own entry", () => {
  const held = JSON.parse('{"__proto__":["KYB_H"],"b":["X"]}');
  const decoded = decodeHeldKeys(contextBridgeCopy(encodeHeldKeys(held)));
  assert.equal(Object.hasOwn(decoded, "__proto__"), true, "no own entry for __proto__");
  assert.deepEqual(ownProto(decoded), ["KYB_H"]);
  assert.equal(Object.getPrototypeOf(decoded), Object.prototype);
  assert.deepEqual(decoded.b, ["X"]);
});
