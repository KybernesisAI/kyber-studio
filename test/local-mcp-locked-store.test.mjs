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
/** See the same counter in local-mcp-call-sites.test.mjs for why it exists. */
let availabilityAsks = 0;

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    safeStorage: {
      // Measured behaviour of a locked keyring: available is false, and both
      // directions throw. Electron latches this for the process.
      isEncryptionAvailable: () => {
        availabilityAsks += 1;
        return false;
      },
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

const { credentialFailureIds, listServers, saveServers, serverStatus, testServer } = await import(
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

test("store-unavailable is app-level: nothing is recorded against a server id", () => {
  // The criterion, and the mutation that has to kill this: re-adding
  //
  //   credentialFailure.set(server.id, { reason: opened.reason, ... })
  //
  // for BOTH reasons — which is what the code did — turns this red.
  //
  // Why it matters, rather than being a tidiness preference. Availability is
  // latched for the life of the process, so it is ONE fact; a map keyed by
  // server id holds N copies of it and they drift. A server added after the
  // failure, or one the user never pressed Test on, has no entry at all — and
  // since only `ensure()` ever wrote to that map, a user who never started
  // anything was never told the store was shut. The assertions below are the
  // two halves of that: nothing stored, and the answer available anyway.
  assert.deepEqual(
    credentialFailureIds(),
    [],
    "a locked keyring was recorded per server, where it is a fact about the process",
  );
});

test("a server that was never started still reports the store is shut", () => {
  // Derived, not remembered. `never-touched` has never been passed to ensure(),
  // has no entry anywhere, and is not even in the config — and the honest
  // answer about its credentials is still that nothing here can be decrypted.
  assert.deepEqual(serverStatus("never-touched").credentials, {
    reason: "store-unavailable",
    keys: [],
  });
  assert.deepEqual(credentialFailureIds(), [], "asking about status recorded a failure");
});

test("a typed value that merely starts with kyb:v1: is kept, not silently dropped", () => {
  // `isSealed` is a claim about the shape of a string; `looksSealed` is the
  // prefix AND a base64 round-trip. saveServers filtered with the former, so a
  // key the user typed as `kyb:v1:my key` was classified as ciphertext:
  // dropped from the write, and — the filtered set being empty — dropped from
  // the warning as well. The user's input disappeared without a word.
  //
  // Mutation: putting `isSealed` back at that filter turns this red.
  givenStored({ API_KEY: sealed("precious") });

  const said = [];
  const warn = console.warn;
  console.warn = (...args) => said.push(args.join(" "));
  try {
    saveServers([
      {
        id: "s1",
        name: "db",
        command: "npx",
        args: [],
        enabled: true,
        // Not valid base64 after the prefix — a space is not a base64 digit —
        // so this is a plaintext value that happens to look official.
        env: { API_KEY: sealed("precious"), TYPED: "kyb:v1:my key" },
      },
    ]);
  } finally {
    console.warn = warn;
  }

  assert.equal(said.length, 1, `the user was not warned their value could not be stored: ${said}`);
  assert.match(said[0], /kept in memory only/i);
  assert.match(said[0], /unlock/i, "the warning did not name the remedy");

  const after = raw();
  assert.ok(!after.includes("my key"), "an unsealable value was written in the clear");
  assert.ok(after.includes(sealed("precious")), "the stored value was disturbed");
});

test("the OS is asked about encryption at most once for the whole process", () => {
  assert.ok(
    availabilityAsks <= 1,
    `asked the OS ${availabilityAsks} times; the answer is latched and each ask can prompt`,
  );
});
