import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
/**
 * How many times the module asked the OS about encryption.
 *
 * Counted because neither electron mock counted anything, and a reviewer
 * showed what that hid: replacing the whole availability cache in
 * `localMcp.ts` with a bare `return safeStorage.isEncryptionAvailable()` left
 * the suite green. The cache is not an optimisation — every ask is what can
 * raise an unlock dialog, and the answer is latched by the OS anyway, so a
 * second ask can only ever repeat the first at the price of a prompt.
 */
let availabilityAsks = 0;

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    safeStorage: {
      isEncryptionAvailable: () => {
        availabilityAsks += 1;
        return true;
      },
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

const {
  ConfigUnreadableError,
  credentialFailureIds,
  listServers,
  saveServers,
  serverStatus,
  testServer,
} = await import("../src/main/localMcp.ts");

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

test("an unreadable file throws a distinguishable error, not an empty list", () => {
  // Mutation: restoring `catch { return [] }` turns this red. That catch is
  // what let a damaged file become an empty one — the renderer holds the [] and
  // the next toggle writes it back over the user's servers.
  saveServers([server()]);
  writeFileSync(configPath(), '{"servers":[{"id":"s1",', "utf8");

  assert.throws(
    () => listServers(),
    (error) => {
      // IN-PROCESS, and the comment now says so. The previous version of this
      // block asserted the same three things and justified them with "because
      // `instanceof` does not survive the structured clone that carries an
      // error across IPC" — a sentence about a boundary this file has never
      // crossed and cannot cross. Worse, it was false in the other direction
      // too: `code` does not survive either, so the renderer could not tell
      // this failure from a disk fault however hard this assertion tried.
      // What crosses is asserted in test/mcp-ipc-handlers.test.mjs, against
      // the handler that turns this error into a value.
      //
      // These assertions still earn their place: they are what the MAIN
      // process needs in order to build that value at all.
      assert.ok(error instanceof ConfigUnreadableError, `wrong type: ${error?.name}`);
      assert.equal(error.code, "MCP_CONFIG_UNREADABLE");
      assert.equal(error.path, configPath());

      // The path is a property and MUST NOT be in the message. `listServers`
      // is on the relay path, and localExec.ts posts `e.message` to a remote
      // agent — see test/local-exec-relay.test.mjs for the leak itself.
      assert.ok(
        !error.message.includes(configPath()) && !error.message.includes(dir),
        `the config path is in the message: ${error.message}`,
      );
      return true;
    },
  );

  // Leave the fixture readable for whatever runs next — a corrupt file also
  // blocks every write by default, which is the point of the assertion above
  // and would otherwise leak into the next test.
  writeFileSync(configPath(), '{"servers":[]}', "utf8");
});

test("a file that parses but carries no servers array is unreadable, not empty", () => {
  // The same dishonest empty, one level up. `return parsed.servers ?? []`
  // answered every one of these with `[]`, and the next save made it true.
  for (const damaged of [
    "{}",
    '{"servers":null}',
    "[]",
    '{"servers":{}}',
    '{"servers":"none"}',
    '{"servers":[{"name":"no id here"}]}',
  ]) {
    writeFileSync(configPath(), damaged, "utf8");
    assert.throws(
      () => listServers(),
      ConfigUnreadableError,
      `${damaged} was answered with a list instead of a refusal`,
    );
  }

  // And the honest empty case must survive the fix: absent is a first run.
  rmSync(configPath(), { force: true });
  assert.deepEqual(listServers(), [], "fixing the dishonest empty broke the honest one");
});

test("by default a damaged config blocks the write rather than replacing it", () => {
  saveServers([server()]);
  const damaged = '{"servers":[{"id":"s1",';
  writeFileSync(configPath(), damaged, "utf8");

  assert.throws(() => saveServers([server()]), ConfigUnreadableError);
  assert.equal(readFileSync(configPath(), "utf8"), damaged, "the damaged file was overwritten");

  // A damaged file blocks every later write, which is exactly the behaviour
  // asserted above and exactly why it must not leak into the next test.
  rmSync(configPath(), { force: true });
});

test("the opt-in recovery moves the damaged file aside, bytes intact, and then writes", () => {
  // The defect this closes: `saveServers` reads the old config first to
  // recover sealed values, so a damaged file blocked add, remove AND toggle.
  // The user could not even delete the broken server from inside the app.
  // Refusing stays the default; this is the explicit way out.
  saveServers([server()]);
  const damaged = '{"servers":[{"id":"s1","env":{"API_KEY":"kyb:v1:tRunCaT';
  writeFileSync(configPath(), damaged, "utf8");

  const before = readdirSync(dir).filter((f) => f.includes(".corrupt-")).length;
  saveServers([server({ id: "fresh", name: "fresh" })], { onUnreadableConfig: "quarantine" });

  const aside = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
  assert.equal(aside.length, before + 1, "the damaged file was not moved aside");
  assert.equal(
    readFileSync(join(dir, aside.at(-1)), "utf8"),
    damaged,
    "the damaged bytes were altered or discarded — they are the user's only copy",
  );

  assert.ok(existsSync(configPath()), "no new config was written");
  assert.deepEqual(
    listServers().map((s) => s.id),
    ["fresh"],
    "the write did not go through after the recovery",
  );
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

test("command, args and cwd stay legible on disk — only env is sealed", () => {
  // Mutation: sealing `command` alongside `env` left the suite green. The file
  // is meant to stay hand-editable; sealing the command line would also make
  // every save opaque to the person who wrote it, for no secret gained.
  saveServers([
    server({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres"],
      cwd: "/home/someone/work",
      env: { API_KEY: "sk-live-2" },
    }),
  ]);

  const stored = read().servers[0];
  assert.equal(stored.command, "npx", "command was sealed");
  assert.deepEqual(stored.args, ["-y", "@modelcontextprotocol/server-postgres"], "args were sealed");
  assert.equal(stored.cwd, "/home/someone/work", "cwd was sealed");
  assert.equal(stored.name, "db");
  assert.equal(stored.enabled, true);
  assert.ok(stored.env.API_KEY.startsWith("kyb:v1:"), "env stopped being sealed");

  // Said the other way round, so a future scheme that seals more cannot slip
  // past by keeping the shape: exactly one field is ciphertext.
  const sealedFields = Object.entries(stored)
    .filter(([, v]) => typeof v === "string" && v.startsWith("kyb:v1:"))
    .map(([k]) => k);
  assert.deepEqual(sealedFields, [], "a top-level field was sealed");
});

test("needs-re-entry IS recorded per server — it is genuinely per server", () => {
  // The counterpart to the locked-store file's assertion that nothing is
  // recorded there. This failure names the values on one server that would not
  // open, which is not a fact about the app, so it belongs in the map.
  saveServers([server({ id: "re", name: "re", env: { API_KEY: "will-not-open" } })]);
  undecryptable.add("will-not-open");
  return testServer("re").then((result) => {
    assert.equal(result.ok, false);
    assert.ok(
      credentialFailureIds().includes("re"),
      "a per-server decrypt failure was not recorded against the server",
    );
    assert.deepEqual(serverStatus("re").credentials, {
      reason: "needs-re-entry",
      keys: ["API_KEY"],
    });
    undecryptable.delete("will-not-open");
  });
});

test("the OS is asked about encryption at most once for the whole process", () => {
  // Deliberately last: it measures everything the file did above. Mutation —
  // replacing the `availabilityAnswer` cache in localMcp.ts with a bare
  // `return safeStorage.isEncryptionAvailable()` — turns this red, where
  // before it was invisible to every test in the repo.
  assert.ok(
    availabilityAsks <= 1,
    `asked the OS ${availabilityAsks} times; each ask is a chance to raise an unlock dialog`,
  );
});
