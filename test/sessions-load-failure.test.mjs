import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-647: when the agent's `/sessions` request fails, the conversations
 * drawer says so and offers Try again, instead of "Loading…" for good; and
 * answers are applied in the order their requests were sent.
 *
 * Rendered through the real `Panel` and the real store, with a fake bridge
 * whose `manage` a test can make refuse, fail, or hold an answer until the
 * test releases it.
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
const { useStore, sessionsPath, SESSIONS_READ_TIMEOUT_MS } = await import("@/lib/store");

after(() => dom.window.close());

const A = { id: "agent-a", name: "a", registeredName: "a", url: "https://a.example", accent: "#000", status: "online" };

const row = (id, status = "alive") => ({
  id,
  title: `title ${id}`,
  surface: "chat",
  trigger: "http",
  status,
  createdAt: "2026-10-26T09:00:00.000Z",
  updatedAt: "2026-10-26T09:00:00.000Z",
});
const LIVE = [row("live-1"), row("live-2")];
const ALL = [...LIVE, row("old-1", "ended")];

const UNREACHABLE = "Couldn't reach this agent";

/**
 * `live.mode` is how the agent answers `/sessions` right now:
 * "ok", "refuse" (the IPC call rejects, as `fetch failed` does) or "error"
 * (an answer that is not ok). `live.hold` makes every `/sessions` request wait
 * for the test to settle it, through the entry pushed onto `held`.
 */
function installBridge() {
  const requests = [];
  const held = [];
  const live = { mode: "ok", alive: LIVE, all: ALL, hold: false };
  const answer = (path) => {
    if (live.mode === "refuse") throw new TypeError("fetch failed");
    if (live.mode === "error") return { ok: false, status: 502, data: null };
    if (live.mode === "unreadable") return { ok: true, status: 200, data: null };
    const alive = new URLSearchParams(path.split("?")[1] ?? "").get("alive") === "1";
    return { ok: true, status: 200, data: { sessions: alive ? live.alive : live.all, routines: null } };
  };
  window.studio = new Proxy(
    {
      manage: async (input) => {
        requests.push(input);
        if (!input.path.startsWith("/sessions")) return { ok: false, status: 404, data: null };
        if (live.hold) {
          return new Promise((resolve, reject) => {
            held.push({
              path: input.path,
              succeed: (sessions) => resolve({ ok: true, status: 200, data: { sessions, routines: null } }),
              refuse: () => reject(new TypeError("fetch failed")),
            });
          });
        }
        return answer(input.path);
      },
      saveState: async () => true,
      loadState: async () => null,
      agentInfo: async () => ({ agent: { name: "a" } }),
    },
    { get: (target, key) => (key in target ? target[key] : async () => undefined) },
  );
  return { requests, held, live, sessionsRequests: () => requests.filter((r) => r.path.startsWith("/sessions")) };
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

function reset(panel = "conversations", prefs = {}) {
  useStore.setState({
    agents: [A],
    activeAgentId: A.id,
    panel,
    prefs,
    agentSessions: {},
    sessionsFailed: {},
    threadIndex: {},
    routinesSessions: {},
    sessions: {},
    sessionChoice: {},
    inflight: {},
    threads: {},
  });
}

/** An agent that keeps one thread for this person (manage 0.30+), as `loadThread` would hold it. */
const THREAD = { current: "thread-s1", sessions: [{ id: "thread-s1", at: "2026-10-26T09:00:00.000Z" }], reports: [], fresh: [] };

test("AC1: a refused /sessions request says the agent couldn't be reached, with Try again, not Loading…", async () => {
  const bridge = installBridge();
  bridge.live.mode = "refuse";
  reset();
  const view = await mount();

  assert.equal(bridge.sessionsRequests().length, 1);
  assert.ok(view.text().includes(UNREACHABLE), `no failed state: ${view.text()}`);
  assert.ok(!view.text().includes("Loading…"), "a failed request still reads as loading");
  assert.ok(view.button("Try again"), "no Try again button");
  await view.unmount();
});

test("AC1: an answer that is not ok is a failure too", async () => {
  const bridge = installBridge();
  bridge.live.mode = "error";
  reset();
  const view = await mount();
  assert.ok(view.text().includes(UNREACHABLE), `no failed state: ${view.text()}`);
  assert.ok(!view.text().includes("Loading…"));
  await view.unmount();
});

test("AC1: an ok answer with no readable body is a failure, not an empty list", async () => {
  const bridge = installBridge();
  bridge.live.mode = "unreadable";
  reset();
  const view = await mount();
  assert.ok(view.text().includes(UNREACHABLE), `no failed state: ${view.text()}`);
  assert.ok(!view.text().includes("No active conversations"), "an unreadable answer read as an empty list");
  await view.unmount();
});

test("AC1: the Agent panel's Show conversations row says so too", async () => {
  const bridge = installBridge();
  bridge.live.mode = "refuse";
  reset("overview");
  const view = await mount();
  assert.ok(bridge.sessionsRequests().length >= 1);
  assert.ok(view.text().includes("Show conversations"));
  assert.ok(view.text().includes(UNREACHABLE), `the overview row does not say so: ${view.text()}`);
  await view.unmount();
});

test("AC2: the /sessions read asks for its own short timeout, not the install bound", async () => {
  const bridge = installBridge();
  reset();
  await useStore.getState().loadSessions(A.id);
  await useStore.getState().loadSessions(A.id, "all");
  assert.equal(SESSIONS_READ_TIMEOUT_MS, 15_000);
  for (const r of bridge.sessionsRequests()) assert.equal(r.timeoutMs, SESSIONS_READ_TIMEOUT_MS, `${r.path} sent no read timeout`);
});

test("AC3: Try again asks again, and when the agent is back the list appears without pressing the switch", async () => {
  const bridge = installBridge();
  bridge.live.mode = "refuse";
  reset();
  const view = await mount();
  assert.ok(view.text().includes(UNREACHABLE));

  // Still down: Try again asks again and stays failed.
  await click(view.button("Try again"));
  assert.equal(bridge.sessionsRequests().length, 2, "Try again sent no request");
  assert.ok(view.text().includes(UNREACHABLE));

  // Back: Try again brings the list, under the filter already chosen.
  bridge.live.mode = "ok";
  await click(view.button("Try again"));
  assert.equal(bridge.sessionsRequests().length, 3);
  assert.equal(bridge.sessionsRequests()[2].path, sessionsPath("active"));
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"]);
  assert.ok(!view.text().includes(UNREACHABLE), "the failed state outlived a good answer");
  assert.equal(useStore.getState().sessionsFailed[A.id], undefined);
  await view.unmount();
});

test("AC4: pressing Active / All while the agent is unreachable ends failed for the new filter", async () => {
  const bridge = installBridge();
  reset();
  const view = await mount();
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"]);

  bridge.live.mode = "refuse";
  await click(view.button("All"));
  assert.equal(bridge.sessionsRequests().at(-1).path, "/sessions?limit=60");
  assert.equal(view.button("All").getAttribute("aria-pressed"), "true");
  assert.ok(view.text().includes(UNREACHABLE), `no failed state under All: ${view.text()}`);
  assert.ok(!view.text().includes("Loading…"));
  assert.deepEqual(useStore.getState().sessionsFailed[A.id]?.filter, "all");

  await click(view.button("Active"));
  assert.ok(view.text().includes(UNREACHABLE), `no failed state back under Active: ${view.text()}`);
  assert.ok(!view.text().includes("Loading…"));
  await view.unmount();
});

test("a refresh that fails keeps the list on screen and says it may be out of date", async () => {
  const bridge = installBridge();
  reset();
  const view = await mount();
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"]);

  bridge.live.mode = "refuse";
  await act(async () => {
    await useStore.getState().loadSessions(A.id);
  });
  await settle();
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"], "a failed refresh took the list away");
  assert.ok(view.text().includes("may be out of date"), `no word of the failure: ${view.text()}`);
  assert.ok(view.button("Try again"));
  await view.unmount();
});

test("AC5: when loadAgentInfo's All request fails and only an Active list is held, no thread is adopted from it", async () => {
  const bridge = installBridge();
  reset(); // the drawer is on Active
  useStore.setState({ agentSessions: { [A.id]: { filter: "active", sessions: [row("old-live")] } } });
  bridge.live.mode = "refuse";

  const returned = await useStore.getState().loadSessions(A.id, "all");
  assert.deepEqual(returned, [], "a failed All request returned the Active list");

  await useStore.getState().loadAgentInfo(A.id);
  await settle();
  assert.ok(bridge.sessionsRequests().some((r) => r.path === "/sessions?limit=60"), "loadAgentInfo did not ask for All");
  assert.equal(useStore.getState().sessions[A.id], undefined, "a thread was adopted from the Active list");
});

test("AC5: a failed request still returns the held list when it was fetched under the same filter", async () => {
  const bridge = installBridge();
  reset("conversations", { [A.id]: { threadFilter: "all" } });
  useStore.setState({ agentSessions: { [A.id]: { filter: "all", sessions: ALL } } });
  bridge.live.mode = "refuse";
  assert.deepEqual(await useStore.getState().loadSessions(A.id, "all"), ALL);
});

test("AC7: two overlapping requests, the first answering last: the second's list is held", async () => {
  const bridge = installBridge();
  bridge.live.hold = true;
  reset();
  const first = useStore.getState().loadSessions(A.id);
  const second = useStore.getState().loadSessions(A.id);
  assert.equal(bridge.held.length, 2);

  bridge.held[1].succeed([row("new-thread"), ...LIVE]);
  await second;
  bridge.held[0].succeed(LIVE);
  const late = await first;

  assert.deepEqual(late, LIVE, "the late answer was not returned to its own caller");
  assert.deepEqual(
    useStore.getState().agentSessions[A.id]?.sessions.map((s) => s.id),
    ["new-thread", "live-1", "live-2"],
    "the late answer replaced the newer list",
  );
});

test("AC7: the first request failing after the second succeeded leaves the list with no failed state", async () => {
  const bridge = installBridge();
  bridge.live.hold = true;
  reset();
  const view = await mount(); // the mount's own request is the first
  const second = act(async () => {
    await useStore.getState().loadSessions(A.id);
  });
  assert.equal(bridge.held.length, 2);

  bridge.held[1].succeed(LIVE);
  await second;
  await act(async () => {
    bridge.held[0].refuse();
    await sleep(0);
  });
  await settle();

  assert.equal(useStore.getState().sessionsFailed[A.id], undefined, "a stale failure was recorded over a newer list");
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"]);
  assert.ok(!view.text().includes(UNREACHABLE), "a stale failure is shown over the list");
  await view.unmount();
});

test("AC7: the first request succeeding after the second failed does not replace the failed state", async () => {
  const bridge = installBridge();
  bridge.live.hold = true;
  reset();
  const first = useStore.getState().loadSessions(A.id);
  const second = useStore.getState().loadSessions(A.id);
  bridge.held[1].refuse();
  await second;
  bridge.held[0].succeed(LIVE);
  await first;
  assert.equal(useStore.getState().sessionsFailed[A.id]?.filter, "active");
  assert.equal(useStore.getState().agentSessions[A.id], undefined, "an older answer was stored after a newer failure");
});

test("an All answer for loadAgentInfo does not make the drawer's pending Active answer stale", async () => {
  // An answer under a filter that is not the drawer's claims no list
  // watermark at all, so the All answer leaves the Active one free to land.
  // This holds whether the watermark is kept per filter or per agent; the
  // test "an Active answer still in flight across a switch to All and back"
  // is the one that needs it per filter.
  const bridge = installBridge();
  bridge.live.hold = true;
  reset(); // the drawer is on Active
  const active = useStore.getState().loadSessions(A.id);
  const all = useStore.getState().loadSessions(A.id, "all");
  bridge.held[1].succeed(ALL);
  await all;
  bridge.held[0].succeed(LIVE);
  await active;
  assert.deepEqual(useStore.getState().agentSessions[A.id], { filter: "active", sessions: LIVE });
});

test("the thread index takes the newest answer whatever its filter", async () => {
  const bridge = installBridge();
  bridge.live.hold = true;
  reset();
  const older = useStore.getState().loadSessions(A.id, "all");
  const newer = useStore.getState().loadSessions(A.id);
  bridge.held[1].succeed([{ ...row("t-1"), title: "newer title" }]);
  await newer;
  bridge.held[0].succeed([{ ...row("t-1"), title: "older title" }]);
  await older;
  assert.equal(useStore.getState().threadIndex[A.id]?.["t-1"]?.title, "newer title");
});

test("an Active answer still in flight across a switch to All and back is stored when it lands", async () => {
  // The one sequence that needs the list watermark per filter: with one
  // watermark per agent, the All answer's claim would drop this Active answer
  // and the drawer would wait on the next request.
  const bridge = installBridge();
  bridge.live.hold = true;
  reset(); // the drawer is on Active
  const first = useStore.getState().loadSessions(A.id);
  useStore.getState().setThreadFilter(A.id, "all");
  assert.equal(bridge.held.length, 2);
  bridge.held[1].succeed(ALL);
  await sleep(0);
  assert.deepEqual(useStore.getState().agentSessions[A.id], { filter: "all", sessions: ALL });

  useStore.getState().setThreadFilter(A.id, "active");
  assert.equal(bridge.held.length, 3);
  bridge.held[0].succeed(LIVE);
  await first;
  assert.deepEqual(useStore.getState().agentSessions[A.id], { filter: "active", sessions: LIVE }, "the first Active answer was dropped");

  // The newer Active request still replaces it when it lands.
  bridge.held[2].succeed([row("new-thread"), ...LIVE]);
  await sleep(0);
  assert.deepEqual(
    useStore.getState().agentSessions[A.id]?.sessions.map((s) => s.id),
    ["new-thread", "live-1", "live-2"],
  );
});

test("a failed refresh with a list held: the Show conversations row keeps its count and says it may be out of date", async () => {
  const bridge = installBridge();
  reset("overview");
  const view = await mount();
  assert.ok(view.text().includes("2 active threads"), view.text());
  assert.ok(!view.text().includes("may be out of date"));

  bridge.live.mode = "refuse";
  await act(async () => {
    await useStore.getState().loadSessions(A.id);
  });
  await settle();
  assert.ok(view.text().includes("2 active threads"), `the count went: ${view.text()}`);
  assert.ok(view.text().includes("may be out of date"), `the row does not say so: ${view.text()}`);

  bridge.live.mode = "ok";
  await act(async () => {
    await useStore.getState().loadSessions(A.id);
  });
  await settle();
  assert.ok(!view.text().includes("may be out of date"), "the note outlived a good answer");
  await view.unmount();
});

test("an agent that keeps one thread: the Other conversations row says the agent couldn't be reached, not Loading…", async () => {
  const bridge = installBridge();
  bridge.live.mode = "refuse";
  reset("overview");
  useStore.setState({ threads: { [A.id]: THREAD } });
  const view = await mount();
  assert.ok(bridge.sessionsRequests().length >= 1);
  assert.ok(view.text().includes("Other conversations"), view.text());
  assert.ok(view.text().includes(UNREACHABLE), `the row does not say so: ${view.text()}`);
  assert.ok(!view.text().includes("Loading…"), "a failed request still reads as loading");

  bridge.live.mode = "ok";
  await act(async () => {
    await useStore.getState().loadSessions(A.id);
  });
  await settle();
  assert.ok(view.text().includes("2 from before the thread"), `no count once the agent is back: ${view.text()}`);
  assert.ok(!view.text().includes(UNREACHABLE));
  await view.unmount();
});

test("an agent that keeps one thread: a failed refresh keeps the Other conversations count and says it may be out of date", async () => {
  const bridge = installBridge();
  reset("overview");
  useStore.setState({ threads: { [A.id]: THREAD } });
  const view = await mount();
  assert.ok(view.text().includes("2 from before the thread"), view.text());

  bridge.live.mode = "refuse";
  await act(async () => {
    await useStore.getState().loadSessions(A.id);
  });
  await settle();
  assert.ok(view.text().includes("2 from before the thread"), `the count went: ${view.text()}`);
  assert.ok(view.text().includes("may be out of date"), `the row does not say so: ${view.text()}`);
  await view.unmount();
});

test("an agent that keeps one thread: the Other conversations drawer says the agent couldn't be reached, with Try again", async () => {
  const bridge = installBridge();
  bridge.live.mode = "refuse";
  reset();
  useStore.setState({ threads: { [A.id]: THREAD } });
  const view = await mount();
  assert.ok(view.text().includes("Back to your thread"), view.text());
  assert.ok(view.text().includes(UNREACHABLE), `no failed state: ${view.text()}`);
  assert.ok(!view.text().includes("Loading…"));

  bridge.live.mode = "ok";
  await click(view.button("Try again"));
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"]);
  await view.unmount();
});

test("an agent that keeps one thread: a failed refresh keeps the Other conversations drawer's list and says it may be out of date", async () => {
  const bridge = installBridge();
  reset();
  useStore.setState({ threads: { [A.id]: THREAD } });
  const view = await mount();
  assert.ok(view.text().includes("Back to your thread"), view.text());
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"]);

  bridge.live.mode = "refuse";
  await act(async () => {
    await useStore.getState().loadSessions(A.id);
  });
  await settle();
  assert.deepEqual(view.rows(), ["title live-1", "title live-2"], "a failed refresh took the list away");
  assert.ok(view.text().includes("may be out of date"), `no word of the failure: ${view.text()}`);
  assert.ok(view.button("Try again"));
  await view.unmount();
});
