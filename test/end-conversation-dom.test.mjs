import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-649, PR 1: the two buttons that used to retire a session, MOUNTED and
 * PRESSED.
 *
 * - The drawer's "New conversation" sends nothing to the agent (AC1).
 * - Settings' "End this conversation" asks first, names the thread it will
 *   end, and ends exactly that thread — even when the chat has moved to
 *   another one while the confirmation was open (AC4, AC8).
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
const { Panel, END_CROSS_SURFACE_LINE } = await import("../src/renderer/src/components/Panel.tsx");
const { useStore } = await import("@/lib/store");

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
  updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
});

function installBridge() {
  const resets = [];
  window.studio = new Proxy(
    {
      resetSession: async (input) => {
        resets.push(input);
      },
      manage: async () => ({ ok: false, status: 404 }),
      saveState: async () => true,
      loadState: async () => null,
    },
    { get: (target, key) => (key in target ? target[key] : async () => undefined) },
  );
  return { resets };
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
    dialog: () => host.querySelector('[role="alertdialog"]'),
    button: (label) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label),
    labelled: (label) => host.querySelector(`button[aria-label="${label}"]`),
    rowButton: (title) =>
      [...host.querySelectorAll("button.routine-row")].find((b) => b.querySelector(".routine-row__name")?.textContent === title),
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

/**
 * KYB-666: what the confirmation says is left once a conversation is ended.
 * It is kept on this device only for the thread's own conversation on an agent
 * that keeps one thread; elsewhere the agent may delete it, and nothing is kept.
 */
const MAY_DELETE = "may also delete its history of it, after which it cannot be read again, here or anywhere else";
const STAYS_HERE = "what is on screen stays on this device";
function assertNeverStored(says) {
  assert.ok(!/stays stored|still read/i.test(says), `the confirmation says it can still be read: ${says}`);
}

function reset({ panel, sessionId, listed = [row("live-1", "alive"), row("live-2", "alive")] }) {
  useStore.setState({
    agents: [A, B],
    activeAgentId: A.id,
    panel,
    prefs: {},
    agentSessions: { [A.id]: { filter: "active", sessions: listed } },
    routinesSessions: {},
    sessions: { [A.id]: sessionId },
    sessionChoice: {},
    conversations: { [A.id]: [{ kind: "text", id: "b1", role: "agent", text: "earlier", at: Date.now() - 60_000 }] },
    inflight: {},
    details: {},
    threads: {},
    threadCopy: {},
    keepsThread: {},
  });
}

test("AC1: the drawer's New conversation sends nothing to the agent and leaves the chat empty", async () => {
  const bridge = installBridge();
  reset({ panel: "conversations", sessionId: "live-1" });
  const view = await mount();

  await click(view.rowButton("New conversation"));

  assert.equal(bridge.resets.length, 0, `New conversation sent ${bridge.resets.length} reset(s)`);
  const st = useStore.getState();
  assert.equal(st.sessions[A.id], undefined);
  assert.deepEqual(st.conversations[A.id], []);
  assert.equal(st.sessionChoice[A.id]?.sessionId, null);
  await view.unmount();
});

test("AC8: Settings' End asks first, names the thread, warns across surfaces, says what is lost, and Cancel sends nothing", async () => {
  const bridge = installBridge();
  reset({ panel: "settings", sessionId: "live-1" });
  const view = await mount();

  assert.equal(view.button("Reset"), undefined, "the old one-click Reset button is still there");
  await click(view.button("End this conversation"));
  assert.equal(bridge.resets.length, 0, "opening the confirmation ended something");

  const dialog = view.dialog();
  assert.ok(dialog, "no confirmation opened");
  const says = dialog.textContent ?? "";
  assert.ok(says.includes("title live-1"), `the confirmation does not name the thread: ${says}`);
  assert.ok(says.includes("with a?"), `the confirmation does not name the agent: ${says}`);
  assert.ok(says.includes("last active 5 min ago"), `the confirmation does not say when it was last active: ${says}`);
  assert.ok(says.includes("cannot be continued"), says);
  assert.ok(says.includes("working memory"), says);
  assert.ok(says.includes(END_CROSS_SURFACE_LINE), "an alive thread's confirmation lacks the cross-surface line");
  // KYB-666 AC1 and AC3: on an agent with many conversations, nothing of it is kept.
  assertNeverStored(says);
  assert.ok(says.includes(MAY_DELETE), `the agent's deleting it is not said: ${says}`);
  assert.ok(!says.includes(STAYS_HERE), `a transcript is promised that is not kept: ${says}`);

  await click(view.button("Cancel"));
  assert.ok(!view.dialog(), "Cancel did not close the confirmation");
  assert.equal(bridge.resets.length, 0, "Cancel sent a reset");
  assert.equal(useStore.getState().sessions[A.id], "live-1", "Cancel moved the chat");
  await view.unmount();
});

test("AC4 + AC8: the thread ended is the one the confirmation named, even if the chat moved while it was open", async () => {
  const bridge = installBridge();
  reset({ panel: "settings", sessionId: "live-1" });
  const view = await mount();

  await click(view.button("End this conversation"));
  // An adoption lands while the confirmation is open.
  await act(async () => {
    useStore.setState((s) => ({ sessions: { ...s.sessions, [A.id]: "live-2" } }));
  });
  assert.ok((view.dialog()?.textContent ?? "").includes("title live-1"), "the confirmation changed what it names");

  await click(view.button("End conversation"));
  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["live-1"], "the reset went to the wrong thread");
  assert.deepEqual(bridge.resets.map((r) => r.url), [A.url]);
  assert.equal(useStore.getState().sessions[A.id], "live-2", "ending a thread no longer on screen moved the chat");
  await view.unmount();
});

test("AC8: confirming on the thread on screen ends it and leaves the chat on a new conversation", async () => {
  const bridge = installBridge();
  reset({ panel: "settings", sessionId: "live-1" });
  const view = await mount();

  await click(view.button("End this conversation"));
  await click(view.button("End conversation"));

  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["live-1"]);
  const st = useStore.getState();
  assert.equal(st.sessions[A.id], undefined);
  assert.equal(st.sessionChoice[A.id]?.sessionId, null);
  assert.ok(!view.dialog());
  await view.unmount();
});

test("an ended thread's confirmation leaves out the cross-surface line; with no thread, End is disabled", async () => {
  installBridge();
  reset({ panel: "settings", sessionId: "live-1", listed: [row("live-1", "ended")] });
  let view = await mount();
  await click(view.button("End this conversation"));
  assert.ok(!(view.dialog()?.textContent ?? "").includes(END_CROSS_SURFACE_LINE), "an ended thread was warned about as if live");
  await view.unmount();

  reset({ panel: "settings", sessionId: undefined });
  view = await mount();
  assert.equal(view.button("End this conversation")?.disabled, true, "End is offered with no conversation to end");
  await view.unmount();
});

test("AC2b: a thread the agent has not listed is named from its transcript, and keeps that name if the chat moves while open", async () => {
  const bridge = installBridge();
  reset({ panel: "settings", sessionId: "live-1", listed: [] });
  const view = await mount();

  await click(view.button("End this conversation"));
  const before = view.dialog()?.textContent ?? "";
  assert.ok(before.includes("earlier"), `not named from the transcript: ${before}`);
  assert.ok(before.includes("last active 1 min ago"), before);
  assert.ok(before.includes(END_CROSS_SURFACE_LINE), "an unlisted thread lacks the cross-surface line");

  await act(async () => {
    useStore.setState((s) => ({ sessions: { ...s.sessions, [A.id]: "live-2" }, conversations: { ...s.conversations, [A.id]: [] } }));
  });
  assert.equal(view.dialog()?.textContent ?? "", before, "the confirmation changed what it says while open");

  await click(view.button("End conversation"));
  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["live-1"]);
  await view.unmount();
});

test("switching agent closes an open confirmation without ending anything", async () => {
  const bridge = installBridge();
  reset({ panel: "settings", sessionId: "live-1" });
  const view = await mount();

  await click(view.button("End this conversation"));
  assert.ok(view.dialog());
  await act(async () => {
    useStore.setState({ activeAgentId: B.id });
  });
  await settle();
  assert.ok(!view.dialog(), "the confirmation for agent a is still open under agent b");
  await act(async () => {
    useStore.setState({ activeAgentId: A.id });
  });
  await settle();
  assert.ok(!view.dialog(), "the confirmation came back on switching back");
  assert.equal(bridge.resets.length, 0);
  await view.unmount();
});

/** An agent that keeps one thread, on `held`, with what that leaves on screen. */
function oneThread({ panel = "settings", held, pick = false, listed = [row("thread-1", "alive"), row("other-1", "alive")] }) {
  reset({ panel, sessionId: held, listed });
  useStore.setState({
    threads: { [A.id]: { current: "thread-1", sessions: [{ id: "thread-1" }], reports: [], fresh: [] } },
    ...(pick
      ? {
          sessionChoice: { [A.id]: { sessionId: held, fromDrawer: true, at: 1 } },
          threadCopy: { [A.id]: [{ kind: "text", id: "t1", role: "agent", text: "the thread's transcript", at: 1 }] },
        }
      : {}),
  });
}

test("KYB-666 AC1/AC2: ending the thread's own conversation on an agent that keeps one thread says what is on screen stays here, and it does", async () => {
  const bridge = installBridge();
  oneThread({ held: "thread-1" });
  const view = await mount();

  await click(view.button("End this conversation"));
  const says = view.dialog()?.textContent ?? "";
  assertNeverStored(says);
  assert.ok(says.includes(STAYS_HERE), `the transcript kept on this device is not said: ${says}`);
  assert.ok(says.includes("working memory"), says);
  assert.ok(!says.includes(MAY_DELETE), `told it cannot be read again, though it stays on screen: ${says}`);

  // Said when it opened: the chat moving meanwhile does not change it.
  await act(async () => {
    useStore.setState((s) => ({ sessions: { ...s.sessions, [A.id]: "other-1" } }));
  });
  assert.equal(view.dialog()?.textContent ?? "", says, "the confirmation changed what it says while open");
  await act(async () => {
    useStore.setState((s) => ({ sessions: { ...s.sessions, [A.id]: "thread-1" } }));
  });

  await click(view.button("End conversation"));
  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["thread-1"]);
  const conv = useStore.getState().conversations[A.id] ?? [];
  assert.ok(conv.some((b) => b.text === "earlier"), "what the confirmation said stays on screen did not");
  await view.unmount();
});

test("KYB-666 AC1/AC3: ending a drawer pick on screen, from Settings, says it may be deleted, and nothing of it is kept", async () => {
  const bridge = installBridge();
  oneThread({ held: "other-1", pick: true });
  const view = await mount();

  await click(view.button("End this conversation"));
  const says = view.dialog()?.textContent ?? "";
  assertNeverStored(says);
  assert.ok(says.includes(MAY_DELETE), says);
  assert.ok(!says.includes(STAYS_HERE), says);

  await click(view.button("End conversation"));
  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["other-1"]);
  const conv = useStore.getState().conversations[A.id] ?? [];
  assert.ok(!conv.some((b) => b.text === "earlier"), "the ended pick is still on screen, though it was said to be gone");
  assert.ok(conv.some((b) => b.text === "the thread's transcript"), "the thread did not come back");
  await view.unmount();
});

test("KYB-666 AC1/AC3: End on a drawer row of an agent that keeps one thread says it may be deleted", async () => {
  const bridge = installBridge();
  oneThread({ panel: "conversations", held: "thread-1" });
  const view = await mount();

  await click(view.labelled("End title other-1"));
  const says = view.dialog()?.textContent ?? "";
  assert.ok(says.includes("title other-1"), says);
  assertNeverStored(says);
  assert.ok(says.includes(MAY_DELETE), says);
  assert.ok(!says.includes(STAYS_HERE), says);

  await click(view.button("Cancel"));
  assert.equal(bridge.resets.length, 0);
  await view.unmount();
});
