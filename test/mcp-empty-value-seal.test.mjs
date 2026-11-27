import { after, test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asRenderer } from "./helpers/mcp-wire.mjs";

/**
 * An empty env value, sealed and opened (KYB-698).
 *
 * On Linux the real `safeStorage.encryptString("")` returns an EMPTY buffer,
 * so sealing `""` stored the bare prefix `kyb:v1:`. `looksSealed` rejects an
 * empty payload on purpose, so that value read back as the 7-character plain
 * text `kyb:v1:`: the child was given it, and the next save sealed it for good.
 *
 * Every other fake store in this repo turns `""` into a non-empty payload
 * (`ENC(${s})`, `sealed(${s})`), which is why no test saw this. The store here
 * does what Linux does, and that is part of what these tests assert: with an
 * `ENC(${s})` store, AC4 passes on a build that has the defect.
 *
 *  - AC1: an empty value is stored empty, and `encryptString("")` is never called.
 *  - AC2: an empty value needs no keyring.
 *  - AC3: a value stored as the bare prefix reads as `""`, on open and on save.
 *  - AC4: end to end, through `studio:saveMcpServers` and a start.
 *  - guard: a non-empty value is still sealed, including one a person typed
 *    that starts with `kyb:v1:`.
 */

const PREFIX = "kyb:v1:";

/**
 * A safeStorage that answers as Linux does for `""`: an empty buffer. Any
 * other value seals to `ENC(<value>)`, so it is never empty. It records each
 * call, and what `encryptString` was given.
 */
function linuxLikeStore({ available = true } = {}) {
  const calls = { isEncryptionAvailable: 0, encryptString: 0, decryptString: 0 };
  const encrypted = [];
  return {
    calls,
    encrypted,
    isEncryptionAvailable() {
      calls.isEncryptionAvailable += 1;
      return available;
    },
    getSelectedStorageBackend() {
      return "gnome_libsecret";
    },
    encryptString(plain) {
      calls.encryptString += 1;
      encrypted.push(plain);
      return plain === "" ? Buffer.alloc(0) : Buffer.from(`ENC(${plain})`, "utf8");
    },
    decryptString(buf) {
      calls.decryptString += 1;
      if (buf.length === 0) return "";
      const match = /^ENC\((.*)\)$/s.exec(buf.toString("utf8"));
      if (!match) throw new Error("not sealed by this store");
      return match[1];
    },
  };
}

/** What `linuxLikeStore` stores for a non-empty `plain`. */
const sealedAs = (plain) => PREFIX + Buffer.from(`ENC(${plain})`, "utf8").toString("base64");

// The main process, for AC4. One store for the life of the file: availability
// is asked once per process and cached.
const dir = mkdtempSync(join(tmpdir(), "kyb-698-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const mainStore = linuxLikeStore();
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
    safeStorage: mainStore,
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

const { sealEnv, unsealEnv } = await import("../src/main/mcpSecrets.ts");
const { registerIpc } = await import("../src/main/ipc.ts");
const { stopAll } = await import("../src/main/localMcp.ts");
registerIpc();
after(() => stopAll());

/** Call a registered handler the way `ipcMain` does: an event, then the args. */
// Through the renderer's codec: `env` crosses as pairs since KYB-700.
const invoke = asRenderer((channel, ...args) => {
  const handler = handlers.get(channel);
  assert.ok(handler, `nothing was registered for ${channel}`);
  return handler({ sender: null }, ...args);
});

test("AC1: an empty value is stored empty, and encryptString is not called for it", () => {
  const ss = linuxLikeStore();
  const result = sealEnv(ss, { K: "" });

  assert.equal(result.ok, true);
  assert.equal(result.env.K, "", `the empty value was stored as ${JSON.stringify(result.env.K)}`);
  assert.ok(!ss.encrypted.includes(""), 'encryptString was called with ""');
});

test("AC1: an empty value beside one that is sealed is still stored empty", () => {
  const ss = linuxLikeStore();
  const result = sealEnv(ss, { K: "", X: "x" });

  assert.equal(result.ok, true);
  assert.equal(result.env.K, "", `the empty value was stored as ${JSON.stringify(result.env.K)}`);
  assert.equal(result.env.X, sealedAs("x"), "precondition: the non-empty value was sealed");
  assert.deepEqual(ss.encrypted, ["x"], 'encryptString was called with ""');
});

test("AC2: one sealed value and one empty value need no keyring", () => {
  const ss = linuxLikeStore({ available: false });
  const env = { S: sealedAs("secret"), K: "" };
  const result = sealEnv(ss, env);

  assert.deepEqual(result, { ok: true, env }, "an empty value made a save with the store unavailable fail");
  assert.equal(ss.calls.isEncryptionAvailable, 0, "the OS was asked for a keyring");
  assert.equal(ss.calls.encryptString, 0, "encryptString was called");
});

test("AC3: a value stored as the bare prefix opens as empty", () => {
  const ss = linuxLikeStore();
  const opened = unsealEnv(ss, { K: PREFIX });

  assert.equal(opened.ok, true);
  assert.equal(opened.env.K, "", `the bare prefix opened as ${JSON.stringify(opened.env.K)}`);
});

test("AC3: a value stored as the bare prefix beside a sealed one opens as empty", () => {
  const ss = linuxLikeStore();
  const opened = unsealEnv(ss, { S: sealedAs("secret"), K: PREFIX });

  assert.equal(opened.ok, true);
  assert.deepEqual(opened.env, { S: "secret", K: "" });
});

test("AC3: a value stored as the bare prefix is saved as empty, without encryptString", () => {
  const ss = linuxLikeStore();
  const result = sealEnv(ss, { K: PREFIX });

  assert.equal(result.ok, true);
  assert.equal(result.env.K, "", `the bare prefix was saved as ${JSON.stringify(result.env.K)}`);
  assert.equal(ss.calls.encryptString, 0, "encryptString was called");
});

test("AC3: a value stored as the bare prefix beside a sealed one is saved as empty, without asking the OS", () => {
  // The migration runs before sealEnv's early checks, so the bare prefix counts
  // as empty there too: nothing in this map needs the OS.
  const ss = linuxLikeStore({ available: false });
  const S = sealedAs("secret");
  const result = sealEnv(ss, { S, K: PREFIX });

  assert.deepEqual(result, { ok: true, env: { S, K: "" } }, "the bare prefix was not saved as empty without the OS");
  assert.equal(ss.calls.isEncryptionAvailable, 0, "the OS was asked for a keyring");
  assert.equal(ss.calls.encryptString, 0, "encryptString was called");
});

test("AC3: a value stored as the bare prefix beside a new value is saved as empty", () => {
  const ss = linuxLikeStore();
  const result = sealEnv(ss, { K: PREFIX, X: "x" });

  assert.equal(result.ok, true);
  assert.equal(result.env.K, "", `the bare prefix was saved as ${JSON.stringify(result.env.K)}`);
  assert.deepEqual(ss.encrypted, ["x"], "encryptString was called for the bare prefix");
});

test("AC4: a server saved with an empty value starts with that value empty", async () => {
  const server = { id: "e", name: "E", command: "npx", args: ["-y", "e-mcp"], enabled: true, env: { K: "" } };
  const saved = invoke("studio:saveMcpServers", [server]);
  assert.equal(saved.ok, true, `the save failed: ${JSON.stringify(saved)}`);

  const result = await invoke("studio:testMcpServer", "e");
  assert.equal(result.ok, true, `the server did not start: ${JSON.stringify(result)}`);

  const env = spawned.at(-1).options.env;
  assert.equal(env.K, "", `the child was given K=${JSON.stringify(env.K)}`);
  const stored = JSON.parse(readFileSync(join(dir, "local-mcp.json"), "utf8")).servers[0].env;
  assert.equal(stored.K, "", `the value was stored as ${JSON.stringify(stored.K)}`);
});

test("guard: a non-empty value is still sealed", () => {
  const ss = linuxLikeStore();
  const result = sealEnv(ss, { K: "x" });

  assert.equal(result.ok, true);
  assert.deepEqual(ss.encrypted, ["x"], "encryptString was not called for the value");
  assert.equal(result.env.K, sealedAs("x"), `the value was stored as ${JSON.stringify(result.env.K)}`);
  assert.deepEqual(unsealEnv(ss, result.env), { ok: true, env: { K: "x" } });
});

test("guard: a typed value that starts with the prefix is sealed and opens as itself", () => {
  // A person may type this, and it is not ciphertext: `looksSealed` says so.
  // Only a value of exactly the prefix is read as empty.
  const typed = `${PREFIX}not base64 at all!!`;
  const ss = linuxLikeStore();
  const result = sealEnv(ss, { K: typed });

  assert.equal(result.ok, true);
  assert.deepEqual(ss.encrypted, [typed], "the typed value was not sealed as typed");
  assert.equal(result.env.K, sealedAs(typed));
  assert.deepEqual(unsealEnv(ss, { K: typed }), { ok: true, env: { K: typed } }, "the typed value did not open as itself");
});
