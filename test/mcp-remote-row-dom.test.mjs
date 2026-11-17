import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * A REMOTE MCP server's row, mounted and driven (KYB-687).
 *
 * The row used to carry four controls side by side: ✓ Connected, Check, Share
 * or Change, and the bin. On a half-width card that left the server's name
 * about 40px, and cut "Linear" to "Line…". It now has the local rows' shape:
 * one primary action and a ⋯ menu.
 *
 * What this pins, for each state a remote card can be in:
 *
 *  - the row shows at most two controls outside the menu, counted at ANY depth,
 *    so wrapping the old controls in one element does not pass;
 *  - the menu holds exactly the actions the row offered on `main` outside its
 *    primary slot, so moving them did not lose one;
 *  - pressing each menu item, and each primary action, does what it did before.
 *
 * What it does not pin: layout. jsdom does no layout, so `scrollWidth` and
 * `clientWidth` are always 0 here. Whether the name fits is measured in
 * Chromium instead (KYB-687, AC3).
 *
 * The trap documented at length in `mcp-panel-dom.test.mjs` applies here too:
 * never make a jsdom node the `actual` of an assertion. A failing assertion
 * serialises its `actual`, and a React-attached node drags its whole fibre
 * graph with it. Every assertion below takes strings, numbers or booleans.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
for (const name of [
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CustomEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Plugins } = await import("../src/renderer/src/components/Plugins.tsx");
const { useStore } = await import("@/lib/store");

after(() => dom.window.close());

const AGENT = "agent-under-test";
const URL = "https://mcp.example.test/mcp";

async function settle() {
  await act(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  });
}

async function click(element) {
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** A fake preload bridge that records what the row asked it to do. */
function bridge({ cards = [], servers = [] } = {}) {
  const calls = [];
  const api = {
    connectors: async () => ({ configured: true, connectors: cards }),
    mcpServers: async () => ({ ok: true, servers }),
    saveMcpServers: async (next) => ({ ok: true, servers: next }),
    testRemoteMcp: async (slug) => {
      calls.push(["testRemoteMcp", slug]);
      return { ok: true, tools: ["a", "b"] };
    },
    startMcpSignIn: async (input) => {
      calls.push(["startMcpSignIn", input]);
      return { ok: true };
    },
    disconnectService: async (input) => {
      calls.push(["disconnectService", input]);
      return { ok: true };
    },
  };
  return { api, calls };
}

async function mount(studio) {
  dom.window.studio = studio;
  useStore.setState({
    pluginsOpen: true,
    activeAgentId: AGENT,
    agents: [],
    details: {},
    catalog: {},
    manageError: null,
    installing: null,
  });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Plugins));
  });
  await settle();
  const tab = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("MCP servers"));
  assert.ok(tab, "the MCP tab is not on screen");
  await click(tab);
  return {
    host,
    unmount: () => act(() => root.unmount()).then(() => host.remove()),
  };
}

/** What a control says: its text, or its title when it is an icon. */
const label = (el) => (el.textContent ?? "").trim() || el.getAttribute("title") || "";

/** The row whose name is exactly `name`. */
function row(host, name) {
  return [...host.querySelectorAll(".pl__row")].find(
    (r) => (r.querySelector(".pl__name")?.textContent ?? "") === name,
  );
}

/**
 * Every control on the row OUTSIDE its menu, at any depth: buttons and the
 * `.pl__added` status. Depth matters: counting direct children only would let
 * the old four controls pass inside one wrapper.
 */
function rowControls(r) {
  return [...r.querySelectorAll("button, .pl__added")]
    .filter((el) => !el.closest(".pl__menu"))
    .map(label);
}

function menuItems(r) {
  return [...r.querySelectorAll(".pl__menu button")].map(label);
}

function menuButton(r, text) {
  return [...r.querySelectorAll(".pl__menu button")].find((b) => label(b) === text);
}

function moreButton(r) {
  return [...r.querySelectorAll("button")].find((b) => b.getAttribute("title") === "More" && !b.closest(".pl__menu"));
}

const card = (over) => ({
  provider: "mcp-direct",
  present: true,
  scope: "agent",
  url: URL,
  connected: false,
  ...over,
});

/**
 * One remote card in each state, with what the row must show and what its menu
 * must hold. `menu` is what the row offered on `main` OUTSIDE its primary slot:
 * Check (when connected), Share or Change (when it has a URL), and the bin.
 */
const STATES = [
  {
    state: "connected, not shared",
    card: card({ slug: "mcp-linear", name: "Linear", connected: true }),
    controls: ["Connected", "More"],
    menu: ["Check again", "Share", "Remove"],
  },
  {
    state: "connected and shared",
    card: card({ slug: "mcp-linear", name: "Linear", connected: true, scope: "app" }),
    controls: ["Connected", "More"],
    menu: ["Check again", "Change", "Remove"],
  },
  {
    state: "signs people in, not connected",
    card: card({ slug: "mcp-linear", name: "Linear", authMode: "oauth" }),
    controls: ["Connect", "More"],
    menu: ["Share", "Remove"],
  },
  {
    state: "token server, not connected",
    card: card({ slug: "mcp-tokened", name: "Tokened", authMode: "token" }),
    controls: ["Check", "More"],
    menu: ["Share", "Remove"],
  },
  {
    state: "connected, with no URL",
    card: card({ slug: "mcp-nourl", name: "No URL", connected: true, url: undefined }),
    controls: ["Connected", "More"],
    menu: ["Check again", "Remove"],
  },
];

for (const s of STATES) {
  test(`DOM: a remote row (${s.state}) shows one action and ⋯, and the menu keeps every other action`, async () => {
    const b = bridge({ cards: [s.card] });
    const panel = await mount(b.api);
    try {
      const r = row(panel.host, s.card.name);
      assert.ok(r, `no row for ${s.card.name}`);
      assert.deepEqual(rowControls(r), s.controls, "the row's own controls");
      assert.equal(menuItems(r).length, 0, "the menu is open before it was asked for");

      await click(moreButton(r));
      assert.deepEqual(menuItems(row(panel.host, s.card.name)), s.menu, "the menu's items");
      assert.ok(
        menuButton(row(panel.host, s.card.name), "Remove").classList.contains("danger"),
        "Remove is not styled as a destructive action",
      );

      await click(moreButton(row(panel.host, s.card.name)));
      assert.equal(menuItems(row(panel.host, s.card.name)).length, 0, "⋯ does not close the menu again");
    } finally {
      await panel.unmount();
    }
  });
}

test("DOM: Check again asks the server, and the answer shows on the row", async () => {
  const b = bridge({ cards: [STATES[0].card] });
  const panel = await mount(b.api);
  try {
    await click(moreButton(row(panel.host, "Linear")));
    await click(menuButton(row(panel.host, "Linear"), "Check again"));
    assert.deepEqual(b.calls, [["testRemoteMcp", "mcp-linear"]]);
    const r = row(panel.host, "Linear");
    assert.equal(r.querySelector(".pl__meta")?.textContent, "Answering · 2 tools");
    assert.equal(menuItems(r).length, 0, "the menu stayed open after Check again");
  } finally {
    await panel.unmount();
  }
});

for (const [state, scope, item] of [
  ["not shared", "agent", "Share"],
  ["shared", "app", "Change"],
]) {
  test(`DOM: ${item} opens the add form filled in for that server (${state})`, async () => {
    const b = bridge({ cards: [card({ slug: "mcp-linear", name: "Linear", connected: true, scope })] });
    const panel = await mount(b.api);
    try {
      await click(moreButton(row(panel.host, "Linear")));
      await click(menuButton(row(panel.host, "Linear"), item));
      const values = [...panel.host.querySelectorAll("input")].map((i) => i.value);
      assert.ok(values.includes("Linear"), `the form's name is not filled in: ${JSON.stringify(values)}`);
      assert.ok(values.includes(URL), `the form's URL is not filled in: ${JSON.stringify(values)}`);
      const box = [...panel.host.querySelectorAll('input[type="checkbox"]')].map((i) => i.checked);
      assert.deepEqual(box, [scope === "app"], "the form's sharing box does not match the server");
      assert.equal(b.calls.length, 0, "opening the form called the bridge");
    } finally {
      await panel.unmount();
    }
  });
}

test("DOM: Remove disconnects that server from this agent", async () => {
  const b = bridge({ cards: [STATES[0].card] });
  const panel = await mount(b.api);
  try {
    await click(moreButton(row(panel.host, "Linear")));
    await click(menuButton(row(panel.host, "Linear"), "Remove"));
    assert.deepEqual(b.calls, [["disconnectService", { agent: AGENT, slug: "mcp-linear" }]]);
  } finally {
    await panel.unmount();
  }
});

test("DOM: the primary Check on a token server still asks the server", async () => {
  const b = bridge({ cards: [STATES[3].card] });
  const panel = await mount(b.api);
  try {
    const check = [...row(panel.host, "Tokened").querySelectorAll("button")].find((x) => label(x) === "Check");
    await click(check);
    assert.deepEqual(b.calls, [["testRemoteMcp", "mcp-tokened"]]);
    assert.equal(row(panel.host, "Tokened").querySelector(".pl__meta")?.textContent, "Answering · 2 tools");
  } finally {
    await panel.unmount();
  }
});

test("DOM: the primary Connect still starts the sign-in", async () => {
  const b = bridge({ cards: [STATES[2].card] });
  const panel = await mount(b.api);
  try {
    const connect = [...row(panel.host, "Linear").querySelectorAll("button")].find((x) => label(x) === "Connect");
    await click(connect);
    assert.deepEqual(b.calls, [
      ["startMcpSignIn", { slug: "mcp-linear", agent: AGENT, shared: false }],
    ]);
  } finally {
    await panel.unmount();
  }
});

test("DOM: a remote menu never opens a local server's menu with the same name", async () => {
  // Both kinds of row share one `menu` state. A local id that happens to equal
  // a remote slug must not open both menus from one press.
  const b = bridge({
    cards: [STATES[0].card],
    servers: [{ id: "mcp-linear", name: "Local twin", command: "node", args: ["x.js"], enabled: true }],
  });
  const panel = await mount(b.api);
  try {
    await click(moreButton(row(panel.host, "Linear")));
    assert.equal(panel.host.querySelectorAll(".pl__menu").length, 1, "more than one menu opened");
    assert.deepEqual(menuItems(row(panel.host, "Local twin")), [], "the local row's menu opened too");
  } finally {
    await panel.unmount();
  }
});
