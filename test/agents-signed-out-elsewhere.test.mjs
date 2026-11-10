import { after, test } from "node:test";
import assert from "node:assert/strict";

import { installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-669: "Not signed in." from `listAgents` means two different things, and
 * the sidebar has to tell them apart.
 *
 * - Offline with a token over an hour old: the refresh cannot reach the
 *   network, so `activeSession` answers null. The session is still stored and
 *   the list comes back with the network, so this is the network sentence.
 * - A refresh answered 401 or 403: the main process dropped the session. No
 *   retry will help, so this is the expired sentence.
 */
const NOT_SIGNED_IN = "Error invoking remote method 'studio:listAgents': Error: Not signed in.";
const bridge = installBridge({ stored: true, fail: ["listAgents"] });
bridge.live.failWith.listAgents = NOT_SIGNED_IN;
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("offline with an expired token: the network sentence, because the session is still stored", async () => {
  await useStore.getState().bootstrap();
  await sleep(50);
  assert.equal(useStore.getState().authError, "Couldn't reach Kybernesis to load your agents. Retrying…");
});

test("session dropped by the main process: the expired sentence", async () => {
  bridge.live.stored = false;
  await useStore.getState().refreshAgents();
  assert.equal(
    useStore.getState().authError,
    "Your sign-in has expired. Sign out from the account menu, then sign in again.",
  );
});
