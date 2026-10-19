import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-646: the Conversations drawer's Active / All switch, MOUNTED and DRIVEN.
 *
 * Before this change the drawer always asked `/sessions?limit=60`, so both
 * states would have been identical. These tests render the real `Panel` on its
 * conversations view, through the real store, with a fake bridge whose
 * `manage` answers differently with and without `alive=1`, and press the
 * buttons a person presses.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const name of ["HTMLElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Panel } = await import("../src/renderer/src/components/Panel.tsx");
const { useStore, sessionsPath } = await import("@/lib/store");

after(() => dom.window.close());

const A = { id: "agent-a", name: "a", registeredName: "a", url: "https://a.example", accent: "#000", status: "online" };
const B = { id: "agent-b", name: "b", registeredName: "b", url: "https://b.example", accent: "#000", status: "online" };

const row = (id, status) => ({
  id,
  title: `title ${id}`,
  surface: "chat",
  trigger: "http",
  status,
  createdAt: "2026-10-19T09:00:00.000Z",
  updatedAt: "2026-10-19T09:00:00.000Z",
});
const LIVE = [row("live-1", "alive"), row("live-2", "alive")];
const ALL = [...LIVE, row("eval-1", "ended"), row("eval-2", "ended"), row("probe-1", "failed")];

/**
 * A bridge whose agent filters as `@kybernesis/manage` does. `live.alive`
 * replaces the rows `?alive=1` answers with; `live.delay` holds an answer
 * back per path, so a test can make an old request land last.
 */
function installBridge() {
  const requests = [];
  const saved = [];
  const live = { alive: LIVE, all: ALL, delay: {}, stored: null };
  window.studio = new Proxy(
    {
      manage: async ({ url, path }) => {
        requests.push({ url, path });
        if (live.delay[path]) await sleep(live.delay[path]);
        if (!path.startsWith("/sessions")) return { ok: false, status: 404 };
        const alive = new URLSearchParams(path.split("?")[1] ?? "").get("alive") === "1";
        return { ok: true, status: 200, data: { sessions: alive ? live.alive : live.all, routines: null } };
      },
      saveState: async (input) => {
        saved.push(structuredClone(input));
        return true;
      },
      loadState: async (name) => (name === "conversations.json" ? live.stored : null),
      agentInfo: async () => ({ agent: { name: "a" } }),
    },
    { get: (target, key) => (key in target ? target[key] : async () => undefined) },
  );
  return { requests, saved, live, sessionsRequests: () => requests.filter((r) => r.path.startsWith("/sessions")) };
}

async function settle(ms = 0) {
  await act(async () => {
    await sleep(ms);
  });
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Panel));
  });
  await settle();
  return {
    host,
    text: () => host.textContent ?? "",
    rows: () => [...host.querySelectorAll(".routine-row__name")].map((n) => n.textContent).filter((t) => t.startsWith("title ")),
    button: (label) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label),
    unmount: () => act(() => root.unmount()).then(() => host.remove()),
  };
}

async function click(el) {
  assert.ok(el, "the button is not on screen");
  await act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function reset(prefs = {}) {
  useStore.setState({ agents: [A, B], activeAgentId: A.id, panel: "conversations", prefs, agentSessions: {}, routinesSessions: {}, sessions: {}, inflight: {} });
}

test("AC1 + AC3: Active asks with alive=1, All asks without it, and each switch asks again", async () => {
  const bridge = installBridge();
  reset();
  const view = await mount();

  assert.deepEqual(bridge.sessionsRequests().map((r) => r.path), [sessionsPath("active")]);
  assert.equal(sessionsPath("active"), "/sessions?limit=60&alive=1");
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"]);
  assert.equal(view.button("Active").getAttribute("aria-pressed"), "true");

  await click(view.button("All"));
  assert.deepEqual(bridge.sessionsRequests().map((r) => r.path), [sessionsPath("active"), "/sessions?limit=60"]);
  assert.equal(view.rows().length, ALL.length, "All shows no more rows than Active did");
  assert.equal(view.button("All").getAttribute("aria-pressed"), "true");

  await click(view.button("Active"));
  assert.equal(bridge.sessionsRequests().length, 3, "switching back filtered locally instead of asking");
  assert.equal(bridge.sessionsRequests()[2].path, sessionsPath("active"));
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"]);
  await view.unmount();
});

test("AC3: a slow Active answer that lands after All is not shown under All", async () => {
  const bridge = installBridge();
  bridge.live.delay[sessionsPath("active")] = 120;
  reset();
  const view = await mount();
  assert.ok(view.text().includes("Loading…"));

  await click(view.button("All"));
  await settle(20);
  assert.equal(view.rows().length, ALL.length);

  await settle(200); // the Active answer lands now
  assert.equal(view.rows().length, ALL.length, "a late Active answer replaced the All list");
  assert.equal(view.button("All").getAttribute("aria-pressed"), "true");
  await view.unmount();
});

test("AC2: the choice is per agent, survives switching agent, and survives a restart", async () => {
  const bridge = installBridge();
  reset();
  const view = await mount();
  await click(view.button("All"));

  const last = bridge.saved.filter((s) => s.name === "conversations.json").at(-1);
  assert.equal(last?.value?.prefs?.[A.id]?.threadFilter, "all", "the choice was not written to disk");

  // Agent B has never chosen: it gets the default.
  await act(async () => useStore.setState({ activeAgentId: B.id }));
  await settle();
  assert.deepEqual(bridge.sessionsRequests().at(-1), { url: B.url, path: sessionsPath("active") });
  assert.equal(view.button("Active").getAttribute("aria-pressed"), "true");

  // Back to A: still All.
  await act(async () => useStore.setState({ activeAgentId: A.id }));
  await settle();
  assert.deepEqual(bridge.sessionsRequests().at(-1), { url: A.url, path: "/sessions?limit=60" });
  assert.equal(view.button("All").getAttribute("aria-pressed"), "true");
  await view.unmount();

  // A restart: empty memory, then what was saved is read back.
  bridge.live.stored = last.value;
  reset();
  await useStore.getState().restore();
  bridge.requests.length = 0;
  const again = await mount();
  assert.deepEqual(bridge.sessionsRequests().map((r) => r.path), ["/sessions?limit=60"], "the choice reset after a restart");
  assert.equal(again.button("All").getAttribute("aria-pressed"), "true");
  await again.unmount();
});

test("AC4: Active with nothing live says so, names the filter, and offers All", async () => {
  const bridge = installBridge();
  bridge.live.alive = [];
  reset();
  const view = await mount();

  assert.ok(view.text().includes("No active conversations"), `no empty state: ${view.text()}`);
  assert.ok(!view.text().includes("Loading…"), "an empty Active list reads as still loading");
  assert.equal(view.rows().length, 0);

  await click(view.button("Show all conversations"));
  assert.equal(bridge.sessionsRequests().at(-1).path, "/sessions?limit=60");
  assert.equal(view.rows().length, ALL.length);
  assert.ok(!view.text().includes("No active conversations"));
  await view.unmount();
});

test("pressing the switch already on does not ask again", async () => {
  const bridge = installBridge();
  reset();
  const view = await mount();
  const before = bridge.sessionsRequests().length;
  await click(view.button("Active"));
  assert.equal(bridge.sessionsRequests().length, before);
  await view.unmount();
});

test("the chat's adopted thread does not depend on the drawer's filter: loadAgentInfo always asks for All", async () => {
  // Under Active, alive=1 reaches past the 60 newest, so an old live thread
  // that All would never have offered could be adopted. Here the All answer
  // holds no live chat and the Active answer holds one: nothing is adopted.
  const bridge = installBridge();
  bridge.live.all = [row("eval-1", "ended")];
  bridge.live.alive = [row("old-live", "alive")];
  reset(); // no choice recorded, so the drawer is on Active
  await useStore.getState().loadAgentInfo(A.id);
  await settle();

  assert.deepEqual(bridge.sessionsRequests().map((r) => r.path), ["/sessions?limit=60"]);
  assert.equal(useStore.getState().sessions[A.id], undefined, "a thread was adopted through the drawer's Active filter");
  // And an All list was not stored where the Active drawer would show it.
  assert.equal(useStore.getState().agentSessions[A.id], undefined);
});
