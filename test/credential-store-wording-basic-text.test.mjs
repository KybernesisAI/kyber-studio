import { test } from "node:test";
import assert from "node:assert/strict";
import { mainProcess, pinPlatform } from "./helpers/mcp-main.mjs";

/**
 * KYB-696 AC1: on Linux's `basic_text` backend there is no keyring, so no
 * message about the unavailable store may say "unlock" or "locked".
 *
 * `basic_text` is Chromium's last resort, a key compiled into the binary. The
 * availability answer is `false` from the backend name alone, and
 * `isEncryptionAvailable()` is never asked: it answers `true` there, which is
 * why the mock below says `true` too. Unlocking is impossible and restarting
 * gives the same answer, so a remedy that says to unlock is wrong advice.
 *
 * All six messages, each through the path a person reaches it by: the Connect
 * error and both `[mcp]` log lines from the main process, and the warning, the
 * note and the eye message from the renderer, fed the main process's real
 * availability answer. One test per message, so a red names which one. The
 * eye message is read twice: with the answer in, and before it arrives, which
 * is the state the product reaches with it (a sealed server is locked once the
 * answer is in, and offers no eye).
 *
 * Imports nothing that KYB-696 added, so it loads on the merge base, where the
 * Connect error, the held log line and both eye readings go red.
 */

pinPlatform("linux");
const main = await mainProcess({ backend: "basic_text", encryptionAvailable: true });
const dom = await import("./helpers/mcp-form-dom.mjs");

const UNLOCK = /unlock|locked/i;

const fromMain = await main.mainMessages();
const fromRenderer = await dom.rendererMessages(() => main.invoke("studio:credentialStoreAvailable"));
const eyeBeforeAnswer = await dom.eyeBeforeAnswer();

const messages = {
  "the Connect error": fromMain.connect,
  "the log line for a value held in memory": fromMain.held,
  "the log line for a server with a sealed value": fromMain.sealedLog,
  "the form warning": fromRenderer.warning,
  "the form note": fromRenderer.note,
  "the eye message": fromRenderer.eye,
  "the eye message before the answer arrives": eyeBeforeAnswer,
};

test("precondition: the store is unavailable, decided from the backend name alone", () => {
  const answer = main.invoke("studio:credentialStoreAvailable");
  assert.equal(typeof answer === "object" ? answer.available : answer, false);
  assert.equal(main.asks.isEncryptionAvailable, 0, "basic_text was decided by asking the OS");
});

for (const [where, said] of Object.entries(messages)) {
  test(`AC1: on basic_text, ${where} does not say unlock or locked`, () => {
    assert.ok(said, `${where} was not produced`);
    assert.doesNotMatch(said, UNLOCK, `${where}: ${said}`);
  });
}
