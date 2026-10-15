import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * KYB-621: the "What agents may do on this computer" card, MOUNTED, with a save
 * that is refused. Before KYB-621 the rejection went unhandled: the select
 * snapped back and nothing said why. The bridge here rejects the way Electron's
 * `ipcRenderer.invoke` does when the main-process handler throws — a plain
 * Error carrying the handler's message — and the card must say so.
 *
 * That the handler DOES throw when the permissions file cannot be written is
 * pinned in test/mcp-ipc-handlers.test.mjs; this file starts at the bridge.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
for (const name of ["HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Element", "Node", "Event",
  "MouseEvent", "KeyboardEvent", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "MutationObserver"]) {
  globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { LocalPermissions } = await import("../src/renderer/src/components/Panel.tsx");

after(() => dom.window.close());

const ALL_ASK = {
  "run-command": "ask",
  "read-file": "ask",
  "write-file": "ask",
  "list-directory": "ask",
  "local-mcp": "ask",
};

async function settle() {
  await act(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  });
}

async function mount(setLocalPermission) {
  dom.window.studio = { localPermissions: async () => ({ ...ALL_ASK }), setLocalPermission };
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(LocalPermissions)));
  await settle();
  return { host, unmount: () => act(() => root.unmount()) };
}

async function choose(select, value) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  });
  await settle();
}

const alertText = (host) => host.querySelector('[role="alert"]')?.textContent ?? null;

test("a refused save is shown on the card, and the select keeps the value that was actually saved", async () => {
  const refused = new Error(
    "Error invoking remote method 'studio:setLocalPermission': Error: EPERM: operation not permitted, rename",
  );
  const { host, unmount } = await mount(async () => {
    throw refused;
  });
  const select = host.querySelector("select");
  assert.ok(select, "the card did not render");
  assert.equal(alertText(host), null, "an error was showing before anything failed");

  await choose(select, "always");

  assert.match(alertText(host) ?? "", /Could not save that setting: .*EPERM/);
  assert.equal(select.value, "ask", "the select claims a value that was never saved");
  await unmount();
});

test("a save that then succeeds clears the message and shows the saved value", async () => {
  let refuse = true;
  const { host, unmount } = await mount(async ({ action, value }) => {
    if (refuse) throw new Error("EPERM: operation not permitted, rename");
    return { ...ALL_ASK, [action]: value };
  });
  const select = host.querySelector("select");

  await choose(select, "never");
  assert.notEqual(alertText(host), null);

  refuse = false;
  await choose(select, "never");
  assert.equal(alertText(host), null, "the stale error stayed after a good save");
  assert.equal(select.value, "never");
  await unmount();
});
