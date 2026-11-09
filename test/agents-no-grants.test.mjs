import { after, test } from "node:test";
import assert from "node:assert/strict";

import { installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-669, AC3: the no-grants sentence is not touched by the offline change.
 * A signed-in account whose control plane answers with no agents still sees
 * it, and the retry added for a failed load does not run for an empty one,
 * which IS loaded.
 */
const bridge = installBridge({ stored: true, agents: [] });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("an account with no agents still sees the no-grants sentence, and it is not retried", async () => {
  await useStore.getState().bootstrap();
  await sleep(50);
  assert.equal(
    useStore.getState().authError,
    "No agents are granted to your account yet. Register one in the control plane, or ask an admin for a grant.",
  );
  const calls = bridge.calls.filter((c) => c === "listAgents").length;
  window.dispatchEvent(new window.Event("focus"));
  await sleep(50);
  assert.equal(bridge.calls.filter((c) => c === "listAgents").length, calls, "an empty, loaded list was fetched again");
});

test("a failed Refresh agents on a loaded empty list retries, so its 'Retrying…' is true, and the no-grants sentence returns", async () => {
  // Review finding, KYB-669 round 1: the sentence promised a retry that only
  // ran for a list that had never loaded.
  bridge.live.fail = ["listAgents"];
  await useStore.getState().refreshAgents();
  assert.match(useStore.getState().authError, /^Couldn't reach Kybernesis.*Retrying…$/);

  bridge.live.fail = [];
  const before = bridge.calls.filter((c) => c === "listAgents").length;
  window.dispatchEvent(new window.Event("focus"));
  await sleep(50);
  assert.equal(bridge.calls.filter((c) => c === "listAgents").length, before + 1, "nothing retried");
  assert.match(useStore.getState().authError, /^No agents are granted to your account yet\./);

  window.dispatchEvent(new window.Event("focus"));
  await sleep(50);
  assert.equal(bridge.calls.filter((c) => c === "listAgents").length, before + 1, "retried after a successful load");
});
