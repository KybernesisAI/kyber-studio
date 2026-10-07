import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The MCP server spawn, wired — the other half of `local-exec-spawn-wiring`.
 *
 * `platform-shell.test.mjs` proves `shellInvocation` returns the right argv and
 * `local-exec-spawn-wiring.test.mjs` proves the RELAY passes it to `spawn`.
 * Neither says anything about `localMcp.ts`, which is the second of the two
 * call sites this lane exists to fix. Review demonstrated the gap by mutation:
 * dropping `windowsVerbatimArguments`, spawning `invocation.args[0]` instead of
 * `invocation.file`, and both plausible changes to `stopAll`'s signal were each
 * invisible to the whole suite.
 *
 * `callServer` is the only exported route into the private `ensure()`, so these
 * tests go through it and the mocked child answers the handshake.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-mcp-wiring-"));

// One server per test. `ensure` caches by id, so sharing one would mean a test
// asserting on a child spawned by an earlier test.
writeFileSync(
  join(dir, "local-mcp.json"),
  JSON.stringify({
    servers: ["posix", "windows", "stop-posix", "stop-windows"].map((id) => ({
      id,
      name: `Probe ${id}`,
      command: "npx",
      args: ["-y", "probe-mcp"],
      enabled: true,
    })),
  }),
);

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    shell: { openExternal: async () => {} },
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

const spawned = [];

mock.module("node:child_process", {
  exports: {
    spawn: (file, args, options) => {
      const child = new EventEmitter();
      child.file = file;
      child.args = args;
      child.options = options;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4242;
      child.killed = false;
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal);
        child.killed = true;
        return true;
      };
      child.unref = () => {};
      // Answer anything with an id, so the handshake completes. A notification
      // carries none and must not be answered, which is also what a real
      // server does.
      child.stdin = {
        write: (payload) => {
          for (const line of payload.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const message = JSON.parse(trimmed);
            if (typeof message.id !== "number") continue;
            const result = message.method === "tools/list" ? { tools: [{ name: "ping" }] } : {};
            const reply = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
            setImmediate(() => child.stdout.emit("data", Buffer.from(`${reply}\n`, "utf8")));
          }
          return true;
        },
      };
      spawned.push(child);
      return child;
    },
  },
});

const { callServer, stopAll } = await import("../src/main/localMcp.ts");

async function onPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}

/** Start one server by answering a real call, and return the child it spawned. */
async function start(platform, serverId) {
  spawned.length = 0;
  const result = await onPlatform(platform, () => callServer({ serverId, method: "tools/list" }));
  assert.deepEqual(result, { tools: [{ name: "ping" }] }, "the handshake should have completed");
  assert.equal(spawned.length, 1, "starting one server should spawn once");
  return spawned[0];
}

test("an MCP server on POSIX starts through a login shell, with the line last", async () => {
  const child = await start("linux", "posix");

  // Spawning `invocation.args[0]` instead of `invocation.file` would try to
  // exec "-lc" here, and no server would start on macOS or Linux either.
  assert.equal(child.file, process.env.SHELL ?? "/bin/bash");
  assert.deepEqual(child.args, ["-lc", "npx -y probe-mcp"]);
});

test("an MCP server on Windows starts through cmd.exe, quoted, not /bin/bash", async () => {
  const child = await start("win32", "windows");

  assert.notEqual(child.file, "/bin/bash");
  assert.equal(child.file, process.env.ComSpec ?? "cmd.exe");
  // Quoted because `/s` strips the outer pair, and verbatim so node does not
  // add quoting of its own on top of ours.
  assert.deepEqual(child.args, ["/d", "/s", "/c", '"npx -y probe-mcp"']);
  assert.equal(child.options.windowsVerbatimArguments, true);
});

test("stopAll on POSIX sends SIGTERM and spawns no killer", async () => {
  const child = await start("linux", "stop-posix");

  onPlatform("linux", () => stopAll());

  // SIGTERM, not SIGKILL: this is a server's one chance to flush state or drop
  // a lockfile, and `index.ts` allows no grace window after it.
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(spawned.length, 1, "POSIX must not spawn a killer");
});

test("stopAll on Windows kills the tree, because the pid is cmd.exe", async () => {
  const child = await start("win32", "stop-windows");

  onPlatform("win32", () => stopAll());

  const killer = spawned.find((c) => c.file.includes("taskkill"));
  assert.ok(killer, "stopAll on Windows must reach taskkill");
  assert.deepEqual(killer.args, ["/pid", "4242", "/T", "/F"]);
  // Signalling the handle instead would stop cmd.exe and leave the server
  // running, which is what the docblock on stopAll promises not to allow.
  assert.deepEqual(child.signals, []);
});
