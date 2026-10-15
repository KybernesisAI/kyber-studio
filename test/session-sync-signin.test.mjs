import { after, test } from "node:test";
import assert from "node:assert/strict";

import { OLD_THREAD, REMOTE_AGENT, captureLogs, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643. A FRESH sign-in (every first run, every wiped config) used to read
 * the account's thread directory once, before the agents had loaded, and then
 * never again: `signIn` did not start the cross-device refresh that
 * `bootstrap` does. With the directory answering first, every row matched no
 * agent, the thread was not adopted, and the first message started a new one.
 * Measured on main at b93af34: one read, nothing adopted.
 */
const bridge = installBridge({ delays: { listSessions: 50, listAgents: 300 } });
const { useStore } = await import("@/lib/store");

after(() => window.close());

test("signIn: the directory answering before the agents still adopts the account's thread, and focus reads it again", async (t) => {
  const logs = captureLogs(t);

  assert.equal(await useStore.getState().signIn(() => {}), true);
  await sleep(600);

  const state = useStore.getState();
  assert.equal(state.sessions[REMOTE_AGENT.id], OLD_THREAD.sessionId, "the account's thread was not adopted");
  assert.deepEqual(
    (state.conversations[REMOTE_AGENT.id] ?? []).map((b) => b.text),
    [`history of ${OLD_THREAD.sessionId}`],
    "the adopted thread's history was not replayed",
  );

  const reads = () => bridge.calls.filter((c) => c === "listSessions").length;
  const before = reads();
  window.dispatchEvent(new window.Event("focus"));
  await sleep(200);
  assert.equal(reads(), before + 1, "focus did not read the directory again: the refresh never started");

  const summary = logs().find((l) => l.startsWith("[index] sync: "));
  assert.ok(summary, `no summary line: ${JSON.stringify(logs())}`);
  assert.match(summary, /1 row\(s\); 1 for an agent here, 1 adopted/);
});
