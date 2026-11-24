import { test } from "node:test";
import assert from "node:assert/strict";
import { credentialStoreWording } from "../src/main/credentialStoreWording.ts";
import { credentialStoreAnswer } from "../src/main/credentialStorage.ts";

/**
 * The shared wording for an unavailable credential store (KYB-696), case by
 * case, with the platform and backend pinned as arguments rather than read
 * from the host.
 *
 * The literal sentences are pinned here once. The tests that drive real
 * messages (`credential-store-wording-*.test.mjs`) check that each message
 * takes its words from this source; this file checks what the source says.
 */

const LINUX_KEYRINGS = ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6", "unknown", null];

/** A full sentence: a capital letter first and a full stop last. */
const SENTENCE = /^[A-Z].*\.$/;

test("a Linux keyring backend, or one whose name could not be read: the keyring is locked, unlock it and restart Studio", () => {
  for (const backend of LINUX_KEYRINGS) {
    assert.deepEqual(credentialStoreWording("linux", backend), {
      description: "Your keyring is locked.",
      remedy: "Unlock your keyring and restart Studio.",
    }, String(backend));
  }
});

test("basic_text: no keyring was found, and neither unlock nor locked is said", () => {
  const wording = credentialStoreWording("linux", "basic_text");
  assert.deepEqual(wording, {
    description: "No keyring was found on this computer.",
    remedy: "Set up a keyring, then restart Studio.",
  });
  assert.doesNotMatch(`${wording.description} ${wording.remedy}`, /unlock|locked/i);
});

test("macOS keeps its remedy, made consistent, and never says keyring", () => {
  const wording = credentialStoreWording("darwin", null);
  assert.deepEqual(wording, {
    description: "Your Keychain isn’t available.",
    remedy: "Unlock your Keychain and restart Studio.",
  });
  assert.doesNotMatch(`${wording.description} ${wording.remedy}`, /keyring/i);
});

test("Windows, and any other platform, gets the generic name, not an invented one", () => {
  for (const platform of ["win32", "freebsd"]) {
    const wording = credentialStoreWording(platform, null);
    assert.deepEqual(wording, {
      description: "Your credential store isn’t available.",
      remedy: "Unlock your credential store and restart Studio.",
    }, platform);
    assert.doesNotMatch(`${wording.description} ${wording.remedy}`, /keyring|Keychain|Credential Manager/, platform);
  }
});

test("the backend is only read on Linux: off it, basic_text changes nothing", () => {
  for (const platform of ["darwin", "win32"]) {
    assert.deepEqual(credentialStoreWording(platform, "basic_text"), credentialStoreWording(platform, null), platform);
  }
});

test("every description and every remedy is a full sentence", () => {
  for (const [platform, backend] of [
    ["linux", "gnome_libsecret"],
    ["linux", "basic_text"],
    ["linux", null],
    ["darwin", null],
    ["win32", null],
  ]) {
    const { description, remedy } = credentialStoreWording(platform, backend);
    assert.match(description, SENTENCE, `${platform}/${backend} description`);
    assert.match(remedy, SENTENCE, `${platform}/${backend} remedy`);
  }
});

test("with the store available, the answer is the fixed shape with nothing to describe", () => {
  // First and only ask in this process: the answer is memoised.
  const answer = credentialStoreAnswer(
    { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret" },
    { platform: "linux" },
  );
  assert.deepEqual(Object.keys(answer).sort(), ["available", "description", "remedy"]);
  assert.deepEqual(answer, { available: true, description: "", remedy: "" });
});
