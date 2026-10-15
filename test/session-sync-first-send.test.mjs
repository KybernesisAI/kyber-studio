import { after, test } from "node:test";
import assert from "node:assert/strict";

import { OLD_THREAD, REMOTE_AGENT, captureLogs, installBridge, occurrences, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643: a first message sent while the directory is still being read must
 * go to the thread the directory names, not start a new one. A new one becomes
 * the account's newest, and every other device then moves onto it.
 *
 * The directory is slow here (400 ms) and the messages are sent the moment
 * sign-in returns, so the read is certainly still in flight. Two are sent, to
 * show they come out once each and in order.
 */
const bridge = installBridge({ delays: { listSessions: 400, listAgents: 20 } });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("messages sent during the directory read wait, then go to the adopted thread, once each, after its history", async (t) => {
  const logs = captureLogs(t);
  await useStore.getState().signIn(() => {});

  useStore.getState().send(REMOTE_AGENT.id, "hello again");
  useStore.getState().send(REMOTE_AGENT.id, "and another");
  // Shown at once, though not yet sent.
  assert.equal(occurrences(useStore, REMOTE_AGENT.id, "hello again"), 1, "the message was not shown while it waited");
  assert.equal(bridge.sends.length, 0, "a message went out before the directory was read");

  await sleep(900);

  assert.ok(bridge.sends.length >= 1, "nothing was sent");
  assert.equal(bridge.sends[0].text, "hello again", "the first message did not go first");
  for (const sent of bridge.sends) {
    assert.equal(sent.sessionId, OLD_THREAD.sessionId, `"${sent.text}" started a new thread`);
  }
  assert.equal(bridge.sends.filter((s) => s.text === "hello again").length, 1, "the first message was sent twice");
  assert.ok(bridge.sends.filter((s) => s.text === "and another").length <= 1, "the second message was sent twice");

  const texts = (useStore.getState().conversations[REMOTE_AGENT.id] ?? []).map((b) => b.text);
  assert.equal(texts[0], `history of ${OLD_THREAD.sessionId}`, `the history is not first: ${JSON.stringify(texts)}`);
  assert.equal(occurrences(useStore, REMOTE_AGENT.id, "hello again"), 1, `lost or duplicated: ${JSON.stringify(texts)}`);
  assert.equal(occurrences(useStore, REMOTE_AGENT.id, "and another"), 1, `lost or duplicated: ${JSON.stringify(texts)}`);
  assert.ok(texts.indexOf("hello again") < texts.indexOf("and another"), `out of order: ${JSON.stringify(texts)}`);
  assert.ok(logs().some((l) => l.startsWith("[send] waiting for the thread directory")));
  assert.ok(!logs().some((l) => l.includes("not read after")), "the wait timed out");
});
