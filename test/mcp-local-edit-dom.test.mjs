import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { replyToWire, serversFromWire } from "../src/shared/envPairs.ts";

/**
 * Editing a local MCP server, renderer half (KYB-591).
 *
 *  - AC1: ⋯ → Edit opens a form filled in from what is stored, with every env
 *    value field empty: no sealed string, no mask held as a value.
 *  - AC2: an edit that does not touch env sends every stored value back byte
 *    for byte.
 *  - AC3: a revealed value that was not changed still goes back sealed; one
 *    that cannot be revealed says why and is kept.
 *  - AC4: replace, remove and add reach the save as typed, removed and added.
 *  - AC5: a rename keeps the id.
 *  - AC6: a hand-set `cwd` (and an argument with a space in it) survives.
 *  - AC7: a row that showed Ready offers Connect after an edit.
 *  - AC8: adding never reuses an id.
 *
 * The harness is `mcp-row-overlap-dom.test.mjs`'s. No jsdom node is ever the
 * `actual` of an assertion.
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
const { Plugins } = await import("../src/renderer/src/components/Plugins.tsx");
const { useStore } = await import("@/lib/store");

after(() => dom.window.close());

const AGENT = "agent-under-test";

async function settle() {
  await act(async () => {
    await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  });
}

async function click(element) {
  assert.ok(element, "nothing to click");
  await act(async () => {
    element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
  await new Promise((resolve) => setImmediate(resolve));
  await settle();
}

/** Type into a controlled input or textarea, through the native setter React watches. */
async function type(element, value) {
  assert.ok(element, "nothing to type into");
  const proto =
    element.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(element, value);
  await act(async () => {
    element.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}

async function mount(studio) {
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

function row(host, name) {
  return [...host.querySelectorAll(".pl__row")].find((r) => (r.querySelector(".pl__name")?.textContent ?? "") === name);
}

function buttonIn(root, text) {
  return [...root.querySelectorAll("button")].find((b) => label(b) === text);
}

/** Open a row's ⋯ and press one of its items. */
async function menu(host, name, item) {
  const r = row(host, name);
  assert.ok(r, `no row named ${name}`);
  await click([...r.querySelectorAll("button")].find((b) => b.getAttribute("title") === "More"));
  const entry = [...row(host, name).querySelectorAll(".pl__menu button")].find((b) => label(b) === item);
  assert.ok(entry, `${name}'s menu has no ${item}`);
  await click(entry);
}

/** The open add/edit form for a local server: the card with a Command field. */
function form(host) {
  return [...host.querySelectorAll(".card")].find((c) =>
    [...c.querySelectorAll(".field__label")].some((l) => l.textContent === "Command"),
  );
}

function field(host, labelText) {
  const f = [...form(host).querySelectorAll(".field")].find(
    (x) => x.querySelector(".field__label")?.textContent === labelText,
  );
  return f?.querySelector("input");
}

const envInput = (host, key) => form(host).querySelector(`input[aria-label="${key}"]`);
const envRow = (host, key) => envInput(host, key)?.closest(".pl__env");
const envLines = (host) => form(host).querySelector("textarea");

/** A value as KYB-590 stores it. */
const sealed = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;
const S_API = sealed("sk-live-1");
const S_DB = sealed("postgres://u:p@h/db");

const plaud = (over = {}) => ({
  id: "plaud",
  name: "Plaud",
  command: "npx",
  args: ["-y", "plaud-mcp"],
  env: { API_KEY: S_API, DB_URL: S_DB },
  enabled: true,
  ...over,
});

/**
 * A bridge holding a server list. Every save is recorded and answered with
 * what was sent, as the main process answers with what it wrote. It speaks
 * pairs as the main process does (KYB-700), so `saves` holds maps.
 */
function bridge({ servers = [], reveal = {} } = {}) {
  let current = servers;
  const saves = [];
  const reveals = [];
  const api = {
    connectors: async () => ({ configured: true, connectors: [] }),
    mcpServers: async () => replyToWire({ ok: true, servers: current, heldKeys: {} }),
    saveMcpServers: async (sent) => {
      const next = serversFromWire(sent);
      saves.push(structuredClone(next));
      current = next;
      return replyToWire({ ok: true, servers: next, heldKeys: {} });
    },
    revealMcpEnv: async (id, key) => {
      reveals.push([id, key]);
      return reveal[key] ?? { ok: false, reason: "not-found" };
    },
    openExternal: async () => {},
    testRemoteMcp: async () => ({ ok: true, tools: [] }),
    startMcpSignIn: async () => ({ ok: true }),
    disconnectService: async () => ({ ok: true }),
    connectMcpServer: async () => ({ ok: true, message: "" }),
    testMcpServer: async () => ({ ok: true, tools: ["a"] }),
  };
  return { api, saves, reveals, lastSaved: () => saves.at(-1) };
}

// ---- AC1 ---------------------------------------------------------------------

test("AC1: Edit opens a form filled in from what is stored, with every env value empty", async () => {
  const b = bridge({ servers: [plaud()] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    assert.ok(form(panel.host), "Edit opened no form");
    assert.equal(field(panel.host, "Name").value, "Plaud");
    assert.equal(field(panel.host, "Command").value, "npx -y plaud-mcp");
    for (const key of ["API_KEY", "DB_URL"]) {
      const input = envInput(panel.host, key);
      assert.ok(input, `${key} is not listed`);
      assert.equal(input.value, "", `${key}'s field holds a value`);
      assert.equal(input.type, "password");
    }
    assert.equal(b.reveals.length, 0, "opening the form revealed a value");
    assert.equal(form(panel.host).innerHTML.includes("kyb:v1:"), false, "a sealed string is in the form");
  } finally {
    await panel.unmount();
  }
});

// ---- AC2 ---------------------------------------------------------------------

test("AC2: changing only the name sends every stored value back byte for byte", async () => {
  const b = bridge({ servers: [plaud()] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await type(field(panel.host, "Name"), "Plaud Notes");
    await click(buttonIn(form(panel.host), "Save"));

    const saved = b.lastSaved();
    assert.ok(saved, "nothing was saved");
    assert.deepEqual(saved[0].env, { API_KEY: S_API, DB_URL: S_DB });
    assert.equal(JSON.stringify(saved).includes("•"), false, "the mask reached the save");
  } finally {
    await panel.unmount();
  }
});

// ---- AC3 ---------------------------------------------------------------------

test("AC3: a revealed value shows in its field, and goes back sealed when not changed", async () => {
  const b = bridge({ servers: [plaud()], reveal: { API_KEY: { ok: true, value: "sk-live-1" } } });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await click(envRow(panel.host, "API_KEY").querySelector('button[title="Show"]'));

    assert.deepEqual(b.reveals, [["plaud", "API_KEY"]], "the eye revealed the wrong thing, or more");
    assert.equal(envInput(panel.host, "API_KEY").value, "sk-live-1");
    assert.equal(envInput(panel.host, "API_KEY").type, "text");
    assert.equal(envInput(panel.host, "DB_URL").value, "", "revealing one value filled another");

    await click(buttonIn(form(panel.host), "Save"));
    assert.deepEqual(b.lastSaved()[0].env, { API_KEY: S_API, DB_URL: S_DB });
  } finally {
    await panel.unmount();
  }
});

test("AC3: a value that cannot be revealed says why on its row, and is kept", async () => {
  const b = bridge({ servers: [plaud()], reveal: { DB_URL: { ok: false, reason: "needs-re-entry" } } });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await click(envRow(panel.host, "DB_URL").querySelector('button[title="Show"]'));

    assert.match(envRow(panel.host, "DB_URL").textContent ?? "", /can’t be opened on this computer/);
    assert.equal(envInput(panel.host, "DB_URL").value, "");

    await click(buttonIn(form(panel.host), "Save"));
    assert.equal(b.lastSaved()[0].env.DB_URL, S_DB);
  } finally {
    await panel.unmount();
  }
});

// ---- AC4 ---------------------------------------------------------------------

test("AC4: replace one value, remove another, add a third", async () => {
  const b = bridge({ servers: [plaud()] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await type(envInput(panel.host, "API_KEY"), "sk-live-2");
    await click(envRow(panel.host, "DB_URL").querySelector('button[title="Remove DB_URL"]'));
    assert.equal(envInput(panel.host, "DB_URL") === null, true, "× did not take DB_URL off the form");
    await type(envLines(panel.host), "REGION=eu");
    await click(buttonIn(form(panel.host), "Save"));

    assert.deepEqual(b.lastSaved()[0].env, { API_KEY: "sk-live-2", REGION: "eu" });
  } finally {
    await panel.unmount();
  }
});

test("AC4: removing a server's only key saves it with no env, and keeps its cwd", async () => {
  const b = bridge({ servers: [plaud({ env: { API_KEY: S_API }, cwd: "/srv/p" })] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await click(envRow(panel.host, "API_KEY").querySelector('button[title="Remove API_KEY"]'));
    await click(buttonIn(form(panel.host), "Save"));

    const saved = b.lastSaved()[0];
    assert.equal("env" in saved, false, `the removed key was kept: ${JSON.stringify(saved.env)}`);
    assert.equal(saved.cwd, "/srv/p");
  } finally {
    await panel.unmount();
  }
});

// ---- AC5, AC6 ----------------------------------------------------------------

test("AC5: a rename keeps the id, and leaves one server", async () => {
  const b = bridge({ servers: [plaud(), plaud({ id: "other", name: "Other" })] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await type(field(panel.host, "Name"), "Something Else");
    await click(buttonIn(form(panel.host), "Save"));

    assert.deepEqual(
      b.lastSaved().map((s) => [s.id, s.name]),
      [["plaud", "Something Else"], ["other", "Other"]],
    );
  } finally {
    await panel.unmount();
  }
});

test("AC6: a hand-set cwd, and an argument with a space in it, survive an edit", async () => {
  const b = bridge({ servers: [plaud({ args: ["--root", "/srv/my files"], cwd: "/srv/project" })] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await type(field(panel.host, "Name"), "Plaud 2");
    await click(buttonIn(form(panel.host), "Save"));

    const saved = b.lastSaved()[0];
    assert.equal(saved.cwd, "/srv/project");
    assert.deepEqual(saved.args, ["--root", "/srv/my files"]);
  } finally {
    await panel.unmount();
  }
});

// ---- AC7 ---------------------------------------------------------------------

test("AC7: a row that showed Ready offers Connect after an edit", async () => {
  const b = bridge({ servers: [plaud()] });
  const panel = await mount(b.api);
  try {
    await click(buttonIn(row(panel.host, "Plaud"), "Connect"));
    assert.ok(buttonIn(row(panel.host, "Plaud"), "Connect") === undefined, "Connect did not finish");
    assert.match(row(panel.host, "Plaud").textContent ?? "", /Ready/);

    await menu(panel.host, "Plaud", "Edit");
    await type(envInput(panel.host, "API_KEY"), "sk-live-2");
    await click(buttonIn(form(panel.host), "Save"));

    assert.doesNotMatch(row(panel.host, "Plaud").textContent ?? "", /Ready/, "the row still shows Ready");
    assert.ok(buttonIn(row(panel.host, "Plaud"), "Connect"), "the row does not offer Connect");
  } finally {
    await panel.unmount();
  }
});

// ---- AC8 ---------------------------------------------------------------------

test("AC8: adding Foo, Foo and foo gives foo, foo-2 and foo-3", async () => {
  const b = bridge();
  const panel = await mount(b.api);
  try {
    for (const name of ["Foo", "Foo", "foo"]) {
      await click(buttonIn(panel.host, "Add one on this computer"));
      await type(field(panel.host, "Name"), name);
      await type(field(panel.host, "Command"), "npx -y foo-mcp");
      await click(buttonIn(form(panel.host), "Add"));
    }
    assert.deepEqual(
      b.lastSaved().map((s) => s.id),
      ["foo", "foo-2", "foo-3"],
    );
  } finally {
    await panel.unmount();
  }
});

// ---- Two stored entries with one id (round 1, Important 1) -------------------
//
// Lists stored before KYB-591 can hold two servers with one id: Add gave "Foo"
// twice the id `foo`. An edit replaces the entry that was opened and leaves the
// other exactly as stored, its command and sealed values included.

const S_OTHER = sealed("other-secret");
const twins = () => [
  plaud({ id: "foo", name: "Foo" }),
  { id: "foo", name: "Other Foo", command: "uvx", args: ["other-mcp"], env: { OTHER: S_OTHER }, enabled: true },
];

test("AC2: editing one of two entries sharing an id leaves the other byte for byte", async () => {
  for (const [edited, untouched] of [["Foo", 1], ["Other Foo", 0]]) {
    const b = bridge({ servers: twins() });
    const panel = await mount(b.api);
    try {
      await menu(panel.host, edited, "Edit");
      await type(field(panel.host, "Name"), `${edited} renamed`);
      await click(buttonIn(form(panel.host), "Save"));

      const saved = b.lastSaved();
      assert.equal(saved.length, 2, `editing ${edited} changed the number of servers`);
      assert.deepEqual(saved[untouched], twins()[untouched], `editing ${edited} changed the other entry`);
      assert.equal(saved[1 - untouched].name, `${edited} renamed`);
      assert.deepEqual(saved[1 - untouched].env, twins()[1 - untouched].env);
    } finally {
      await panel.unmount();
    }
  }
});

test("AC2: with the search box hiding one of two entries sharing an id, Edit still replaces the one opened", async () => {
  const b = bridge({ servers: twins() });
  const panel = await mount(b.api);
  try {
    await type(panel.host.querySelector('input[placeholder="Search plugins"]'), "Other");
    assert.equal(row(panel.host, "Foo"), undefined, "the search did not hide Foo");
    await menu(panel.host, "Other Foo", "Edit");
    await type(field(panel.host, "Name"), "Renamed");
    await click(buttonIn(form(panel.host), "Save"));

    const saved = b.lastSaved();
    assert.deepEqual(saved[0], twins()[0], "the hidden entry was changed");
    assert.equal(saved[1].name, "Renamed");
    assert.deepEqual(saved[1].env, { OTHER: S_OTHER });
  } finally {
    await panel.unmount();
  }
});

// ---- A change made while the form is open (round 1, Nit 1) ------------------

test("a Turn off made while the Edit form is open survives the form's Save", async () => {
  const b = bridge({ servers: [plaud()] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await type(field(panel.host, "Name"), "Plaud Notes");
    await menu(panel.host, "Plaud", "Turn off");
    assert.equal(b.lastSaved()[0].enabled, false, "Turn off did not save");
    assert.ok(form(panel.host), "Turn off closed the form");

    await click(buttonIn(form(panel.host), "Save"));
    const saved = b.lastSaved();
    assert.equal(saved[0].enabled, false, "the form's Save turned the server back on");
    assert.equal(saved[0].name, "Plaud Notes");
  } finally {
    await panel.unmount();
  }
});

// ---- What a row says when its value cannot be shown (round 1, Nits 2 and 4) --

test("AC3: a row that cannot be shown says so, and that its value is kept", async () => {
  const b = bridge({
    servers: [plaud()],
    reveal: { API_KEY: { ok: false, reason: "store-unavailable" }, DB_URL: { ok: false, reason: "not-found" } },
  });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "Plaud", "Edit");
    await click(envRow(panel.host, "API_KEY").querySelector('button[title="Show"]'));
    await click(envRow(panel.host, "DB_URL").querySelector('button[title="Show"]'));

    // This bridge gives no availability answer, so the store-unavailable
    // message has no description to show: the main process writes that, and
    // the renderer adds none of its own (KYB-696). It still says the value
    // cannot be shown.
    assert.match(envRow(panel.host, "API_KEY").textContent ?? "", /Can’t show it\./);
    assert.doesNotMatch(envRow(panel.host, "API_KEY").textContent ?? "", /keyring|locked/);
    assert.match(envRow(panel.host, "DB_URL").textContent ?? "", /stored value is kept/);
    assert.doesNotMatch(envRow(panel.host, "DB_URL").textContent ?? "", /isn’t stored/);

    await click(buttonIn(form(panel.host), "Save"));
    assert.deepEqual(b.lastSaved()[0].env, { API_KEY: S_API, DB_URL: S_DB });
  } finally {
    await panel.unmount();
  }
});
