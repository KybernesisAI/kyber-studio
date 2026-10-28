import { after, test } from "node:test";
import assert from "node:assert/strict";

import { captureLogs, installBridge, occurrences, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643, review round 2: sign out of one account and into ANOTHER in the
 * same window. Sign-out leaves the first account's agents in the store. A
 * directory pass that starts while the second account's agents are still
 * loading (here, a focus event) must not resolve the second account's threads
 * against the first account's agents and call the directory read: if it did,
 * the gate would open early and a first message would start a new thread.
 */
const A_AGENT = { id: "a-agent", name: "a", url: "https://a.example" };
const B_AGENT = { id: "b-agent", name: "b", url: "https://b.example" };
const B_THREAD = { agent: "b", sessionId: "wrun_B", label: "b-agent", lastMessageAt: "2026-10-10T10:00:00.000Z" };

const delays = { listSessions: 10, listAgents: 10 };
const bridge = installBridge({ delays, agents: [A_AGENT], rows: [] });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("a different account in the same window: a pass during its agent load does not open its gate, and its thread is adopted", async (t) => {
  const logs = captureLogs(t);
  await useStore.getState().signIn(() => {});
  await sleep(100);
  assert.equal(useStore.getState().directoryLoading, false, "the first account's gate never settled");
  await useStore.getState().signOut();

  // Account B: other agents, a thread with one of them, and a slow agent list.
  bridge.live.agents = [B_AGENT];
  bridge.live.rows = [B_THREAD];
  delays.listAgents = 400;
  delays.listSessions = 300;
  const signingIn = useStore.getState().signIn(() => {});

  // While B's agents load, the store still holds A's.
  await sleep(50);
  assert.deepEqual(useStore.getState().agents.map((a) => a.id), [A_AGENT.id]);
  window.dispatchEvent(new window.Event("focus"));

  // Past where that pass would have read B's directory (~350 ms), and before
  // B's own read lands (~700 ms).
  await sleep(450);
  assert.equal(useStore.getState().directoryLoading, true, "a pass against the previous account's agents opened this gate");

  useStore.getState().send(B_AGENT.id, "hello b");
  assert.equal(bridge.sends.length, 0, "the first message went out before B's directory was read");

  assert.equal(await signingIn, true);
  await sleep(700);

  const toB = bridge.sends.filter((s) => s.text === "hello b");
  assert.equal(toB.length, 1, `sent ${toB.length} times`);
  assert.equal(toB[0].sessionId, B_THREAD.sessionId, "the first message started a new thread");
  assert.equal(useStore.getState().sessions[B_AGENT.id], B_THREAD.sessionId, "B's thread was not adopted");
  assert.equal(occurrences(useStore, B_AGENT.id, "hello b"), 1);
  assert.equal(useStore.getState().directoryLoading, false);
  assert.ok(logs().some((l) => l === "[index] sync skipped — agents not loaded yet"), "the early pass was not skipped");
});
