import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mainProcess, pinPlatform } from "./helpers/mcp-main.mjs";
import { contextBridgeCopy } from "./helpers/context-bridge.mjs";
import { MALFORMED_ENVS } from "./helpers/mcp-wire.mjs";
import { serversToWire } from "../src/shared/envPairs.ts";

/**
 * The main process's half of KYB-700, with the credential store available,
 * joined to the renderer through the fake context bridge: the real
 * `studio:mcpServers` and `studio:saveMcpServers` handlers, with Electron
 * mocked, called with what `contextBridgeCopy` makes of what the renderer
 * sends, and answering through the same copy.
 *
 *  - AC2: the box line `__proto__=x`, typed in the real edit form, reaches
 *    `saveServers` as an own property `__proto__` with value `x`. Seen on
 *    disk: with the store available `saveServers` seals every value it is
 *    given into `local-mcp.json`, so the sealed `__proto__` there, opening to
 *    `x`, is the one it received.
 *  - AC3: a stored `__proto__` reaches the panel and the edit form from the
 *    `mcpServers` handler, and from the save handler's reply.
 *  - AC4: an env without `__proto__` reaches the panel and the file with the
 *    same keys, values and order, and the panel's map has `Object.prototype`.
 *  - AC5: the save handler refuses every malformed list, before reading or
 *    writing anything: it rejects, `local-mcp.json` keeps every byte, and the
 *    panel shows the existing could-not-save message.
 *
 * The store-shut half, and AC7, are `mcp-env-pairs-held`.
 */

pinPlatform("linux");
const main = await mainProcess({ backend: "gnome_libsecret", encryptionAvailable: true, seals: true });
const dom = await import("./helpers/mcp-form-dom.mjs");
const { initialMcpPanelState, loadMcpPanel, saveMcpPanel, SAVE_FAILED_MESSAGE } = await import(
  "../src/renderer/src/lib/mcpPanel.ts"
);

const sealedOf = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;
const opened = (value) => {
  assert.ok(typeof value === "string" && value.startsWith("kyb:v1:"), `not sealed: ${value}`);
  return /^ENC\((.*)\)$/s.exec(Buffer.from(value.slice(7), "base64").toString("utf8"))[1];
};

/** The value under `__proto__` if it is an own property, read without the accessor. */
const ownProto = (object) => Object.getOwnPropertyDescriptor(object, "__proto__")?.value;

/** An env with an own `__proto__` holding `value`. A literal `{ __proto__: ... }` sets the prototype instead. */
const envWithProto = (value, rest) =>
  JSON.parse(JSON.stringify(rest).replace("{", `{"__proto__":${JSON.stringify(value)},`));

const plaud = (over = {}) => ({
  id: "plaud",
  name: "Plaud",
  command: "npx",
  args: ["-y", "plaud-mcp"],
  env: { API_KEY: sealedOf("sk-live-1") },
  enabled: true,
  ...over,
});

const onDisk = () => JSON.parse(readFileSync(main.configPath, "utf8")).servers;

/**
 * The bridge as the page sees it: every argument and every reply copied as
 * the context bridge copies, into and out of the real handlers.
 */
function joinedApi() {
  const across = (channel, ...args) => contextBridgeCopy(main.rawInvoke(channel, ...args.map(contextBridgeCopy)));
  return {
    ...dom.bridge().api,
    credentialStoreAvailable: async () => across("studio:credentialStoreAvailable"),
    mcpServers: async () => across("studio:mcpServers"),
    saveMcpServers: async (servers, options) => across("studio:saveMcpServers", servers, options),
    revealMcpEnv: async (id, key) => across("studio:revealMcpEnv", id, key),
  };
}

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

// ---- AC2 ---------------------------------------------------------------------

test("AC2: the box line __proto__=x reaches saveServers as an own property __proto__ with value x", async () => {
  main.givenStored([plaud()]);
  const panel = await dom.mount(joinedApi());
  try {
    await dom.menu(panel.host, "Plaud", "Edit");
    assert.ok(dom.form(panel.host), "Edit opened no form");
    await dom.type(dom.envLines(panel.host), "__proto__=x\nKYB_N=ok");
    await dom.click(dom.buttonIn(dom.form(panel.host), "Save"));
    assert.equal(dom.form(panel.host), undefined, "the form did not close: the save did not go through");
  } finally {
    await panel.unmount();
  }
  const [written] = onDisk();
  assert.equal(Object.hasOwn(written.env, "__proto__"), true, "saveServers received no own __proto__");
  assert.equal(opened(ownProto(written.env)), "x");
  assert.equal(opened(written.env.KYB_N), "ok");
  assert.equal(written.env.API_KEY, sealedOf("sk-live-1"), "the stored value did not go back as it was");
});

// ---- AC3 ---------------------------------------------------------------------

test("AC3: a stored __proto__ reaches the panel from the mcpServers handler and from the save handler's reply", async () => {
  main.givenStored([plaud({ env: envWithProto(sealedOf("p"), { API_KEY: sealedOf("sk-live-1") }) })]);
  const api = joinedApi();
  const panel = panelState();
  await loadMcpPanel(api, panel.apply);
  assert.equal(panel.get().loadError, null, `the load failed: ${panel.get().loadError}`);
  assert.equal(ownProto(panel.get().servers[0].env), sealedOf("p"), "the load lost __proto__");

  await saveMcpPanel(api, panel.apply, panel.get().servers);
  assert.equal(panel.get().saveError, null, `the save failed: ${panel.get().saveError}`);
  assert.equal(ownProto(panel.get().servers[0].env), sealedOf("p"), "the save's reply lost __proto__");
  assert.equal(ownProto(onDisk()[0].env), sealedOf("p"), "the save took __proto__ off the disk");
});

test("AC3: a stored __proto__ is a row in the edit form, after a load and after a Turn off", async () => {
  main.givenStored([plaud({ env: envWithProto(sealedOf("p"), { API_KEY: sealedOf("sk-live-1") }) })]);
  const panel = await dom.mount(joinedApi());
  try {
    await dom.menu(panel.host, "Plaud", "Edit");
    assert.ok(dom.envInput(panel.host, "__proto__"), "after a load, the edit form shows no row for __proto__");
    await dom.click(dom.buttonIn(dom.form(panel.host), "Cancel"));
    assert.equal(dom.form(panel.host), undefined, "precondition: Cancel did not close the form");

    await dom.menu(panel.host, "Plaud", "Turn off");
    assert.equal(onDisk()[0].enabled, false, "precondition: Turn off did not save");
    await dom.menu(panel.host, "Plaud", "Edit");
    assert.ok(dom.envInput(panel.host, "__proto__"), "after a Turn off, the edit form shows no row for __proto__");
  } finally {
    await panel.unmount();
  }
  const raw = readFileSync(main.configPath, "utf8");
  assert.equal(raw.split('"__proto__"').length - 1, 1, "local-mcp.json does not hold exactly one __proto__ key");
});

// ---- AC4 ---------------------------------------------------------------------

/** An env with no `__proto__`, in an order sorting would change. */
const ORDINARY = [
  ["Z_LAST", "1"],
  ["A_FIRST", "2"],
  ["constructor", "c"],
  ["M_MIDDLE", " spaced "],
  ["EMPTY", ""],
];

test("AC4: an env without __proto__ reaches the panel from the handler with its keys, values and order, and Object.prototype", async () => {
  main.givenStored([plaud({ env: Object.fromEntries(ORDINARY) }), { ...plaud({ id: "bare", name: "Bare" }), env: undefined }]);
  const panel = panelState();
  await loadMcpPanel(joinedApi(), panel.apply);
  assert.equal(panel.get().loadError, null, `the load failed: ${panel.get().loadError}`);
  const [server, bare] = panel.get().servers;
  assert.deepEqual(Object.entries(server.env), ORDINARY);
  assert.equal(Object.getPrototypeOf(server.env), Object.prototype);
  assert.deepEqual(Object.keys(server), Object.keys(plaud()), "a server's fields moved");
  assert.equal(Object.hasOwn(bare, "env"), false, "a server stored with no env arrived with one");
});

test("AC4: an env without __proto__ reaches saveServers with its keys, values and order", async () => {
  main.givenStored([]);
  const panel = panelState();
  // Built as Save builds it: a map with no prototype, filled in form order.
  const env = Object.assign(Object.create(null), Object.fromEntries(ORDINARY));
  await saveMcpPanel(joinedApi(), panel.apply, [plaud({ env })]);
  assert.equal(panel.get().saveError, null, `the save failed: ${panel.get().saveError}`);
  const [written] = onDisk();
  assert.deepEqual(Object.keys(written), Object.keys(plaud()), "a server's fields moved on disk");
  assert.deepEqual(
    Object.entries(written.env).map(([key, value]) => [key, value === "" ? "" : opened(value)]),
    ORDINARY,
  );
  const replied = panel.get().servers[0].env;
  assert.deepEqual(Object.keys(replied), ORDINARY.map(([key]) => key), "the reply carried other keys");
  assert.equal(Object.getPrototypeOf(replied), Object.prototype);
});

// ---- AC5 ---------------------------------------------------------------------

/** One stored server, and its bytes, before a refused save. */
function storedBytes() {
  main.givenStored([plaud()]);
  return readFileSync(main.configPath);
}

const wirePlaud = (over = {}) => ({ ...serversToWire([plaud()])[0], ...over });

for (const [label, env] of Object.entries(MALFORMED_ENVS)) {
  test(`AC5: the save handler rejects an env that is ${label}, and local-mcp.json keeps every byte`, async () => {
    const before = storedBytes();
    await assert.rejects(async () => main.rawInvoke("studio:saveMcpServers", [wirePlaud({ env })]), TypeError);
    assert.deepEqual(readFileSync(main.configPath), before, "local-mcp.json changed");
  });
}

test("AC5: one malformed server refuses the whole save, even after a well-formed one", async () => {
  const before = storedBytes();
  const good = wirePlaud({ env: [["API_KEY", "changed"]] });
  const bad = wirePlaud({ id: "other", name: "Other", env: { KYB_A: "x" } });
  await assert.rejects(async () => main.rawInvoke("studio:saveMcpServers", [good, bad]), TypeError);
  assert.deepEqual(readFileSync(main.configPath), before, "local-mcp.json changed");
});

test("AC5: a list that is not an array, or an entry that is not a server, is refused and nothing is written", async () => {
  for (const servers of [{}, "servers", null, [null], ["plaud"]]) {
    const before = storedBytes();
    await assert.rejects(async () => main.rawInvoke("studio:saveMcpServers", servers), TypeError, JSON.stringify(servers));
    assert.deepEqual(readFileSync(main.configPath), before, `local-mcp.json changed for ${JSON.stringify(servers)}`);
  }
});

for (const [label, env] of Object.entries(MALFORMED_ENVS)) {
  test(`AC5: an env that is ${label} is refused before the config is read: a damaged config is neither answered for nor moved aside`, async () => {
    // Refused by the decoder, not by something later that happens to throw:
    // `saveServers` would read this config first and refuse it as unreadable,
    // or with `quarantine`, move it aside and write a new one.
    const damaged = '{"servers":[{"id":"s1"';
    writeFileSync(main.configPath, damaged, "utf8");
    for (const options of [undefined, { onUnreadableConfig: "quarantine" }]) {
      await assert.rejects(
        async () => main.rawInvoke("studio:saveMcpServers", [wirePlaud({ env })], options),
        (error) => error instanceof TypeError && /^servers\[0\]\.env/.test(error.message),
        `options ${JSON.stringify(options)}: not refused by the decoder`,
      );
      assert.equal(readFileSync(main.configPath, "utf8"), damaged, "the damaged file was touched");
    }
  });
}

test("AC5: a save the handler refuses reaches the panel as the could-not-save message", async (t) => {
  storedBytes();
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args.join(" ")));
  const panel = panelState();
  // A renderer that bypassed the codec: the old object shape.
  const api = { ...joinedApi(), saveMcpServers: async () => main.rawInvoke("studio:saveMcpServers", [wirePlaud({ env: { KYB_A: "x" } })]) };
  await saveMcpPanel(api, panel.apply, [plaud()]);
  assert.equal(panel.get().saveError, SAVE_FAILED_MESSAGE);
  assert.equal(logged.length, 1, "the refusal was not logged once");
});
