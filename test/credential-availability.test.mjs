import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How many times the whole process asks the OS whether it can encrypt.
 *
 * The rule, ruled on for KYB-590: **at most once per process, and zero times
 * for a user who has not signed in.** Every ask is a chance to raise a keyring
 * unlock dialog, and the answer is latched by the OS anyway — measured, a run
 * that begins with the keyring locked stays broken after an unlock — so a
 * second ask can only repeat the first at the price of a second prompt.
 *
 * Before this change the count was three on a signed-in machine with an MCP
 * server: `controlPlane.ts` asked raw on the session read and again on the
 * session write, and `localMcp.ts` kept its own separate cache. Nothing in the
 * repo could see that, because the only counter lived in the MCP tests and the
 * session layer had no tests at all.
 *
 * This file therefore drives BOTH layers in ONE process, which is the only
 * place the property is visible. It is also why the counter is a module-level
 * variable rather than per-test state: the question is about the process.
 *
 * Order matters here and the tests are written to be read top to bottom. The
 * no-session case must run first, while the count is still genuinely zero.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-availability-"));
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
        return match[1];
      },
    },
    shell: { openExternal: async () => {} },
  },
});

const { forceRefresh, loadSession } = await import("../src/main/controlPlane.ts");
const { listServers, saveServers } = await import("../src/main/localMcp.ts");

const sessionPath = () => join(dir, "session.bin");

/** A JWT only in shape: the payload is base64url JSON and nothing verifies it. */
function jwt(claims) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

/** Write a session file as a previous, working run would have left it. */
function givenStoredSession(overrides = {}) {
  const session = {
    token: jwt({ email: "someone@example.com", exp: Math.floor(Date.now() / 1000) + 3600 }),
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
    email: "someone@example.com",
    ...overrides,
  };
  writeFileSync(sessionPath(), Buffer.from(`ENC(${JSON.stringify(session)})`, "utf8"));
  return session;
}

test("a user with no session file is never asked about the keyring", () => {
  // The short-circuit in `loadSession`:
  //
  //   if (!existsSync(p) || !isCredentialStoreAvailable(safeStorage)) return null;
  //
  // `existsSync` first, and `||` short-circuits, so the OS is not reached at
  // all. This is the fresh-install and signed-out case, and it is the whole
  // reason a cold start is silent: asking is what raises the unlock dialog.
  //
  // Mutation M12 — reordering those two operands — reads identically (still
  // null, still no crash) and turns this red. Nothing else in the suite
  // notices, which is exactly how the prompt-on-cold-start defect survived.
  assert.ok(!existsSync(sessionPath()), "fixture is wrong: a session file exists");

  assert.equal(loadSession(), null, "invented a session out of an absent file");
  assert.equal(
    availabilityAsks,
    0,
    `a signed-out user was asked about the keyring ${availabilityAsks} time(s)`,
  );
});

test("a session read, a session write and an MCP save ask the OS once between them", async () => {
  givenStoredSession();

  // 1. Session READ. The file exists now, so availability is genuinely needed.
  const loaded = loadSession();
  assert.equal(loaded?.email, "someone@example.com", "the stored session did not come back");
  assert.equal(availabilityAsks, 1, "the read did not reach the OS at all — fixture is inert");

  // 2. Session WRITE, through the refresh path, which is the one that persists
  //    a session without a browser. Asserted by its effect on disk rather than
  //    trusted: a write that silently did nothing would prove nothing.
  const before = readFileSync(sessionPath(), "utf8");
  const fetchWas = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      token: jwt({ email: "someone@example.com", exp: Math.floor(Date.now() / 1000) + 7200 }),
      refresh_token: "refresh-2",
    }),
  });
  try {
    const refreshed = await forceRefresh();
    assert.equal(refreshed?.refreshToken, "refresh-2", "the refresh did not produce a session");
  } finally {
    globalThis.fetch = fetchWas;
  }
  assert.notEqual(readFileSync(sessionPath(), "utf8"), before, "the session was not re-written");

  // 3. An MCP operation, which seals values with the same store. Again checked
  //    by its effect: a save that did not seal never consulted availability.
  saveServers([
    { id: "s1", name: "db", command: "npx", args: [], enabled: true, env: { API_KEY: "sk-live-1" } },
  ]);
  const onDisk = readFileSync(join(dir, "local-mcp.json"), "utf8");
  assert.ok(onDisk.includes("kyb:v1:"), "the MCP save did not seal, so it never used the store");
  assert.ok(!onDisk.includes("sk-live-1"), "plaintext on disk");
  assert.equal(listServers().length, 1);

  // The point of the file. Three subsystems, one question.
  //
  // Mutation M11 — dropping the memoisation in `credentialStorage.ts` for a
  // bare `return safeStorage.isEncryptionAvailable()` — turns this red at four.
  assert.equal(
    availabilityAsks,
    1,
    `asked the OS ${availabilityAsks} times; the answer is latched and each ask can prompt`,
  );
});
