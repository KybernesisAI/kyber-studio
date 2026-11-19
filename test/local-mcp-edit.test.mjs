import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Editing a local MCP server, main-process half (KYB-591).
 *
 *  - AC3: the reveal call opens one value and nothing else, and says why when
 *    it cannot. (The store-unavailable answer needs a process whose store is
 *    shut for good: see local-mcp-locked-store.test.mjs.)
 *  - AC4: an edit's replace, remove and add land on disk sealed.
 *  - AC5: a rename keeps the id and the consent grant.
 *  - AC7: a save stops a running server it changed, removed or turned off,
 *    and nothing else; the next call starts it with what was saved.
 *  - AC9: the consent card names the server, not its id.
 *  - AC10: a grant is cleared with its server and before a new one takes its
 *    id, and never by a save over a config that cannot be read.
 *
 * The save goes through the handler `registerIpc` registered for
 * `studio:saveMcpServers`, invoked as `ipcMain` would, because the grant
 * clearing lives there.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-mcp-edit-"));
/** Every value the fake store was asked to open, in order. */
const decrypted = [];
/** Plaintexts this store refuses to open, as one sealed elsewhere would. */
const undecryptable = new Set();

mock.module("electron", {
  exports: {
    app: { getPath: () => dir, on: () => {}, whenReady: async () => {} },
    shell: { openExternal: async () => {} },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
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
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (s) => Buffer.from(`ENC(${s})`, "utf8"),
      decryptString: (b) => {
        const match = /^ENC\((.*)\)$/s.exec(b.toString("utf8"));
        if (!match) throw new Error("not sealed by this store");
        decrypted.push(match[1]);
        if (undecryptable.has(match[1])) throw new Error("decrypt failed");
        return match[1];
      },
    },
  },
});

mock.module("@electron-toolkit/utils", {
  exports: { electronApp: {}, optimizer: {}, is: { dev: false } },
});

/** Every child `spawn` made, newest last. Each answers the MCP handshake. */
const spawned = [];
/**
 * When set, `kill` leaves `child.killed` false, as on Windows, where the handle
 * is `cmd.exe` and `killTree` signals nothing through it.
 */
let killLeavesKilledFalse = false;
mock.module("node:child_process", {
  exports: {
    spawn: (file, args, options) => {
      const child = new EventEmitter();
      child.file = file;
      child.args = args;
      child.options = options;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4000 + spawned.length;
      child.killed = false;
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal ?? "SIGTERM");
        if (!killLeavesKilledFalse) child.killed = true;
        return true;
      };
      child.unref = () => {};
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

const handlers = new Map();
const { registerIpc } = await import("../src/main/ipc.ts");
const { callServer, listServers, saveServers, stopAll } = await import("../src/main/localMcp.ts");
const { answerAsk, authorize, serverPermission, setServerPermission } = await import("../src/main/localExec.ts");
registerIpc();

const configPath = () => join(dir, "local-mcp.json");
const permsPath = () => join(dir, "local-permissions.json");
const onDisk = () => JSON.parse(readFileSync(configPath(), "utf8")).servers;
const perms = () => (existsSync(permsPath()) ? JSON.parse(readFileSync(permsPath(), "utf8")) : {});
const sealedOf = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;
const opened = (value) => {
  assert.ok(value.startsWith("kyb:v1:"), `not sealed: ${value}`);
  return /^ENC\((.*)\)$/s.exec(Buffer.from(value.slice(7), "base64").toString("utf8"))[1];
};

/** The save the renderer makes, through the registered handler. */
const save = (servers, options) => handlers.get("studio:saveMcpServers")({}, servers, options);
const reveal = (id, key) => handlers.get("studio:revealMcpEnv")({}, id, key);

const server = (over = {}) => ({
  id: "s1",
  name: "db",
  command: "npx",
  args: ["-y", "db-mcp"],
  enabled: true,
  ...over,
});

/** A clean slate: no config, no grants, nothing running. */
function fresh() {
  stopAll();
  rmSync(configPath(), { force: true });
  rmSync(permsPath(), { force: true });
  spawned.length = 0;
  killLeavesKilledFalse = false;
  decrypted.length = 0;
  undecryptable.clear();
}

// ---- AC3: reveal opens one value and nothing else ---------------------------

test("AC3: reveal opens the one value asked for, and asks the store about no other", () => {
  fresh();
  saveServers([server({ env: { A: "alpha", B: "beta", C: "gamma" } })]);
  decrypted.length = 0;

  assert.deepEqual(reveal("s1", "B"), { ok: true, value: "beta" });
  assert.deepEqual(decrypted, ["beta"], "the reveal opened more than the key asked for");
});

test("AC3: a value this store did not seal answers needs-re-entry, and does not stop another opening", () => {
  fresh();
  saveServers([server({ env: { A: "alpha", B: "beta" } })]);
  undecryptable.add("alpha");

  assert.deepEqual(reveal("s1", "A"), { ok: false, reason: "needs-re-entry" });
  assert.deepEqual(reveal("s1", "B"), { ok: true, value: "beta" });
});

test("AC3: an unknown server or key answers not-found, with no value", () => {
  fresh();
  saveServers([server({ env: { A: "alpha" } })]);
  decrypted.length = 0;

  assert.deepEqual(reveal("nope", "A"), { ok: false, reason: "not-found" });
  assert.deepEqual(reveal("s1", "Z"), { ok: false, reason: "not-found" });
  // `hasOwnProperty`, not `in`: a key named after an Object member is not stored.
  assert.deepEqual(reveal("s1", "toString"), { ok: false, reason: "not-found" });
  assert.deepEqual(decrypted, [], "a not-found reveal asked the store to open something");
});

// ---- AC4: replace, remove and add land on disk sealed -----------------------

test("AC4: an edit that replaces A, removes B and adds C is on disk sealed, with B gone", () => {
  fresh();
  saveServers([server({ env: { A: "old-a", B: "old-b", D: "keep-d" } })]);
  const stored = listServers()[0];

  // What the edit form sends: A typed anew, B removed, C added, D untouched
  // and so sent back as the sealed string it arrived as.
  save([{ ...stored, env: { A: "new-a", C: "new-c", D: stored.env.D } }]);

  const env = onDisk()[0].env;
  assert.deepEqual(Object.keys(env).sort(), ["A", "C", "D"]);
  assert.equal(opened(env.A), "new-a");
  assert.equal(opened(env.C), "new-c");
  assert.equal(env.D, stored.env.D, "an untouched value was rewritten");
  assert.ok(!readFileSync(configPath(), "utf8").includes("new-a"), "plaintext on disk");
});

// ---- AC5: a rename keeps the id and the grant -------------------------------

test("AC5: renaming a server keeps its grant, and adds none", () => {
  fresh();
  save([server()]);
  setServerPermission("s1", "always");
  const keysBefore = Object.keys(perms()).sort();

  const result = save([{ ...listServers()[0], name: "renamed db" }]);

  assert.equal(result.ok, true);
  assert.deepEqual(result.servers.map((s) => [s.id, s.name]), [["s1", "renamed db"]]);
  assert.equal(serverPermission("s1"), "always");
  assert.deepEqual(Object.keys(perms()).sort(), keysBefore, "the grant file gained or lost a key");
});

// ---- AC7: a save stops what it changed, and only that -----------------------

async function startBoth() {
  save([server({ id: "a", name: "A", env: { KEY: "first" } }), server({ id: "b", name: "B" })]);
  await callServer({ serverId: "a", method: "tools/list" });
  await callServer({ serverId: "b", method: "tools/list" });
  assert.equal(spawned.length, 2, "both servers should be running");
  return { a: spawned[0], b: spawned[1] };
}

test("AC7: an edit to A stops A, leaves B, and A's next call starts with the new env", async () => {
  fresh();
  const { a, b } = await startBoth();
  const [storedA, storedB] = listServers();

  save([{ ...storedA, env: { KEY: "second" } }, storedB]);
  assert.deepEqual(a.signals, ["SIGTERM"], "the edited server was not stopped");
  assert.deepEqual(b.signals, [], "an unchanged server was stopped");

  await callServer({ serverId: "a", method: "tools/list" });
  assert.equal(spawned.length, 3, "A's next call did not start a new process");
  assert.equal(spawned[2].options.env.KEY, "second", "the new process did not get the new env");

  // The old process exits after its replacement started. It must not take the
  // replacement out of the running set, or the next call would start a third.
  a.emit("exit", 0);
  await callServer({ serverId: "a", method: "tools/list" });
  assert.equal(spawned.length, 3, "the old process's exit evicted its replacement");
});

test("AC7: a stopped process whose handle still says it is alive is not handed back", async () => {
  fresh();
  const { a } = await startBoth();
  killLeavesKilledFalse = true;
  const [storedA, storedB] = listServers();

  save([{ ...storedA, env: { KEY: "second" } }, storedB]);
  assert.deepEqual(a.signals, ["SIGTERM"], "the edited server was not stopped");
  assert.equal(a.killed, false, "the fake should leave killed false");

  await callServer({ serverId: "a", method: "tools/list" });
  assert.equal(spawned.length, 3, "the call went to the stopped process instead of a new one");
  assert.equal(spawned[2].options.env.KEY, "second");

  // The old process errors after its replacement started. It must not take the
  // replacement out of the running set, or the next call would start a third.
  a.emit("error", new Error("spawn EPERM"));
  await callServer({ serverId: "a", method: "tools/list" });
  assert.equal(spawned.length, 3, "the old process's error evicted its replacement");
});

test("AC7: an unchanged save stops nothing, whatever order the entry's keys arrive in", async () => {
  fresh();
  const { a, b } = await startBoth();
  save(listServers());
  assert.deepEqual([a.signals, b.signals], [[], []]);

  // The edit form builds a fresh object, so an edit that changed nothing sends
  // the same entry with its keys in another order.
  const reversed = (s) => Object.fromEntries(Object.entries(s).reverse());
  save(listServers().map(reversed));
  assert.deepEqual([a.signals, b.signals], [[], []], "a save that changed nothing stopped a server");
});

test("AC7: turning A off stops it", async () => {
  fresh();
  const { a, b } = await startBoth();
  save(listServers().map((s) => (s.id === "a" ? { ...s, enabled: false } : s)));
  assert.deepEqual(a.signals, ["SIGTERM"], "a turned-off server is still running");
  assert.deepEqual(b.signals, []);
});

test("AC7: removing A stops it", async () => {
  fresh();
  const { a, b } = await startBoth();
  save(listServers().filter((s) => s.id !== "a"));
  assert.deepEqual(a.signals, ["SIGTERM"], "a removed server is still running");
  assert.deepEqual(b.signals, []);
});

// ---- AC9: the consent card names the server ---------------------------------

/** Ask consent for a call to `serverId`, and return the card's detail. */
async function cardDetail(serverId) {
  const sent = [];
  const sender = { isDestroyed: () => false, send: (channel, payload) => sent.push({ channel, payload }) };
  const decision = authorize(sender, {
    id: `ask-${serverId}`,
    agent: "agent",
    action: "local-mcp",
    payload: { server: serverId, method: "tools/list" },
  });
  assert.equal(sent.length, 1, "no consent card was sent");
  answerAsk(`ask-${serverId}`, false, false);
  await decision;
  return sent[0].payload.detail;
}

test("AC9: the card shows the stored name for an id, and the id when nothing is stored under it", async () => {
  fresh();
  save([server({ id: "foo", name: "Bar" })]);
  assert.equal(await cardDetail("foo"), "Bar");
  assert.equal(await cardDetail("ghost"), "ghost");
});

// ---- AC10: a grant never outlives its server --------------------------------

test("AC10: removing foo clears mcp:foo", () => {
  fresh();
  save([server({ id: "foo", name: "Foo" }), server({ id: "keep", name: "Keep" })]);
  setServerPermission("foo", "always");
  setServerPermission("keep", "always");

  save(listServers().filter((s) => s.id !== "foo"));

  assert.equal(Object.prototype.hasOwnProperty.call(perms(), "mcp:foo"), false, "the removed server's grant is still stored");
  assert.equal(serverPermission("keep"), "always", "another server's grant was cleared");
});

test("AC10: a new server under an id with a grant left behind starts at ask", () => {
  fresh();
  save([server({ id: "other", name: "Other" })]);
  setServerPermission("foo", "always"); // left by a server removed on an older build

  save([...listServers(), server({ id: "foo", name: "Foo" })]);

  assert.equal(serverPermission("foo"), "ask", "the new server inherited an old grant");
});

test("AC10: editing or turning off foo keeps its grant", () => {
  fresh();
  save([server({ id: "foo", name: "Foo" })]);
  setServerPermission("foo", "always");

  save([{ ...listServers()[0], name: "Foo renamed", args: ["-y", "other"] }]);
  assert.equal(serverPermission("foo"), "always", "an edit cleared the grant");
  save([{ ...listServers()[0], enabled: false }]);
  assert.equal(serverPermission("foo"), "always", "turning off cleared the grant");
});

test("AC10: a save over an unreadable config clears no grant, refused or quarantined", () => {
  fresh();
  writeFileSync(configPath(), "{ not json", "utf8");
  setServerPermission("foo", "always");
  setServerPermission("gone", "never");

  const refused = save([server({ id: "foo", name: "Foo" })]);
  assert.equal(refused.ok, false, "the save was not refused");
  assert.deepEqual([serverPermission("foo"), serverPermission("gone")], ["always", "never"]);

  const quarantined = save([server({ id: "foo", name: "Foo" })], { onUnreadableConfig: "quarantine" });
  assert.equal(quarantined.ok, true);
  assert.deepEqual([serverPermission("foo"), serverPermission("gone")], ["always", "never"]);
});

test("AC10: a grant file that cannot be read is not replaced by an empty one", () => {
  fresh();
  save([server({ id: "foo", name: "Foo" })]);
  writeFileSync(permsPath(), "{ torn", "utf8");

  save([]);

  assert.equal(readFileSync(permsPath(), "utf8"), "{ torn", "the unreadable grant file was rewritten");
});
