import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KYB-680, in the main process: abandoning a sign-in code with Start again.
 *
 * Driven through the real `registerIpc` handlers, invoked as `ipcMain` would
 * invoke them, with the control plane faked at `fetch`. Every token request is
 * HELD until the test answers it, because both faults live in the gap between
 * a cancel and a token request that was already on the wire:
 *
 *   - the abandoned code's request answered with a token signed the app in;
 *   - the abandoned wait unwinding late cleared the NEW pending sign-in, so
 *     the new wait failed with "No sign-in in progress.".
 *
 * The fake `fetch` ignores the abort signal unless a test sets `honourSignal`.
 * A real `fetch` rejects when its signal fires, but a response that has
 * already arrived does not, so the check that matters most is the one made
 * after the answer, before anything is kept. Ignoring the signal tests that
 * check alone; the last test honours it, as a real `fetch` would.
 *
 * What this does not prove: anything about Electron's real IPC ordering, or
 * that the real control plane issues a token to a request already in flight.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-start-again-"));
const handlers = new Map();
const opened = [];

mock.module("electron", {
  exports: {
    app: { getPath: () => dir, on: () => {}, whenReady: async () => {} },
    shell: { openExternal: async (url) => void opened.push(url) },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} },
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
    // A keyring that works, so a session that is kept is WRITTEN, and "nothing
    // was saved" can be read off the disk as well as off memory.
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
mock.module("@electron-toolkit/utils", {
  exports: { electronApp: {}, optimizer: {}, is: { dev: false } },
});

let devices = 0;
let honourSignal = false;
const held = [];
const reply = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.endsWith("/api/oauth/device")) {
    devices += 1;
    return reply(200, {
      device_code: `D${devices}`,
      user_code: `CODE-${devices}`,
      verification_uri: "https://cp.example/verify",
      verification_uri_complete: `https://cp.example/verify?code=CODE-${devices}`,
      interval: 0.01,
      expires_in: 600,
    });
  }
  if (u.endsWith("/api/oauth/token")) {
    const { device_code } = JSON.parse(init.body);
    return new Promise((resolve, reject) => {
      held.push({ device_code, resolve });
      // As a real fetch does: the request fails when its signal fires.
      if (honourSignal) init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  }
  throw new Error(`unexpected fetch ${u}`);
};

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const claims = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const token = (email) => `h.${claims({ email, exp: Math.floor(Date.now() / 1000) + 3600 })}.s`;
const settle = (p) => p.then((v) => ({ resolved: v?.email ?? v }), (e) => ({ rejected: e.message }));

const { registerIpc } = await import("../src/main/ipc.ts");
registerIpc();
const invoke = (channel, ...args) => handlers.get(channel)({ sender: null }, ...args);
const sessionFile = join(dir, "session.bin");

beforeEach(async () => {
  for (const h of held.splice(0)) h.resolve(reply(400, { error: "expired_token" }));
  await tick();
  await invoke("studio:signOut");
  rmSync(sessionFile, { force: true });
  honourSignal = false;
  mock.method(console, "log", () => {});
});

test("an approval of the abandoned code that lands in flight is discarded, not saved", async () => {
  await invoke("studio:signIn");
  const old = settle(invoke("studio:awaitSignIn"));
  await tick();
  assert.equal(held.length, 1, "fixture is wrong: no token request in flight");

  await invoke("studio:cancelSignIn");
  // The person approved the old code in the wrong browser profile just before
  // giving up on it, and the request already on the wire comes back with it.
  held.shift().resolve(reply(200, { token: token("wrong@account.example"), refresh_token: "r-old" }));

  assert.deepEqual(await old, { rejected: "sign-in cancelled" });
  assert.equal(await invoke("studio:session"), null, "the abandoned code signed the app in");
  assert.equal(existsSync(sessionFile), false, "the abandoned code's session was written to disk");
});

test("cancelling stops the poll: no further token request is made for the old code", async () => {
  await invoke("studio:signIn");
  const old = settle(invoke("studio:awaitSignIn"));
  await tick();
  assert.equal(held.length, 1);
  await invoke("studio:cancelSignIn");
  held.shift().resolve(reply(400, { error: "authorization_pending" }));
  assert.deepEqual(await old, { rejected: "sign-in cancelled" });
  await tick(100);
  assert.equal(held.length, 0, `the old code was polled again: ${JSON.stringify(held.map((h) => h.device_code))}`);
});

test("the old wait unwinding late does not take the new sign-in with it", async () => {
  await invoke("studio:signIn");
  const old = settle(invoke("studio:awaitSignIn"));
  await tick();
  assert.equal(held.length, 1);
  const oldRequest = held.shift();

  await invoke("studio:cancelSignIn");
  opened.splice(0);
  const second = await invoke("studio:signIn");
  const newDevice = `D${devices}`;
  assert.equal(second.userCode, `CODE-${devices}`);
  assert.deepEqual(opened, [`https://cp.example/verify?code=CODE-${devices}`], "the browser was not opened on the new code");

  // Only now does the abandoned request come back.
  oldRequest.resolve(reply(400, { error: "authorization_pending" }));
  assert.deepEqual(await old, { rejected: "sign-in cancelled" });

  const fresh = settle(invoke("studio:awaitSignIn"));
  await tick();
  assert.deepEqual(
    held.map((h) => h.device_code),
    [newDevice],
    "the new wait is not polling the new code",
  );
  held.shift().resolve(reply(200, { token: token("right@account.example"), refresh_token: "r-new" }));
  assert.deepEqual(await fresh, { resolved: "right@account.example" });
  assert.equal((await invoke("studio:session"))?.email, "right@account.example");
});

test("a request the cancel aborts ends as a cancellation, not as a network failure", async () => {
  honourSignal = true;
  await invoke("studio:signIn");
  const old = settle(invoke("studio:awaitSignIn"));
  await tick();
  assert.equal(held.length, 1);
  await invoke("studio:cancelSignIn");
  // Promptly: without the cancel reaching the request, the wait would hang on
  // until the request's own 20 s timeout. And as a cancellation: unmapped, an
  // aborted request reads "This operation was aborted".
  const outcome = await Promise.race([old, tick(1_000).then(() => "still waiting 1 s after the cancel")]);
  assert.deepEqual(outcome, { rejected: "sign-in cancelled" });
  held.splice(0);
  assert.equal(await invoke("studio:session"), null);
});

// KYB-681: a sign-in code issued, or still polled, while the app already holds
// a session. Approving it replaced the session with whichever account approved
// it, with nothing on screen asking.

test("while signed in, no new sign-in code is issued: no device request and no browser tab", async () => {
  await invoke("studio:signIn");
  const first = settle(invoke("studio:awaitSignIn"));
  await tick();
  held.shift().resolve(reply(200, { token: token("first@account.example"), refresh_token: "r1" }));
  assert.deepEqual(await first, { resolved: "first@account.example" });

  // Start again, landing after main saved the session but before the renderer
  // heard: the cancel has nothing left to stop.
  await invoke("studio:cancelSignIn");
  const before = devices;
  opened.splice(0);
  const second = await settle(invoke("studio:signIn"));
  assert.deepEqual(second, { rejected: "already signed in" }, "a second code was issued while signed in");
  assert.equal(devices, before, "a device request was made while signed in");
  assert.deepEqual(opened, [], "a browser tab was opened while signed in");

  // Nothing is left waiting that an approval could land on.
  assert.deepEqual(await settle(invoke("studio:awaitSignIn")), { rejected: "No sign-in in progress." });
  await tick(80);
  assert.equal(held.length, 0, `a code was polled while signed in: ${JSON.stringify(held.map((h) => h.device_code))}`);
  assert.equal((await invoke("studio:session"))?.email, "first@account.example");
});

test("a code started before a session existed cannot replace it, even with its approval in flight", async () => {
  // Two codes waiting at once, as two windows or a stale renderer could leave
  // them: the first is approved, and the second's request is already on the
  // wire with another account's approval.
  await invoke("studio:signIn");
  const first = settle(invoke("studio:awaitSignIn"));
  await tick();
  const firstRequest = held.shift();
  await invoke("studio:signIn");
  const second = settle(invoke("studio:awaitSignIn"));
  await tick();
  const secondRequest = held.find((h) => h.device_code === `D${devices}`);
  assert.ok(secondRequest, "fixture is wrong: the second code is not being polled");
  held.splice(held.indexOf(secondRequest), 1);

  firstRequest.resolve(reply(200, { token: token("first@account.example"), refresh_token: "r1" }));
  assert.deepEqual(await first, { resolved: "first@account.example" });
  secondRequest.resolve(reply(200, { token: token("other@account.example"), refresh_token: "r2" }));

  assert.deepEqual(await second, { rejected: "already signed in" });
  assert.equal((await invoke("studio:session"))?.email, "first@account.example", "the second code replaced the session");
  await tick(80);
  assert.equal(held.length, 0, `the second code was polled after the session existed: ${JSON.stringify(held.map((h) => h.device_code))}`);
});

test("a code waiting when a session appears stops polling at once", async () => {
  await invoke("studio:signIn");
  const first = settle(invoke("studio:awaitSignIn"));
  await tick();
  const firstRequest = held.shift();
  await invoke("studio:signIn");
  const second = settle(invoke("studio:awaitSignIn"));
  await tick();
  // The second code's first answer is "keep waiting".
  for (const h of held.splice(0)) h.resolve(reply(400, { error: "authorization_pending" }));
  firstRequest.resolve(reply(200, { token: token("first@account.example"), refresh_token: "r1" }));
  assert.deepEqual(await first, { resolved: "first@account.example" });
  // Raced, so the code before the fix fails here rather than polling on.
  const outcome = await Promise.race([second, tick(1_000).then(() => "still polling 1 s after the session existed")]);
  assert.deepEqual(outcome, { rejected: "already signed in" });
  await tick(80);
  assert.equal(held.length, 0, "the second code was polled after the session existed");
  assert.equal((await invoke("studio:session"))?.email, "first@account.example");
});
