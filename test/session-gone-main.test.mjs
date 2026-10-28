import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KYB-657, AC1, the main-process half: a refused read of a held conversation
 * reaches the renderer as "gone", not as an empty history or an ordinary
 * ending. `replaySession` and `watchSession` are driven for real against a
 * stubbed `fetch`, with a stored session that carries a bundle.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-session-gone-"));

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
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
    shell: { openExternal: async () => {} },
  },
});

const { watchSession, ConversationGoneError } = await import("../src/main/controlPlane.ts");
const { replaySession } = await import("../src/main/sessionIndex.ts");

const jwt = (claims) => `header.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.signature`;
const exp = Math.floor(Date.now() / 1000) + 3600;
writeFileSync(
  join(dir, "session.bin"),
  Buffer.from(
    `ENC(${JSON.stringify({
      token: jwt({ email: "someone@example.com", exp }),
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
      email: "someone@example.com",
      bundle: jwt({ exp }),
    })})`,
    "utf8",
  ),
);

const EXPIRED = JSON.stringify({ code: "session_expired", error: "Session history is no longer available.", ok: false });

/** Run `fn` with every request answered by `status` and `body`. */
async function answering(status, body, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(body, { status, headers: { "content-type": "application/json" } });
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

function watch() {
  const controller = new AbortController();
  return watchSession({
    url: "https://a.example",
    sessionId: "wrun_DEAD",
    startIndex: 107,
    signal: controller.signal,
    onDelta: () => {},
    onReset: () => {},
    onActivity: () => {},
    onCursor: () => {},
    onPeer: () => {},
    onStep: () => {},
    onLive: () => {},
  }).finally(() => controller.abort());
}

test("a history read refused with 410 says the conversation has gone, not that it is empty", async (t) => {
  t.mock.method(console, "log", () => {});
  const result = await answering(410, EXPIRED, () => replaySession({ url: "https://a.example", sessionId: "wrun_DEAD" }));
  assert.deepEqual(result, { gone: "expired" });
});

test("a history read that fails for any other reason is still no answer", async (t) => {
  t.mock.method(console, "log", () => {});
  const result = await answering(503, "", () => replaySession({ url: "https://a.example", sessionId: "wrun_X" }));
  assert.equal(result, null);
});

test("a watch refused with 410 ends with ConversationGoneError", async (t) => {
  t.mock.method(console, "log", () => {});
  await assert.rejects(
    answering(410, EXPIRED, watch),
    (error) => error instanceof ConversationGoneError && error.reason === "expired" && error.status === 410,
  );
});

test("a watch answered by a platform's 404 is not taken as a gone conversation: it is tried again", async (t) => {
  t.mock.method(console, "log", () => {});
  // Stopped at the second request: reaching it at all is the point. Left to
  // run, the existing reconnect gives up after about 40 s with an ordinary error.
  const controller = new AbortController();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls >= 2) controller.abort();
    return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
  };
  try {
    await watchSession({
      url: "https://a.example",
      sessionId: "wrun_ALIVE",
      startIndex: 107,
      signal: controller.signal,
      onDelta: () => {},
      onReset: () => {},
      onActivity: () => {},
      onCursor: () => {},
      onPeer: () => {},
      onStep: () => {},
      onLive: () => {},
    });
  } catch (error) {
    assert.ok(!(error instanceof ConversationGoneError), "not gone");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(calls >= 2, `asked again (${calls} request(s))`);
});
