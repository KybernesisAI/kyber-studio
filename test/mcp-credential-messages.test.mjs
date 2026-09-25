import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What a remote agent is told when the stored credentials will not open.
 *
 * THE LEAK THIS CLOSES, and it is one we introduced on this branch. `ensure()`
 * threw
 *
 *   `${server.name}'s stored credentials could not be decrypted
 *    (${opened.keys.join(", ")}). Remove the server and add it again.`
 *
 * and `opened.keys` is the sorted list of environment-variable NAMES out of the
 * user's `local-mcp.json`. That throw runs `callServer` → `executeLocalAction`
 * → the catch in `localExec.ts`, which posts `e.message` to
 * `/api/local-exec/responses`. So an agent that asked to call a tool was
 * answered with `DATABASE_URL, ACME_INTERNAL_TOKEN` — the schema of the user's
 * secrets, and with it the vendors and internal systems this machine talks to.
 *
 * `git show 3b9df92:src/main/localMcp.ts | grep "stored credentials could not
 * be decrypted"` returns nothing: it is new in this branch. It is the same
 * species as the two path leaks 4163f64 closed, on the same wire, in the same
 * file, and the threat model at `localExec.ts:479-484` puts it in scope.
 *
 * The fix is the pattern 4163f64 established for the config path: the sensitive
 * detail is a PROPERTY on the error, never part of `.message`. Redaction at the
 * relay boundary was offered in round 3 and refused, because it masks the next
 * leak as well as this one.
 *
 * A separate file from `local-exec-relay.test.mjs` on purpose: this one needs a
 * config whose values are sealed and WILL NOT open, and that file's fixtures
 * are shared across its tests in order.
 */

const dir = mkdtempSync(join(tmpdir(), "kyb-creds-"));

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

const { executeLocalAction, relayErrorPayload } = await import("../src/main/localExec.ts");

/**
 * Well-formed ciphertext that this store cannot open — a value sealed by a
 * different install, or by a keyring that has since been reset. Valid base64
 * after the prefix, so `looksSealed` accepts it and `decryptString` is the
 * thing that fails, which is the real-world shape of `needs-re-entry`.
 */
const unopenable = (label) => `kyb:v1:${Buffer.from(label, "utf8").toString("base64")}`;

/** The names in the fixture. Both are plausible, and both are the leak. */
const KEYS = ["ACME_INTERNAL_TOKEN", "DATABASE_URL"];

writeFileSync(
  join(dir, "local-mcp.json"),
  JSON.stringify({
    servers: [
      {
        id: "pg",
        name: "Postgres",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-postgres"],
        enabled: true,
        env: {
          DATABASE_URL: unopenable("sealed-by-someone-else"),
          ACME_INTERNAL_TOKEN: unopenable("sealed-by-someone-else-too"),
        },
      },
    ],
  }),
  "utf8",
);

/** Ask for a tool call, the way a remote agent does, and keep what was thrown. */
async function callAndCatch() {
  const said = [];
  const warn = console.warn;
  console.warn = (...args) => said.push(args.join(" "));
  try {
    await executeLocalAction("local-mcp", { server: "pg", method: "tools/list" });
    assert.fail("a server whose credentials cannot be opened was started anyway");
  } catch (error) {
    return { error, said };
  } finally {
    console.warn = warn;
  }
}

test("the thrown message names no environment variable", async () => {
  const { error } = await callAndCatch();

  for (const key of KEYS) {
    assert.ok(
      !error.message.includes(key),
      `\`${key}\` is in the thrown message, which localExec.ts posts to the relay: ${error.message}`,
    );
  }

  // Said generally as well, so a future detail cannot smuggle a different name
  // past the two specific strings above. Environment variables carry
  // underscores and this message carries none.
  assert.ok(
    !error.message.includes("_"),
    `something shaped like an environment variable reached the message: ${error.message}`,
  );

  // And it must still be useful. Saying nothing is not the fix; saying nothing
  // about the user's secrets is. The remedy wording is fixed by KYB-594 and is
  // deliberately not "retry" — neither of these conditions is retryable.
  assert.match(error.message, /could not be decrypted/i, "the caller was told nothing at all");
  assert.match(error.message, /remove the server and add it again/i, "no remedy was offered");
  assert.ok(!/\bretry\b/i.test(error.message), "offered a retry for a condition that is not one");
});

test("the names survive as a property and in the local log — they are hidden, not lost", async () => {
  // The other half of the fix, and the reason this is redaction-from-the-wire
  // rather than deletion. The user owns this machine and needs to know which
  // values to re-enter: the renderer gets the names through
  // `serverStatus().credentials.keys`, and the main process prints them where
  // only the person sitting in front of it can read them.
  const { error, said } = await callAndCatch();

  assert.equal(error.reason, "needs-re-entry", "a decrypt failure was blamed on the environment");
  assert.deepEqual(error.keys, KEYS, "the names were thrown away rather than kept off the wire");
  assert.equal(said.length, 1, `the terminal was told nothing: ${said}`);
  for (const key of KEYS) assert.ok(said[0].includes(key), `${key} missing from the local log`);
});

test("the relay payload for that error carries no environment variable", async () => {
  // `relayErrorPayload` is the function `startLocalExec` calls in its catch, so
  // this is the body a remote agent receives — not a reconstruction of it.
  const { error } = await callAndCatch();
  const payload = relayErrorPayload("req-1", error);
  const wire = JSON.stringify(payload);

  for (const key of KEYS) {
    assert.ok(!wire.includes(key), `\`${key}\` was sent to the agent: ${wire}`);
  }
  assert.ok(!wire.includes("_"), `something shaped like an environment variable went out: ${wire}`);
  assert.ok(!wire.includes("kyb:v1:"), `ciphertext went out: ${wire}`);
  assert.ok(!/[/\\]/.test(payload.error), `a path separator reached the agent: ${wire}`);

  // The `keys` property is not on the wire even though it is on the error:
  // `relayErrorPayload` projects the message and nothing else.
  assert.deepEqual(Object.keys(payload).sort(), ["error", "id"]);
});
