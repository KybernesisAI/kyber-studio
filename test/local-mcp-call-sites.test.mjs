import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The call sites, executed — not reasoned about.
 *
 * Four tickets in this repo have excused `localMcp.ts` and `localExec.ts` from
 * coverage on the grounds that importing `electron` makes them unloadable under
 * `node --test`. That is wrong, and this file is the counter-example. Electron
 * mocks fine with `mock.module`. What actually blocked it was mundane: the repo
 * writes extensionless relative imports (`./atomicWrite`), which tsc and
 * esbuild resolve and native ESM does not. `test/ts-ext-resolve.mjs` closes
 * that in fifteen lines with no dependency.
 *
 * It matters because the seam between the sealing module and its callers is
 * exactly where review found every real defect in this change — the pure module
 * was fine, and the bugs were all in the wiring that nothing could reach.
 *
 * This file covers the store-AVAILABLE paths. The unavailable ones need a
 * separate process, because availability is deliberately cached for the life of
 * the process; see local-mcp-locked-store.test.mjs.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-mcp-"));
const undecryptable = new Set();

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "gnome_libsecret",
      encryptString: (s) => Buffer.from(`ENC(${s})`, "utf8"),
      decryptString: (b) => {
        const text = b.toString("utf8");
        const match = /^ENC\((.*)\)$/s.exec(text);
        if (!match) throw new Error("not sealed by this store");
        if (undecryptable.has(match[1])) throw new Error("decrypt failed");
        return match[1];
      },
    },
  },
});

const { listServers, saveServers, serverStatus, testServer } = await import(
  "../src/main/localMcp.ts"
);

const configPath = () => join(dir, "local-mcp.json");
const read = () => JSON.parse(readFileSync(configPath(), "utf8"));
const server = (over = {}) => ({
  id: "s1",
  name: "db",
  command: "npx",
  args: [],
  enabled: true,
  env: { API_KEY: "sk-live-1" },
  ...over,
});

test("the renderer round trip: listServers -> whole-list save -> listServers leaves env intact", () => {
  // The criterion this proves, quoted: "A test drives listServers -> the array
  // the renderer would hold -> saveServers -> listServers and asserts the
  // decrypted env is unchanged." Previously claimed unprovable.
  //
  // Mutation: making listServers mask env turns this red, because the mask
  // would be written back as the new secret — KYB-291's failure, which is the
  // whole reason values travel sealed rather than hidden.
  saveServers([server()]);
  const sealedOnDisk = read().servers[0].env.API_KEY;
  assert.ok(sealedOnDisk.startsWith("kyb:v1:"), "value was not sealed at rest");
  assert.ok(!readFileSync(configPath(), "utf8").includes("sk-live-1"), "plaintext on disk");

  // Exactly what Plugins.tsx does on a toggle: take the list it was given and
  // write all of it back.
  const asRenderer = listServers();
  saveServers(asRenderer.map((s) => ({ ...s, enabled: false })));

  assert.equal(read().servers[0].env.API_KEY, sealedOnDisk, "the sealed value changed");
  assert.equal(read().servers[0].enabled, false, "the toggle was not saved");
});

test("repeated saves do not grow the file", () => {
  saveServers([server()]);
  const first = readFileSync(configPath(), "utf8").length;
  for (let i = 0; i < 4; i += 1) saveServers(listServers());
  assert.equal(readFileSync(configPath(), "utf8").length, first, "ciphertext of ciphertext");
});

test("toggling server A does not disturb server B's stored env", () => {
  saveServers([server(), server({ id: "s2", name: "other", env: { OTHER: "keep-me" } })]);
  const bBefore = read().servers[1].env.OTHER;

  const asRenderer = listServers();
  saveServers(asRenderer.map((s) => (s.id === "s1" ? { ...s, enabled: false } : s)));

  assert.equal(read().servers[1].env.OTHER, bBefore, "B's stored secret moved when A was toggled");
});

test("an absent file is still an honest empty list", () => {
  // Fixing the dishonest empty case must not break the honest one.
  rmSync(configPath(), { force: true });
  assert.deepEqual(listServers(), []);
});

test("an unreadable file throws rather than answering with an empty list", () => {
  // Mutation: restoring `catch { return [] }` turns this red. That catch is
  // what let a damaged file become an empty one — the renderer holds the [] and
  // the next toggle writes it back over the user's servers.
  saveServers([server()]);
  writeFileSync(configPath(), '{"servers":[{"id":"s1",', "utf8");
  assert.throws(() => listServers(), /JSON|Unexpected|Unterminated/i);

  // Leave the fixture readable for whatever runs next — a corrupt file also
  // blocks every write, which is the point of the assertion above and would
  // otherwise leak into the next test.
  writeFileSync(configPath(), '{"servers":[]}', "utf8");
});

test("a value that will not decrypt is reported, and the file is not blanked", async () => {
  saveServers([server({ env: { API_KEY: "doomed" } })]);
  const before = readFileSync(configPath(), "utf8");
  undecryptable.add("doomed");

  // listServers still reports the server: the config is readable, it is the
  // credential that is not.
  assert.equal(listServers().length, 1, "a decrypt failure emptied the server list");

  const result = await testServer("s1");
  assert.equal(result.ok, false);
  assert.match(
    result.error ?? "",
    /could not be decrypted|add it again/i,
    "the failure did not name a remedy the user can act on",
  );
  assert.equal(serverStatus("s1").credentials?.reason, "needs-re-entry");

  // And a save after the failure does not destroy what is there.
  saveServers(listServers());
  assert.equal(readFileSync(configPath(), "utf8"), before, "the file changed after a failed open");
  undecryptable.delete("doomed");
});
