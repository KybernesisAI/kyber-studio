import { after, test } from "node:test";
import assert from "node:assert/strict";

import { OLD_THREAD, REMOTE_AGENT, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643: the same race as session-sync-signin, through `bootstrap` (a
 * session already on disk). This path worked before the fix; this guards it.
 */
const bridge = installBridge({ stored: true, delays: { listSessions: 50, listAgents: 300 } });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("bootstrap: the directory answering before the agents still adopts the account's thread, and focus reads it again", async () => {
  await useStore.getState().bootstrap();
  await sleep(600);

  assert.equal(useStore.getState().authState, "signed-in");
  assert.equal(useStore.getState().sessions[REMOTE_AGENT.id], OLD_THREAD.sessionId, "the account's thread was not adopted");

  const reads = () => bridge.calls.filter((c) => c === "listSessions").length;
  const before = reads();
  window.dispatchEvent(new window.Event("focus"));
  await sleep(200);
  assert.equal(reads(), before + 1, "focus did not read the directory again");
});
