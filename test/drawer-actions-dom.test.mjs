import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-649, PR 2: the drawer's actions and the read-only composer, MOUNTED and
 * PRESSED.
 *
 * - Each live thread has its own End, behind the same confirmation as
 *   Settings; threads already ended do not offer it (AC2b).
 * - Archive hides a thread here without calling the agent; "Show archived"
 *   lists it with Unarchive (AC2).
 * - Archived and ended stay separate in what the drawer shows (AC6), and an
 *   ended or failed thread reads as ended, never as an error (AC7).
 * - The overview's count leaves archived threads out and follows the list (AC9).
 * - A retired thread opens with no composer, a reason, and a way to start a new
 *   conversation (AC3b).
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
// jsdom has none; the conversation view only observes its own size with it.
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Panel, END_CROSS_SURFACE_LINE } = await import("../src/renderer/src/components/Panel.tsx");
const { Conversation } = await import("../src/renderer/src/components/Conversation.tsx");
const { useStore } = await import("@/lib/store");

after(() => dom.window.close());

const A = { id: "agent-a", name: "a", registeredName: "a", url: "https://a.example", accent: "#000", status: "online" };

const row = (id, status) => ({
  id,
  title: `title ${id}`,
  surface: "chat",
  trigger: "http",
  status,
  createdAt: "2026-10-19T09:00:00.000Z",
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
});

function installBridge() {
  const resets = [];
  const manage = [];
  const sends = [];
  window.studio = new Proxy(
    {
      resetSession: async (input) => {
        resets.push(input);
      },
      manage: async ({ path }) => {
        manage.push(path);
        return { ok: false, status: 404 };
      },
      send: async (input) => {
        sends.push(input);
        return new Promise(() => {});
      },
      saveState: async () => true,
      loadState: async () => null,
    },
    {
      // `on…` subscriptions hand back an unsubscribe; everything else answers nothing.
      get: (target, key) =>
        key in target ? target[key] : typeof key === "string" && key.startsWith("on") ? () => () => {} : async () => undefined,
    },
  );
  return { resets, manage, sends };
}

async function settle(ms = 0) {
  await act(async () => {
    await sleep(ms);
  });
}

async function mount(component = Panel) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(component));
  });
  await settle();
  return {
    host,
    text: () => host.textContent ?? "",
    dialog: () => host.querySelector('[role="alertdialog"]'),
    button: (label) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label),
    labelled: (label) => host.querySelector(`button[aria-label="${label}"]`),
    rowButton: (title) =>
      [...host.querySelectorAll("button.routine-row")].find((b) => b.querySelector(".routine-row__name")?.textContent === title),
    rowDetail: (title) =>
      [...host.querySelectorAll("button.routine-row")]
        .find((b) => b.querySelector(".routine-row__name")?.textContent === title)
        ?.textContent ?? "",
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

function reset({ panel = "conversations", sessionId, listed, filter = "all", archived }) {
  useStore.setState({
    agents: [A],
    activeAgentId: A.id,
    panel,
    prefs: { [A.id]: { threadFilter: filter, ...(archived ? { archived } : {}) } },
    agentSessions: { [A.id]: { filter, sessions: listed } },
    threadIndex: { [A.id]: Object.fromEntries(listed.map((s) => [s.id, s])) },
    routinesSessions: {},
    sessions: { [A.id]: sessionId },
    sessionChoice: {},
    conversations: { [A.id]: [] },
    inflight: {},
    details: {},
  });
}

test("AC2b: a live row has its own End, behind the full confirmation — Cancel sends nothing, confirming ends that row's thread only", async () => {
  const bridge = installBridge();
  reset({ sessionId: "live-1", listed: [row("live-1", "alive"), row("live-2", "alive")] });
  const view = await mount();

  await click(view.labelled("End title live-2"));
  assert.equal(bridge.resets.length, 0, "opening the confirmation ended something");
  const says = view.dialog()?.textContent ?? "";
  assert.ok(says.includes("title live-2"), `the confirmation does not name the row's thread: ${says}`);
  assert.ok(says.includes("with a?"), says);
  assert.ok(says.includes("stored"), says);
  assert.ok(says.includes("cannot be continued"), says);
  assert.ok(says.includes("working memory"), says);
  assert.ok(says.includes(END_CROSS_SURFACE_LINE), "a live thread's confirmation lacks the cross-surface line");
  assert.ok(!/delet/i.test(says), "the confirmation talks about deleting");
  assert.ok(!/archiv/i.test(says), "the End confirmation talks about archiving");

  await click(view.button("Cancel"));
  assert.ok(!view.dialog(), "Cancel did not close the confirmation");
  assert.equal(bridge.resets.length, 0, "Cancel sent a reset");

  await click(view.labelled("End title live-2"));
  await click(view.button("End conversation"));
  await settle(10);
  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["live-2"], "End reset the wrong thread");
  assert.equal(useStore.getState().sessions[A.id], "live-1", "ending another row moved the chat");
  assert.equal(useStore.getState().prefs[A.id]?.archived, undefined, "End archived the thread");
  await view.unmount();
});

test("AC2b: a thread already ended or failed offers no End", async () => {
  installBridge();
  reset({ sessionId: undefined, listed: [row("live-1", "alive"), row("old-1", "ended"), row("old-2", "failed")] });
  const view = await mount();
  assert.ok(view.labelled("End title live-1"), "a live thread has no End");
  assert.ok(!view.labelled("End title old-1"), "an ended thread offers End");
  assert.ok(!view.labelled("End title old-2"), "a failed thread offers End");
  await view.unmount();
});

test("AC2: Archive hides the row without calling the agent; Show archived lists it; Unarchive brings it back", async () => {
  const bridge = installBridge();
  reset({ sessionId: undefined, listed: [row("live-1", "alive"), row("live-2", "alive")] });
  const view = await mount();
  const before = bridge.manage.length;

  await click(view.labelled("Archive title live-2"));
  assert.ok(!view.rowButton("title live-2"), "the archived thread is still in the list");
  assert.ok(view.rowButton("title live-1"), "archiving hid the wrong thread");
  assert.deepEqual(bridge.manage.slice(before), [], "archiving called the agent");
  assert.equal(bridge.resets.length, 0, "archiving ended the thread");

  await click(view.button("Show archived"));
  assert.ok(view.rowButton("title live-2"), "Show archived does not list the archived thread");
  assert.ok(view.labelled("Unarchive title live-2"), "the archived thread has no Unarchive");
  assert.ok(!view.labelled("End title live-2"), "End is offered from the archived list");

  await click(view.labelled("Unarchive title live-2"));
  await click(view.button("Hide archived"));
  assert.ok(view.rowButton("title live-2"), "Unarchive did not bring the thread back");
  assert.deepEqual(useStore.getState().prefs[A.id]?.archived, []);
  assert.equal(bridge.resets.length, 0);
  await view.unmount();
});

test("AC6: ended-not-archived stays in the list; archived-but-alive is only under Archived; the archived list is not the ended list", async () => {
  installBridge();
  reset({
    sessionId: undefined,
    listed: [row("live-1", "alive"), row("live-2", "alive"), row("old-1", "ended"), row("old-2", "ended")],
    archived: ["live-2", "old-2"],
  });
  const view = await mount();

  assert.ok(view.rowButton("title old-1"), "an ended thread the person never archived is hidden");
  assert.ok(!view.rowButton("title live-2"), "an archived live thread is still in the list");

  await click(view.button("Show archived"));
  const archivedRows = [...view.host.querySelectorAll("button.routine-row")]
    .map((b) => b.querySelector(".routine-row__name")?.textContent)
    .filter((t) => t === "title live-2" || t === "title old-2" || t === "title old-1");
  // old-1 appears once (the main list); live-2 and old-2 once each (Archived).
  assert.deepEqual(archivedRows.sort(), ["title live-2", "title old-1", "title old-2"], `rows: ${archivedRows}`);
  assert.ok(!view.rowDetail("title live-2").includes("ended"), "an archived live thread is labelled ended");
  assert.ok(view.rowDetail("title old-2").includes("ended"), "an archived ended thread lost its ended label");
  await view.unmount();
});

test("AC6: an archived thread the agent no longer lists still appears under Archived, and can be unarchived", async () => {
  installBridge();
  reset({ sessionId: undefined, listed: [row("live-1", "alive")], archived: ["gone-1"] });
  useStore.setState({ threadIndex: { [A.id]: { "live-1": row("live-1", "alive") } } });
  const view = await mount();
  await click(view.button("Show archived"));
  assert.ok(view.labelled("Unarchive A conversation not listed by the agent right now"), "an unlisted archived thread cannot be unarchived");
  await view.unmount();
});

test("AC7: ended and failed threads are findable under All and both read as ended — never as an error", async () => {
  installBridge();
  reset({ sessionId: undefined, listed: [row("old-1", "ended"), row("old-2", "failed")] });
  const view = await mount();
  for (const title of ["title old-1", "title old-2"]) {
    const detail = view.rowDetail(title);
    assert.ok(detail.includes("· ended"), `${title} is not labelled ended: ${detail}`);
    assert.ok(!/fail|error/i.test(detail), `${title} reads as a failure: ${detail}`);
  }
  await view.unmount();
});

test("AC9: the overview's count leaves archived threads out and follows the list without reopening", async () => {
  installBridge();
  reset({ panel: "overview", sessionId: undefined, filter: "active", listed: [row("live-1", "alive"), row("live-2", "alive"), row("live-3", "alive")], archived: ["live-3"] });
  const view = await mount();
  assert.ok(view.rowDetail("Show conversations").includes("2 active threads"), view.rowDetail("Show conversations"));

  // What a refresh delivers: a thread started elsewhere.
  await act(async () => {
    useStore.setState((s) => ({
      agentSessions: { [A.id]: { filter: "active", sessions: [...s.agentSessions[A.id].sessions, row("live-4", "alive")] } },
    }));
  });
  assert.ok(view.rowDetail("Show conversations").includes("3 active threads"), view.rowDetail("Show conversations"));
  await view.unmount();
});

test("AC3b: a retired thread opens with no composer, says why, and offers a new conversation", async () => {
  const bridge = installBridge();
  reset({ panel: "none", sessionId: "old-1", listed: [row("old-1", "ended")] });
  const view = await mount(Conversation);

  assert.ok(!view.host.querySelector('[role="textbox"]'), "a retired thread has a composer");
  assert.ok(view.text().includes("This conversation has ended"), "no reason is given");
  await click(view.button("New conversation"));
  assert.equal(useStore.getState().sessions[A.id], undefined, "New conversation did not leave the retired thread");
  assert.ok(view.host.querySelector('[role="textbox"]'), "the new conversation has no composer");
  assert.equal(bridge.resets.length, 0, "New conversation ended something");
  await view.unmount();
});

test("AC3b: failed counts as retired too", async () => {
  installBridge();
  reset({ panel: "none", sessionId: "old-2", listed: [row("old-2", "failed")] });
  const view = await mount(Conversation);
  assert.ok(!view.host.querySelector('[role="textbox"]'), "a failed thread has a composer");
  await view.unmount();
});

test("AC3b control: a live thread, and one the agent has not listed yet, keep the composer", async () => {
  installBridge();
  reset({ panel: "none", sessionId: "live-1", listed: [row("live-1", "alive")] });
  let view = await mount(Conversation);
  assert.ok(view.host.querySelector('[role="textbox"]'), "a live thread lost its composer");
  assert.ok(!view.text().includes("This conversation has ended"));
  await view.unmount();

  reset({ panel: "none", sessionId: "unlisted", listed: [] });
  view = await mount(Conversation);
  assert.ok(view.host.querySelector('[role="textbox"]'), "a thread not yet listed lost its composer");
  await view.unmount();
});
