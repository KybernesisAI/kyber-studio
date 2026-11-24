import { after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * The local MCP panel under jsdom, for the KYB-696 tests that drive the add
 * and edit forms. The harness is `mcp-store-unavailable-dom.test.mjs`'s, moved
 * into one module so the new files share it rather than copy it a third and
 * fourth time.
 *
 * Importing this sets up the DOM globals and loads `Plugins.tsx`, so import it
 * dynamically, after any `mock.module` the test file needs: a main-process
 * module mocked afterwards would already be loaded for real.
 *
 * No jsdom node is ever the `actual` of an assertion: a failing one tries to
 * print it, and runs out of heap.
 */

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
for (const name of [
  "HTMLElement",
  "HTMLInputElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CustomEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]) {
  globalThis[name] = dom.window[name];
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Plugins } = await import("../../src/renderer/src/components/Plugins.tsx");
const { useStore } = await import("@/lib/store");

after(() => dom.window.close());

const AGENT = "agent-under-test";

export async function settle() {
  await act(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  });
}

/** Let a promise the form is waiting on resolve, and React render what follows. */
export async function flush() {
  await settle();
  await new Promise((resolve) => setImmediate(resolve));
  await settle();
}

export async function click(element) {
  assert.ok(element, "nothing to click");
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

export async function type(element, value) {
  assert.ok(element, "nothing to type into");
  const proto =
    element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  await act(async () => {
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

export async function mount(studio) {
  dom.window.studio = studio;
  useStore.setState({
    pluginsOpen: true,
    activeAgentId: AGENT,
    agents: [],
    details: {},
    catalog: {},
    manageError: null,
    installing: null,
  });
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Plugins));
  });
  await settle();
  const tab = [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("MCP servers"));
  assert.ok(tab, "the MCP tab is not on screen");
  await click(tab);
  return {
    host,
    unmount: () => act(() => root.unmount()).then(() => host.remove()),
  };
}

const label = (el) => (el.textContent ?? "").trim() || el.getAttribute("title") || "";
export const text = (el) => el?.textContent ?? "";

export function row(host, name) {
  return [...host.querySelectorAll(".pl__row")].find((r) => (r.querySelector(".pl__name")?.textContent ?? "") === name);
}

export function buttonIn(root, wanted) {
  return [...root.querySelectorAll("button")].find((b) => label(b) === wanted);
}

export async function menu(host, name, item) {
  const r = row(host, name);
  assert.ok(r, `no row named ${name}`);
  await click([...r.querySelectorAll("button")].find((b) => b.getAttribute("title") === "More"));
  const entry = [...row(host, name).querySelectorAll(".pl__menu button")].find((b) => label(b) === item);
  assert.ok(entry, `${name}'s menu has no ${item}`);
  await click(entry);
}

export function form(host) {
  return [...host.querySelectorAll(".card")].find((c) =>
    [...c.querySelectorAll(".field__label")].some((l) => l.textContent === "Command"),
  );
}

export function field(host, labelText) {
  const f = [...form(host).querySelectorAll(".field")].find(
    (x) => x.querySelector(".field__label")?.textContent === labelText,
  );
  return f?.querySelector("input");
}

export const envInput = (host, key) => form(host).querySelector(`input[aria-label="${key}"]`);
/** The eye on a stored key's row. */
export const eyeOf = (host, key) => envInput(host, key)?.closest(".pl__env")?.querySelector('button[title="Show"]');
/** The message under a stored key's row, if any: the text after its name. */
export const envRowMessage = (host, key) =>
  envInput(host, key)?.closest(".pl__env")?.querySelector(".muted")?.textContent ?? "";
export const envLines = (host) => form(host).querySelector("textarea");
/** The text of every notice in the form: the warning or the locked note. */
export const notices = (host) => [...form(host).querySelectorAll(".pl__notice")].map((n) => n.textContent ?? "");

/** A value as an earlier session, with the store available, would have sealed it. */
export const sealed = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;

export const local = (over = {}) => ({
  id: "kyb",
  name: "MCP kyb",
  command: "sh",
  args: ["-c", "exit 1"],
  enabled: true,
  ...over,
});

/**
 * A bridge holding a server list. `answer` is what `credentialStoreAvailable`
 * resolves to, called on each ask, so a test can hand it the main process's
 * real answer or hold it back. Every reveal answers `reveal`. Saves are
 * recorded and answered with what was sent.
 */
export function bridge({ answer, servers = [], reveal = { ok: false, reason: "store-unavailable" } } = {}) {
  let current = servers;
  const saves = [];
  let asks = 0;
  const api = {
    connectors: async () => ({ configured: true, connectors: [] }),
    mcpServers: async () => ({ ok: true, servers: current, heldKeys: {} }),
    credentialStoreAvailable: async () => {
      asks += 1;
      return answer ? answer() : undefined;
    },
    saveMcpServers: async (next) => {
      saves.push(structuredClone(next));
      current = next;
      return { ok: true, servers: next, heldKeys: {} };
    },
    revealMcpEnv: async () => reveal,
    openExternal: async () => {},
    testRemoteMcp: async () => ({ ok: true, tools: [] }),
    startMcpSignIn: async () => ({ ok: true }),
    disconnectService: async () => ({ ok: true }),
    connectMcpServer: async () => ({ ok: true, message: "" }),
    testMcpServer: async () => ({ ok: true, tools: ["a"] }),
  };
  return { api, saves, lastSaved: () => saves.at(-1), asks: () => asks };
}

/**
 * The three renderer messages about an unavailable store, read off the DOM
 * with `answer` as the availability answer (KYB-696 AC1 and AC3):
 *
 *  - the warning, on the add form;
 *  - the note, on the edit form of a server with a sealed value;
 *  - the eye's store-unavailable message, on the edit form of a server stored
 *    in plain text. In the product only a sealed value fails that way, and
 *    such a server is locked once the answer is in, so the message shows
 *    before the answer. A plain server is the one form that keeps its eye
 *    with the answer in, and the bridge's reveal answers store-unavailable
 *    for it, so what the renderer does with the answer's text can be read.
 */
export async function rendererMessages(answer) {
  const out = {};
  {
    const b = bridge({ answer });
    const panel = await mount(b.api);
    try {
      await click(buttonIn(panel.host, "Add one on this computer"));
      const said = notices(panel.host);
      assert.equal(said.length, 1, `the add form shows ${said.length} notices, not one warning`);
      out.warning = said[0];
    } finally {
      await panel.unmount();
    }
  }
  {
    const b = bridge({
      answer,
      servers: [local({ id: "kybsealed", name: "MCP kybsealed", env: { KYB_KEY: sealed("first") } })],
    });
    const panel = await mount(b.api);
    try {
      await menu(panel.host, "MCP kybsealed", "Edit");
      const said = notices(panel.host);
      assert.equal(said.length, 1, `the sealed server's form shows ${said.length} notices, not one note`);
      out.note = said[0];
    } finally {
      await panel.unmount();
    }
  }
  {
    const b = bridge({ answer, servers: [local({ env: { KYB_KEY: "plain-value" } })] });
    const panel = await mount(b.api);
    try {
      await menu(panel.host, "MCP kyb", "Edit");
      const eye = eyeOf(panel.host, "KYB_KEY");
      assert.ok(eye, "precondition: no eye on KYB_KEY");
      await click(eye);
      out.eye = envRowMessage(panel.host, "KYB_KEY");
      assert.ok(out.eye, "the eye's store-unavailable message is not shown");
    } finally {
      await panel.unmount();
    }
  }
  return out;
}

/**
 * The eye's store-unavailable message as the product reaches it: on a server
 * with a sealed value, before the availability answer has arrived. The answer
 * is held back for the whole read, so the form is not yet locked and still
 * offers the eye, and the reveal answers store-unavailable as main does for a
 * sealed value with the store shut.
 */
export async function eyeBeforeAnswer() {
  const b = bridge({
    answer: () => new Promise(() => {}),
    servers: [local({ id: "kybsealed", name: "MCP kybsealed", env: { KYB_KEY: sealed("first") } })],
  });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kybsealed", "Edit");
    assert.equal(b.asks(), 1, "precondition: the form did not ask");
    assert.equal(notices(panel.host).length, 0, "precondition: the answer arrived");
    const eye = eyeOf(panel.host, "KYB_KEY");
    assert.ok(eye, "precondition: no eye on the sealed KYB_KEY before the answer");
    await click(eye);
    const said = envRowMessage(panel.host, "KYB_KEY");
    assert.ok(said, "the eye's store-unavailable message is not shown");
    return said;
  } finally {
    await panel.unmount();
  }
}
