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

/**
 * Run a watch to its end with every request answered by `status` and `body`.
 *
 * eve's own client retries a 404 or 409 on opening the stream, twelve times
 * over about 38 s, before it throws; only then does Studio classify the
 * answer. The waits are cut to nothing here so the classification is what is
 * tested, not that retry.
 */
async function watchToEnd(status, body) {
  const realFetch = globalThis.fetch;
  const realSetTimeout = globalThis.setTimeout;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  };
  globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
  try {
    await watch();
    return { error: null, calls };
  } catch (error) {
    return { error, calls };
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
  }
}

test("a watch that ends on eve's own 404 ends with ConversationGoneError", async (t) => {
  t.mock.method(console, "log", () => {});
  const { error } = await watchToEnd(404, JSON.stringify({ error: "Session not found.", ok: false }));
  assert.ok(error instanceof ConversationGoneError, `ended with ${error}`);
  assert.equal(error.reason, "missing");
});

test("a watch that ends on a platform's 404 is an ordinary ending, not a gone conversation", async (t) => {
  t.mock.method(console, "log", () => {});
  for (const body of ["Not Found", "The deployment could not be found on Vercel.\n\nDEPLOYMENT_NOT_FOUND\n"]) {
    const { error } = await watchToEnd(404, body);
    assert.ok(error, "it ends");
    assert.ok(!(error instanceof ConversationGoneError), `not gone for ${JSON.stringify(body)}`);
  }
});
