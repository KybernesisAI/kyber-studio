import { after, test } from "node:test";
import assert from "node:assert/strict";

import { captureLogs, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-644: an agent-list request that is still on its way when its sign-in
 * ends must not land on the next one. Account A signs in with a slow
 * `listAgents`, signs out before it answers, and account B signs in through a
 * whole sign-in and loads its own list first. When A's answer finally lands,
 * B's list, B's selected agent and B's sign-in screen state must be untouched.
 *
 * Both cases run in one file, in order, against one copy of the store: the
 * second starts from the first's signed-in B.
 */
const A_AGENT = { id: "a-agent", name: "a", url: "https://a.example" };
const B_AGENT = { id: "b-agent", name: "b", url: "https://b.example" };
const B_THREAD = { agent: "b", sessionId: "wrun_B", label: "b-agent", lastMessageAt: "2026-10-10T10:00:00.000Z" };

/** Longer than the whole of B's sign-in below, which takes tens of ms. */
const SLOW = 600;
const FAST = 20;

const bridge = installBridge({ agents: [], rows: [] });
const { useStore } = await import("@/lib/store");

after(() => window.close());

const agentIds = () => useStore.getState().agents.map((a) => a.id);
const agentCalls = () => bridge.calls.filter((c) => c === "listAgents").length;

/**
 * Sign in as an account whose agent list is `firstAgents` and slow, sign out
 * before it answers, then sign in as B. Returns A's sign-in, still running,
 * wrapped: an async function returning the promise itself would wait for it.
 */
async function slowAccountThenB(firstAgents) {
  await useStore.getState().signOut();
  bridge.live.agents = firstAgents;
  bridge.live.rows = [];
  bridge.live.delays.listAgents = SLOW;
  const before = agentCalls();
  const first = useStore.getState().signIn(() => {});
  let landed = false;
  void first.finally(() => {
    landed = true;
  });
  await sleep(50);
  assert.equal(agentCalls(), before + 1, "the first account's agent list was never asked for");

  await useStore.getState().signOut();
  bridge.live.agents = [B_AGENT];
  bridge.live.rows = [B_THREAD];
  bridge.live.delays.listAgents = FAST;
  assert.equal(await useStore.getState().signIn(() => {}), true);
  await sleep(50);

  // B's own list is in place before the stale one lands, or the test proves nothing.
  assert.equal(landed, false, "the first account's list landed too early, so nothing was tested");
  assert.deepEqual(agentIds(), [B_AGENT.id], "B's agents had not loaded");
  assert.equal(useStore.getState().activeAgentId, B_AGENT.id);
  return { first };
}

test("a slow agent list from a previous sign-in does not replace the next account's agents", async (t) => {
  const logs = captureLogs(t);
  const { first } = await slowAccountThenB([A_AGENT]);

  await first; // A's sign-in finishes once its list has landed
  await sleep(50);

  assert.deepEqual(agentIds(), [B_AGENT.id], "A's late agent list replaced B's");
  assert.equal(useStore.getState().activeAgentId, B_AGENT.id, "A's late agent list moved B onto A's agent");
  assert.ok(
    logs().some((l) => l === "[agents] stale agent list dropped: the sign-in changed while it loaded"),
    "the stale list was not reported as dropped",
  );
});

test("an empty agent list from a previous sign-in does not empty the next account's list", async (t) => {
  const logs = captureLogs(t);
  const { first } = await slowAccountThenB([]);
  assert.equal(useStore.getState().authError, null);

  await first;
  await sleep(50);

  assert.deepEqual(agentIds(), [B_AGENT.id], "A's late empty list emptied B's");
  assert.equal(useStore.getState().activeAgentId, B_AGENT.id);
  assert.equal(useStore.getState().authError, null, "B was told it has no agents");
  assert.ok(logs().some((l) => l === "[agents] stale agent list dropped: the sign-in changed while it loaded"));
});
