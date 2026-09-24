import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The store-unavailable paths, which is where review found the data loss.
 *
 * A separate file because availability is answered once and cached for the life
 * of the process — deliberately, since the OS latches it anyway and every ask
 * risks an unlock dialog. Two answers need two processes.
 *
 * The rule these pin down: when the OS will not encrypt, stored secrets are
 * untouchable in BOTH directions. Not merely "a new value cannot be written" —
 * an existing one must not be destroyed either. The first version of this
 * change got the first half right and the second half wrong, because clearing
 * the env box returned early before the availability check ever ran. On a
 * machine that provably cannot re-seal, that deleted a key with no way back.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-locked-"));

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    safeStorage: {
      // Measured behaviour of a locked keyring: available is false, and both
      // directions throw. Electron latches this for the process.
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

const { listServers, saveServers, serverStatus, testServer } = await import(
  "../src/main/localMcp.ts"
);

const configPath = () => join(dir, "local-mcp.json");
const raw = () => readFileSync(configPath(), "utf8");
/** A value as an earlier, working session would have written it. */
const sealed = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;

function givenStored(env) {
  writeFileSync(
    configPath(),
    JSON.stringify(
      { servers: [{ id: "s1", name: "db", command: "npx", args: [], enabled: true, env }] },
      null,
      2,
    ),
    "utf8",
  );
}

test("clearing the env box does not destroy a stored value we cannot rewrite", () => {
  givenStored({ API_KEY: sealed("precious") });
  const before = raw();

  // The user empties the environment box and saves.
  saveServers([{ id: "s1", name: "db", command: "npx", args: [], enabled: true, env: {} }]);

  assert.equal(raw(), before, "a sealed value was destroyed on a machine that cannot re-seal");
});

test("a newly typed value is not written in the clear, and does not disturb what is stored", () => {
  givenStored({ API_KEY: sealed("precious") });

  saveServers([
    {
      id: "s1",
      name: "db",
      command: "npx",
      args: [],
      enabled: true,
      // What the renderer holds: the untouched sealed value plus a freshly
      // typed one. Both arrive together, and neither may be written.
      env: { API_KEY: sealed("precious"), NEW_TOKEN: "typed-just-now" },
    },
  ]);

  const after = raw();
  assert.ok(!after.includes("typed-just-now"), "a secret was written in the clear");
  assert.ok(after.includes(sealed("precious")), "the stored value was disturbed");
  assert.ok(!after.includes("NEW_TOKEN"), "an unsealable key was persisted");
});

test("a toggle still saves, even though the secrets cannot move", () => {
  givenStored({ API_KEY: sealed("precious") });

  saveServers([{ id: "s1", name: "db", command: "npx", args: [], enabled: false, env: { API_KEY: sealed("precious") } }]);

  const after = JSON.parse(raw()).servers[0];
  assert.equal(after.enabled, false, "the non-secret half of the save was refused too");
  assert.equal(after.env.API_KEY, sealed("precious"));
});

test("the child process is never handed ciphertext — it refuses, and says unlock and restart", async () => {
  // The defect review reproduced. The previous code fell back to whatever the
  // renderer sent whenever the user had typed anything this session — and the
  // renderer holds SEALED strings for every value they did not retype. The MCP
  // server received `kyb:v1:...` as its DATABASE_URL, and the failure marker
  // was cleared on the way past, so it reported healthy.
  givenStored({ DATABASE_URL: sealed("postgres://real") });

  // User retypes one value only.
  saveServers([
    {
      id: "s1",
      name: "db",
      command: "npx",
      args: [],
      enabled: true,
      env: { DATABASE_URL: sealed("postgres://real"), API_KEY: "sk-live-NEW" },
    },
  ]);

  const result = await testServer("s1");
  assert.equal(result.ok, false, "started a server whose stored credentials could not be opened");
  assert.match(
    result.error ?? "",
    /unlock your keyring and restart/i,
    "the remedy offered was not the one that works — availability is latched per process",
  );
  assert.ok(
    !/kyb:v1:/.test(result.error ?? ""),
    "ciphertext leaked into a user-facing message",
  );
  assert.equal(serverStatus("s1").credentials?.reason, "store-unavailable");
  assert.notEqual(
    serverStatus("s1").credentials?.reason,
    "needs-re-entry",
    "a locked keyring was blamed on the credential",
  );
});

test("listServers still reports the servers — a locked keyring is not an empty configuration", () => {
  givenStored({ API_KEY: sealed("precious") });
  assert.equal(listServers().length, 1);
});
