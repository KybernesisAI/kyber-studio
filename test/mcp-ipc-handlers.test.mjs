import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The two MCP-config IPC handlers, called.
 *
 * WHAT THIS FILE PROVES, and what it does not — stated up front because the
 * assertion it replaces was dishonest about exactly this. The previous version
 * of `local-mcp-call-sites.test.mjs` asserted `error instanceof
 * ConfigUnreadableError` and `error.code === "MCP_CONFIG_UNREADABLE"` and
 * justified those assertions with a comment about the IPC boundary. It never
 * crossed one. It called `listServers` in-process, where `instanceof` obviously
 * holds, and the property it was really asserting — that the renderer can tell
 * this failure apart from a disk fault — was false the whole time.
 *
 * Proves:
 *   - what `registerIpc` actually registered for `studio:mcpServers` and
 *     `studio:saveMcpServers`, invoked exactly as `ipcMain` would invoke it:
 *     `(event, ...args)`. So an argument the registration drops is visible here.
 *   - that those handlers RESOLVE on a damaged config rather than reject, and
 *     what the resolved value says.
 *   - that an `Error` does not survive being cloned, which is why resolving
 *     with a value is the only shape that works.
 *
 * Does NOT prove:
 *   - anything about Electron's real `ipcRenderer.invoke` round trip. There is
 *     no Electron here. The clone assertion below is the FAVOURABLE model of
 *     that boundary; Electron 34 is worse — `-ipc-invoke` replies with
 *     `{ error: error.toString() }` and the renderer throws a fresh plain
 *     `Error` built from that string, so even `stack` and `cause` are gone.
 *   - anything about `contextBridge`, which copies again on the way through.
 *
 * Both of those would need a real Electron process. What they would show is
 * strictly less survival than what is asserted here, so a handler that is safe
 * under this test is safe under them.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-ipc-"));

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
        return match[1];
      },
    },
  },
});

// `ipc.ts` reaches `voice.ts`, which pulls this in. It imports named bindings
// from `electron` as ESM, which the real CommonJS package will not give it.
mock.module("@electron-toolkit/utils", {
  exports: { electronApp: {}, optimizer: {}, is: { dev: false } },
});

/** Everything `registerIpc` handed to `ipcMain.handle`, by channel. */
const handlers = new Map();

const { registerIpc } = await import("../src/main/ipc.ts");
const { ConfigUnreadableError } = await import("../src/main/localMcp.ts");

registerIpc();

/** Call a registered handler the way `ipcMain` does: an event, then the args. */
const invoke = (channel, ...args) => {
  const handler = handlers.get(channel);
  assert.ok(handler, `nothing was registered for ${channel}`);
  return handler({ sender: null }, ...args);
};

const configPath = () => join(dir, "local-mcp.json");
const server = (over = {}) => ({
  id: "s1",
  name: "db",
  command: "npx",
  args: [],
  enabled: true,
  env: { API_KEY: "sk-live-1" },
  ...over,
});
const damaged = '{"servers":[{"id":"s1","cwd":"/home/someone/private-project"';

test("a healthy config answers with the servers", () => {
  invoke("studio:saveMcpServers", [server()]);
  const result = invoke("studio:mcpServers");

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.servers.map((s) => s.id),
    ["s1"],
  );
});

test("an unreadable config is ANSWERED, not thrown, and says which failure it is", () => {
  writeFileSync(configPath(), damaged, "utf8");

  // The whole point. `listServers` throws; the handler must not, because a
  // rejection reaches the renderer as an anonymous string.
  const result = invoke("studio:mcpServers");

  assert.equal(result.ok, false);
  assert.equal(result.code, "MCP_CONFIG_UNREADABLE");
  assert.equal(result.path, configPath());
});

test("an error does not survive being cloned — which is why the answer is a value", () => {
  const original = new ConfigUnreadableError("/home/someone/.config/app", "it is not valid JSON");
  const arrived = structuredClone(original);

  // Every one of these was relied upon by the comment this file replaces.
  assert.equal(arrived instanceof ConfigUnreadableError, false, "instanceof survived");
  assert.equal(arrived.name, "Error", "the class name survived");
  assert.equal(arrived.code, undefined, "`code` survived the clone");
  assert.equal(arrived.path, undefined, "`path` survived the clone");

  // And the value the handler returns instead does survive, intact.
  const answer = structuredClone({ ok: false, code: original.code, path: original.path });
  assert.deepEqual(answer, {
    ok: false,
    code: "MCP_CONFIG_UNREADABLE",
    path: "/home/someone/.config/app",
  });
});

test("a save with no options still refuses, and does not touch the damaged bytes", () => {
  writeFileSync(configPath(), damaged, "utf8");

  const result = invoke("studio:saveMcpServers", [server({ id: "fresh", name: "fresh" })]);

  assert.equal(result.ok, false, "a damaged config was silently written over");
  assert.equal(result.code, "MCP_CONFIG_UNREADABLE");
  assert.equal(readFileSync(configPath(), "utf8"), damaged, "the damaged file was overwritten");
});

test("the quarantine option reaches saveServers THROUGH the registered handler", () => {
  // M14. This is the finding: `saveServers` has taken `onUnreadableConfig`
  // since the previous round, but no renderer call could carry it — the IPC
  // signature had one parameter — so the recovery path was unreachable by
  // construction and a user could not delete a broken server from inside the
  // app. Reverting any link in the chain (the shared type, the preload
  // forward, or this registration's third argument) turns this red.
  writeFileSync(configPath(), damaged, "utf8");
  const before = readdirSync(dir).filter((f) => f.includes(".corrupt-")).length;

  const result = invoke("studio:saveMcpServers", [server({ id: "fresh", name: "fresh" })], {
    onUnreadableConfig: "quarantine",
  });

  assert.equal(result.ok, true, "the option did not reach saveServers");
  assert.deepEqual(
    result.servers.map((s) => s.id),
    ["fresh"],
    "the write did not go through after the recovery",
  );

  const aside = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
  assert.equal(aside.length, before + 1, "the damaged file was not moved aside");
  assert.equal(
    readFileSync(join(dir, aside.at(-1)), "utf8"),
    damaged,
    "the damaged bytes were altered or discarded — they are the user's only copy",
  );
});

test("the preload forwards the options argument rather than dropping it", () => {
  // The third link in the chain, and the only one nothing above can execute:
  // `src/preload/index.ts` runs inside a real preload context, so this is a
  // source read and is honest about being one. It proves the argument is
  // written down, not that Electron carries it.
  //
  // It is worth asserting anyway, because dropping it is silent and total: the
  // handler above would receive `undefined` for `options`, take the default,
  // refuse, and the recovery button would do nothing at all while every test
  // in this file stayed green.
  const source = readFileSync("src/preload/index.ts", "utf8");
  const line = source
    .split("\n")
    .find((l) => l.includes('ipcRenderer.invoke("studio:saveMcpServers"'));

  assert.ok(line, "nothing in the preload invokes studio:saveMcpServers");
  assert.match(
    line,
    /"studio:saveMcpServers",\s*servers,\s*options/,
    `the preload drops the options argument: ${line.trim()}`,
  );
});

/**
 * KYB-621: the permissions panel's save, through the REGISTERED handler, against
 * a target that can never be written. The handler must reject — that rejection
 * is what the card shows (test/local-permissions-dom.test.mjs) — rather than
 * swallow the failure and answer with the unchanged permissions as if it had
 * saved. On POSIX a read-only DIRECTORY refuses the temp write; a read-only
 * file would not stop the rename. On Windows a read-only file does.
 */
test("a permission save that cannot be written rejects through the handler, and changes nothing", {
  skip: process.platform !== "win32" && process.getuid?.() === 0 && "root ignores directory permissions",
}, (t) => {
  // POSIX: a read-only directory. Windows: the read-only attribute on the file,
  // which refuses the rename with EPERM — the retry's own case — so this also
  // shows the retry giving up and the failure still reaching the caller.
  const perms = join(dir, "local-permissions.json");
  if (!existsSync(perms)) writeFileSync(perms, "{}", "utf8");
  const before = invoke("studio:localPermissions");
  if (process.platform === "win32") {
    chmodSync(perms, 0o444);
    t.after(() => chmodSync(perms, 0o666));
  } else {
    chmodSync(dir, 0o555);
    t.after(() => chmodSync(dir, 0o755));
  }

  assert.throws(() => invoke("studio:setLocalPermission", { action: "run-command", value: "always" }), {
    code: process.platform === "win32" ? "EPERM" : "EACCES",
  });
  assert.deepEqual(invoke("studio:localPermissions"), before, "the refused value was applied anyway");
});

/**
 * KYB-621: the MCP config — the ticket's headline case — saved through the
 * REGISTERED handler against a target that can never be written. It must reject
 * (the Plugins panel folds a rejection into "That didn't save: …", pinned in
 * test/mcp-panel-dom.test.mjs), leave the file's bytes alone, and leave the
 * servers it reports unchanged.
 *
 * Runs on BOTH arms, because Windows is where the save actually fails:
 *   - POSIX: a read-only directory refuses the temp write (EACCES). A read-only
 *     FILE would not stop the rename, so it would prove nothing.
 *   - Windows: the read-only attribute on the file refuses the rename (EPERM),
 *     which is exactly the error the retry exists for — so this also shows the
 *     retry giving up and the failure still reaching the caller.
 */
test("an MCP config save that cannot be written rejects through the handler, and changes nothing", {
  skip: process.platform !== "win32" && process.getuid?.() === 0 && "root ignores directory permissions",
}, (t) => {
  writeFileSync(configPath(), JSON.stringify({ servers: [server()] }, null, 2), "utf8");
  const bytes = readFileSync(configPath(), "utf8");
  const before = invoke("studio:mcpServers");
  assert.equal(before.ok, true, "the fixture did not load");

  if (process.platform === "win32") {
    chmodSync(configPath(), 0o444);
    t.after(() => chmodSync(configPath(), 0o666));
  } else {
    chmodSync(dir, 0o555);
    t.after(() => chmodSync(dir, 0o755));
  }

  assert.throws(() => invoke("studio:saveMcpServers", []), {
    code: process.platform === "win32" ? "EPERM" : "EACCES",
  });
  assert.equal(readFileSync(configPath(), "utf8"), bytes, "the refused save changed the file");
  assert.deepEqual(invoke("studio:mcpServers"), before, "the refused save changed what is reported");
  assert.equal(readdirSync(dir).some((f) => f.endsWith(".tmp")), false, "a temp file was left behind");
});
