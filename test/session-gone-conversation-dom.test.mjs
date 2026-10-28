import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-657: the gone notice and the composer inside the real conversation
 * view, MOUNTED and PRESSED. On an agent that keeps one thread, a gone
 * conversation opened from the drawer is read-only and offers the way back to
 * the thread; the notice says whether anything of it is on this device.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const name of ["HTMLElement", "Element", "Node", "Event", "MouseEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  globalThis[name] = dom.window[name];
}
globalThis.ResizeObserver = window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

window.studio = new Proxy(
  {
    manage: async () => ({ ok: false, status: 404 }),
    send: async () => new Promise(() => {}),
    saveState: async () => true,
    loadState: async () => null,
  },
  {
    get: (target, key) =>
      key in target ? target[key] : typeof key === "string" && key.startsWith("on") ? () => () => {} : async () => undefined,
  },
);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Conversation } = await import("../src/renderer/src/components/Conversation.tsx");
const { useStore } = await import("@/lib/store");

after(() => dom.window.close());

const A = { id: "agent-a", name: "a", registeredName: "a", url: "https://a.example", accent: "#000", status: "online" };
const DEAD = "wrun_DEAD";
const hello = { kind: "text", id: "u1", role: "user", text: "hello", at: 1 };
const notice = { kind: "gone", id: `gone-${DEAD}`, at: 2, sessionId: DEAD };

function reset({ thread, conversation, held = true }) {
  const sessionId = held ? DEAD : undefined;
  useStore.setState({
    agents: [A],
    activeAgentId: A.id,
    panel: "none",
    threads: { [A.id]: thread },
    threadIndex: {},
    sessions: { [A.id]: sessionId },
    sessionChoice: held ? { [A.id]: { sessionId, at: 1, fromDrawer: true } } : { [A.id]: { sessionId: null, at: 1 } },
    goneSessions: { [A.id]: [DEAD] },
    conversations: { [A.id]: conversation },
    inflight: {},
    details: {},
  });
}

async function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(Conversation)));
  await act(async () => sleep(0));
  return {
    host,
    text: () => host.textContent ?? "",
    button: (label) => [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label),
    unmount: () => act(() => root.unmount()).then(() => host.remove()),
  };
}

test("one thread: a gone drawer pick is read-only, says this device's copy is above, and Back to your thread leaves it", async () => {
  reset({ thread: { current: null, sessions: [], reports: [], fresh: [] }, conversation: [hello, notice] });
  const view = await mount();
  assert.ok(!view.host.querySelector('[role="textbox"]'), "no composer on a conversation the agent no longer has");
  assert.match(view.text(), /What is above is this device's copy/);
  assert.doesNotMatch(view.text(), /Anything you send/);
  assert.equal(view.button("New conversation"), undefined, "no Start fresh in disguise");
  const back = view.button("Back to your thread");
  assert.ok(back, "the way back is offered");
  await act(async () => back.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })));
  await act(async () => sleep(0));
  assert.equal(useStore.getState().sessions[A.id], undefined, "on the thread");
  await view.unmount();
});

test("one thread: with nothing of it on this device, the notice says so", async () => {
  reset({ thread: { current: null, sessions: [], reports: [], fresh: [] }, conversation: [notice] });
  const view = await mount();
  assert.match(view.text(), /Studio has no copy of it on this device/);
  await view.unmount();
});

test("many conversations: the notice keeps its New conversation, and the composer stays", async () => {
  reset({ thread: null, conversation: [hello, notice], held: false });
  const view = await mount();
  assert.ok(view.host.querySelector('[role="textbox"]'), `the composer is there: ${view.text()}`);
  assert.ok(view.button("New conversation"));
  assert.match(view.text(), /starts a new conversation/);
  await view.unmount();
});
