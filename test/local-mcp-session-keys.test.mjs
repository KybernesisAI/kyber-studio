import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Keys typed while the credential store is unavailable (KYB-691).
 *
 * Studio writes no new env value to disk then, and holds it in memory for the
 * session instead. The renderer saves the whole list on every change, sending
 * each server's env as it is stored, which never includes a held value. These
 * pin down that such a save keeps what is held, so the key lasts until Studio
 * restarts or the server is removed, and that nothing typed reaches the disk.
 *
 *  - AC1: a held key survives a rename, Turn off then on, and another server
 *    being added or removed. Also for a server whose stored values are plain
 *    text, where every save re-sends that plain text.
 *  - AC2: the typed text is never on disk after any of those saves.
 *  - AC3: removing a server forgets its held key.
 *  - AC4: retyping one key replaces that key and keeps the others.
 *
 * A separate file because availability is answered once and cached for the
 * life of the process: this whole file runs with the store unavailable.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-session-keys-"));
const TYPED = "typed-this-session";

mock.module("electron", {
  exports: {
    app: { getPath: () => dir, on: () => {}, whenReady: async () => {} },
    shell: { openExternal: async () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: () => {}, on: () => {} },
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
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => "gnome_libsecret",
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

/** Every server `spawn` made, newest last. Each answers the MCP handshake. */
const spawned = [];
mock.module("node:child_process", {
  exports: {
    spawn: (file, args, options) => {
      const child = new EventEmitter();
      child.unref = () => {};
      if (/taskkill/i.test(file)) return child;
      child.file = file;
      child.args = args;
      child.options = options;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 5000 + spawned.length;
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
    execFile: () => {},
    exec: () => {},
  },
});

const { callServer, listServers, saveServers, stopAll } = await import("../src/main/localMcp.ts");

const configPath = () => join(dir, "local-mcp.json");
const raw = () => readFileSync(configPath(), "utf8");

const server = (over = {}) => ({ id: "a", name: "A", command: "npx", args: ["-y", "a-mcp"], enabled: true, ...over });
const stored = (id) => listServers().find((s) => s.id === id);

/** A clean slate: no config, nothing running, nothing held. */
function fresh() {
  stopAll();
  // Saving an empty list forgets every held value, through the same loop a
  // removal takes, so no test inherits another's.
  rmSync(configPath(), { force: true });
  saveServers([]);
  rmSync(configPath(), { force: true });
  spawned.length = 0;
}

/** The env A's next started process gets. */
async function nextEnvOf(id) {
  stopAll();
  await callServer({ serverId: id, method: "tools/list" });
  return spawned.at(-1).options.env;
}

/** A added while the store is unavailable, with a key typed for it. */
function addedWithTypedKey() {
  fresh();
  saveServers([server({ env: { KYB_KEY: TYPED } })]);
}

/**
 * Each later save as the renderer makes it: from what is stored, which is the
 * state `listServers()` hands back after every save.
 */
const laterSaves = {
  "a rename of A": () => saveServers([{ ...stored("a"), name: "A renamed" }]),
  "A turned off, then on": () => {
    saveServers([{ ...stored("a"), enabled: false }]);
    saveServers([{ ...stored("a"), enabled: true }]);
  },
  "the list with another server added": () => saveServers([...listServers(), server({ id: "b", name: "B" })]),
  "the list with another server removed": () => {
    saveServers([...listServers(), server({ id: "b", name: "B" })]);
    saveServers(listServers().filter((s) => s.id !== "b"));
  },
};

for (const [what, act] of Object.entries(laterSaves)) {
  test(`AC1, AC2: a key typed this session survives ${what}, and never reaches disk`, async () => {
    addedWithTypedKey();
    assert.equal((await nextEnvOf("a")).KYB_KEY, TYPED, "precondition: the typed key reaches the first start");

    act();

    assert.ok(!raw().includes(TYPED), "the typed key was written to disk");
    assert.equal((await nextEnvOf("a")).KYB_KEY, TYPED, `the typed key was lost by ${what}`);
  });
}

test("AC1, AC2: on a server stored in plain text, a typed key survives Turn off then on", async () => {
  fresh();
  writeFileSync(
    configPath(),
    JSON.stringify({ servers: [server({ env: { OLD: "disk" } })] }, null, 2),
    "utf8",
  );
  // The edit form sends the stored plain value back with the new key.
  saveServers([{ ...stored("a"), env: { ...stored("a").env, KYB_KEY: TYPED } }]);
  assert.equal((await nextEnvOf("a")).KYB_KEY, TYPED, "precondition: the typed key reaches the first start");

  laterSaves["A turned off, then on"]();

  const env = await nextEnvOf("a");
  assert.equal(env.KYB_KEY, TYPED, "the typed key was lost on a server stored in plain text");
  assert.equal(env.OLD, "disk", "the stored plain value was lost");
  assert.ok(!raw().includes(TYPED), "the typed key was written to disk");
});

test("AC1: on a server stored in plain text, a new value for a stored key is held over it", async () => {
  fresh();
  writeFileSync(
    configPath(),
    JSON.stringify({ servers: [server({ env: { OLD: "disk" } })] }, null, 2),
    "utf8",
  );
  saveServers([{ ...stored("a"), env: { OLD: "retyped" } }]);
  laterSaves["a rename of A"]();

  assert.equal((await nextEnvOf("a")).OLD, "retyped");
  assert.equal(stored("a").env.OLD, "disk", "the stored plain value changed on disk");
});

test("AC3: removing a server forgets its key, even when its id comes back", async () => {
  addedWithTypedKey();

  saveServers([]);
  saveServers([server()]);

  assert.equal((await nextEnvOf("a")).KYB_KEY, undefined, "the removed server's key reached the new one");
});

test("AC3: a server new to the disk does not inherit a key held under its id, as after a quarantine", async () => {
  addedWithTypedKey();

  // The config becomes unreadable, and the way out renames it aside and saves
  // a new list. Nothing is on disk any more, so the new A is a new server.
  writeFileSync(configPath(), "{ not json", "utf8");
  saveServers([server({ name: "Another A" })], { onUnreadableConfig: "quarantine" });

  assert.equal((await nextEnvOf("a")).KYB_KEY, undefined, "a new server inherited a key held under its id");
});

test("AC4: retyping one key replaces that key and keeps the others", async () => {
  fresh();
  saveServers([server({ env: { X: "1", Y: "2" } })]);

  // The form cannot show held keys, so this save carries X alone.
  saveServers([{ ...stored("a"), env: { X: "3" } }]);

  const env = await nextEnvOf("a");
  assert.equal(env.X, "3", "the retyped key did not take");
  assert.equal(env.Y, "2", "retyping one key lost another");
});

test("the in-memory warning is logged when a value is typed, not again on a save that brings nothing new", () => {
  // A server stored in plain text, because every save re-sends that plain
  // text: before KYB-691 each of those saves counted as typing and warned.
  fresh();
  writeFileSync(
    configPath(),
    JSON.stringify({ servers: [server({ env: { OLD: "disk" } })] }, null, 2),
    "utf8",
  );
  const warned = [];
  const original = console.warn;
  console.warn = (...args) => warned.push(args.join(" "));
  try {
    saveServers([{ ...stored("a"), env: { ...stored("a").env, KYB_KEY: TYPED } }]);
    const afterTyping = warned.filter((w) => w.includes("kept in memory only")).length;
    laterSaves["A turned off, then on"]();
    const afterToggle = warned.filter((w) => w.includes("kept in memory only")).length;
    assert.equal(afterTyping, 1, "no warning when the value was typed");
    assert.equal(afterToggle, 1, "a save with nothing new warned again");
  } finally {
    console.warn = original;
  }
});
