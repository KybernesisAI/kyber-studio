import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KYB-688: `disconnectService` and `startMcpSignIn` answer a failed `fetch`
 * (offline, or the 30-second timeout) as `{ ok: false, error }`, as
 * `testRemoteMcp` already did, instead of rejecting. A rejection reached the
 * MCP row as Electron's IPC wrapping, and on `main` left the Connect spinner
 * turning for good.
 *
 * Each function is driven for real, against a stubbed `fetch`, with a stored
 * session that carries a bundle. The harness is `add-custom-connector.test.mjs`'s.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-mcp-unreachable-"));

const opened = [];
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
    shell: {
      openExternal: async (url) => {
        opened.push(url);
      },
    },
  },
});

const { disconnectService, startMcpSignIn } = await import("../src/main/controlPlane.ts");

function jwt(claims) {
  return `header.${Buffer.from(JSON.stringify(claims), "utf8").toString("base64url")}.signature`;
}
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

/** Run `call` with `fetch` replaced by `fake`, and count the calls. */
async function withFetch(fake, call) {
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    return fake(url, init);
  };
  try {
    return { result: await call(), urls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const offline = async () => {
  throw new TypeError("fetch failed");
};
const timedOut = async () => {
  throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
};
const answering = (status, body) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const UNREACHABLE = { ok: false, error: "Could not reach the control plane." };

for (const [why, fake] of [
  ["offline", offline],
  ["timed out", timedOut],
]) {
  test(`disconnectService answers, rather than rejecting, when fetch fails (${why})`, async () => {
    const { result, urls } = await withFetch(fake, () => disconnectService({ agent: "a", slug: "s" }));
    assert.equal(urls.length, 1, "the control plane was not asked exactly once");
    assert.match(urls[0], /\/api\/connectors\/disconnect$/);
    assert.deepEqual(result, UNREACHABLE);
  });

  test(`startMcpSignIn answers, rather than rejecting, when fetch fails (${why})`, async () => {
    opened.length = 0;
    const { result, urls } = await withFetch(fake, () => startMcpSignIn({ agent: "a", slug: "s" }));
    assert.equal(urls.length, 1, "the control plane was not asked exactly once");
    assert.match(urls[0], /\/api\/connectors\/mcp\/oauth\/start$/);
    assert.deepEqual(result, UNREACHABLE);
    assert.deepEqual(opened, [], "a browser was opened");
  });
}

test("disconnectService still reports a refusal by its status", async () => {
  const { result } = await withFetch(answering(500, {}), () => disconnectService({ agent: "a", slug: "s" }));
  assert.deepEqual(result, { ok: false, error: "Could not disconnect (500)." });
});

test("disconnectService still answers ok when the control plane agrees", async () => {
  const { result } = await withFetch(answering(200, {}), () => disconnectService({ agent: "a", slug: "s" }));
  assert.deepEqual(result, { ok: true });
});

test("startMcpSignIn still opens the browser on a good answer, and passes a refusal through", async () => {
  opened.length = 0;
  const good = await withFetch(answering(200, { authorizeUrl: "https://auth.example.test/go" }), () =>
    startMcpSignIn({ agent: "a", slug: "s" }),
  );
  assert.deepEqual(good.result, { ok: true });
  assert.deepEqual(opened, ["https://auth.example.test/go"]);

  const refused = await withFetch(answering(403, { error: "No." }), () => startMcpSignIn({ agent: "a", slug: "s" }));
  assert.deepEqual(refused.result, { ok: false, error: "No." });
});
