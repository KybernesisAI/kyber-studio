import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * Two MCP rows working at once (KYB-689).
 *
 * The tab used to hold one `checking` value and one `awaiting` value. Checking
 * a second row took the first row's spinner away, and the first answer cleared
 * the second's; a second sign-in replaced the first, whose approval then went
 * unnoticed. Remote slugs and local ids were also bare keys, and the control
 * plane's slug rule makes a remote "Linear" and a local "MCP Linear" both
 * `mcp-linear`.
 *
 *  - AC1: each row's spinner follows its own call, for two remote rows and two
 *    local rows, and KYB-688's no-Check-again-mid-check holds for each.
 *  - AC2: two sign-ins are waited on at once, each noticed when approved and
 *    each given up 3 minutes after its own Connect.
 *  - AC3: a remote row and a local row with the same id share nothing.
 *
 * The harness is `mcp-row-failures-dom.test.mjs`'s, and its rule holds: no
 * jsdom node is ever the `actual` of an assertion.
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

function moreButton(r) {
  return [...r.querySelectorAll("button")].find((b) => b.getAttribute("title") === "More" && !b.closest(".pl__menu"));
}

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

const remoteCard = (over) => ({
  provider: "mcp-direct",
  present: true,
  scope: "agent",
  url: URL,
  connected: false,
  ...over,
});

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

/** Let the effects and promises a click started run to the end. */
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


/** Calls held open, one per argument, settled from the test. */
function held() {
  const open = new Map();
  const call = (arg) => {
    const key = typeof arg === "string" ? arg : arg.slug;
    const d = deferred();
    open.set(key, d);
    return d.promise;
  };
  const settleOne = async (key, value) => {
    await act(async () => {
      open.get(key).resolve(value);
    });
    await drain();
  };
  return { call, settle: settleOne };
}

/** What a row shows in its primary slot: a spinner, or the label there. */
function primary(r) {
  if (spinning(r)) return "spinner";
  const el = [...r.querySelectorAll("button, .pl__added")].find((e) => !e.closest(".pl__menu"));
  return el ? label(el) : "";
}

const WAITING = "Waiting for you to approve it…";

// ---- AC1: each row's spinner follows its own call ---------------------------

test("AC1: two remote rows, Check on A then B: each spins until its own answer", async () => {
  const calls = held();
  const b = bridge({
    cards: [
      remoteCard({ slug: "mcp-a", name: "A", authMode: "token" }),
      remoteCard({ slug: "mcp-b", name: "B", authMode: "token" }),
    ],
    over: { testRemoteMcp: calls.call },
  });
  const panel = await mount(b.api);
  try {
    await click(button(row(panel.host, "A"), "Check"));
    await click(button(row(panel.host, "B"), "Check"));
    assert.equal(spinning(row(panel.host, "A")), true, "A's spinner went when B's check started");
    assert.equal(spinning(row(panel.host, "B")), true, "B shows no spinner during its check");

    await calls.settle("mcp-a", { ok: true, tools: ["a"] });
    assert.match(meta(row(panel.host, "A")), /^Answering · 1 tools?$/);
    assert.equal(spinning(row(panel.host, "A")), false, "A still spins after its answer");
    assert.equal(spinning(row(panel.host, "B")), true, "A's answer cleared B's spinner while B is still checking");

    await calls.settle("mcp-b", { ok: true, tools: ["a", "b"] });
    assert.equal(meta(row(panel.host, "B")), "Answering · 2 tools");
    assert.equal(spinning(row(panel.host, "B")), false, "B still spins after its answer");
  } finally {
    await panel.unmount();
  }
});

test("AC1: two local rows, Connect on a then b: each spins until its own answer, with no Check again mid-check", async () => {
  const calls = held();
  const b = bridge({
    servers: [
      { id: "hang-a", name: "hang a", command: "sleep", args: ["600"], enabled: true },
      { id: "hang-b", name: "hang b", command: "sleep", args: ["600"], enabled: true },
    ],
    over: { connectMcpServer: calls.call },
  });
  const panel = await mount(b.api);
  try {
    await click(button(row(panel.host, "hang a"), "Connect"));
    await click(button(row(panel.host, "hang b"), "Connect"));
    assert.equal(spinning(row(panel.host, "hang a")), true, "hang a's spinner went when hang b's check started");
    assert.equal(spinning(row(panel.host, "hang b")), true, "hang b shows no spinner during its check");

    await click(moreButton(row(panel.host, "hang a")));
    const during = menuItems(row(panel.host, "hang a"));
    assert.ok(during.length > 0, "⋯ did not open");
    assert.equal(during.includes("Check again"), false, `hang a offers Check again mid-check: ${JSON.stringify(during)}`);
    await click(moreButton(row(panel.host, "hang a")));

    await calls.settle("hang-a", { ok: false, message: "hang a did not answer in time." });
    assert.equal(meta(row(panel.host, "hang a")), "hang a did not answer in time.");
    assert.equal(spinning(row(panel.host, "hang a")), false, "hang a still spins after its answer");
    assert.equal(spinning(row(panel.host, "hang b")), true, "hang a's answer cleared hang b's spinner mid-check");

    await calls.settle("hang-b", { ok: false, message: "hang b did not answer in time." });
    assert.equal(meta(row(panel.host, "hang b")), "hang b did not answer in time.");
    assert.equal(spinning(row(panel.host, "hang b")), false, "hang b still spins after its answer");
  } finally {
    await panel.unmount();
  }
});

// ---- AC2: two sign-ins waited on at once ------------------------------------

const OA = remoteCard({ slug: "mcp-oa", name: "OA", authMode: "oauth" });
const OB = remoteCard({ slug: "mcp-ob", name: "OB", authMode: "oauth" });

/** A bridge whose `connectors()` reports each card connected once approved. */
function signInBridge() {
  const approved = new Set();
  const b = bridge({ cards: [OA, OB] });
  b.api.connectors = async () => ({
    configured: true,
    connectors: [OA, OB].map((c) => ({ ...c, connected: approved.has(c.slug) })),
  });
  return { api: b.api, approve: (slug) => approved.add(slug) };
}

test("AC2: Connect on OA then OB: both wait, and OA's approval is noticed while OB still waits", async () => {
  const b = signInBridge();
  const panel = await mount(b.api);
  try {
    await click(button(row(panel.host, "OA"), "Connect"));
    await click(button(row(panel.host, "OB"), "Connect"));
    assert.equal(meta(row(panel.host, "OA")), WAITING, "OA stopped waiting when OB's sign-in started");
    assert.equal(meta(row(panel.host, "OB")), WAITING);
    assert.equal(primary(row(panel.host, "OA")), "spinner");

    b.approve("mcp-oa");
    const by = Date.now() + 5_000;
    while (primary(row(panel.host, "OA")) !== "Connected" && Date.now() < by) {
      await act(async () => {
        await new Promise((resolve) => dom.window.setTimeout(resolve, 250));
      });
    }
    assert.equal(primary(row(panel.host, "OA")), "Connected", "OA's approval was not noticed within 5 s");
    assert.equal(meta(row(panel.host, "OB")), WAITING, "OB stopped waiting when OA was approved");
  } finally {
    await panel.unmount();
  }
});

test("AC2: each sign-in gives up 3 minutes after its own Connect, not after the last one", async () => {
  const b = signInBridge();
  const panel = await mount(b.api);
  // Timers are mocked after the mount, and nothing below waits on one: jsdom's
  // timers are Node's, so `settle()` would never return. `setImmediate` is not
  // mocked, and flushes the effects and promises a click starts.
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const flush = () =>
    act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    });
  const press = async (name) => {
    await act(async () => {
      button(row(panel.host, name), "Connect").dispatchEvent(
        new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await flush();
  };
  const tick = async (ms) => {
    await act(async () => {
      mock.timers.tick(ms);
    });
    await flush();
  };
  try {
    await press("OA");
    await tick(60_000);
    await press("OB");
    await tick(60_000);
    // 120 s after OA's Connect, 60 s after OB's.
    assert.equal(meta(row(panel.host, "OA")), WAITING, "OA is not waiting 120 s after its Connect");
    assert.equal(meta(row(panel.host, "OB")), WAITING, "OB is not waiting 60 s after its Connect");

    await tick(61_000);
    // 181 s after OA's Connect, 121 s after OB's.
    assert.notEqual(meta(row(panel.host, "OA")), WAITING, "OA is still waiting 181 s after its Connect");
    assert.equal(primary(row(panel.host, "OA")), "Connect", "OA does not offer Connect again after giving up");
    assert.equal(meta(row(panel.host, "OB")), WAITING, "OB gave up with OA, 121 s after its own Connect");

    await tick(60_000);
    // 181 s after OB's Connect.
    assert.notEqual(meta(row(panel.host, "OB")), WAITING, "OB is still waiting 181 s after its Connect");
  } finally {
    mock.timers.reset();
    await panel.unmount();
  }
});

// ---- AC3: a remote row and a local row with the same id ---------------------

test("AC3: Check on a remote row neither spins nor writes on a local row with the same id", async () => {
  const calls = held();
  const b = bridge({
    cards: [remoteCard({ slug: "mcp-same", name: "Same remote", authMode: "token" })],
    servers: [{ id: "mcp-same", name: "Same local", command: "node", args: ["x.js"], enabled: true }],
    over: { testRemoteMcp: calls.call },
  });
  const panel = await mount(b.api);
  try {
    const before = meta(row(panel.host, "Same local"));
    await click(button(row(panel.host, "Same remote"), "Check"));
    assert.equal(spinning(row(panel.host, "Same remote")), true, "the remote row shows no spinner during its check");
    assert.equal(spinning(row(panel.host, "Same local")), false, "the local row spins with the remote row's check");

    await calls.settle("mcp-same", { ok: true, tools: ["a"] });
    assert.match(meta(row(panel.host, "Same remote")), /^Answering · 1 tools?$/);
    assert.equal(meta(row(panel.host, "Same local")), before, "the remote row's result was written on the local row");
    assert.equal(primary(row(panel.host, "Same local")), "Connect", "the local row's primary slot changed");
  } finally {
    await panel.unmount();
  }
});
