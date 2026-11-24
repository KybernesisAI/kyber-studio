import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mainProcess, pinPlatform } from "./helpers/mcp-main.mjs";

/**
 * KYB-696 AC3: every message about an unavailable store takes its words from
 * the one shared source, `src/main/credentialStoreWording.ts`, and writes no
 * description or remedy of its own.
 *
 * The source is replaced by one that answers with two marker strings, whatever
 * the platform and backend. Each of the six messages is then produced through
 * the path a person reaches it by: the Connect error and both `[mcp]` log
 * lines from the main process, and the warning, the note and the eye message
 * from the renderer, fed the main process's real availability answer. So a
 * marker that reaches the renderer has travelled the whole way: source,
 * answer, IPC handler, form.
 *
 * What each check does, exactly:
 *
 *  1. Both markers are in every message, each exactly once: AC3's "shows
 *     those markers" is the description AND the remedy.
 *  2. With every marker taken out, what is left contains none of the words
 *     that would make a description or remedy of its own: no phrase the real
 *     source uses (from `credentialStoreWording` for every platform and
 *     backend, read before it is replaced), and none of `keyring`, `Keychain`,
 *     `credential store`, `encryption`, `unlock`, `locked`, `unavailable`,
 *     `isn't available`, `not open` or `restart`. The one exception is the
 *     warning's own consequence, "Studio will use them until it restarts.",
 *     which is taken out before the check: it says how long a typed value
 *     lasts, not what is wrong or what to do.
 *  3. A marker appears once in a message, so nothing repeats the source's
 *     words beside a copy of its own.
 *
 * The eye message is also read BEFORE the answer arrives, which is the state
 * the product actually reaches with it: only a sealed value fails with
 * store-unavailable, and a sealed server is locked once the answer is in. The
 * renderer has no words for the store then, so check 2 applies to it as it
 * stands: no own description or remedy, markers or no markers.
 *
 * The availability answer's shape is checked here too, with the markers: the
 * three fields and nothing else, of the right types, carrying none of the env
 * values or key names on disk or held in memory.
 */

const DESCRIPTION = "DESCRIPTION-MARKER-7f3a.";
const REMEDY = "REMEDY-MARKER-91c2.";

// The real wording, read before it is replaced, so check 2 knows every phrase
// the source can produce. Through a query string, so this import is a
// different module instance from the one the mock below replaces.
//
// Both steps are skipped when the file does not exist, so this file loads on
// the merge base, where there is no shared source, and each message goes red
// on its own line rather than the whole file failing to load. A file that
// exists and fails to load or to be replaced is a fault, and throws here,
// loudly: tolerating it would leave the phrase list empty and weaken check 2.
const SOURCE = new URL("../src/main/credentialStoreWording.ts", import.meta.url);
const REAL_PHRASES = [];
if (existsSync(SOURCE)) {
  const real = await import(`${SOURCE.href}?real`);
  for (const platform of ["linux", "darwin", "win32", "freebsd"]) {
    for (const backend of ["basic_text", "gnome_libsecret", "kwallet6", null]) {
      const { description, remedy } = real.credentialStoreWording(platform, backend);
      REAL_PHRASES.push(description, remedy);
    }
  }
  assert.ok(REAL_PHRASES.every((phrase) => typeof phrase === "string" && phrase.length > 0), "the shared source answered with an empty phrase");
  mock.module(SOURCE.href, {
    exports: {
      credentialStoreWording: () => ({ description: DESCRIPTION, remedy: REMEDY }),
    },
  });
} else {
  console.log(`# ${SOURCE.pathname} does not exist (the merge base): nothing to replace`);
}

pinPlatform("linux");
const main = await mainProcess({ backend: "gnome_libsecret", encryptionAvailable: false });
const dom = await import("./helpers/mcp-form-dom.mjs");

const OWN_WORDS = /keyring|keychain|credential store|encryption|unlock|locked|unavailable|isn[’']t available|not open|restart/i;
const WARNING_CONSEQUENCE = "Studio will use them until it restarts.";

const fromMain = await main.mainMessages();
const fromRenderer = await dom.rendererMessages(() => main.invoke("studio:credentialStoreAvailable"));
const eyeBeforeAnswer = await dom.eyeBeforeAnswer();

/** Each message, and whether its composition carries the remedy: all six do. */
const messages = {
  "the Connect error": [fromMain.connect, true],
  "the log line for a value held in memory": [fromMain.held, true],
  "the log line for a server with a sealed value": [fromMain.sealedLog, true],
  "the form warning": [fromRenderer.warning, true],
  "the form note": [fromRenderer.note, true],
  "the eye message": [fromRenderer.eye, true],
};

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** Check 2: with the markers out, no description or remedy of its own. */
function assertNoOwnWording(where, said) {
  let rest = said.split(DESCRIPTION).join(" ").split(REMEDY).join(" ");
  if (where === "the form warning") {
    assert.ok(rest.includes(WARNING_CONSEQUENCE), `precondition: the warning's consequence moved: ${said}`);
    rest = rest.split(WARNING_CONSEQUENCE).join(" ");
  }
  assert.doesNotMatch(rest, OWN_WORDS, `${where} describes the store in words of its own: ${said}`);
  for (const phrase of REAL_PHRASES) {
    assert.ok(!rest.includes(phrase), `${where} carries the source's own phrase "${phrase}" beside the markers: ${said}`);
  }
}

for (const [where, [said, hasRemedy]] of Object.entries(messages)) {
  test(`AC3: ${where} takes its description${hasRemedy ? " and remedy" : ""} from the shared source, and has none of its own`, () => {
    assert.ok(said, `${where} was not produced`);
    assert.equal(count(said, DESCRIPTION), 1, `${where} does not show the description marker once: ${said}`);
    assert.equal(count(said, REMEDY), hasRemedy ? 1 : 0, `${where} has the remedy marker ${count(said, REMEDY)} times: ${said}`);
    assertNoOwnWording(where, said);
  });
}

test("AC3: the eye message before the answer arrives has no description or remedy of its own", () => {
  assert.ok(eyeBeforeAnswer, "the eye's store-unavailable message was not produced before the answer");
  assertNoOwnWording("the eye message before the answer", eyeBeforeAnswer);
});

test("AC3: the availability answer is the fixed shape, and carries no env data", () => {
  const VALUE_ON_DISK = "sentinel-value-on-disk-5d1e";
  const VALUE_HELD = "sentinel-value-held-a04b";
  const KEY_ON_DISK = "SENTINEL_KEY_ON_DISK";
  const KEY_HELD = "SENTINEL_KEY_HELD";
  const server = { id: "sentinel", name: "MCP sentinel", command: "npx", args: [], enabled: true };
  main.givenStored([{ ...server, env: { [KEY_ON_DISK]: VALUE_ON_DISK } }]);
  const saved = main.invoke("studio:saveMcpServers", [
    { ...server, env: { [KEY_ON_DISK]: VALUE_ON_DISK, [KEY_HELD]: VALUE_HELD } },
  ]);
  assert.deepEqual(saved.heldKeys?.sentinel, [KEY_HELD], "precondition: the typed value is not held");

  const answer = main.invoke("studio:credentialStoreAvailable");
  assert.equal(typeof answer, "object");
  assert.notEqual(answer, null);
  assert.equal(Array.isArray(answer), false);
  assert.equal(Object.getPrototypeOf(answer), Object.prototype, "not a plain object");
  assert.deepEqual(Object.keys(answer).sort(), ["available", "description", "remedy"]);
  assert.equal(typeof answer.available, "boolean");
  assert.equal(typeof answer.description, "string");
  assert.equal(typeof answer.remedy, "string");
  assert.deepEqual(answer, { available: false, description: DESCRIPTION, remedy: REMEDY });

  const wire = JSON.stringify(answer);
  for (const sentinel of [VALUE_ON_DISK, VALUE_HELD, KEY_ON_DISK, KEY_HELD]) {
    assert.ok(!wire.includes(sentinel), `the answer carries ${sentinel}`);
  }
  main.invoke("studio:saveMcpServers", []);
});
