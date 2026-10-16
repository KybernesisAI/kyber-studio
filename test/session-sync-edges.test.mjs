import { after, test } from "node:test";
import assert from "node:assert/strict";

import { REMOTE_AGENT, captureLogs, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643, review round 2: the two ways the directory pass ends without a
 * row to adopt, other than a timeout. Both must open the gate promptly, not
 * hold "Loading messages…" and every first message for the full bound.
 *
 * One module, so the second test signs in again after the first.
 */
const bridge = installBridge({ agents: [], delays: { listAgents: 20 } });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("an account with no agents granted: the gate opens without a directory read", async (t) => {
  const logs = captureLogs(t);
  await useStore.getState().signIn(() => {});
  await sleep(150);
  assert.equal(useStore.getState().directoryLoading, false, "\"Loading messages\" stays up with no agent to load for");
  assert.ok(logs().some((l) => l === "[index] sync skipped — no agents granted to this account"));
  assert.equal(bridge.calls.filter((c) => c === "listSessions").length, 0);
});

test("a directory read that rejects: the failure is logged, the gate opens, and the first message goes out without waiting the bound", async (t) => {
  await useStore.getState().signOut();
  const failing = installBridge({ fail: ["listSessions"], delays: { listSessions: 50 } });
  const logs = captureLogs(t);
  await useStore.getState().signIn(() => {});
  await sleep(200);

  assert.ok(logs().some((l) => l.startsWith("[index] sync failed: listSessions failed")), `not logged: ${JSON.stringify(logs())}`);
  assert.equal(useStore.getState().directoryLoading, false, "a failed read left the gate shut");

  useStore.getState().send(REMOTE_AGENT.id, "after a failed read");
  await sleep(100);
  assert.equal(failing.sends.length, 1, "the message waited on a gate that a failed read should have opened");
  assert.equal(failing.sends[0].sessionId, undefined);
  assert.ok(!logs().some((l) => l.includes("not read after")));
});
