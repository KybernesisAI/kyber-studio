import { after, afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-677: the computer view closes on Ctrl+Esc (⌘+Esc on macOS) even after a
 * click into the remote screen.
 *
 * Once the screen has focus, noVNC's keydown listener on its canvas calls
 * stopPropagation() on every key, so nothing bubbles up to `window`. The
 * stand-in below plays that canvas: it is attached to the page (a detached
 * element has only itself in the event path, so nothing would reach `window`
 * either way) and its own listener stops every keydown. Only a listener on
 * `window` in the capture phase hears the chord before it does.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
// noVNC builds a MutationObserver when it is imported.
for (const name of ["HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ComputerView } = await import("../src/renderer/src/components/Computer.tsx");
const { useStore } = await import("@/lib/store");

after(() => dom.window.close());

const AGENT = { id: "agent-a", name: "a", registeredName: "a", url: "https://a.example", accent: "#000", status: "online" };

// The agent refuses a ticket, so no real RFB connection is attempted and the
// view settles on "failed". The keyboard shortcut does not depend on the phase.
window.studio = new Proxy(
  { manage: async () => ({ ok: false, status: 404, data: null }) },
  { get: (target, key) => (key in target ? target[key] : async () => undefined) },
);

let view;
let canvas;

beforeEach(async () => {
  useStore.setState({ agents: [AGENT], activeAgentId: AGENT.id, computerOpen: true });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ComputerView));
  });
  await act(async () => {
    await sleep(0);
  });
  assert.ok(host.querySelector(".computer-view"), "the computer view is not on screen");

  // The noVNC canvas stand-in, attached to the page, swallowing every keydown.
  canvas = document.createElement("canvas");
  canvas.received = [];
  canvas.addEventListener("keydown", (e) => {
    canvas.received.push({ key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, defaultPrevented: e.defaultPrevented });
    e.stopPropagation();
  });
  document.body.appendChild(canvas);

  view = { host, unmount: () => act(() => root.unmount()).then(() => host.remove()) };
});

afterEach(async () => {
  await view.unmount();
  canvas.remove();
});

async function press(init) {
  const e = new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    canvas.dispatchEvent(e);
  });
  return e;
}

test("Ctrl+Esc on the focused screen closes the view and is kept from the computer", async () => {
  const e = await press({ key: "Escape", ctrlKey: true });
  assert.equal(useStore.getState().computerOpen, false, "Ctrl+Esc did not close the view");
  assert.equal(e.defaultPrevented, true, "the chord's default action was not prevented");
  assert.deepEqual(canvas.received, [], "the chord reached the computer's canvas");
});

test("⌘+Esc on the focused screen closes the view and is kept from the computer", async () => {
  const e = await press({ key: "Escape", metaKey: true });
  assert.equal(useStore.getState().computerOpen, false, "⌘+Esc did not close the view");
  assert.equal(e.defaultPrevented, true, "the chord's default action was not prevented");
  assert.deepEqual(canvas.received, [], "the chord reached the computer's canvas");
});

test("plain Esc goes to the computer and leaves the view open", async () => {
  const e = await press({ key: "Escape" });
  assert.equal(useStore.getState().computerOpen, true, "plain Esc closed the view");
  assert.deepEqual(canvas.received, [{ key: "Escape", ctrl: false, meta: false, defaultPrevented: false }], "plain Esc did not reach the canvas untouched");
  assert.equal(e.defaultPrevented, false);
});

test("another Ctrl chord goes to the computer and leaves the view open", async () => {
  const e = await press({ key: "k", ctrlKey: true });
  assert.equal(useStore.getState().computerOpen, true, "Ctrl+K closed the view");
  assert.deepEqual(canvas.received, [{ key: "k", ctrl: true, meta: false, defaultPrevented: false }], "Ctrl+K did not reach the canvas untouched");
  assert.equal(e.defaultPrevented, false);
});

test("once the view has closed, its listener is gone and Ctrl+Esc reaches the page untouched", async () => {
  await press({ key: "Escape", ctrlKey: true });
  assert.equal(useStore.getState().computerOpen, false);
  canvas.received.length = 0;

  const e = await press({ key: "Escape", ctrlKey: true });
  assert.deepEqual(canvas.received, [{ key: "Escape", ctrl: true, meta: false, defaultPrevented: false }], "a listener from the closed view still caught Ctrl+Esc");
  assert.equal(e.defaultPrevented, false);
});
