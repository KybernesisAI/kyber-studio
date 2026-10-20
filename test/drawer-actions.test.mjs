import { before, after, test } from "node:test";
import assert from "node:assert/strict";

import { REMOTE_AGENT, captureLogs, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-649, PR 2: the drawer's own actions, through the real store and a fake
 * bridge.
 *
 * - Archive is this machine's choice: it calls nothing on the agent, survives
 *   a relaunch, and can be undone (AC2).
 * - Archived and ended are separate axes (AC6): the store remembers each
 *   thread's lifecycle whatever filter it was listed under, and ending a thread
 *   never archives it.
 * - A thread the agent reports ended cannot be sent into (AC3b).
 * - A list on screen asks the agent again after this client's own send and
 *   End, and on the cross-device tick; a hidden one does not (AC9).
 */

const ID = REMOTE_AGENT.id;

const thread = (id, status, title = `title ${id}`) => ({
  id,
  title,
  surface: "chat",
  trigger: "http",
  status,
  createdAt: "2026-10-19T07:00:00.000Z",
  updatedAt: "2026-10-20T08:00:00.000Z",
});
const LIVE = thread("wrun_LIVE", "alive");
const ENDED = thread("wrun_ENDED", "ended");
const FAILED = thread("wrun_FAILED", "failed");

const bridge = installBridge({ rows: [], agentSessions: [LIVE, ENDED, FAILED] });
const { useStore, isRetired, sessionsPath } = await import("@/lib/store");

after(() => window.close());

before(async () => {
  await useStore.getState().signIn(() => {});
  await sleep(150);
  assert.equal(useStore.getState().directoryLoading, false, "the directory gate never settled");
  useStore.setState({ activeAgentId: ID });
});

/** Calls to the agent made since `mark`, as `manage:<path>` / `reset` / `send`. */
function agentCallsSince(mark) {
  return {
    manage: bridge.calls.slice(mark.calls).filter((c) => c.startsWith("manage:")),
    resets: bridge.resets.slice(mark.resets),
    sends: bridge.sends.slice(mark.sends),
  };
}
const mark = () => ({ calls: bridge.calls.length, resets: bridge.resets.length, sends: bridge.sends.length });
/**
 * The drawer's OWN listing, under its Active filter. Every settled turn also
 * lists ALL threads through `loadAgentInfo` (the manifest watch), whatever is
 * on screen; that predates KYB-649 and is not what AC9 is about, so it is not
 * counted — a test that counted it would pass with the AC9 hooks removed.
 */
const listings = (calls) => calls.filter((c) => c === `manage:${sessionsPath("active")}`);

function freshState(panel = "none") {
  useStore.setState((s) => ({
    panel,
    prefs: { [ID]: { threadFilter: "active" } },
    threadIndex: {},
    sessions: { ...s.sessions, [ID]: undefined },
    sessionChoice: {},
    inflight: { ...s.inflight, [ID]: undefined },
    conversations: { ...s.conversations, [ID]: [] },
  }));
}

test("AC2: archive calls nothing on the agent, is saved to disk, and unarchive undoes it", async () => {
  freshState();
  const m = mark();

  useStore.getState().archiveThread(ID, LIVE.id);
  await sleep(20);
  assert.deepEqual(useStore.getState().prefs[ID]?.archived, [LIVE.id]);
  assert.deepEqual(bridge.live.saved["conversations.json"]?.prefs?.[ID]?.archived, [LIVE.id], "the archive was not saved");

  useStore.getState().unarchiveThread(ID, LIVE.id);
  await sleep(20);
  assert.deepEqual(useStore.getState().prefs[ID]?.archived, []);
  assert.deepEqual(bridge.live.saved["conversations.json"]?.prefs?.[ID]?.archived, [], "the unarchive was not saved");

  const out = agentCallsSince(m);
  assert.deepEqual(out.manage, [], `archiving called the agent: ${out.manage.join(", ")}`);
  assert.equal(out.resets.length, 0, "archiving ended a conversation");
  assert.equal(out.sends.length, 0);
});

test("AC2: archiving twice keeps one entry, and archiving does not touch other agents' lists", () => {
  freshState();
  useStore.setState((s) => ({ prefs: { ...s.prefs, other: { archived: ["x"] } } }));
  useStore.getState().archiveThread(ID, LIVE.id);
  useStore.getState().archiveThread(ID, LIVE.id);
  assert.deepEqual(useStore.getState().prefs[ID]?.archived, [LIVE.id]);
  assert.deepEqual(useStore.getState().prefs.other?.archived, ["x"]);
});

test("AC6: a thread's lifecycle is remembered whatever filter listed it, and Active does not forget an ended one", async () => {
  freshState();
  await useStore.getState().loadSessions(ID, "active");
  assert.equal(useStore.getState().threadIndex[ID]?.[ENDED.id], undefined, "Active listed an ended thread");
  assert.equal(useStore.getState().threadIndex[ID]?.[LIVE.id]?.status, "alive");

  await useStore.getState().loadSessions(ID, "all");
  await useStore.getState().loadSessions(ID, "active");
  const index = useStore.getState().threadIndex[ID] ?? {};
  assert.equal(index[ENDED.id]?.status, "ended");
  assert.equal(index[FAILED.id]?.status, "failed");
  // Knowing a thread ended says nothing about whether the person archived it.
  assert.equal(useStore.getState().prefs[ID]?.archived, undefined, "listing threads archived something");
});

test("AC6: ending a thread does not archive it", async () => {
  freshState();
  await useStore.getState().loadSessions(ID, "all");
  useStore.getState().endConversation(ID, LIVE.id);
  await sleep(20);
  assert.equal(useStore.getState().prefs[ID]?.archived, undefined, "End archived the thread");
});

test("isRetired: ended and failed are retired; alive and unknown are not", () => {
  assert.equal(isRetired(ENDED), true);
  assert.equal(isRetired(FAILED), true);
  assert.equal(isRetired(LIVE), false);
  assert.equal(isRetired(undefined), false, "a thread not yet listed must not lock the composer");
});

test("AC3b: a message cannot be sent into a thread the agent reports ended — through any path into send", async (t) => {
  freshState();
  await useStore.getState().loadSessions(ID, "all");
  await useStore.getState().openSession(ID, ENDED.id);
  const logs = captureLogs(t);
  const m = mark();

  useStore.getState().send(ID, "into the ended thread");
  await sleep(50);

  assert.equal(agentCallsSince(m).sends.length, 0, "a message was sent into an ended thread");
  assert.ok(logs().some((l) => l.includes("[send] refused")), "the refusal was not logged");
});

test("AC3b: a thread ended from here is read-only straight away, before the agent is asked again", async () => {
  freshState();
  await useStore.getState().loadSessions(ID, "all");
  bridge.live.agentSessions = [LIVE, ENDED, FAILED]; // the agent has not caught up yet
  useStore.getState().endConversation(ID, LIVE.id);
  await sleep(20);
  assert.equal(useStore.getState().threadIndex[ID]?.[LIVE.id]?.status, "ended");

  await useStore.getState().openSession(ID, LIVE.id);
  const m = mark();
  useStore.getState().send(ID, "after End");
  await sleep(50);
  assert.equal(agentCallsSince(m).sends.length, 0, "a message went into the thread just ended");
});

test("AC3b: with the drawer open, the refresh after End does not reopen the thread when the agent has not caught up", async () => {
  freshState("conversations");
  await useStore.getState().loadSessions(ID, "all");
  // The agent still lists it alive, as it may for a moment after the reset.
  useStore.getState().endConversation(ID, LIVE.id);
  await sleep(50);
  assert.ok(bridge.calls.includes(`manage:${sessionsPath("active")}`), "the drawer was not refreshed after End");
  assert.equal(useStore.getState().threadIndex[ID]?.[LIVE.id]?.status, "ended", "a stale listing reopened the ended thread");
});

test("AC3b control: a live thread still sends", async () => {
  freshState();
  await useStore.getState().loadSessions(ID, "all");
  await useStore.getState().openSession(ID, LIVE.id);
  const m = mark();
  useStore.getState().send(ID, "into the live thread");
  await sleep(50);
  const out = agentCallsSince(m).sends;
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, LIVE.id);
});

for (const panel of ["conversations", "overview"]) {
  test(`AC9 (${panel}): this client's send, End and the cross-device tick each ask for the list again`, async () => {
    freshState(panel);

    let m = mark();
    useStore.getState().send(ID, "a new topic");
    await sleep(100);
    assert.ok(listings(agentCallsSince(m).manage).length >= 1, "a send did not refresh the list on screen");

    m = mark();
    useStore.getState().endConversation(ID, "wrun_NEW");
    await sleep(50);
    assert.ok(listings(agentCallsSince(m).manage).length >= 1, "an End did not refresh the list on screen");

    m = mark();
    await useStore.getState().refreshFromOthers();
    await sleep(20);
    assert.ok(listings(agentCallsSince(m).manage).length >= 1, "the cross-device tick did not refresh the list on screen");
  });
}

test("AC9: a new thread refreshes the list when its first turn starts, not only when the reply ends", async () => {
  freshState("conversations");
  const realSend = window.studio.send;
  let turn;
  // A reply that has not come back yet: only the turn event has arrived.
  window.studio.send = (input) => {
    bridge.sends.push(input);
    return new Promise((resolve) => {
      turn = { input, resolve };
    });
  };
  try {
    useStore.getState().send(ID, "a long question");
    await sleep(50);
    assert.ok(turn, "the send never reached the bridge");
    const m = mark();
    bridge.live.emit.turn?.({ streamId: turn.input.streamId, sessionId: "wrun_STARTED", turnId: "t1" });
    await sleep(20);
    assert.ok(listings(agentCallsSince(m).manage).length >= 1, "the first turn of a new thread did not refresh the list");
    turn.resolve({ sessionId: "wrun_STARTED", streamIndex: 3, reply: "done" });
    await sleep(50);
  } finally {
    window.studio.send = realSend;
  }
});

test("AC9 control: with no list on screen, none of those asks the agent for its list", async () => {
  freshState("settings");
  const m = mark();
  useStore.getState().send(ID, "nobody is looking at the list");
  await sleep(100);
  useStore.getState().endConversation(ID, "wrun_NEW");
  await sleep(50);
  await useStore.getState().refreshFromOthers();
  await sleep(20);
  assert.deepEqual(listings(agentCallsSince(m).manage), [], "a hidden list was refreshed");
});
