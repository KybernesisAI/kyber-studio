import { test } from "node:test";
import assert from "node:assert/strict";
import { mainProcess, pinPlatform } from "./helpers/mcp-main.mjs";

/**
 * KYB-696 AC2 and AC4, on Linux with a keyring backend whose unlock prompt was
 * dismissed: `gnome_libsecret`, and `isEncryptionAvailable()` answering
 * `false`.
 *
 *  - AC2: the Connect error and the log line for a value held in memory still
 *    say to unlock the keyring and restart Studio, which is the remedy that
 *    works here (availability is latched for the process). Asserted
 *    literally, not composed from the shared source, so the source cannot
 *    agree with itself into a wrong remedy. Mutation M1, the keyring case
 *    given the `basic_text` wording, turns it red.
 *  - AC4: choosing the wording asks the OS nothing new. Listing the servers
 *    asks nothing at all, and the availability answer (asked twice, as two
 *    forms opening would), the Connect error and a save together ask
 *    `isEncryptionAvailable()` no more often than the merge base did.
 *    Mutation M2, working out the case with a raw `isEncryptionAvailable()`
 *    rather than the memoised answer, turns it red.
 *
 * Every call is made at the top of the file, in order, and the tests read
 * what was recorded: availability is memoised for the process, so the order
 * of the asks is the thing being measured.
 */

/**
 * Raw `isEncryptionAvailable()` calls for the sequence below, measured on the
 * merge base, `ae8be83`: one, because every caller there goes through the
 * memoised `isCredentialStoreAvailable`.
 */
const MERGE_BASE_RAW_ASKS = 1;
/**
 * Backend reads for the same sequence on the merge base: one, inside the same
 * memoised answer. The name is free to ask, but it sits inside that latch.
 */
const MERGE_BASE_BACKEND_READS = 1;

pinPlatform("linux");
const main = await mainProcess({ backend: "gnome_libsecret", encryptionAvailable: false });

main.givenStored([
  { id: "listed", name: "MCP listed", command: "npx", args: [], enabled: true, env: { KYB_KEY: "kyb:v1:RU5DKGZpcnN0KQ==" } },
]);
const listed = main.invoke("studio:mcpServers");
main.invoke("studio:mcpServers");
const asksWhileListing = { ...main.asks };

const answers = [main.invoke("studio:credentialStoreAvailable"), main.invoke("studio:credentialStoreAvailable")];
const messages = await main.mainMessages();
const asksAfterSequence = { ...main.asks };

test("AC4: listing the servers asks the store nothing", () => {
  assert.equal(listed.ok, true, "precondition: the list was not read");
  assert.equal(listed.servers.length, 1, "precondition: the stored server is not listed");
  assert.deepEqual(asksWhileListing, { isEncryptionAvailable: 0, getSelectedStorageBackend: 0 });
});

test("AC4: the availability answer, the Connect error and a save ask isEncryptionAvailable() no more than the merge base", (t) => {
  t.diagnostic(`raw isEncryptionAvailable() calls: ${asksAfterSequence.isEncryptionAvailable}`);
  for (const answer of answers) {
    assert.equal(typeof answer === "object" ? answer.available : answer, false, "precondition: the store is available");
  }
  assert.ok(
    asksAfterSequence.isEncryptionAvailable <= MERGE_BASE_RAW_ASKS,
    `asked isEncryptionAvailable() ${asksAfterSequence.isEncryptionAvailable} times; the merge base asked ${MERGE_BASE_RAW_ASKS}`,
  );
});

test("AC4: choosing the wording reads the backend name no more than the merge base", (t) => {
  t.diagnostic(`getSelectedStorageBackend() calls: ${asksAfterSequence.getSelectedStorageBackend}`);
  assert.ok(
    asksAfterSequence.getSelectedStorageBackend <= MERGE_BASE_BACKEND_READS,
    `read the backend ${asksAfterSequence.getSelectedStorageBackend} times; the merge base read it ${MERGE_BASE_BACKEND_READS}`,
  );
});

test("AC2: on a Linux keyring backend, the Connect error says to unlock the keyring and restart Studio", () => {
  assert.match(messages.connect, /unlock your keyring and restart Studio/i, messages.connect);
});

test("AC2: on a Linux keyring backend, the log line for a value held in memory says to unlock the keyring and restart Studio", () => {
  assert.match(messages.held, /kept in memory only/, `precondition: not the held line: ${messages.held}`);
  assert.match(messages.held, /unlock your keyring and restart Studio/i, messages.held);
});
