import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The machine that reports it can encrypt and cannot.
 *
 * `basic_text` is Chromium's last-resort backend: a key compiled into the binary,
 * identical on every install. `isEncryptionAvailable()` answers `true` on it, so
 * before KYB-603 a keyring-less Linux box passed the one check that guards every
 * secret Studio writes — and persisted both the session token and every MCP
 * provider key in a form anyone holding the file can read.
 *
 * This file is the counterpart to `credential-availability.test.mjs`, which is
 * the same two layers on a machine with a REAL backend. Two files rather than
 * two tests because the availability answer is latched process-wide and has no
 * reset hook by design, so one answer needs one process.
 *
 * ## Why `process.platform` is pinned here
 *
 * `controlPlane.ts` and `localMcp.ts` call `isCredentialStoreAvailable(safeStorage)`
 * without injecting an environment, so the platform comes from `process`. Left
 * alone, every assertion below would pass **vacuously** on the macOS CI arm: the
 * Linux-only guard would skip the backend check, the store would read as
 * available, and the writes this file forbids would be the writes that happen.
 * Green, and measuring nothing.
 *
 * That is not hypothetical. Three tests in `credential-storage.test.mjs` asserted
 * a Linux-only call count without declaring a platform and were discovered broken
 * only when a Mac first ran the suite, during the KYB-590 UAT.
 *
 * So the platform is pinned to `linux` before the modules load. The weak path is
 * then exercised on both CI arms, which is strictly more coverage than skipping.
 */
Object.defineProperty(process, "platform", { value: "linux", configurable: true });

const dir = mkdtempSync(join(tmpdir(), "kyb-weak-backend-"));
let availabilityAsks = 0;
let backendReads = 0;

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    safeStorage: {
      // The lie this ticket is about: "yes, I can encrypt."
      isEncryptionAvailable: () => {
        availabilityAsks += 1;
        return true;
      },
      getSelectedStorageBackend: () => {
        backendReads += 1;
        return "basic_text";
      },
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

const { loadSession, pollDeviceAuth } = await import("../src/main/controlPlane.ts");
const { listServers, saveServers } = await import("../src/main/localMcp.ts");

const sessionPath = () => join(dir, "session.bin");
const mcpPath = () => join(dir, "local-mcp.json");

/** A JWT only in shape: the payload is base64url JSON and nothing verifies it. */
function jwt(claims) {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header.${payload}.signature`;
}

function givenStoredSession() {
  const session = {
    token: jwt({ email: "someone@example.com", exp: Math.floor(Date.now() / 1000) + 3600 }),
    refreshToken: "refresh-1",
    expiresAt: Date.now() + 3_600_000,
    email: "someone@example.com",
  };
  writeFileSync(sessionPath(), Buffer.from(`ENC(${JSON.stringify(session)})`, "utf8"));
  return session;
}

/** Capture `console.warn` for one call, so a remedy can be asserted rather than hoped at. */
function sayings(run) {
  const said = [];
  const was = console.warn;
  console.warn = (...args) => said.push(args.join(" "));
  try {
    run();
  } finally {
    console.warn = was;
  }
  return said;
}

test("a stored session is refused because of the BACKEND, and the OS is never asked to encrypt", () => {
  // Ordered first, while the counters are genuinely zero, and driven through the
  // real caller rather than a local stub. That matters: the latch means whichever
  // call comes first decides for the process, so if this test used its own stub,
  // every test below would be exercising a cached `false` and would pass just as
  // well on a machine whose keyring works perfectly. The assertions on the two
  // counters are what prove the weak backend is the cause.
  givenStoredSession();
  assert.ok(existsSync(sessionPath()), "fixture is wrong: no session file");

  assert.equal(loadSession(), null, "read back a session it cannot protect");

  // The name was read — so the decision went through the weak-backend path.
  assert.equal(backendReads, 1, `read the backend name ${backendReads} time(s)`);
  // And availability was never asked, which is the question that raises an
  // unlock dialog. If this reads 1 the two checks have been reordered and the
  // fix now costs a prompt on exactly the machines it cannot help.
  assert.equal(availabilityAsks, 0, `asked the OS ${availabilityAsks} time(s)`);

  // The file is left alone, not deleted. Ignoring it is this ticket's scope;
  // removing it deliberately is not, since no released build can have written one.
  assert.ok(existsSync(sessionPath()), "the session file was deleted, which is out of scope");
});

test("signing in holds the session in memory, and nothing reaches the disk", async () => {
  // The real sign-in path: `pollDeviceAuth` is what calls `saveSession`, so this
  // is the route a person actually takes on a fresh machine. A refresh is not
  // usable here — it needs a session it can read first, and on this machine
  // there is none, which is itself the correct behaviour.
  const before = readFileSync(sessionPath(), "utf8");
  const fetchWas = globalThis.fetch;
  const said = [];
  const warnWas = console.warn;
  const logWas = console.log;

  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      token: jwt({ email: "someone@example.com", exp: Math.floor(Date.now() / 1000) + 7200 }),
      refresh_token: "refresh-2",
    }),
  });
  console.warn = (...args) => said.push(args.join(" "));
  console.log = () => {};

  let signedIn;
  try {
    // `interval` is in seconds and is slept BEFORE the first poll, so keep it tiny.
    signedIn = await pollDeviceAuth({ deviceCode: "dc-1", interval: 0.001, expiresIn: 60 });
  } finally {
    globalThis.fetch = fetchWas;
    console.warn = warnWas;
    console.log = logWas;
  }

  // Signed in for this run: the session exists in memory.
  assert.equal(signedIn?.refreshToken, "refresh-2", "the sign-in produced no session");
  assert.equal(signedIn?.email, "someone@example.com");

  // And the file is byte-for-byte what it was. A weaker check — "no plaintext
  // token on disk" — would also pass if the file had been rewritten with the
  // same useless sealing, which is the behaviour this ticket removes.
  assert.equal(readFileSync(sessionPath(), "utf8"), before, "the session was written anyway");
  assert.ok(
    said.some((line) => /OS encryption unavailable/.test(line)),
    `no remedy was said; got ${JSON.stringify(said)}`,
  );
  assert.ok(
    said.some((line) => /memory only/.test(line)),
    `the remedy did not say the session is memory-only; got ${JSON.stringify(said)}`,
  );
});

test("an MCP env value is kept in memory only, with nothing written for it", () => {
  const said = sayings(() =>
    saveServers([
      {
        id: "s1",
        name: "db",
        command: "npx",
        args: [],
        enabled: true,
        env: { API_KEY: "sk-live-weak-1" },
      },
    ]),
  );

  const onDisk = readFileSync(mcpPath(), "utf8");

  // Neither in the clear...
  assert.ok(!onDisk.includes("sk-live-weak-1"), "the key is on disk in the clear");
  // ...nor sealed with a key every machine on earth shares.
  assert.ok(!onDisk.includes("kyb:v1:"), "the key was sealed with the weak backend");
  // The server itself is still recorded and usable this run.
  assert.equal(listServers().length, 1);
  assert.ok(
    said.some((line) => /kept in memory only/.test(line)),
    `no remedy was said; got ${JSON.stringify(said)}`,
  );
});

test("the whole run asked the OS about encryption exactly zero times", () => {
  // The cumulative claim, and the reason this file is one process. Four
  // operations that would each have prompted on a locked keyring, and not one
  // of them reached the question.
  assert.equal(availabilityAsks, 0, `asked ${availabilityAsks} time(s)`);
  // Exactly once, not once per caller: the new question sits inside the same
  // latch as the old one. Four operations, one read.
  assert.equal(backendReads, 1, `read the backend name ${backendReads} time(s)`);
});
