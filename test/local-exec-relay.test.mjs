import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const { answerAsk, authorize, executeLocalAction, readPermissions, relayErrorPayload, rememberDecision } = await import(
  "../src/main/localExec.ts"
);

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

/**
 * What the relay sends back when the config is DAMAGED.
 *
 * Deliberately last in this file: it replaces the fixture with an unreadable
 * one, and every test above wants the good one.
 *
 * This is a leak we introduced. Before KYB-590 `listServers` swallowed
 * everything and answered `[]`, so nothing about a damaged config ever reached
 * the relay. It now throws — correctly, that was the KYB-582 fix — and
 * `servers/list` is on the relay path, which puts the thrown message straight
 * into `/api/local-exec/responses`. A message that named the config file
 * therefore sent the user's `userData` directory, and with it their home
 * directory and their username, to a remote agent that asked only which
 * servers exist. Discovery does not even prompt, so nobody saw it go.
 *
 * TWO routes, and they are separate bugs with separate fixes. Both fixtures
 * below are here because each one leaves the other alive:
 *
 *   1. the config path interpolated into `ConfigUnreadableError.message`;
 *   2. the SyntaxError's own message, which V8 builds by quoting the offending
 *      source back — `Unexpected token ']', ..."/tmp/x"},]}" is not valid
 *      JSON`. The source is the user's config, which carries `cwd`. Only the
 *      "Unexpected token" form quotes, and only a short window around the
 *      position, which is why fixture 2 is shaped the way it is: a longer path
 *      is truncated by V8 and the test would pass while the leak stayed real.
 */

const homeish = "/home/someone/private-project";

/** `${label}: ${damaged JSON}`, each reaching the message by a different route. */
const damagedFixtures = [
  ["a truncated file, whose message can only name the path", `{"servers":[{"cwd":"${homeish}"`],
  // Short enough that V8's quoted window holds the whole path — checked.
  ["a file V8 quotes back at us", '{"servers":[{"cwd":"/home/b"},]}'],
];

for (const [label, damaged] of damagedFixtures) {
  test(`${label} tells the relay nothing about the filesystem`, async () => {
    writeFileSync(join(dir, "local-mcp.json"), damaged, "utf8");

    // `relayErrorPayload` is the function localExec.ts calls in its catch, so
    // this is the body a remote agent receives rather than a reconstruction of
    // it. It used to be rebuilt by hand here under a comment claiming the two
    // matched, which is only as good as the comment.
    let payload;
    try {
      await executeLocalAction("local-mcp", { method: "servers/list" });
      assert.fail("a damaged config was answered instead of refused");
    } catch (e) {
      payload = relayErrorPayload("req-1", e);
    }

    const wire = JSON.stringify(payload);

    for (const forbidden of [dir, homeish, "/home/", "/tmp/", "local-mcp.json"]) {
      assert.ok(!wire.includes(forbidden), `\`${forbidden}\` was sent to the agent: ${wire}`);
    }
    // Said generally as well, so a future detail cannot smuggle a path past the
    // specific strings above: nothing shaped like a path at all.
    assert.ok(!/[/\\]/.test(payload.error), `a path separator reached the agent: ${wire}`);

    // And it must still be useful to whoever reads it. Saying nothing at all is
    // not the fix; saying nothing about the filesystem is.
    assert.match(payload.error, /could not be read/i, "the relay was told nothing at all");
  });
}

/**
 * KYB-621: remembering a card answer can fail (on Windows, whenever another
 * process holds the permissions file). Before this, the throw escaped
 * `authorize` after the user had decided, and the agent's request was never
 * answered. Now it is logged and the decision is unaffected.
 */
test("a remembered card answer that cannot be saved is logged, not thrown", () => {
  const lines = [];
  const failing = () => {
    throw Object.assign(new Error("EPERM: operation not permitted, rename"), { code: "EPERM" });
  };
  assert.doesNotThrow(() => rememberDecision(failing, (line) => lines.push(line)));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /could not remember the decision: EPERM/);

  let ran = false;
  rememberDecision(() => { ran = true; }, (line) => lines.push(line));
  assert.equal(ran, true);
  assert.equal(lines.length, 1, "a successful remember logged something");
});

/**
 * The same, through the real card flow rather than the helper on its own:
 * reverting `authorize` to call setPermission directly must fail here. The
 * permissions file is made PERMANENTLY unwritable by making its directory
 * read-only (on POSIX a read-only directory refuses both the temp write and the
 * rename; a read-only file would not). The person answers "always" and asks for
 * it to be remembered; the request must still be answered with their decision.
 */
test("a card answered 'always, remember' whose save fails still answers the request, and logs the loss", {
  skip: process.platform === "win32" && "a read-only directory does not refuse writes on Windows",
}, async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const sender = {
    isDestroyed: () => false,
    // The card is answered as soon as it is shown, the way a click would.
    send: (_channel, card) => setImmediate(() => answerAsk(card.id, true, true)),
  };
  chmodSync(dir, 0o555);
  t.after(() => chmodSync(dir, 0o755));

  const allowed = await authorize(sender, { id: "card-1", agent: "a", action: "run-command", payload: { command: "ls" } });

  assert.equal(allowed, true, "the person's decision was lost along with the save");
  const lines = logged.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(lines.some((l) => /could not remember the decision/.test(l)), `nothing logged: ${JSON.stringify(lines)}`);
  // And nothing was remembered: the next request asks again.
  assert.equal(readPermissions()["run-command"], "ask");
});
