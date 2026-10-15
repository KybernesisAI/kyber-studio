import { after, test } from "node:test";
import assert from "node:assert/strict";

import { REMOTE_AGENT, captureLogs, installBridge, occurrences, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643: the directory answers in time and has NO thread for this agent. The
 * first message waits, then starts a new thread, which is correct here. The
 * bubble is still on screen after the wait and must not be added a second time.
 */
const bridge = installBridge({ rows: [], delays: { listSessions: 200 } });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("a directory with no thread for the agent: the first message waits, then starts one, shown once", async (t) => {
  const logs = captureLogs(t);
  await useStore.getState().signIn(() => {});

  useStore.getState().send(REMOTE_AGENT.id, "first ever");
  assert.equal(bridge.sends.length, 0);
  await sleep(500);

  assert.equal(bridge.sends.length, 1, `sent ${bridge.sends.length} times`);
  assert.equal(bridge.sends[0].sessionId, undefined);
  assert.equal(occurrences(useStore, REMOTE_AGENT.id, "first ever"), 1, "the bubble was added twice");
  assert.ok(!logs().some((l) => l.includes("not read after")), "settled, yet the timeout was logged");
});
