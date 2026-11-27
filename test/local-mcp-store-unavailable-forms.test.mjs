import { after, mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRenderer } from "./helpers/mcp-wire.mjs";

/**
 * With the credential store unavailable, the main process half (KYB-695).
 *
 *  - AC5: listing the servers never asks the store whether it is available.
 *    First in this file on purpose: availability is memoised for the process,
 *    so only the first ask in it can be counted.
 *  - AC3: the availability call answers one fixed shape, `{ available,
 *    description, remedy }`, with `available` false and no env data (KYB-696
 *    widened it from the bare boolean KYB-695 asked for); a server with a
 *    sealed value on disk keeps no typed value, not on disk, not in memory,
 *    and not in a started process.
 *  - AC4: the list result names the keys held for a server with no sealed
 *    value, never their values, and stops naming them on removal.
 *  - AC1 (looksSealed): `saveServers` judges "sealed on disk" with
 *    `looksSealed`, so a stored `kyb:v1:my key` is plain text and a typed
 *    value is held and used.
 *
 * Every call goes through the handler `registerIpc` registered, invoked as
 * `ipcMain` invokes it, so a handler that answers the wrong shape is visible.
 * One process, store unavailable throughout, as in
 * `local-mcp-session-keys.test.mjs`.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-store-unavailable-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const TYPED = "typed-this-session";

/** Every question put to the OS about its credential store. */
let storeAsks = 0;
const handlers = new Map();

mock.module("electron", {
  exports: {
    app: { getPath: () => dir, on: () => {}, whenReady: async () => {} },
    shell: { openExternal: async () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: () => {},
    },
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
    Notification: class {
      static isSupported() {
        return false;
      }
    },
    safeStorage: {
      isEncryptionAvailable: () => {
        storeAsks += 1;
        return false;
      },
      getSelectedStorageBackend: () => {
        storeAsks += 1;
        return "gnome_libsecret";
      },
      encryptString: () => {
        throw new Error("Encryption is not available");
      },
      decryptString: () => {
        throw new Error("Decryption is not available");
      },
    },
  },
});

mock.module("@electron-toolkit/utils", {
  exports: { electronApp: {}, optimizer: {}, is: { dev: false } },
});

/** Every server process `spawn` made. Each answers the MCP handshake. */
const spawned = [];
mock.module("node:child_process", {
  exports: {
    spawn: (file, args, options) => {
      const child = new EventEmitter();
      child.unref = () => {};
      if (/taskkill/i.test(file)) return child;
      child.options = options;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 6000 + spawned.length;
      child.killed = false;
      child.kill = () => {
        child.killed = true;
        return true;
      };
      child.stdin = {
        write: (payload) => {
          for (const line of payload.split("\n")) {
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (typeof message.id !== "number") continue;
            const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
            setImmediate(() => child.stdout.emit("data", Buffer.from(`${reply}\n`, "utf8")));
          }
          return true;
        },
      };
      spawned.push(child);
      return child;
    },
    spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
    execFile: () => {},
    exec: () => {},
  },
});

const { registerIpc } = await import("../src/main/ipc.ts");
const { callServer, stopAll } = await import("../src/main/localMcp.ts");
registerIpc();

// Through the renderer's codec: `env` crosses as pairs since KYB-700.
const invoke = asRenderer((channel, ...args) => {
  const handler = handlers.get(channel);
  assert.ok(handler, `nothing was registered for ${channel}`);
  return handler({ sender: null }, ...args);
});

const configPath = () => join(dir, "local-mcp.json");
const raw = () => readFileSync(configPath(), "utf8");
/** A value as an earlier session, with the store available, would have sealed it. */
const sealed = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;
const server = (over = {}) => ({ id: "a", name: "A", command: "npx", args: ["-y", "a-mcp"], enabled: true, ...over });

function givenStored(servers) {
  writeFileSync(configPath(), JSON.stringify({ servers }, null, 2), "utf8");
}

/** A clean slate: no config, nothing running, nothing held. */
function fresh() {
  stopAll();
  rmSync(configPath(), { force: true });
  // An empty save forgets every held value, through the removal loop.
  invoke("studio:saveMcpServers", []);
  rmSync(configPath(), { force: true });
  spawned.length = 0;
}

/** A server as the list answer gives it, which is what the renderer sends back. */
const stored = (id) => invoke("studio:mcpServers").servers.find((s) => s.id === id);

const everyEnvSpawned = () => spawned.map((c) => c.options?.env ?? {});

// ---- AC5 (first: availability is asked at most once per process) ------------

test("AC5: listing the servers does not ask the store whether it is available", () => {
  givenStored([
    server({ id: "sealed", name: "Sealed", env: { KYB_KEY: sealed("first") } }),
    server({ id: "plain", name: "Plain", env: { OLD: "disk" } }),
  ]);
  assert.equal(storeAsks, 0, "precondition: something asked the store before the listing");

  const first = invoke("studio:mcpServers");
  const second = invoke("studio:mcpServers");

  assert.equal(first.ok, true);
  assert.equal(second.servers.length, 2);
  assert.equal(storeAsks, 0, `listing the servers asked the store ${storeAsks} time(s)`);
});

// ---- AC3 ---------------------------------------------------------------------

test("AC3: the availability call answers the fixed shape, false, and nothing else", () => {
  // KYB-695 held this to a bare boolean. KYB-696 widens it on purpose, so the
  // renderer can show the main process's words for the case, and this test
  // holds the new shape just as tightly: a field missing, a field extra, a
  // field of the wrong type, or any env data, is red.
  fresh();
  givenStored([server({ id: "plain", name: "Plain", env: { STORED_SENTINEL_KEY: "stored-sentinel-value" } })]);
  const saved = invoke("studio:saveMcpServers", [
    { ...stored("plain"), env: { STORED_SENTINEL_KEY: "stored-sentinel-value", HELD_SENTINEL_KEY: TYPED } },
  ]);
  assert.deepEqual(saved.heldKeys?.plain, ["HELD_SENTINEL_KEY"], "precondition: the typed value is not held");

  const answer = invoke("studio:credentialStoreAvailable");
  assert.equal(typeof answer, "object", `answered ${JSON.stringify(answer)}`);
  assert.ok(answer !== null && !Array.isArray(answer), `answered ${JSON.stringify(answer)}`);
  assert.equal(Object.getPrototypeOf(answer), Object.prototype, "not a plain object");
  assert.deepEqual(Object.keys(answer).sort(), ["available", "description", "remedy"], `answered ${JSON.stringify(answer)}`);
  assert.equal(answer.available, false);
  assert.equal(typeof answer.description, "string");
  assert.equal(typeof answer.remedy, "string");
  assert.ok(answer.description.length > 0, "no description for an unavailable store");
  assert.ok(answer.remedy.length > 0, "no remedy for an unavailable store");
  const wire = JSON.stringify(answer);
  for (const sentinel of ["stored-sentinel-value", TYPED, "STORED_SENTINEL_KEY", "HELD_SENTINEL_KEY"]) {
    assert.ok(!wire.includes(sentinel), `the answer carries ${sentinel}`);
  }
});

test("AC3: a typed value for a server with a sealed value is not written to disk", () => {
  fresh();
  givenStored([server({ id: "sealed", name: "Sealed", env: { KYB_KEY: sealed("first") } })]);
  const before = JSON.parse(raw()).servers[0].env;

  invoke("studio:saveMcpServers", [{ ...stored("sealed"), env: { KYB_KEY: TYPED } }]);

  assert.ok(!raw().includes(TYPED), "the typed value was written to disk");
  assert.deepEqual(JSON.parse(raw()).servers[0].env, before, "the stored env changed");
});

test("AC3: a typed value for a server with a sealed value is not held in memory", async () => {
  fresh();
  givenStored([server({ id: "sealed", name: "Sealed", env: { KYB_KEY: sealed("first") } })]);

  const result = invoke("studio:saveMcpServers", [
    { ...stored("sealed"), env: { KYB_KEY: sealed("first"), NEW_KEY: TYPED } },
  ]);
  assert.equal(result.heldKeys?.sealed, undefined, "the list result names keys held for a sealed server");

  // Nothing typed may be waiting either. A hand-edit that takes the sealed
  // value off the disk is the one way such a server can start this run, and
  // whatever was held would reach it then.
  givenStored([server({ id: "sealed", name: "Sealed", env: {} })]);
  stopAll();
  await callServer({ serverId: "sealed", method: "tools/list" });
  const env = spawned.at(-1).options.env;
  assert.equal(env.NEW_KEY, undefined, "a value typed for a sealed server was held, and reached a process");
});

test("AC3: a typed value for a server with a sealed value never reaches a started process", async () => {
  fresh();
  givenStored([server({ id: "sealed", name: "Sealed", env: { KYB_KEY: sealed("first") } })]);

  // The new value for its one sealed key, the case where writing it through
  // would leave nothing sealed and let the server start.
  invoke("studio:saveMcpServers", [{ ...stored("sealed"), env: { KYB_KEY: TYPED } }]);
  const checked = await invoke("studio:testMcpServer", "sealed");

  assert.equal(checked.ok, false, "a server with a sealed value started while the store is unavailable");
  for (const env of everyEnvSpawned()) {
    assert.ok(!Object.values(env).includes(TYPED), "the typed value reached a started process");
  }
});

// ---- AC4 ---------------------------------------------------------------------

test("AC4: the list result names KYB_KEY for a server with no sealed value, and never its value", () => {
  fresh();
  const saved = invoke("studio:saveMcpServers", [server({ env: { KYB_KEY: TYPED } })]);
  const listed = invoke("studio:mcpServers");

  for (const [what, result] of [["the save's answer", saved], ["the list", listed]]) {
    assert.equal(result.ok, true);
    assert.deepEqual(result.heldKeys?.a, ["KYB_KEY"], `${what} does not name KYB_KEY`);
    assert.ok(!JSON.stringify(result).includes(TYPED), `${what} carries the typed value`);
  }
});

test("AC4: a server with nothing held has no names in the result", () => {
  fresh();
  invoke("studio:saveMcpServers", [server({ env: { KYB_KEY: TYPED } }), server({ id: "b", name: "B" })]);

  const listed = invoke("studio:mcpServers");
  assert.deepEqual(listed.heldKeys, { a: ["KYB_KEY"] });
  assert.equal("b" in listed.heldKeys, false, "B has names with nothing held");
});

test("AC4: removing the server takes its names out of the result", () => {
  fresh();
  invoke("studio:saveMcpServers", [server({ env: { KYB_KEY: TYPED } }), server({ id: "b", name: "B" })]);

  const afterRemove = invoke("studio:saveMcpServers", [stored("b")]);
  const listed = invoke("studio:mcpServers");

  assert.deepEqual(afterRemove.heldKeys, {}, "the save that removed A still names a key for it");
  assert.deepEqual(listed.heldKeys, {}, "the list still names a key for a removed server");
});

// ---- AC1, the main process's half of the looksSealed clause -------------------

test("AC1 (looksSealed): in the main process, a server whose only stored value starts with kyb:v1: but fails looksSealed holds what is typed", async () => {
  // `saveServers` decides "sealed on disk" with `looksSealed`, as the renderer
  // does. A bare prefix check would call this server sealed and drop NEW_KEY.
  fresh();
  givenStored([server({ env: { KYB_KEY: "kyb:v1:my key" } })]);

  const saved = invoke("studio:saveMcpServers", [
    { ...stored("a"), env: { KYB_KEY: "kyb:v1:my key", NEW_KEY: TYPED } },
  ]);
  assert.deepEqual(saved.heldKeys?.a, ["NEW_KEY"], "the typed key is not held");

  stopAll();
  await callServer({ serverId: "a", method: "tools/list" });
  assert.equal(spawned.at(-1).options.env.NEW_KEY, TYPED, "the typed key did not reach the started process");
});
