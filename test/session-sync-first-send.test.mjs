import { after, test } from "node:test";
import assert from "node:assert/strict";

import { OLD_THREAD, REMOTE_AGENT, captureLogs, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643: a first message sent while the directory is still being read must
 * go to the thread the directory names, not start a new one. A new one becomes
 * the account's newest, and every other device then moves onto it.
 *
 * The directory is slow here (400 ms) and the message is sent the moment
 * sign-in returns, so the read is certainly still in flight.
 */
const bridge = installBridge({ delays: { listSessions: 400, listAgents: 20 } });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("a first message during the directory read waits, then goes to the adopted thread, after its history", async (t) => {
  const logs = captureLogs(t);
  await useStore.getState().signIn(() => {});

  useStore.getState().send(REMOTE_AGENT.id, "hello again");
  // Shown at once, though not yet sent.
  assert.ok(
    (useStore.getState().conversations[REMOTE_AGENT.id] ?? []).some((b) => b.text === "hello again"),
    "the message was not shown while it waited",
  );
  assert.equal(bridge.sends.length, 0, "the message went out before the directory was read");

  await sleep(900);

  assert.equal(bridge.sends.length, 1, `sent ${bridge.sends.length} times`);
  assert.equal(bridge.sends[0].sessionId, OLD_THREAD.sessionId, "the first message started a new thread");
  const texts = (useStore.getState().conversations[REMOTE_AGENT.id] ?? []).map((b) => b.text);
  assert.deepEqual(
    texts.slice(0, 2),
    [`history of ${OLD_THREAD.sessionId}`, "hello again"],
    `the message was lost or duplicated by adoption: ${JSON.stringify(texts)}`,
  );
  assert.ok(logs().some((l) => l.startsWith("[send] waiting for the thread directory")));
});
