import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KYB-647: a management call keeps the 420 s bound sized for installs unless
 * the caller asks for less, and the `/sessions` read asks for less.
 *
 * `manageCall` is driven for real, against a stubbed `fetch`, with a stored
 * session that carries a bundle, and `AbortSignal.timeout` watched to see the
 * bound each request was given.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-manage-timeout-"));

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

const { manageCall, manageTimeoutMs, MANAGE_TIMEOUT_MS } = await import("../src/main/controlPlane.ts");

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

/** Run `fn` with fetch answering 200 and every AbortSignal.timeout bound recorded. */
async function withBounds(fn) {
  const bounds = [];
  const urls = [];
  const realTimeout = AbortSignal.timeout;
  const realFetch = globalThis.fetch;
  AbortSignal.timeout = (ms) => {
    bounds.push(ms);
    return realTimeout.call(AbortSignal, ms);
  };
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ sessions: [] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await fn();
  } finally {
    AbortSignal.timeout = realTimeout;
    globalThis.fetch = realFetch;
  }
  return { bounds, urls };
}

test("AC6: a call that names no timeout keeps the 420 s install bound", async () => {
  assert.equal(MANAGE_TIMEOUT_MS, 420_000);
  const { bounds, urls } = await withBounds(async () => {
    const res = await manageCall({ url: "https://a.example", path: "/install", body: { name: "x" } });
    assert.equal(res.ok, true);
  });
  assert.deepEqual(urls, ["https://a.example/eve/v1/kyb/install"]);
  assert.deepEqual(bounds, [420_000]);
});

test("AC2: a call that asks for a shorter bound gets it", async () => {
  const { bounds } = await withBounds(async () => {
    await manageCall({ url: "https://a.example", path: "/sessions?limit=60", timeoutMs: 15_000 });
  });
  assert.deepEqual(bounds, [15_000]);
});

test("AC2: a request that never answers fails within the bound it asked for", async () => {
  const realFetch = globalThis.fetch;
  // A connection that is accepted and never answered: only the signal ends it.
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  try {
    const started = Date.now();
    await assert.rejects(manageCall({ url: "https://a.example", path: "/sessions?limit=60", timeoutMs: 50 }), { name: "TimeoutError" });
    assert.ok(Date.now() - started < 5_000, "the short bound was not applied");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a caller can only shorten the bound, and nonsense gets the default", () => {
  assert.equal(manageTimeoutMs(15_000), 15_000);
  assert.equal(manageTimeoutMs(10_000_000), 420_000);
  for (const bad of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "15000", {}]) {
    assert.equal(manageTimeoutMs(bad), 420_000, `${String(bad)} was not given the default`);
  }
});
