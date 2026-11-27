import { test } from "node:test";
import assert from "node:assert/strict";
import { mainProcess, pinPlatform } from "./helpers/mcp-main.mjs";
import { contextBridgeCopy } from "./helpers/context-bridge.mjs";

/**
 * KYB-700 with the credential store shut, where values typed in the form are
 * held in memory and only their names reach the panel, as `heldKeys`.
 *
 *  - AC7: the held key names of a server whose id is `__proto__` (only a
 *    hand-edited `local-mcp.json` can carry one) are an own entry in what
 *    `heldKeyNames()` returns, in the `heldKeys` the panel holds after the
 *    reply crosses the fake context bridge, and on the server's row.
 *  - AC4: for ordinary ids, `heldKeys` is what it was before pairs: the same
 *    entries in the same order, as an ordinary object, in main and in the
 *    panel.
 *
 * The real handlers, with Electron mocked, joined to the renderer through
 * `contextBridgeCopy` as in `mcp-env-pairs-main`.
 */

pinPlatform("linux");
const main = await mainProcess({ backend: "gnome_libsecret", encryptionAvailable: false });
const dom = await import("./helpers/mcp-form-dom.mjs");
const { initialMcpPanelState, loadMcpPanel, saveMcpPanel } = await import("../src/renderer/src/lib/mcpPanel.ts");

/** The value under `__proto__` if it is an own property, read without the accessor. */
const ownProto = (object) => Object.getOwnPropertyDescriptor(object, "__proto__")?.value;

const server = (over = {}) => ({ id: "kyb", name: "MCP kyb", command: "sh", args: ["-c", "exit 1"], enabled: true, ...over });
const hand = (over = {}) => server({ id: "__proto__", name: "Hand", ...over });

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

function panelState() {
  let state = initialMcpPanelState;
  return {
    apply: (fold) => {
      state = fold(state);
    },
    get: () => state,
  };
}

/**
 * `servers` stored with no env, then saved with `typed.get(id)` as each one's
 * env (a `Map`, so an id of `__proto__` is a key like any other), as
 * the form saves what is typed in its box: with the store shut, held in
 * memory. Logged warnings are swallowed.
 */
async function hold(servers, typed) {
  main.givenStored(servers);
  await main.warnings(() => main.invoke("studio:saveMcpServers", servers.map((s) => ({ ...s, env: typed.get(s.id) }))));
}

/** Nothing held is left for the next test. */
function release() {
  main.invoke("studio:saveMcpServers", []);
}

// ---- AC7 ---------------------------------------------------------------------

test("AC7: heldKeyNames() returns the held key names of a server whose id is __proto__ as an own entry", async (t) => {
  t.after(release);
  await hold([hand()], new Map([["__proto__", { KYB_H: "held" }]]));
  const names = main.localMcp.heldKeyNames();
  assert.equal(Object.hasOwn(names, "__proto__"), true, "no own entry for the server whose id is __proto__");
  assert.deepEqual(ownProto(names), ["KYB_H"]);
  assert.equal(Object.getPrototypeOf(names), Object.prototype, "the answer was re-parented");
});

test("AC7: the panel holds that entry after the reply crosses the fake bridge, from a load and from a save", async (t) => {
  t.after(release);
  await hold([hand()], new Map([["__proto__", { KYB_H: "held" }]]));
  const api = joinedApi();
  const panel = panelState();
  await loadMcpPanel(api, panel.apply);
  assert.equal(panel.get().loadError, null, `the load failed: ${panel.get().loadError}`);
  assert.equal(Object.hasOwn(panel.get().heldKeys, "__proto__"), true, "no own entry after the load");
  assert.deepEqual(ownProto(panel.get().heldKeys), ["KYB_H"]);

  await saveMcpPanel(api, panel.apply, panel.get().servers);
  assert.equal(panel.get().saveError, null, `the save failed: ${panel.get().saveError}`);
  assert.equal(Object.hasOwn(panel.get().heldKeys, "__proto__"), true, "no own entry after the save's reply");
  assert.deepEqual(ownProto(panel.get().heldKeys), ["KYB_H"]);
});

test("AC7: the row of a hand-added server whose id is __proto__ names the key typed into its box", async (t) => {
  // AC6's last check, short of a real bridge: the store shut, a server whose
  // id is `__proto__` in `local-mcp.json`, and `KYB_H=held` typed into its box.
  t.after(release);
  main.givenStored([hand()]);
  const panel = await dom.mount(joinedApi());
  try {
    await dom.menu(panel.host, "Hand", "Edit");
    assert.ok(dom.form(panel.host), "Edit opened no form");
    await dom.type(dom.envLines(panel.host), "KYB_H=held");
    await main.warnings(() => dom.click(dom.buttonIn(dom.form(panel.host), "Save")));
    assert.equal(dom.form(panel.host), undefined, "the form did not close: the save did not go through");
    assert.match(dom.text(dom.row(panel.host, "Hand")), /Kept until Studio restarts, not saved: KYB_H/);
  } finally {
    await panel.unmount();
  }
});

// ---- AC4 ---------------------------------------------------------------------

test("AC4: for ordinary ids, heldKeys has the same entries, order and prototype in main and in the panel", async (t) => {
  t.after(release);
  const servers = [server({ id: "zeta", name: "Zeta" }), server({ id: "alpha", name: "Alpha" })];
  await hold(servers, new Map([["zeta", { Z_KEY: "1", A_KEY: "2" }], ["alpha", { K: "3" }]]));
  const expected = [
    ["zeta", ["A_KEY", "Z_KEY"]],
    ["alpha", ["K"]],
  ];
  const names = main.localMcp.heldKeyNames();
  assert.deepEqual(Object.entries(names), expected);
  assert.equal(Object.getPrototypeOf(names), Object.prototype);

  const panel = panelState();
  await loadMcpPanel(joinedApi(), panel.apply);
  assert.deepEqual(Object.entries(panel.get().heldKeys), expected);
  assert.equal(Object.getPrototypeOf(panel.get().heldKeys), Object.prototype);
});
