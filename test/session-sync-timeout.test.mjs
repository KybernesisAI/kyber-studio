import { after, test } from "node:test";
import assert from "node:assert/strict";

import { REMOTE_AGENT, captureLogs, installBridge, occurrences, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-643: a control plane that never answers must not stop someone talking
 * to an agent. After the bound the first message goes out, on a new thread
 * because there is nothing else to go on, and the log says so: that is the one
 * exit where a new thread is started knowingly.
 */
const bridge = installBridge({ hang: ["listSessions"] });
const { useStore, setDirectoryWaitForTests } = await import("@/lib/store");
setDirectoryWaitForTests(150);

after(() => window.close());

test("a directory that never answers: after the bound the first message goes out once, on a new thread, and the log says why", async (t) => {
  const logs = captureLogs(t);
  await useStore.getState().signIn(() => {});

  useStore.getState().send(REMOTE_AGENT.id, "anyone there?");
  await sleep(50);
  assert.equal(bridge.sends.length, 0, "sent before the bound");
  assert.equal(useStore.getState().directoryLoading, true);

  await sleep(400);

  assert.equal(bridge.sends.length, 1, `sent ${bridge.sends.length} times`);
  assert.equal(bridge.sends[0].sessionId, undefined, "there was no thread to go on, yet it named one");
  assert.equal(occurrences(useStore, REMOTE_AGENT.id, "anyone there?"), 1, "the message was lost or shown twice");
  assert.ok(
    logs().some((l) => l.includes("thread directory not read after") && l.includes("starts a new thread")),
    `the timeout exit was not logged: ${JSON.stringify(logs())}`,
  );
});
