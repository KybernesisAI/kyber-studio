import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * MCP server rows when a call fails, or is still running (KYB-688).
 *
 *  - AC1: a remote Remove that is refused, or that throws, says so on the row
 *    and leaves the row in place.
 *  - AC2: every handler that turns a row's spinner stops it when its bridge
 *    call throws, puts an error on the row, and leaves no unhandled rejection.
 *  - AC3: Check again is not in ⋯ while that row is checking, and is back once
 *    the call settles.
 *
 * The harness is `mcp-remote-row-dom.test.mjs`'s, and its rule holds here: no
 * jsdom node is ever the `actual` of an assertion. Every assertion takes
 * strings, numbers or booleans.
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

function menuItems(r) {
  return [...r.querySelectorAll(".pl__menu button")].map(label);
}

function menuButton(r, text) {
  return [...r.querySelectorAll(".pl__menu button")].find((b) => label(b) === text);
}

function moreButton(r) {
  return [...r.querySelectorAll("button")].find((b) => b.getAttribute("title") === "More" && !b.closest(".pl__menu"));
}

/** The sentence a row shows when its bridge call throws (Plugins.tsx). */
const FAILED = "That didn\u2019t work. Please try again.";

/**
 * Every unhandled rejection while this file runs. Each test reads how many
 * arrived during it. On `main` the handlers below leave the rejection escaping
 * the click, and this is where it lands.
 */
const unhandled = [];
process.on("unhandledRejection", (reason) => {
  unhandled.push(reason instanceof Error ? reason.message : String(reason));
});

/** A promise and the means to settle it from outside. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const LOCAL = { id: "local-1", name: "Local one", command: "node", args: ["x.js"], enabled: true };

const remoteCard = (over) => ({
  provider: "mcp-direct",
  present: true,
  scope: "agent",
  url: URL,
  connected: false,
  ...over,
});
const CONNECTED = remoteCard({ slug: "mcp-linear", name: "Linear", connected: true });
const OAUTH = remoteCard({ slug: "mcp-signs", name: "Signs in", authMode: "oauth" });
const TOKEN = remoteCard({ slug: "mcp-tokened", name: "Tokened", authMode: "token" });

/**
 * A fake preload bridge whose calls all answer well, with `over` replacing any
 * of them. Records every call.
 */
function bridge({ cards = [], servers = [], over = {} } = {}) {
  const calls = [];
  const answer = (name, value) => async (arg) => {
    calls.push(name);
    return over[name] ? over[name](arg) : value;
  };
  const api = {
    connectors: async () => ({ configured: true, connectors: cards }),
    mcpServers: async () => ({ ok: true, servers }),
    saveMcpServers: async (next) => ({ ok: true, servers: next }),
    openExternal: async () => {},
    testRemoteMcp: answer("testRemoteMcp", { ok: true, tools: ["a", "b"] }),
    startMcpSignIn: answer("startMcpSignIn", { ok: true }),
    disconnectService: answer("disconnectService", { ok: true }),
    connectMcpServer: answer("connectMcpServer", { ok: true, message: "" }),
    testMcpServer: answer("testMcpServer", { ok: true, tools: ["a"] }),
  };
  return { api, calls };
}

const rejecting = () => Promise.reject(new Error("Error invoking remote method 'studio:x': Error: boom"));

/** Wait long enough for an unhandled rejection to have been reported. */
async function drain() {
  await settle();
  await new Promise((resolve) => setImmediate(resolve));
  await settle();
}

function button(r, text) {
  return [...r.querySelectorAll("button")].find((b) => !b.closest(".pl__menu") && label(b) === text);
}

const meta = (r) => r.querySelector(".pl__meta")?.textContent ?? "";
const spinning = (r) => r.querySelector(".spinner") !== null;

// ---- AC1: a remote Remove that fails ----------------------------------------

test("AC1: a refused remote Remove shows the answer's error and keeps the row", async () => {
  const b = bridge({ cards: [CONNECTED], over: { disconnectService: async () => ({ ok: false, error: "E" }) } });
  const before = unhandled.length;
  const panel = await mount(b.api);
  try {
    await click(moreButton(row(panel.host, "Linear")));
    await click(menuButton(row(panel.host, "Linear"), "Remove"));
    await drain();
    assert.deepEqual(b.calls, ["disconnectService"]);
    const r = row(panel.host, "Linear");
    assert.ok(r, "the row went, though the Remove was refused");
    assert.equal(meta(r), "E", "the refusal is not on the row");
    assert.deepEqual(unhandled.slice(before), [], "an unhandled rejection was recorded");
  } finally {
    await panel.unmount();
  }
});

test("AC1: a remote Remove that throws shows an error on the row and keeps the row", async () => {
  const b = bridge({ cards: [CONNECTED], over: { disconnectService: rejecting } });
  const before = unhandled.length;
  const panel = await mount(b.api);
  try {
    await click(moreButton(row(panel.host, "Linear")));
    await click(menuButton(row(panel.host, "Linear"), "Remove"));
    await drain();
    const r = row(panel.host, "Linear");
    assert.ok(r, "the row went, though the Remove threw");
    assert.equal(meta(r), FAILED, "no error is shown on the row");
    assert.deepEqual(unhandled.slice(before), [], "an unhandled rejection was recorded");
  } finally {
    await panel.unmount();
  }
});

// ---- AC2: no spinner outlives its call --------------------------------------

/**
 * Each handler that turns a row's spinner, the call made to throw, and how to
 * press it. Local Connect makes two calls, so each is made to throw in turn.
 */
const THROWS = [
  {
    what: "remote primary Check (token server), testRemoteMcp",
    cards: [TOKEN],
    name: "Tokened",
    over: { testRemoteMcp: rejecting },
    press: async (host) => click(button(row(host, "Tokened"), "Check")),
    back: "Check",
  },
  {
    what: "remote ⋯ → Check again (connected), testRemoteMcp",
    cards: [CONNECTED],
    name: "Linear",
    over: { testRemoteMcp: rejecting },
    press: async (host) => {
      await click(moreButton(row(host, "Linear")));
      await click(menuButton(row(host, "Linear"), "Check again"));
    },
    back: "Connected",
  },
  {
    what: "remote primary Connect (signs people in), startMcpSignIn",
    cards: [OAUTH],
    name: "Signs in",
    over: { startMcpSignIn: rejecting },
    press: async (host) => click(button(row(host, "Signs in"), "Connect")),
    back: "Connect",
  },
  {
    what: "local primary Connect, connectMcpServer",
    servers: [LOCAL],
    name: "Local one",
    over: { connectMcpServer: rejecting },
    press: async (host) => click(button(row(host, "Local one"), "Connect")),
    back: "Connect",
  },
  {
    what: "local primary Connect, testMcpServer after a good connect",
    servers: [LOCAL],
    name: "Local one",
    over: { testMcpServer: rejecting },
    press: async (host) => click(button(row(host, "Local one"), "Connect")),
    back: "Connect",
  },
  {
    what: "local ⋯ → Check again, testMcpServer",
    servers: [LOCAL],
    name: "Local one",
    over: { testMcpServer: rejecting },
    press: async (host) => {
      await click(moreButton(row(host, "Local one")));
      await click(menuButton(row(host, "Local one"), "Check again"));
    },
    back: "Connect",
  },
];

for (const c of THROWS) {
  test(`AC2: ${c.what} throwing stops the spinner and shows an error`, async () => {
    const b = bridge({ cards: c.cards, servers: c.servers, over: c.over });
    const before = unhandled.length;
    const panel = await mount(b.api);
    try {
      await c.press(panel.host);
      await drain();
      const r = row(panel.host, c.name);
      assert.ok(r, `no row for ${c.name}`);
      assert.equal(spinning(r), false, "the spinner is still turning");
      assert.equal(meta(r), FAILED, "no error is shown on the row");
      assert.ok(
        [...r.querySelectorAll("button, .pl__added")].some((el) => !el.closest(".pl__menu") && label(el) === c.back),
        `the row's primary slot is not back to ${c.back}`,
      );
      assert.deepEqual(unhandled.slice(before), [], "an unhandled rejection was recorded");
    } finally {
      await panel.unmount();
    }
  });
}

// ---- AC3: Check again is not offered while that row is checking ------------

/**
 * Each state in which ⋯ offered Check again during that row's own check. The
 * bridge call is held open, ⋯ is opened during the spinner, then the call is
 * let go and ⋯ is opened again.
 */
const PENDING = [
  {
    what: "remote, connected, started by ⋯ → Check again",
    cards: [CONNECTED],
    name: "Linear",
    call: "testRemoteMcp",
    answer: { ok: true, tools: ["a"] },
    start: async (host) => {
      await click(moreButton(row(host, "Linear")));
      await click(menuButton(row(host, "Linear"), "Check again"));
    },
  },
  {
    what: "local, started by Connect",
    servers: [LOCAL],
    name: "Local one",
    call: "testMcpServer",
    answer: { ok: true, tools: ["a"] },
    start: async (host) => click(button(row(host, "Local one"), "Connect")),
  },
  {
    what: "local, started by ⋯ → Check again",
    servers: [LOCAL],
    name: "Local one",
    call: "testMcpServer",
    answer: { ok: true, tools: ["a"] },
    start: async (host) => {
      await click(moreButton(row(host, "Local one")));
      await click(menuButton(row(host, "Local one"), "Check again"));
    },
  },
];

for (const c of PENDING) {
  test(`AC3: ${c.what}: ⋯ has no Check again during the check, and has it after`, async () => {
    const held = deferred();
    const b = bridge({ cards: c.cards, servers: c.servers, over: { [c.call]: () => held.promise } });
    const panel = await mount(b.api);
    try {
      await c.start(panel.host);
      assert.equal(spinning(row(panel.host, c.name)), true, "the check is not running, so this proves nothing");

      await click(moreButton(row(panel.host, c.name)));
      const during = menuItems(row(panel.host, c.name));
      assert.ok(during.length > 0, "⋯ did not open during the check");
      assert.equal(
        during.includes("Check again"),
        false,
        `⋯ offers Check again during the check: ${JSON.stringify(during)}`,
      );
      await click(moreButton(row(panel.host, c.name)));

      await act(async () => {
        held.resolve(c.answer);
      });
      await drain();
      assert.equal(spinning(row(panel.host, c.name)), false, "the spinner did not stop once the call settled");

      await click(moreButton(row(panel.host, c.name)));
      const afterwards = menuItems(row(panel.host, c.name));
      assert.ok(afterwards.includes("Check again"), `⋯ has no Check again once the call settled: ${JSON.stringify(afterwards)}`);
    } finally {
      await panel.unmount();
    }
  });
}
