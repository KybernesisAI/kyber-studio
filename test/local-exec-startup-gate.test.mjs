import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KYB-604: local execution must not reach the OS credential store until a
 * window is on screen.
 *
 * Asking the credential store is what makes the OS unlock its keyring, and on
 * Linux a locked keyring answers that with a system password dialog. Raised
 * from `app.whenReady()` — which is where `startLocalExec` is called — it is a
 * prompt for the user's login password with nothing behind it.
 *
 * The defect is invisible to a reader, because nothing in `startLocalExec`
 * looks synchronous: it ends in `void heartbeat()`. But an `await` evaluates
 * its operand synchronously, so `await activeSession()` enters `loadSession`
 * before `startLocalExec` returns.
 *
 * ORDER MATTERS. The first test asserts a count of credential-store asks, and
 * `isCredentialStoreAvailable` memoises for the life of the process — so once
 * any test has let the loops run, that counter can never move again. The later
 * tests therefore observe the loops through the relay instead.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-604-"));

let availabilityAsks = 0;

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    // `localExec.ts` reaches `controlPlane.ts`, which wants `shell` too.
    shell: { openExternal: async () => {} },
    safeStorage: {
      isEncryptionAvailable: () => {
        availabilityAsks += 1;
        return true;
      },
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

/**
 * A session valid for an hour, so `activeSession` returns it rather than
 * attempting a refresh. Without this the loops reach the relay zero times and
 * the later tests would pass against a build that never starts them.
 */
const planted = {
  token: "access-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 3_600_000,
  email: "someone@example.com",
  orgName: "Example",
};
writeFileSync(join(dir, "session.bin"), Buffer.from(`ENC(${JSON.stringify(planted)})`, "utf8"));

/**
 * Cap the loops' own sleeps.
 *
 * `heartbeat` parks on a 10-second timer and `poll` on a 3-second one at the
 * end of every iteration. Those are not unref'd, so once a test has started
 * the loops they hold this process open for ten seconds after the last
 * assertion — ten seconds added to every suite run, local and CI, for nothing.
 *
 * The cap cannot mask the thing under test: it only shortens waits of a second
 * or more, and every gate interval these tests use is deliberately below that,
 * so a gate that released early would still be caught.
 */
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) =>
  realSetTimeout(fn, typeof ms === "number" && ms >= 1_000 ? 20 : ms, ...rest);

let relayRequests = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  relayRequests.push(target);
  // 503 on the long poll so it backs off instead of spinning as fast as this
  // stub can resolve.
  if (target.includes("/api/local-exec/requests")) return { ok: false, status: 503 };
  return { ok: true, status: 200, json: async () => ({}) };
};

const { notifyWindowOnScreen, startLocalExec, stopLocalExec } = await import(
  "../src/main/localExec.ts"
);

const settle = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

test("the credential store is not asked before a window is on screen", async () => {
  availabilityAsks = 0;
  relayRequests = [];

  // 900ms: long enough that nothing below can be the timeout floor releasing
  // the gate, short enough to stay under the sleep cap above.
  startLocalExec(900);
  await settle(60);

  assert.equal(
    availabilityAsks,
    0,
    "startLocalExec reached the credential store before any window existed",
  );
  assert.deepEqual(relayRequests, [], "neither loop may run before a window is on screen");

  notifyWindowOnScreen();
  await settle(60);

  assert.ok(
    availabilityAsks >= 1,
    "the loops never ran after the window appeared — the gate does not release",
  );
  assert.ok(
    relayRequests.some((u) => u.includes("/api/local-exec/hello")),
    "the heartbeat did not announce this machine after the window appeared",
  );

  stopLocalExec();
  await settle(20);
});

test("the loops still start if a window never arrives", async () => {
  relayRequests = [];

  startLocalExec(120);
  await settle(30);
  assert.deepEqual(
    relayRequests,
    [],
    "the loops ran before the floor elapsed — the gate is not holding at all",
  );

  await settle(250);
  assert.ok(
    relayRequests.some((u) => u.includes("/api/local-exec/hello")),
    "local execution never started: a window that never shows must delay the loops, not lose them",
  );

  stopLocalExec();
  await settle(20);
});

test("notifyWindowOnScreen is idempotent and safe with nothing waiting", () => {
  assert.doesNotThrow(() => {
    notifyWindowOnScreen();
    notifyWindowOnScreen();
  });
});
