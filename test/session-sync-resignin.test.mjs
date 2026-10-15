import { after, test } from "node:test";
import assert from "node:assert/strict";

import { OLD_THREAD, REMOTE_AGENT, captureLogs, installBridge, occurrences, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643, review round 1: sign in, type a first message, sign out while it is
 * waiting, sign in again, all in ONE window (one module). The message written
 * under the first sign-in must not go out under the second, a directory pass
 * started under the first must not settle the second's gate, and the second
 * sign-in must read the directory itself (`startCrossDeviceRefresh` reads on
 * every sign-in, not just the first in a window).
 */
const delays = { listSessions: 300, listAgents: 10 };
const bridge = installBridge({ delays });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("sign out during the wait, then sign in again: the old message is not sent, and the new sign-in reads the directory", async (t) => {
  const logs = captureLogs(t);
  await useStore.getState().signIn(() => {});
  useStore.getState().send(REMOTE_AGENT.id, "typed before sign-out");
  await sleep(20);
  await useStore.getState().signOut();
  // The second sign-in's read is slower, so the first one's (in flight since
  // the first sign-in, landing at ~300 ms) finishes while this gate is open.
  delays.listSessions = 900;
  await useStore.getState().signIn(() => {});

  await sleep(500);
  assert.equal(useStore.getState().directoryLoading, true, "the previous sign-in's pass settled this one's gate");

  await sleep(900);

  assert.equal(
    bridge.sends.filter((s) => s.text === "typed before sign-out").length,
    0,
    "a message from the previous sign-in went out under this one",
  );
  assert.equal(bridge.calls.filter((c) => c === "listSessions").length, 2, "the second sign-in did not read the directory");
  assert.equal(useStore.getState().directoryLoading, false, "the second sign-in's gate never settled");
  assert.equal(useStore.getState().sessions[REMOTE_AGENT.id], OLD_THREAD.sessionId, "the second sign-in did not adopt the thread");
  // Deliberate: the unsent message is not carried into the next sign-in.
  // Adopting the account's thread replaces the chat, so it is gone; sending it
  // instead would put it under a sign-in it was not written under.
  assert.equal(occurrences(useStore, REMOTE_AGENT.id, "typed before sign-out"), 0, "the unsent message is still shown");
  assert.ok(logs().some((l) => l.includes("sync dropped")), "the stale pass was not dropped");
  assert.ok(logs().some((l) => l.includes("not sent: the sign-in ended")), "the stale message was not reported");
});
