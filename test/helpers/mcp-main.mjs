import { after, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The main process with a credential store that is unavailable, for the
 * KYB-696 tests. The electron mock is `local-mcp-store-unavailable-forms`'s,
 * with the backend and the availability answer as parameters.
 *
 * Call `mainProcess` once per file, before anything imports a main-process
 * module: availability is memoised for the process, so one file is one answer.
 *
 * Pinning the platform is the caller's job and comes first, because the
 * messages are worded per platform and `process.platform` is read by the code
 * under test. Without it these tests assert Linux wording and fail on CI's
 * macOS and Windows runners.
 */
export async function mainProcess({ backend, encryptionAvailable }) {
  const dir = mkdtempSync(join(tmpdir(), "kyb-696-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map();
  /** Raw calls to the OS, by question. */
  const asks = { isEncryptionAvailable: 0, getSelectedStorageBackend: 0 };

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
          asks.isEncryptionAvailable += 1;
          return encryptionAvailable;
        },
        getSelectedStorageBackend: () => {
          asks.getSelectedStorageBackend += 1;
          return backend;
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

  // No server may start: a store-unavailable server refuses before it spawns,
  // and one that spawned anyway would be the defect, so it is loud.
  mock.module("node:child_process", {
    exports: {
      spawn: (file) => {
        const child = new EventEmitter();
        child.unref = () => {};
        if (/taskkill/i.test(file)) return child;
        throw new Error(`a process was spawned: ${file}`);
      },
      spawnSync: () => ({ status: 0, stdout: "", stderr: "" }),
      execFile: () => {},
      exec: () => {},
    },
  });

  const { registerIpc } = await import("../../src/main/ipc.ts");
  const localMcp = await import("../../src/main/localMcp.ts");
  registerIpc();

  const invoke = (channel, ...args) => {
    const handler = handlers.get(channel);
    assert.ok(handler, `nothing was registered for ${channel}`);
    return handler({ sender: null }, ...args);
  };

  const configPath = join(dir, "local-mcp.json");
  const givenStored = (servers) => writeFileSync(configPath, JSON.stringify({ servers }, null, 2), "utf8");

  /** What `fn` wrote with `console.warn`, one string per call. */
  const warnings = async (fn) => {
    const said = [];
    const warn = console.warn;
    console.warn = (...args) => said.push(args.join(" "));
    try {
      await fn();
    } finally {
      console.warn = warn;
    }
    return said;
  };

  /**
   * The three main-process messages about an unavailable store: the Connect
   * error for a server with a sealed value, and the `[mcp]` log lines for a
   * value held in memory and for a server with a sealed value. Each is
   * produced through the path a person reaches it by.
   */
  const mainMessages = async () => {
    const sealed = `kyb:v1:${Buffer.from("ENC(first)", "utf8").toString("base64")}`;
    const server = (over) => ({ command: "npx", args: ["-y", "a-mcp"], enabled: true, ...over });

    givenStored([server({ id: "sealed", name: "MCP kybsealed", env: { KYB_KEY: sealed } })]);
    const connect = await invoke("studio:connectMcpServer", "sealed");
    assert.equal(connect.ok, false, "precondition: Connect succeeded with the store unavailable");

    givenStored([server({ id: "plain", name: "MCP kybplain", env: { OLD: "disk" } })]);
    const heldSaid = await warnings(() =>
      invoke("studio:saveMcpServers", [server({ id: "plain", name: "MCP kybplain", env: { OLD: "disk", KYB_KEY: "typed" } })]),
    );
    assert.equal(heldSaid.length, 1, `the held save logged ${heldSaid.length} lines: ${heldSaid.join(" | ")}`);

    givenStored([server({ id: "sealed", name: "MCP kybsealed", env: { KYB_KEY: sealed } })]);
    const sealedSaid = await warnings(() =>
      invoke("studio:saveMcpServers", [server({ id: "sealed", name: "MCP kybsealed", env: { KYB_KEY: "typed" } })]),
    );
    assert.equal(sealedSaid.length, 1, `the sealed save logged ${sealedSaid.length} lines: ${sealedSaid.join(" | ")}`);

    // Nothing held is left behind for the next test.
    invoke("studio:saveMcpServers", []);
    rmSync(configPath, { force: true });

    return { connect: connect.message, held: heldSaid[0], sealedLog: sealedSaid[0] };
  };

  return { asks, invoke, givenStored, warnings, mainMessages, localMcp, configPath };
}

/**
 * Pin `process.platform` for the life of the file. The repo's precedent is
 * `dictation-binding-failure.test.mjs`.
 */
export function pinPlatform(platform) {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  after(() => Object.defineProperty(process, "platform", real));
}
