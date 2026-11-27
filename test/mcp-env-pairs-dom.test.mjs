import { test } from "node:test";
import assert from "node:assert/strict";
import { serversToWire } from "../src/shared/envPairs.ts";
import { initialMcpPanelState, loadMcpPanel, saveMcpPanel } from "../src/renderer/src/lib/mcpPanel.ts";
import { bridge, envInput, form, local, menu, mount, row, text } from "./helpers/mcp-form-dom.mjs";

/**
 * The renderer's half of KYB-700, through the fake bridge in
 * `helpers/mcp-form-dom.mjs`, which now copies as Electron's context bridge was
 * measured to: an own `__proto__` dropped from every object, whatever its
 * value, on what is sent and on both replies.
 *
 *  - AC1: the fake copies like the context bridge on all three crossings.
 *    With the encoding taken out of its main-process side (`pairs: false`),
 *    a map's `__proto__` is gone from the save it records, from the
 *    `mcpServers` answer and from the save's reply.
 *  - AC3: a stored `__proto__` reaches the edit form after a load, and after
 *    a save's reply.
 *  - AC4: an env without `__proto__`, and `heldKeys` for ordinary ids, reach
 *    the panel and the main process with the same keys, values, order and
 *    prototype they had before pairs.
 *  - AC7: the panel holds the held key names of a server whose id is
 *    `__proto__` as an own entry, and its row names them.
 *
 * AC2 on this side is KYB-699's two AC8 tests in `mcp-box-quotes-dom`, which
 * read what the fake decoded on the main process's side, and now pass only
 * because the env crossed as pairs. The handler's half is
 * `mcp-env-pairs-main` and `-held`.
 */

/** The store available, as the main process answers it (KYB-696). */
const AVAILABLE = () => ({ available: true, description: "", remedy: "" });

/** An env with an own `__proto__` holding `value`. A literal `{ __proto__: ... }` sets the prototype instead. */
const envWithProto = (value, rest = { KYB_N: "ok" }) =>
  JSON.parse(JSON.stringify(rest).replace("{", `{"__proto__":${JSON.stringify(value)},`));

/** The value under `__proto__` if it is an own property, read without the accessor. */
const ownProto = (object) => Object.getOwnPropertyDescriptor(object, "__proto__")?.value;

/** A panel state driven by `loadMcpPanel` and `saveMcpPanel`, as `Plugins.tsx` drives it. */
function panelState() {
  let state = initialMcpPanelState;
  return {
    apply: (fold) => {
      state = fold(state);
    },
    get: () => state,
  };
}

// ---- AC1 ---------------------------------------------------------------------

test("AC1: with the encoding removed, the env the fake records for a save has no own __proto__", async () => {
  const b = bridge({ pairs: false });
  const env = Object.create(null);
  env.__proto__ = "x";
  env.KYB_N = "ok";
  await b.api.saveMcpServers([local({ env })]);
  for (const [what, recorded, prototype] of [
    ["what crossed", b.received().at(-1)[0].env, Object.getPrototypeOf(b.received().at(-1)[0].env)],
    ["what was saved", b.lastSaved()[0].env, b.lastSavedEnvPrototypes()[0]],
  ]) {
    assert.equal(Object.hasOwn(recorded, "__proto__"), false, `${what} kept an own __proto__`);
    assert.equal(prototype, Object.prototype, `${what} was not re-parented`);
    assert.equal(recorded.KYB_N, "ok", what);
  }
});

test("AC1: with the encoding removed, the env in the mcpServers answer has no own __proto__", async () => {
  const b = bridge({ pairs: false, servers: [local({ env: envWithProto("x") })] });
  const answer = await b.api.mcpServers();
  const env = answer.servers[0].env;
  assert.equal(Object.hasOwn(env, "__proto__"), false, "the answer kept an own __proto__");
  assert.equal(Object.getPrototypeOf(env), Object.prototype);
  assert.equal(env.KYB_N, "ok");
});

test("AC1: with the encoding removed, the env in a save's reply has no own __proto__", async () => {
  // The main process answers a save with what it then holds, which with the
  // store shut is the stored env written back, `__proto__` and all.
  const b = bridge({ pairs: false, onSave: (next) => next.map((s) => ({ ...s, env: envWithProto("x") })) });
  const reply = await b.api.saveMcpServers([local({ env: { KYB_N: "ok" } })]);
  const env = reply.servers[0].env;
  assert.equal(Object.hasOwn(env, "__proto__"), false, "the reply kept an own __proto__");
  assert.equal(Object.getPrototypeOf(env), Object.prototype);
  assert.equal(env.KYB_N, "ok");
});

test("AC1: as pairs, __proto__ crosses all three ways through the same fake", async () => {
  const b = bridge({ servers: [local({ env: envWithProto("stored") })] });
  const answer = await b.api.mcpServers();
  assert.deepEqual(answer.servers[0].env, [["__proto__", "stored"], ["KYB_N", "ok"]]);

  const reply = await b.api.saveMcpServers(serversToWire([local({ env: envWithProto("x") })]));
  assert.equal(ownProto(b.lastSaved()[0].env), "x", "the save lost __proto__ as pairs");
  assert.deepEqual(reply.servers[0].env, [["__proto__", "x"], ["KYB_N", "ok"]]);
});

// ---- AC3 ---------------------------------------------------------------------

test("AC3: a stored __proto__ is a row in the edit form after a load", async () => {
  const b = bridge({ answer: AVAILABLE, servers: [local({ env: envWithProto("stored-proto") })] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kyb", "Edit");
    assert.ok(form(panel.host), "Edit opened no form");
    assert.ok(envInput(panel.host, "__proto__"), "the edit form shows no row for the stored __proto__");
    assert.ok(envInput(panel.host, "KYB_N"), "the edit form shows no row for KYB_N");
  } finally {
    await panel.unmount();
  }
});

test("AC3: a stored __proto__ is a row in the edit form after a save's reply", async () => {
  // Loaded without it, answered with it, so only the reply can put it there.
  // This is a Turn off with the store shut: the main process writes the
  // stored env back, a hand-edited `__proto__` included, and answers with it.
  const b = bridge({
    answer: AVAILABLE,
    servers: [local({ env: { KYB_N: "ok" } })],
    onSave: (next) => next.map((s) => ({ ...s, env: envWithProto("stored-proto") })),
  });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kyb", "Turn off");
    assert.equal(b.lastSaved()?.[0]?.enabled, false, "precondition: Turn off did not save");
    await menu(panel.host, "MCP kyb", "Edit");
    assert.ok(form(panel.host), "Edit opened no form");
    assert.ok(envInput(panel.host, "__proto__"), "the edit form shows no row for __proto__ after the save's reply");
  } finally {
    await panel.unmount();
  }
});

test("AC3: the panel holds a stored __proto__ as an own property with its value, after a load and after a save", async () => {
  const b = bridge({ servers: [local({ env: envWithProto("stored-proto") })] });
  const panel = panelState();
  await loadMcpPanel(b.api, panel.apply);
  assert.equal(panel.get().loadError, null, `the load failed: ${panel.get().loadError}`);
  assert.equal(ownProto(panel.get().servers[0].env), "stored-proto", "the load lost __proto__");

  await saveMcpPanel(b.api, panel.apply, panel.get().servers);
  assert.equal(panel.get().saveError, null, `the save failed: ${panel.get().saveError}`);
  assert.equal(ownProto(b.lastSaved()[0].env), "stored-proto", "the save sent back without __proto__");
  assert.equal(ownProto(panel.get().servers[0].env), "stored-proto", "the save's reply lost __proto__");
});

// ---- AC4 ---------------------------------------------------------------------

/** An env with no `__proto__`, in an order sorting would change, as stored. */
const ordinaryEnv = () => ({ Z_LAST: "1", A_FIRST: "2", constructor: "c", M_MIDDLE: " spaced " });
const ORDINARY_ENTRIES = Object.entries(ordinaryEnv());

test("AC4: the env the panel receives from a load has the stored keys, values and order, and Object.prototype", async () => {
  const b = bridge({ servers: [local({ env: ordinaryEnv() }), local({ id: "bare", name: "Bare" })] });
  const panel = panelState();
  await loadMcpPanel(b.api, panel.apply);
  const [kyb, bare] = panel.get().servers;
  assert.deepEqual(Object.entries(kyb.env), ORDINARY_ENTRIES);
  assert.equal(Object.getPrototypeOf(kyb.env), Object.prototype);
  assert.deepEqual(Object.keys(kyb), Object.keys(local({ env: {} })), "a server's fields moved");
  assert.equal(Object.hasOwn(bare, "env"), false, "a server stored with no env arrived with one");
});

test("AC4: what the main process receives from a save, and the env in its reply, keep keys, values, order and Object.prototype", async () => {
  const b = bridge();
  const panel = panelState();
  // Built as Save builds it: a map with no prototype, filled in form order.
  const sent = Object.assign(Object.create(null), ordinaryEnv());
  await saveMcpPanel(b.api, panel.apply, [local({ env: sent })]);
  assert.equal(panel.get().saveError, null, `the save failed: ${panel.get().saveError}`);

  const received = b.lastSaved()[0];
  assert.deepEqual(Object.entries(received.env), ORDINARY_ENTRIES, "the main process received another env");
  assert.equal(b.lastSavedEnvPrototypes()[0], Object.prototype, "the main process received another prototype");
  assert.deepEqual(Object.keys(received), Object.keys(local({ env: {} })), "a server's fields moved");

  const replied = panel.get().servers[0].env;
  assert.deepEqual(Object.entries(replied), ORDINARY_ENTRIES, "the reply carried another env");
  assert.equal(Object.getPrototypeOf(replied), Object.prototype);
});

test("AC4: the heldKeys the panel holds for ordinary ids keep their entries, order and Object.prototype", async () => {
  const heldKeys = { kyb: ["B_KEY", "A_KEY"], other: ["X"] };
  const b = bridge({ servers: [local(), local({ id: "other", name: "Other" })], heldKeys });
  const panel = panelState();
  await loadMcpPanel(b.api, panel.apply);
  assert.deepEqual(Object.entries(panel.get().heldKeys), Object.entries(heldKeys));
  assert.equal(Object.getPrototypeOf(panel.get().heldKeys), Object.prototype);

  await saveMcpPanel(b.api, panel.apply, panel.get().servers);
  assert.deepEqual(Object.entries(panel.get().heldKeys), Object.entries(heldKeys), "the save's reply changed heldKeys");
  assert.equal(Object.getPrototypeOf(panel.get().heldKeys), Object.prototype);
});

// ---- AC7 ---------------------------------------------------------------------

test("AC7: the panel holds the held key names of a server whose id is __proto__ as an own entry, after a load and a save", async () => {
  const heldKeys = JSON.parse('{"__proto__":["KYB_H"]}');
  const b = bridge({ servers: [local({ id: "__proto__", name: "Hand" })], heldKeys });
  const panel = panelState();
  await loadMcpPanel(b.api, panel.apply);
  assert.equal(panel.get().loadError, null, `the load failed: ${panel.get().loadError}`);
  assert.equal(Object.hasOwn(panel.get().heldKeys, "__proto__"), true, "no own entry after the load");
  assert.deepEqual(ownProto(panel.get().heldKeys), ["KYB_H"]);

  await saveMcpPanel(b.api, panel.apply, panel.get().servers);
  assert.equal(Object.hasOwn(panel.get().heldKeys, "__proto__"), true, "no own entry after the save's reply");
  assert.deepEqual(ownProto(panel.get().heldKeys), ["KYB_H"]);
});

test("AC7: the row of a server whose id is __proto__ names the keys held for it", async () => {
  const b = bridge({ servers: [local({ id: "__proto__", name: "Hand" })], heldKeys: JSON.parse('{"__proto__":["KYB_H"]}') });
  const panel = await mount(b.api);
  try {
    const hand = row(panel.host, "Hand");
    assert.ok(hand, "the server whose id is __proto__ has no row");
    assert.match(text(hand), /Kept until Studio restarts, not saved: KYB_H/);
  } finally {
    await panel.unmount();
  }
});

