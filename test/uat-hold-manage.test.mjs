import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The UAT-only `KYBER_STUDIO_HOLD_MANAGE` switch. `manageCall` is driven for
 * real, against a stubbed `fetch`, with a stored session that carries a bundle,
 * and each call timed.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-uat-hold-"));

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

const { manageCall } = await import("../src/main/controlPlane.ts");

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

/**
 * KYB-662 AC6, UAT only: `KYBER_STUDIO_HOLD_MANAGE` holds GETs of one path for
 * a set time from the first, so the moment before Studio has read the thread
 * can be acted in by hand. Reads during the hold wait with the first; reads
 * after it go straight through. One launch is one process, so this file holds
 * its own module state.
 */
async function timed(fn) {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push(`${init.method} ${String(url).replace("https://a.example/eve/v1/kyb", "")}`);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const started = Date.now();
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return { ms: Date.now() - started, sent };
}

test("unset, nothing is held", async () => {
  delete process.env.KYBER_STUDIO_HOLD_MANAGE;
  const { ms } = await timed(() => manageCall({ url: "https://a.example", path: "/thread" }));
  assert.ok(ms < 200, `held for ${ms} ms`);
});

test("a malformed setting holds nothing", async () => {
  // Before the test below uses up the one hold this launch has.
  for (const bad of ["/thread", "thread=400", "/thread=abc", "/thread=-5", "/thread=400x", "x/thread=400"]) {
    process.env.KYBER_STUDIO_HOLD_MANAGE = bad;
    const { ms } = await timed(() => manageCall({ url: "https://a.example", path: "/thread" }));
    assert.ok(ms < 200, `${bad} held for ${ms} ms`);
  }
  delete process.env.KYBER_STUDIO_HOLD_MANAGE;
});

test("set, GETs of that path are held until the hold ends, and no other call, and none after", async () => {
  process.env.KYBER_STUDIO_HOLD_MANAGE = "/thread=400";
  try {
    const other = await timed(async () => {
      await manageCall({ url: "https://a.example", path: "/sessions?limit=60" });
      await manageCall({ url: "https://a.example", path: "/thread", body: { fresh: true } });
      await manageCall({ url: "https://a.example", path: "/thread/fresh" });
    });
    assert.ok(other.ms < 200, `another path, or a POST, was held: ${other.ms} ms`);
    // A focus during the hold refreshes the thread: that read waits with the
    // first. One stub over both, since they overlap.
    const realFetch = globalThis.fetch;
    const sent = [];
    globalThis.fetch = async (url, init) => {
      sent.push(`${init.method} ${String(url).replace("https://a.example/eve/v1/kyb", "")}`);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const started = Date.now();
    const done = [];
    const read = () => manageCall({ url: "https://a.example", path: "/thread" }).then(() => done.push(Date.now() - started));
    try {
      const first = read();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const duringAt = Date.now() - started;
      await Promise.all([first, read()]);
      assert.deepEqual(sent, ["GET /thread", "GET /thread"], "both are still sent");
      assert.ok(done.every((ms) => ms >= 380), `a GET /thread went through before the hold ended: ${JSON.stringify(done)}`);
      assert.ok(Math.max(...done) - duringAt < 380, `a read during the hold was held for the whole time again: ${JSON.stringify(done)}`);
    } finally {
      globalThis.fetch = realFetch;
    }
    const later = await timed(async () => {
      await manageCall({ url: "https://a.example", path: "/thread" });
      await manageCall({ url: "https://a.example", path: "/thread" });
    });
    assert.ok(later.ms < 200, `a GET /thread after the hold was held: ${later.ms} ms`);
  } finally {
    delete process.env.KYBER_STUDIO_HOLD_MANAGE;
  }
});
