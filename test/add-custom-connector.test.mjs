import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * KYB-686: adding a remote MCP server hands the control plane's `slug` and
 * `needsSignIn` back to the add form, which shows the sign-in card only when
 * both are there (`Plugins.tsx`, `if (res.needsSignIn && res.slug)`).
 *
 * `addCustomConnector` is driven for real, against a stubbed `fetch`, with a
 * stored session that carries a bundle.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-add-custom-connector-"));

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

const { addCustomConnector } = await import("../src/main/controlPlane.ts");

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

const INPUT = { agent: "agent-a", name: "Signs in", url: "https://mcp.example.test/mcp" };

/** Add a server with the control plane answering `answer` with `status`. */
async function addAnswering(answer, status = 200) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    return new Response(JSON.stringify(answer), { status, headers: { "content-type": "application/json" } });
  };
  try {
    return { result: await addCustomConnector(INPUT), calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("AC1: a server that needs a sign-in comes back with its slug and needsSignIn", async () => {
  const { result, calls } = await addAnswering({ slug: "s", needsSignIn: true });
  assert.equal(calls.length, 1, "the add did not reach the control plane exactly once");
  assert.match(calls[0].url, /\/api\/connectors\/custom$/);
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(JSON.parse(calls[0].body), INPUT);
  assert.equal(result.ok, true);
  assert.equal(result.slug, "s", "the control plane's slug was dropped");
  assert.equal(result.needsSignIn, true, "the control plane's needsSignIn was dropped");
});

test("AC1: the control plane's full answer for a server waiting for sign-in", async () => {
  // The shape `POST /api/connectors/custom` returns on success.
  const { result } = await addAnswering({ ok: true, slug: "mcp-signs-in", authMode: "oauth", needsSignIn: true });
  assert.deepEqual(result, { ok: true, slug: "mcp-signs-in", needsSignIn: true });
});

test("AC2: an answer that does not say a sign-in is needed closes the form, as before", async () => {
  const { result } = await addAnswering({});
  assert.equal(result.ok, true);
  assert.notEqual(result.needsSignIn, true, "an empty answer was read as needing a sign-in");
});

test("AC2: a server already signed in, or one with a token, is not sent to the card", async () => {
  for (const answer of [
    { ok: true, slug: "mcp-signs-in", authMode: "oauth", needsSignIn: false },
    { ok: true, slug: "mcp-token", authMode: "bearer", needsSignIn: false },
    { ok: true, slug: "mcp-weird", needsSignIn: "true" },
  ]) {
    const { result } = await addAnswering(answer);
    assert.equal(result.ok, true);
    assert.notEqual(result.needsSignIn, true, `${JSON.stringify(answer)} was read as needing a sign-in`);
  }
});

test("a slug that is not a string never reaches the form", async () => {
  const { result } = await addAnswering({ slug: 42, needsSignIn: true });
  assert.equal(result.ok, true);
  assert.equal(result.slug, undefined, "a non-string slug was handed to the form");
});

test("a successful add whose body is null still succeeds and closes the form", async () => {
  const { result } = await addAnswering(null);
  assert.equal(result.ok, true);
  assert.notEqual(result.needsSignIn, true);
});

test("a refused add still reports the control plane's reason", async () => {
  const { result } = await addAnswering({ error: "That URL did not answer as an MCP server." }, 400);
  assert.deepEqual(result, { ok: false, error: "That URL did not answer as an MCP server." });
});
