import { after, afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-677: closing the computer view leaves no modifier held on the computer.
 *
 * Ctrl+Esc (⌘+Esc on macOS) closes the view once the screen has focus, but the
 * Ctrl went down on the computer before the Esc arrived, and noVNC's own
 * clean-up sends nothing once it is disconnecting. So the view releases every
 * modifier while still connected, and disconnects a moment later: a relay may
 * drop key events that reach it together with the close (websockify does).
 *
 * noVNC is replaced by a fake that records what the view asks of it, in order,
 * with the time of each call.
 */

const calls = [];
let now = 0;
class FakeRFB extends EventTarget {
  constructor(target, url) {
    super();
    this.target = target;
    this.url = url;
    FakeRFB.instances.push(this);
  }
  sendKey(keysym, code, down) {
    calls.push({ at: now, call: "sendKey", keysym, code, down });
  }
  disconnect() {
    calls.push({ at: now, call: "disconnect", rfb: FakeRFB.instances.indexOf(this) });
  }
  blur() {}
  focus() {}
}
FakeRFB.instances = [];
mock.module("@novnc/novnc", { exports: { default: FakeRFB } });

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const name of ["HTMLElement", "Element", "Node", "Event", "KeyboardEvent", "MouseEvent", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]) {
  globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const realSetTimeout = globalThis.setTimeout;
const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ComputerView, RELEASE_BEFORE_DISCONNECT_MS } = await import("../src/renderer/src/components/Computer.tsx");
const { useStore } = await import("@/lib/store");

after(() => dom.window.close());

const AGENT = { id: "agent-a", name: "a", registeredName: "a", url: "https://a.example", accent: "#000", status: "online" };

// The agent hands over a ticket, so the view builds its (fake) RFB.
window.studio = new Proxy(
  {
    manage: async () => ({
      ok: true,
      status: 200,
      data: { ticket: "t", path: "/computer/socket", computer: { screen: { width: 1280, height: 800 } }, credentials: null },
    }),
  },
  { get: (target, key) => (key in target ? target[key] : async () => undefined) },
);

// Every modifier, left and right, by the keysym noVNC sends for it.
const MODIFIERS = {
  Control_L: 0xffe3,
  Control_R: 0xffe4,
  Shift_L: 0xffe1,
  Shift_R: 0xffe2,
  Alt_L: 0xffe9,
  Alt_R: 0xffea,
  Super_L: 0xffeb,
  Super_R: 0xffec,
  Meta_L: 0xffe7,
  Meta_R: 0xffe8,
};

let view;

beforeEach(async () => {
  calls.length = 0;
  FakeRFB.instances.length = 0;
  now = 0;
  mock.timers.enable({ apis: ["setTimeout"] });
  useStore.setState({ agents: [AGENT], activeAgentId: AGENT.id, computerOpen: true });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(ComputerView));
  });
  await act(async () => {
    await flush();
  });
  assert.equal(FakeRFB.instances.length, 1, "the view did not connect to the screen");
  view = { host, root };
});

afterEach(async () => {
  await act(async () => {
    view.root.unmount();
  });
  view.host.remove();
  mock.timers.reset();
});

/** Advance the fake clock, keeping `now` in step for the call log. */
function tick(ms) {
  now += ms;
  mock.timers.tick(ms);
}

async function closeWithChord() {
  const canvas = view.host.querySelector(".computer-view__stage") ?? document.body;
  await act(async () => {
    canvas.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", ctrlKey: true, bubbles: true, cancelable: true }));
  });
  assert.equal(useStore.getState().computerOpen, false, "Ctrl+Esc did not close the view");
}

test("closing with Ctrl+Esc releases every modifier, then disconnects", async () => {
  await closeWithChord();

  const releases = calls.filter((c) => c.call === "sendKey");
  for (const [name, keysym] of Object.entries(MODIFIERS)) {
    assert.ok(
      releases.some((c) => c.keysym === keysym && c.down === false),
      `no release was sent for ${name}`,
    );
  }
  assert.ok(releases.every((c) => c.down === false), "something other than a release was sent");

  tick(RELEASE_BEFORE_DISCONNECT_MS);
  const disconnects = calls.filter((c) => c.call === "disconnect");
  assert.equal(disconnects.length, 1, "the screen was not disconnected");
  const lastRelease = Math.max(...calls.map((c, i) => (c.call === "sendKey" ? i : -1)));
  assert.ok(calls.indexOf(disconnects[0]) > lastRelease, "the screen was disconnected before the releases were sent");
});

test("the disconnect waits, so the releases do not arrive together with the close", async () => {
  await closeWithChord();

  assert.equal(calls.filter((c) => c.call === "disconnect").length, 0, "the screen was disconnected in the same moment as the releases");
  tick(RELEASE_BEFORE_DISCONNECT_MS - 1);
  assert.equal(calls.filter((c) => c.call === "disconnect").length, 0, "the screen was disconnected before the grace period ended");
  tick(1);
  assert.equal(calls.filter((c) => c.call === "disconnect").length, 1, "the screen was not disconnected after the grace period");
  assert.ok(RELEASE_BEFORE_DISCONNECT_MS >= 100, `a grace period of ${RELEASE_BEFORE_DISCONNECT_MS} ms is too short to separate the releases from the close`);
});

test("closing with the button releases the modifiers too", async () => {
  const button = view.host.querySelector(".computer-view__close");
  assert.ok(button, "no close button");
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  });
  assert.equal(useStore.getState().computerOpen, false);
  assert.ok(
    calls.some((c) => c.call === "sendKey" && c.keysym === MODIFIERS.Control_L && c.down === false),
    "closing with the button released nothing",
  );
  tick(RELEASE_BEFORE_DISCONNECT_MS);
  assert.equal(calls.filter((c) => c.call === "disconnect").length, 1);
});
