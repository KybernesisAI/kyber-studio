import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { REMOTE_AGENT, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * Reopening a thread from the drawer must not read its history in as new turns.
 *
 * Opening a thread clears its stream cursor. The live watch used to start at
 * once from event 0, before the replay had set the cursor, and took the whole
 * session in as fresh turns stamped with the time they arrived: the thread's
 * first answer showed up at the bottom, with no question above it.
 */

const ID = REMOTE_AGENT.id;
installBridge({ rows: [], delays: { replaySession: 60 } });
const watches = [];
const bridge = window.studio;
window.studio = new Proxy(bridge, {
  get: (target, key) =>
    key === "watch"
      ? async (input) => {
          watches.push(input);
        }
      : target[key],
});
const { useStore } = await import("@/lib/store");

after(() => window.close());

before(async () => {
  await useStore.getState().signIn(() => {});
  await sleep(150);
  useStore.setState({ activeAgentId: ID });
});

test("a reopened thread is replayed first, then watched from where the replay ended", async () => {
  watches.length = 0;
  const opening = useStore.getState().openSession(ID, "wrun_REOPENED");
  // Whatever asks for a watch while the replay is still in flight.
  useStore.getState().watchActive();
  await opening;
  await sleep(100);
  const mine = watches.filter((w) => w.sessionId === "wrun_REOPENED");
  assert.ok(mine.length >= 1, "the thread is watched once its replay is in");
  assert.ok(mine.every((w) => w.streamIndex === 7), `watched from ${mine.map((w) => w.streamIndex).join(", ")}, not from the replay's end`);
  const texts = (useStore.getState().conversations[ID] ?? []).map((b) => b.text);
  assert.deepEqual(texts, ["history of wrun_REOPENED"]);
});
