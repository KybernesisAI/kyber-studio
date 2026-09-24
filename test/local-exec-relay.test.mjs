import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What the relay actually sends back for `servers/list`.
 *
 * Nothing under `test/` loaded `localExec.ts` before this file existed, and a
 * reviewer proved what that cost: replacing the projection at the discovery
 * branch with `.map(server => server)` left the entire suite green. The result
 * of that mutation is not a tidiness problem. `listServers` returns values
 * SEALED as of KYB-590, so the unprojected object carries `kyb:v1:` ciphertext
 * for every provider key, plus the command line and the working directory, to
 * a remote agent over the relay — and discovery is the one local-mcp call that
 * deliberately does not prompt the user, because asking what exists is not
 * using anything.
 *
 * The excuse for the gap was that importing `electron` makes the module
 * unloadable under `node --test`. It does not: `mock.module` handles it, and
 * the real obstacle was extensionless relative imports, closed by
 * `test/ts-ext-resolve.mjs`.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-relay-"));

mock.module("electron", {
  exports: {
    app: { getPath: () => dir },
    // `localExec.ts` reaches `controlPlane.ts`, which wants `shell` as well.
    shell: { openExternal: async () => {} },
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

const { executeLocalAction } = await import("../src/main/localExec.ts");

const sealed = (plain) => `kyb:v1:${Buffer.from(`ENC(${plain})`, "utf8").toString("base64")}`;

writeFileSync(
  join(dir, "local-mcp.json"),
  JSON.stringify({
    servers: [
      {
        id: "pg",
        name: "Postgres",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        cwd: "/home/someone/private-project",
        enabled: true,
        env: { DATABASE_URL: sealed("postgres://user:hunter2@internal/db") },
      },
      {
        id: "off",
        name: "Disabled one",
        command: "npx",
        args: [],
        enabled: false,
        env: { API_KEY: sealed("sk-live-should-not-appear") },
      },
    ],
  }),
  "utf8",
);

test("servers/list answers with id and name and nothing else", async () => {
  const result = await executeLocalAction("local-mcp", { method: "servers/list" });

  assert.deepEqual(result, { servers: [{ id: "pg", name: "Postgres" }] });

  // deepEqual above would already catch an extra property, but say it directly:
  // this is the assertion the mutation has to get past.
  for (const server of result.servers) {
    assert.deepEqual(
      Object.keys(server).sort(),
      ["id", "name"],
      "the relay response carries a field that is not id or name",
    );
  }
});

test("no sealed value, command, argument or path reaches the relay", async () => {
  const wire = JSON.stringify(await executeLocalAction("local-mcp", { method: "servers/list" }));

  for (const forbidden of [
    "kyb:v1:",
    "npx",
    "@modelcontextprotocol/server-postgres",
    "private-project",
    "DATABASE_URL",
    "env",
    "cwd",
    "command",
  ]) {
    assert.ok(!wire.includes(forbidden), `\`${forbidden}\` was sent to the agent: ${wire}`);
  }
});

test("a disabled server is not offered at all", async () => {
  const result = await executeLocalAction("local-mcp", { method: "servers/list" });
  assert.ok(
    !result.servers.some((s) => s.id === "off"),
    "a server the user switched off was advertised to the agent",
  );
});
