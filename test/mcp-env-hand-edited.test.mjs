import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mainProcess, pinPlatform } from "./helpers/mcp-main.mjs";
import { contextBridgeCopy } from "./helpers/context-bridge.mjs";
import { serversToWire } from "../src/shared/envPairs.ts";

/**
 * KYB-700 AC8: a hand-edited env value in `local-mcp.json` is read honestly,
 * and no server is hidden or lost for it.
 *
 * Through the real `studio:mcpServers` and `studio:saveMcpServers` handlers,
 * with Electron mocked and a store that seals, joined to the renderer's
 * `loadMcpPanel`, `saveMcpPanel` and the mounted panel by `contextBridgeCopy`,
 * which copies as the context bridge was measured to (the AC1 copy).
 *
 * Every fixture puts a good server first and the hand-edited one second, as
 * in the case Hange measured, where `servers[1].env[0]` threw in the
 * renderer's decoder and the good server went with it.
 *
 *  - A number is read as its text in the file, never `String()` of the double,
 *    and a boolean as `"true"` or `"false"`: the panel lists every server, the edit form's eye opens the string, and a save with the store
 *    available writes it sealed, opening to that string.
 *  - An object, an array or `null` value, and an `env` that is a string, a
 *    number, a boolean or an array, refuse the whole file: the panel shows
 *    the unreadable state, which names the server's id and name and neither
 *    the key nor the value; the error's message names neither; and a save
 *    other than "Move it aside" leaves every byte of the file as it was.
 *  - An `env` of `null` is no env, as it was before KYB-700.
 */

pinPlatform("linux");
const main = await mainProcess({ backend: "gnome_libsecret", encryptionAvailable: true, seals: true });
const dom = await import("./helpers/mcp-form-dom.mjs");
const { initialMcpPanelState, loadMcpPanel, panelView, saveMcpPanel, SAVE_REFUSED_MESSAGE } = await import(
  "../src/renderer/src/lib/mcpPanel.ts"
);
const { ConfigUnreadableError, listServers } = main.localMcp;

const sealedOf = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;
const opened = (value) => {
  assert.ok(typeof value === "string" && value.startsWith("kyb:v1:"), `not sealed: ${value}`);
  return /^ENC\((.*)\)$/s.exec(Buffer.from(value.slice(7), "base64").toString("utf8"))[1];
};

const KEY = "KYB_HAND_KEY";

const plaud = () => ({
  id: "plaud",
  name: "Plaud",
  command: "npx",
  args: ["-y", "plaud-mcp"],
  env: { API_KEY: sealedOf("sk-live-1") },
  enabled: true,
});

/** The hand-edited server, second in the file. */
const kyb = (over = {}) => ({
  id: "kyb",
  name: "MCP kyb",
  command: "sh",
  args: ["-c", "exit 1"],
  enabled: true,
  ...over,
});

const onDisk = () => JSON.parse(readFileSync(main.configPath, "utf8")).servers;

/** The bridge as the page sees it: every argument and reply copied as the context bridge copies. */
function joinedApi() {
  const across = (channel, ...args) => contextBridgeCopy(main.rawInvoke(channel, ...args.map(contextBridgeCopy)));
  return {
    ...dom.bridge().api,
    credentialStoreAvailable: async () => across("studio:credentialStoreAvailable"),
    mcpServers: async () => across("studio:mcpServers"),
    saveMcpServers: async (servers, options) => across("studio:saveMcpServers", servers, options),
    revealMcpEnv: async (id, key) => across("studio:revealMcpEnv", id, key),
  };
}

function panelState() {
  let state = initialMcpPanelState;
  return {
    apply: (fold) => {
      state = fold(state);
    },
    get: () => state,
  };
}

// ---- a number or a boolean: read as its string form ---------------------------

const SETTLED = [
  ["a number", 8080, "8080"],
  ["the boolean true", true, "true"],
  ["the boolean false", false, "false"],
];

for (const [label, value, text] of SETTLED) {
  test(`AC8: with ${label} stored, the panel lists every server and holds the value as "${text}"`, async () => {
    main.givenStored([plaud(), kyb({ env: { OTHER: "plain", [KEY]: value } })]);
    const panel = panelState();
    await loadMcpPanel(joinedApi(), panel.apply);
    const state = panel.get();
    assert.equal(state.loadError, null, `the load failed: ${state.loadError}`);
    assert.equal(state.unreadable, null, "the file was refused");
    assert.deepEqual(state.servers.map((s) => s.id), ["plaud", "kyb"], "not every server is listed");
    assert.deepEqual(Object.entries(state.servers[1].env), [["OTHER", "plain"], [KEY, text]]);
    assert.equal(state.servers[0].env.API_KEY, sealedOf("sk-live-1"), "the good server's env changed");
  });

  test(`AC8: with ${label} stored, the edit form's eye opens "${text}", and Turn off writes it sealed`, async () => {
    main.givenStored([plaud(), kyb({ env: { OTHER: "plain", [KEY]: value } })]);
    const panel = await dom.mount(joinedApi());
    try {
      assert.ok(dom.row(panel.host, "Plaud"), "the good server is not listed");
      assert.ok(dom.row(panel.host, "MCP kyb"), "the hand-edited server is not listed");

      await dom.menu(panel.host, "MCP kyb", "Edit");
      assert.ok(dom.envInput(panel.host, KEY), "the edit form shows no row for the hand-edited key");
      const eye = dom.eyeOf(panel.host, KEY);
      assert.ok(eye, "the hand-edited key's row has no eye");
      await dom.click(eye);
      assert.equal(dom.envInput(panel.host, KEY).value, text, "the eye did not open the string form");
      await dom.click(dom.buttonIn(dom.form(panel.host), "Cancel"));
      assert.equal(dom.form(panel.host), undefined, "precondition: Cancel did not close the form");

      await dom.menu(panel.host, "MCP kyb", "Turn off");
    } finally {
      await panel.unmount();
    }
    const [good, written] = onDisk();
    assert.equal(written.enabled, false, "precondition: Turn off did not save");
    assert.deepEqual(Object.keys(written.env), ["OTHER", KEY]);
    assert.equal(opened(written.env[KEY]), text, "the value was not written sealed, opening to its string form");
    assert.equal(opened(written.env.OTHER), "plain");
    assert.deepEqual(good, plaud(), "the good server changed on disk");
  });
}

// ---- a number is read as the text it has in the file --------------------------

/**
 * A file written as a person would type it, which `JSON.stringify` cannot
 * write: a number keeps no text once parsed, so `12345678901234567890`,
 * `1.0`, `-0` and `1e21` only exist as source. String values sit beside them,
 * one with an escaped quote, because the reviver's source text for a string
 * includes its quotes and must never be used for one (KYB-699 removed exactly
 * that symptom).
 */
const NUMBER_TEXT_FILE = `{
  "servers": [
    ${JSON.stringify(plaud())},
    {
      "id": "kyb", "name": "MCP kyb", "command": "sh", "args": ["-c", "exit 1"], "enabled": true,
      "env": {
        "QUOTED": "str",
        "ESCAPED": "a\\"b",
        "BIG": 12345678901234567890,
        "ONE": 1.0,
        "NEG": -0,
        "EXP": 1e21,
        "PORT": 8080
      }
    }
  ]
}
`;
const NUMBER_TEXT_ENTRIES = [
  ["QUOTED", "str"],
  ["ESCAPED", 'a"b'],
  ["BIG", "12345678901234567890"],
  ["ONE", "1.0"],
  ["NEG", "-0"],
  ["EXP", "1e21"],
  ["PORT", "8080"],
];
const givenRaw = (text) => writeFileSync(main.configPath, text, "utf8");

test("AC8: a number is read as its text in the file, every digit kept, and a string value gains no quotes", async () => {
  givenRaw(NUMBER_TEXT_FILE);
  assert.equal(String(12345678901234567890), "12345678901234567000", "precondition: the double does not round");
  const panel = panelState();
  await loadMcpPanel(joinedApi(), panel.apply);
  const state = panel.get();
  assert.equal(state.loadError, null, `the load failed: ${state.loadError}`);
  assert.equal(state.unreadable, null, "the file was refused");
  assert.deepEqual(state.servers.map((s) => s.id), ["plaud", "kyb"], "not every server is listed");
  assert.deepEqual(Object.entries(state.servers[1].env), NUMBER_TEXT_ENTRIES);
});

test("AC8: a save with the store available seals each number's text in the file, and each string as it was", async () => {
  givenRaw(NUMBER_TEXT_FILE);
  const panel = panelState();
  const api = joinedApi();
  await loadMcpPanel(api, panel.apply);
  const servers = panel.get().servers.map((s) => (s.id === "kyb" ? { ...s, enabled: false } : s));
  await saveMcpPanel(api, panel.apply, servers);
  assert.equal(panel.get().saveError, null, `the save failed: ${panel.get().saveError}`);
  const [good, written] = onDisk();
  assert.equal(written.enabled, false, "precondition: the save did not write");
  assert.deepEqual(
    Object.entries(written.env).map(([key, value]) => [key, opened(value)]),
    NUMBER_TEXT_ENTRIES,
    "a value was written changed",
  );
  assert.deepEqual(good, plaud(), "the good server changed on disk");
});

test("AC8: with no source text for a number, the read refuses loudly rather than falling back to String()", async () => {
  givenRaw(NUMBER_TEXT_FILE);
  const parse = JSON.parse;
  // A runtime whose reviver gets no third argument, as before Node 24 and Electron 34.
  JSON.parse = (text, reviver) =>
    parse(text, reviver && function (key, value) { return reviver.call(this, key, value); });
  let thrown;
  try {
    listServers();
  } catch (error) {
    thrown = error;
  } finally {
    JSON.parse = parse;
  }
  assert.ok(thrown instanceof Error, "the read answered instead of refusing");
  assert.equal(thrown instanceof ConfigUnreadableError, false, "refused as a damaged file, which it is not");
  assert.match(thrown.message, /source text for a number/);
  for (const [key, value] of NUMBER_TEXT_ENTRIES) {
    assert.equal(thrown.message.includes(key), false, `the message names the key ${key}`);
    if (value.length > 1) assert.equal(thrown.message.includes(value), false, `the message names the value ${value}`);
  }

  givenRaw(JSON.stringify({ servers: [plaud(), kyb({ env: { OTHER: "plain", FLAG: true } })] }));
  JSON.parse = (text, reviver) =>
    parse(text, reviver && function (key, value) { return reviver.call(this, key, value); });
  try {
    assert.deepEqual(Object.entries(listServers()[1].env), [["OTHER", "plain"], ["FLAG", "true"]],
      "a file with no number was refused too");
  } finally {
    JSON.parse = parse;
  }
});

test("AC8: an env of null is no env: the panel lists every server and the save keeps both", async () => {
  main.givenStored([plaud(), kyb({ env: null })]);
  const panel = panelState();
  await loadMcpPanel(joinedApi(), panel.apply);
  assert.equal(panel.get().unreadable, null, "an env of null refused the file");
  assert.deepEqual(panel.get().servers.map((s) => s.id), ["plaud", "kyb"]);
  assert.equal(Object.hasOwn(panel.get().servers[1], "env"), false, "an env of null reached the panel as an env");
  await saveMcpPanel(joinedApi(), panel.apply, panel.get().servers);
  assert.equal(panel.get().saveError, null, `the save failed: ${panel.get().saveError}`);
  assert.deepEqual(onDisk().map((s) => s.id), ["plaud", "kyb"]);
});

// ---- no honest string: the whole file is refused -------------------------------

/**
 * Each hand-edited `env` the file is refused for, with the words neither the
 * unreadable state nor the error may contain: the key, and the value as text.
 */
const REFUSED = [
  ["a value that is an object", { [KEY]: { inner: "SECRET-VALUE" } }, "env-value", [KEY, "SECRET-VALUE", "inner", "object"]],
  ["a value that is an array", { [KEY]: ["SECRET-VALUE", "other"] }, "env-value", [KEY, "SECRET-VALUE", "other"]],
  ["a value that is null", { [KEY]: null }, "env-value", [KEY, "null"]],
  ["an env that is a string", `${KEY}=SECRET-VALUE`, "env", [KEY, "SECRET-VALUE"]],
  ["an env that is a number", 424242, "env", ["424242"]],
  ["an env that is a boolean", true, "env", ["true"]],
  ["an env that is an array", [[KEY, "SECRET-VALUE"]], "env", [KEY, "SECRET-VALUE"]],
];

const named = (problem, over = {}) => ({ index: 1, id: "kyb", name: "MCP kyb", problem, ...over });

/** Which of `words` appear in `said`. */
const leaked = (said, words) => words.filter((word) => said.includes(word));

/** The unreadable state's own block in the mounted panel. */
const unreadableBlock = (host) =>
  [...host.querySelectorAll(".empty")].find((e) => (e.textContent ?? "").includes("damaged and can’t be read"));

for (const [label, env, problem, words] of REFUSED) {
  test(`AC8: ${label} refuses the file, and the error names the server but neither the key nor the value`, () => {
    main.givenStored([plaud(), kyb({ env })]);
    assert.throws(
      () => listServers(),
      (error) => {
        assert.ok(error instanceof ConfigUnreadableError, `wrong type: ${error?.name}`);
        assert.deepEqual(error.server, named(problem));
        assert.match(error.message, /servers\[1\] \(id "kyb"\)/, "the message does not name the server");
        assert.deepEqual(leaked(error.message, words), [], `the message names the key or the value: ${error.message}`);
        return true;
      },
    );
  });

  test(`AC8: ${label} shows the unreadable state, naming the server's id and name and neither the key nor the value`, async () => {
    main.givenStored([plaud(), kyb({ env })]);
    const panel = panelState();
    await loadMcpPanel(joinedApi(), panel.apply);
    const view = panelView(panel.get(), panel.get().servers);
    assert.equal(view.kind, "unreadable", `the panel shows ${view.kind}`);
    assert.deepEqual(view.server, named(problem), "the unreadable state does not name the server");
    assert.deepEqual(leaked(JSON.stringify(panel.get().unreadable), words), [], "the unreadable state names the key or the value");

    const mounted = await dom.mount(joinedApi());
    try {
      assert.equal(dom.row(mounted.host, "Plaud"), undefined, "a server is listed over a refused file");
      const block = unreadableBlock(mounted.host);
      assert.ok(block, "the unreadable state is not shown");
      const said = dom.text(block);
      for (const part of ["“MCP kyb”", "id “kyb”", "number 2 in the list", main.configPath]) {
        assert.ok(said.includes(part), `the unreadable state does not say ${part}: ${said}`);
      }
      assert.deepEqual(leaked(said, words), [], `the unreadable state names the key or the value: ${said}`);
    } finally {
      await mounted.unmount();
    }
  });

  test(`AC8: ${label}: no save but "Move it aside" changes a byte of local-mcp.json`, async () => {
    main.givenStored([plaud(), kyb({ env })]);
    const before = readFileSync(main.configPath);
    const lists = {
      // Without the hand-edited server: the save that would delete it.
      "without the hand-edited server": [plaud()],
      "with the hand-edited server mended": [plaud(), kyb({ env: { [KEY]: "mended" } })],
      "with nothing": [],
    };
    for (const [what, servers] of Object.entries(lists)) {
      for (const options of [undefined, { onUnreadableConfig: "refuse" }]) {
        const reply = await main.rawInvoke("studio:saveMcpServers", serversToWire(servers), options);
        assert.equal(reply.ok, false, `a save ${what} was not refused`);
        assert.deepEqual(reply.server, named(problem), `the refusal of a save ${what} does not name the server`);
        assert.deepEqual(readFileSync(main.configPath), before, `a save ${what} changed local-mcp.json`);
      }
    }

    // And through the panel, as Remove or Turn off would send it.
    const panel = panelState();
    await saveMcpPanel(joinedApi(), panel.apply, [plaud()]);
    assert.equal(panel.get().saveError, SAVE_REFUSED_MESSAGE);
    assert.deepEqual(panel.get().unreadable?.server, named(problem));
    assert.deepEqual(readFileSync(main.configPath), before, "a save from the panel changed local-mcp.json");
  });
}

test("AC8: the unreadable state names a server with no name by its id", async () => {
  main.givenStored([plaud(), kyb({ name: "", env: { [KEY]: { inner: "SECRET-VALUE" } } })]);
  const panel = panelState();
  await loadMcpPanel(joinedApi(), panel.apply);
  assert.deepEqual(panel.get().unreadable?.server, named("env-value", { name: "kyb" }));
});

test("AC8: \"Move it aside\" is still the way out, and keeps the hand-edited file's bytes", async () => {
  main.givenStored([plaud(), kyb({ env: { [KEY]: { inner: "SECRET-VALUE" } } })]);
  const before = readFileSync(main.configPath);
  const panel = await dom.mount(joinedApi());
  try {
    const block = unreadableBlock(panel.host);
    assert.ok(block, "precondition: the unreadable state is not shown");
    await dom.click(dom.buttonIn(block, "Move it aside and start again"));
    assert.equal(unreadableBlock(panel.host), undefined, "the panel is still in the unreadable state");
  } finally {
    await panel.unmount();
  }
  assert.deepEqual(onDisk(), [], "the new list is not empty");
  const dir = dirname(main.configPath);
  const aside = readdirSync(dir).filter((name) => name.startsWith("local-mcp.json.corrupt-"));
  assert.equal(aside.length, 1, `expected one file moved aside, found ${aside.length}`);
  assert.deepEqual(readFileSync(`${dir}/${aside[0]}`), before, "the file moved aside lost bytes");
  assert.ok(existsSync(main.configPath));
});
