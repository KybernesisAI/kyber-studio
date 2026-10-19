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

function reset({ panel, sessionId, listed = [row("live-1", "alive"), row("live-2", "alive")] }) {
  useStore.setState({
    agents: [A],
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

test("AC8: Settings' End asks first, names the thread, warns across surfaces, never says delete — and Cancel sends nothing", async () => {
  const bridge = installBridge();
  reset({ panel: "settings", sessionId: "live-1" });
  const view = await mount();

  assert.ok(view.text().includes("End this conversation"), "the Settings row is not labelled End this conversation");
  assert.equal(view.button("Reset"), undefined, "the old one-click Reset button is still there");
  await click(view.button("End…"));
  assert.equal(bridge.resets.length, 0, "opening the confirmation ended something");

  const dialog = view.dialog();
  assert.ok(dialog, "no confirmation opened");
  const says = dialog.textContent ?? "";
  assert.ok(says.includes("title live-1"), `the confirmation does not name the thread: ${says}`);
  assert.ok(says.includes("last active 5 min ago"), `the confirmation does not say when it was last active: ${says}`);
  assert.ok(says.includes("cannot be continued"), says);
  assert.ok(says.includes("working memory"), says);
  assert.ok(says.includes(END_CROSS_SURFACE_LINE), "an alive thread's confirmation lacks the cross-surface line");
  assert.ok(!/delet/i.test(says), "the confirmation talks about deleting");

  await click(view.button("Cancel"));
  assert.equal(view.dialog(), null, "Cancel did not close the confirmation");
  assert.equal(bridge.resets.length, 0, "Cancel sent a reset");
  assert.equal(useStore.getState().sessions[A.id], "live-1", "Cancel moved the chat");
  await view.unmount();
});

test("AC4 + AC8: the thread ended is the one the confirmation named, even if the chat moved while it was open", async () => {
  const bridge = installBridge();
  reset({ panel: "settings", sessionId: "live-1" });
  const view = await mount();

  await click(view.button("End…"));
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

  await click(view.button("End…"));
  await click(view.button("End conversation"));

  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["live-1"]);
  const st = useStore.getState();
  assert.equal(st.sessions[A.id], undefined);
  assert.equal(st.sessionChoice[A.id]?.sessionId, null);
  assert.equal(view.dialog(), null);
  await view.unmount();
});

test("an ended thread's confirmation leaves out the cross-surface line; with no thread, End is disabled", async () => {
  installBridge();
  reset({ panel: "settings", sessionId: "live-1", listed: [row("live-1", "ended")] });
  let view = await mount();
  await click(view.button("End…"));
  assert.ok(!(view.dialog()?.textContent ?? "").includes(END_CROSS_SURFACE_LINE), "an ended thread was warned about as if live");
  await view.unmount();

  reset({ panel: "settings", sessionId: undefined });
  view = await mount();
  assert.equal(view.button("End…")?.disabled, true, "End is offered with no conversation to end");
  await view.unmount();
});
