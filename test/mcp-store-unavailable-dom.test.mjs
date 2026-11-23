import { after, test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * The local MCP forms and rows with the credential store unavailable, renderer
 * half (KYB-695).
 *
 *  - AC1: no sealed value on disk (the add form, or an edit of a server stored
 *    in plain text): a warning that values will not be saved and last until
 *    Studio restarts; values still typeable; no × on a stored key. A value that
 *    starts with `kyb:v1:` but fails `looksSealed` is not sealed.
 *  - AC2: a sealed value on disk: no field, eye, × or new-line box; a note that
 *    does not promise unlocking alone is enough; Save enabled; a rename sends
 *    the stored env back byte for byte.
 *  - AC4: a row with keys held names them on a line of its own, which stays on
 *    a row turned off or showing a result, and is absent with nothing held.
 *  - AC5: with the store available, none of it shows and the form is as it was;
 *    the panel asks about the store only when the form opens.
 *  - Values typed before the availability answer are not sent once the form
 *    locks (AC2). The eye's store-unavailable message carries no "Type a new
 *    value" advice (checked with the store available, under AC5).
 *
 * The harness is `mcp-local-edit-dom.test.mjs`'s. jsdom reports no platform, so
 * the store is named "keyring". No jsdom node is ever the `actual` of an
 * assertion: a failing one tries to print it, and runs out of heap.
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
const text = (el) => el?.textContent ?? "";

function row(host, name) {
  return [...host.querySelectorAll(".pl__row")].find((r) => (r.querySelector(".pl__name")?.textContent ?? "") === name);
}

function buttonIn(root, wanted) {
  return [...root.querySelectorAll("button")].find((b) => label(b) === wanted);
}

async function menu(host, name, item) {
  const r = row(host, name);
  assert.ok(r, `no row named ${name}`);
  await click([...r.querySelectorAll("button")].find((b) => b.getAttribute("title") === "More"));
  const entry = [...row(host, name).querySelectorAll(".pl__menu button")].find((b) => label(b) === item);
  assert.ok(entry, `${name}'s menu has no ${item}`);
  await click(entry);
}

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
/** The eye on a stored key's row. */
const eyeOf = (host, key) => envInput(host, key)?.closest(".pl__env")?.querySelector('button[title="Show"]');
/** The text of a stored key's row: its name and any message under it. */
const envRowText = (host, key) => envInput(host, key)?.closest(".pl__env")?.textContent ?? "";
const TYPE_NEW = /Type a new value to replace it\./;
const envLines = (host) => form(host).querySelector("textarea");
/** Every input and textarea in the form's Environment field. */
const envFields = (host) => {
  const f = [...form(host).querySelectorAll(".field")].find(
    (x) => x.querySelector(".field__label")?.textContent === "Environment (optional)",
  );
  return [...f.querySelectorAll("input, textarea")];
};

const WARNING = [/won’t be saved/, /until it restarts/];
const NOTE = [/can’t be changed/, /once it is available and Studio has restarted/];
const HELD_LINE = /until Studio restarts/;

const sealed = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;
const S_KEY = sealed("first");

const local = (over = {}) => ({
  id: "kyb",
  name: "MCP kyb",
  command: "sh",
  args: ["-c", "exit 1"],
  enabled: true,
  ...over,
});

/**
 * A bridge whose store is available or not, holding a server list and the
 * names of keys held per server. Saves are recorded and answered with what was
 * sent, and with the held names as they are.
 */
function bridge({ available, availability, servers = [], heldKeys = {}, connect, test: check } = {}) {
  let current = servers;
  const saves = [];
  let availabilityAsks = 0;
  const api = {
    connectors: async () => ({ configured: true, connectors: [] }),
    mcpServers: async () => ({ ok: true, servers: current, heldKeys }),
    credentialStoreAvailable: async () => {
      availabilityAsks += 1;
      return availability ? availability() : available;
    },
    saveMcpServers: async (next) => {
      saves.push(structuredClone(next));
      current = next;
      return { ok: true, servers: next, heldKeys };
    },
    revealMcpEnv: async () => ({ ok: false, reason: "store-unavailable" }),
    openExternal: async () => {},
    testRemoteMcp: async () => ({ ok: true, tools: [] }),
    startMcpSignIn: async () => ({ ok: true }),
    disconnectService: async () => ({ ok: true }),
    connectMcpServer: connect ?? (async () => ({ ok: true, message: "" })),
    testMcpServer: check ?? (async () => ({ ok: true, tools: ["a"] })),
  };
  return { api, saves, lastSaved: () => saves.at(-1), asks: () => availabilityAsks };
}

// ---- AC1 ---------------------------------------------------------------------

test("AC1: the add form warns that values will not be saved and last until Studio restarts", async () => {
  const b = bridge({ available: false });
  const panel = await mount(b.api);
  try {
    await click(buttonIn(panel.host, "Add one on this computer"));
    for (const words of WARNING) assert.match(text(form(panel.host)), words, "no warning on the add form");
    assert.match(text(form(panel.host)), /keyring/, "the store is not named");
    for (const words of NOTE) assert.doesNotMatch(text(form(panel.host)), words, "the locked note is on the add form");
  } finally {
    await panel.unmount();
  }
});

test("AC1: the edit form for a server stored in plain text warns, and shows no locked note", async () => {
  const b = bridge({ available: false, servers: [local({ env: { KYB_KEY: "plain-value" } })] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kyb", "Edit");
    for (const words of WARNING) assert.match(text(form(panel.host)), words, "no warning on the edit form");
    for (const words of NOTE) assert.doesNotMatch(text(form(panel.host)), words);
  } finally {
    await panel.unmount();
  }
});

test("AC1: with the warning, value fields can be typed in, and what is typed reaches the save", async () => {
  // The add form.
  {
    const b = bridge({ available: false });
    const panel = await mount(b.api);
    try {
      await click(buttonIn(panel.host, "Add one on this computer"));
      for (const el of envFields(panel.host)) {
        assert.equal(el.readOnly, false, "a value field is read-only");
        assert.equal(el.disabled, false, "a value field is disabled");
      }
      await type(field(panel.host, "Name"), "MCP kybnew");
      await type(field(panel.host, "Command"), "sh -c true");
      await type(envLines(panel.host), "KYB_KEY=typed");
      await click(buttonIn(form(panel.host), "Add"));
      assert.deepEqual(b.lastSaved()?.[0]?.env, { KYB_KEY: "typed" });
    } finally {
      await panel.unmount();
    }
  }
  // The edit form for a server stored in plain text.
  {
    const b = bridge({ available: false, servers: [local({ env: { KYB_KEY: "plain-value" } })] });
    const panel = await mount(b.api);
    try {
      await menu(panel.host, "MCP kyb", "Edit");
      const input = envInput(panel.host, "KYB_KEY");
      assert.ok(input, "the stored key has no field");
      for (const el of envFields(panel.host)) {
        assert.equal(el.readOnly, false, "a value field is read-only");
        assert.equal(el.disabled, false, "a value field is disabled");
      }
      await type(input, "retyped");
      await type(envLines(panel.host), "OTHER=new");
      await click(buttonIn(form(panel.host), "Save"));
      assert.deepEqual(b.lastSaved()?.[0]?.env, { KYB_KEY: "retyped", OTHER: "new" });
    } finally {
      await panel.unmount();
    }
  }
});

test("AC1: × is not offered on a stored key", async () => {
  const b = bridge({ available: false, servers: [local({ env: { KYB_KEY: "plain-value", OTHER: "x" } })] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kyb", "Edit");
    assert.ok(envInput(panel.host, "KYB_KEY"), "precondition: the key is listed with its field");
    for (const key of ["KYB_KEY", "OTHER"]) {
      assert.equal(Boolean(buttonIn(form(panel.host), `Remove ${key}`)), false, `× is offered on ${key}`);
    }
  } finally {
    await panel.unmount();
  }
});

test("AC1 (looksSealed): a server whose only stored value starts with kyb:v1: but fails looksSealed is not treated as sealed", async () => {
  const b = bridge({ available: false, servers: [local({ env: { KYB_KEY: "kyb:v1:my key" } })] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kyb", "Edit");
    assert.ok(envInput(panel.host, "KYB_KEY"), "the key has no field: it was treated as sealed");
    assert.ok(envLines(panel.host), "no box for new lines: it was treated as sealed");
    for (const words of NOTE) assert.doesNotMatch(text(form(panel.host)), words, "the locked note is shown");
  } finally {
    await panel.unmount();
  }
});

// ---- AC2 ---------------------------------------------------------------------

/** A sealed key and a plain one: ANY sealed value locks the server. */
const sealedServer = () => local({ id: "kybsealed", name: "MCP kybsealed", env: { KYB_KEY: S_KEY, PLAIN: "p" } });

test("AC2: a server with a sealed value offers no field, eye, × or new-line box", async () => {
  const b = bridge({ available: false, servers: [sealedServer()] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kybsealed", "Edit");
    const f = form(panel.host);
    for (const key of ["KYB_KEY", "PLAIN"]) {
      assert.match(text(f), new RegExp(key), `${key} is not listed by name`);
      assert.equal(Boolean(envInput(panel.host, key)), false, `${key} has a field`);
      assert.equal(Boolean(buttonIn(f, `Remove ${key}`)), false, `${key} has ×`);
    }
    assert.equal(envFields(panel.host).length, 0, "an env field can be typed in");
    assert.equal(Boolean(f.querySelector('button[title="Show"]')), false, "an eye is offered");
    assert.equal(Boolean(envLines(panel.host)), false, "a box for new lines is offered");
    assert.equal(f.innerHTML.includes("kyb:v1:"), false, "a sealed string is in the form");
  } finally {
    await panel.unmount();
  }
});

test("AC2: a note says values can't be changed until the store is available and Studio restarts, and does not say unlock", async () => {
  const b = bridge({ available: false, servers: [sealedServer()] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kybsealed", "Edit");
    const said = text(form(panel.host));
    for (const words of NOTE) assert.match(said, words, "no note");
    assert.match(said, /keyring/, "the store is not named");
    assert.doesNotMatch(said, /unlock/i, "the note promises unlocking is enough");
    for (const words of WARNING) assert.doesNotMatch(said, words, "the unsealed warning is on a sealed server");
  } finally {
    await panel.unmount();
  }
});

test("AC2: Save stays enabled on a server with a sealed value, and saves", async () => {
  const b = bridge({ available: false, servers: [sealedServer()] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kybsealed", "Edit");
    const save = buttonIn(form(panel.host), "Save");
    assert.ok(save, "no Save");
    assert.equal(save.disabled, false, "Save is disabled");
    await type(field(panel.host, "Name"), "MCP kybsealed renamed");
    await click(save);
    assert.equal(b.lastSaved()?.[0]?.name, "MCP kybsealed renamed", "Save did not save");
  } finally {
    await panel.unmount();
  }
});

test("AC2: saving a rename from that form leaves the stored env byte for byte", async () => {
  const original = sealedServer();
  const b = bridge({ available: false, servers: [original] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kybsealed", "Edit");
    await type(field(panel.host, "Name"), "MCP kybsealed renamed");
    await click(buttonIn(form(panel.host), "Save"));
    const saved = b.lastSaved()?.[0];
    assert.ok(saved, "nothing was saved");
    assert.equal(JSON.stringify(saved.env), JSON.stringify(original.env), "the stored env changed");
  } finally {
    await panel.unmount();
  }
});

test("AC2: values typed before the availability answer arrives are not sent once the form locks", async () => {
  // The fields are offered until the answer arrives. Typed into then, a value
  // stayed in the form's state after it locked, Save sent it, and the main
  // process refused it while the form closed as if it had worked.
  let release;
  const answered = new Promise((resolve) => {
    release = resolve;
  });
  const original = sealedServer();
  const b = bridge({ availability: () => answered, servers: [original] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kybsealed", "Edit");
    assert.equal(b.asks(), 1, "precondition: the form did not ask");
    const input = envInput(panel.host, "KYB_KEY");
    assert.ok(input, "precondition: no KYB_KEY field before the answer");
    await type(input, "typed-before-answer");
    await type(envLines(panel.host), "EARLY=typed-early");

    release(false);
    await settle();
    await new Promise((resolve) => setImmediate(resolve));
    await settle();
    assert.equal(Boolean(envInput(panel.host, "KYB_KEY")), false, "precondition: the form did not lock");

    await type(field(panel.host, "Name"), "MCP kybsealed renamed");
    await click(buttonIn(form(panel.host), "Save"));
    const saved = b.lastSaved()?.[0];
    assert.ok(saved, "nothing was saved");
    assert.equal(JSON.stringify(saved.env), JSON.stringify(original.env), "the saved env is not the stored env");
    const sent = JSON.stringify(b.lastSaved());
    for (const typed of ["typed-before-answer", "typed-early", "EARLY"]) {
      assert.ok(!sent.includes(typed), `${typed} was sent`);
    }
  } finally {
    await panel.unmount();
  }
});

// ---- AC4 ---------------------------------------------------------------------

test("AC4: a row with keys held names them, and says they last until Studio restarts", async () => {
  const b = bridge({ available: false, servers: [local()], heldKeys: { kyb: ["KYB_KEY"] } });
  const panel = await mount(b.api);
  try {
    const said = text(row(panel.host, "MCP kyb"));
    assert.match(said, /KYB_KEY/, "the row does not name KYB_KEY");
    assert.match(said, HELD_LINE, "the row does not say it lasts until Studio restarts");
  } finally {
    await panel.unmount();
  }
});

test("AC4: no line on a row with nothing held", async () => {
  const b = bridge({
    available: false,
    servers: [local(), local({ id: "empty", name: "Empty list" }), local({ id: "none", name: "No entry" })],
    heldKeys: { kyb: ["KYB_KEY"], empty: [] },
  });
  const panel = await mount(b.api);
  try {
    assert.match(text(row(panel.host, "MCP kyb")), HELD_LINE, "precondition: the held row has its line");
    for (const name of ["Empty list", "No entry"]) {
      assert.doesNotMatch(text(row(panel.host, name)), HELD_LINE, `${name} shows a line with nothing held`);
    }
  } finally {
    await panel.unmount();
  }
});

test("AC4: the line stays on a row that is turned off", async () => {
  // Stored off, and turned off from the menu.
  const b = bridge({
    available: false,
    servers: [local({ id: "off", name: "Stored off", enabled: false }), local()],
    heldKeys: { off: ["KYB_KEY"], kyb: ["KYB_KEY"] },
  });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kyb", "Turn off");
    for (const name of ["Stored off", "MCP kyb"]) {
      const said = text(row(panel.host, name));
      assert.match(said, /Off/, `precondition: ${name} is not off`);
      assert.match(said, /KYB_KEY/, `${name} is off and does not name KYB_KEY`);
      assert.match(said, HELD_LINE, `${name} is off and has lost its line`);
    }
  } finally {
    await panel.unmount();
  }
});

test("AC4: the line stays on a row showing a result, an error or connected", async () => {
  const results = {
    "an error": {
      connect: async () => ({ ok: false, message: "key=typed" }),
      shows: /key=typed/,
    },
    connected: {
      connect: async () => ({ ok: true, message: "" }),
      shows: /Connected/,
    },
  };
  for (const [what, { connect, shows }] of Object.entries(results)) {
    const b = bridge({ available: false, servers: [local()], heldKeys: { kyb: ["KYB_KEY"] }, connect });
    const panel = await mount(b.api);
    try {
      await click(buttonIn(row(panel.host, "MCP kyb"), "Connect"));
      const said = text(row(panel.host, "MCP kyb"));
      assert.match(said, shows, `precondition: the row does not show ${what}`);
      assert.match(said, /KYB_KEY/, `the row showing ${what} does not name KYB_KEY`);
      assert.match(said, HELD_LINE, `the row showing ${what} has lost its line`);
    } finally {
      await panel.unmount();
    }
  }
});

// ---- AC5 ---------------------------------------------------------------------

test("AC5: with the store available, the add form shows no warning and no note, and no row shows the line", async () => {
  const b = bridge({ available: true, servers: [local()] });
  const panel = await mount(b.api);
  try {
    assert.doesNotMatch(text(row(panel.host, "MCP kyb")), HELD_LINE, "a row shows the line");
    await click(buttonIn(panel.host, "Add one on this computer"));
    const said = text(form(panel.host));
    for (const words of [...WARNING, ...NOTE]) assert.doesNotMatch(said, words);
    assert.ok(envLines(panel.host), "no box for new lines");
  } finally {
    await panel.unmount();
  }
});

test("AC5: with the store available, a sealed server's edit form is editable as it always was", async () => {
  const b = bridge({ available: true, servers: [sealedServer()] });
  const panel = await mount(b.api);
  try {
    await menu(panel.host, "MCP kybsealed", "Edit");
    const f = form(panel.host);
    for (const words of [...WARNING, ...NOTE]) assert.doesNotMatch(text(f), words);
    for (const key of ["KYB_KEY", "PLAIN"]) {
      assert.ok(envInput(panel.host, key), `${key} has no field`);
      assert.ok(buttonIn(f, `Remove ${key}`), `${key} has no ×`);
    }
    assert.ok(f.querySelector('button[title="Show"]'), "no eye");
    assert.ok(envLines(panel.host), "no box for new lines");

    // The eye's store-unavailable message is today's: no advice to type.
    await click(eyeOf(panel.host, "PLAIN"));
    assert.match(envRowText(panel.host, "PLAIN"), /keyring is locked/, "precondition: no message");
    assert.doesNotMatch(envRowText(panel.host, "PLAIN"), TYPE_NEW, "the hint shows with the store available");
  } finally {
    await panel.unmount();
  }
});

test("AC5: the panel asks whether the store is available when the form opens, not when it lists servers", async () => {
  const b = bridge({ available: false, servers: [local()] });
  const panel = await mount(b.api);
  try {
    assert.equal(b.asks(), 0, "listing the servers asked about the store");
    await click(buttonIn(panel.host, "Add one on this computer"));
    assert.equal(b.asks(), 1, "opening the form did not ask about the store, or asked more than once");
  } finally {
    await panel.unmount();
  }
});
