import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-657, AC2: what the chat shows where the agent no longer has the
 * conversation, MOUNTED and PRESSED. It says so, and offers the way forward:
 * a new conversation, or on an agent that keeps one thread per person, that
 * thread. Once the person has carried on below it, it offers nothing.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const name of ["HTMLElement", "Element", "Node", "Event", "MouseEvent"]) globalThis[name] = dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GoneNotice, GONE_LINE } = await import("../src/renderer/src/components/GoneNotice.tsx");

after(() => dom.window.close());

async function mount(props) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(GoneNotice, props)));
  return { host, unmount: () => act(async () => root.unmount()) };
}

function recorder() {
  const pressed = [];
  return {
    pressed,
    onNewConversation: () => pressed.push("new"),
  };
}

test("it names the agent and says the next message starts a new conversation", async () => {
  const r = recorder();
  const { host, unmount } = await mount({ agentName: "mikasa", oneThread: false, hasCopy: true, showAction: true, ...r });
  assert.match(host.textContent, new RegExp(`${GONE_LINE} mikasa`));
  assert.match(host.textContent, /What is above is this device's copy/);
  assert.match(host.textContent, /starts a new conversation/);
  const button = host.querySelector("button");
  assert.equal(button.textContent, "New conversation");
  await act(async () => button.click());
  assert.deepEqual(r.pressed, ["new"]);
  await unmount();
});

test("on an agent that keeps one thread per person it only says why: the composer offers the way back", async () => {
  const r = recorder();
  const { host, unmount } = await mount({ agentName: "mikasa", oneThread: true, hasCopy: false, showAction: true, ...r });
  assert.match(host.textContent, new RegExp(`${GONE_LINE} mikasa`));
  assert.match(host.textContent, /Studio has no copy of it on this device/);
  assert.doesNotMatch(host.textContent, /What is above/);
  assert.doesNotMatch(host.textContent, /Anything you send/);
  assert.equal(host.querySelector("button"), null);
  await unmount();
});

test("once the person has carried on below it, it offers nothing", async () => {
  const { host, unmount } = await mount({ agentName: "mikasa", oneThread: false, hasCopy: true, showAction: false, ...recorder() });
  assert.match(host.textContent, new RegExp(GONE_LINE));
  assert.equal(host.querySelector("button"), null);
  await unmount();
});
