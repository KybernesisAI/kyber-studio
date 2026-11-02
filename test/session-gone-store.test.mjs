import { after, before, test } from "node:test";
import assert from "node:assert/strict";

import { REMOTE_AGENT, captureLogs, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-657: a conversation the agent no longer has.
 *
 * Since eve 0.80 a private conversation's history is deleted when its run
 * ends, and every read of it is refused with 410 `session_expired`. Studio used
 * to treat that like a stream that had merely closed: re-read, re-watch, at
 * once, for ever (1,901 watches in one 28 Oct log). Driven through the real
 * renderer store and a fake bridge whose watch and replay can be told to
 * refuse a session.
 */

const ID = REMOTE_AGENT.id;
const DEAD = "wrun_DEAD";
const ALIVE = "wrun_ALIVE";

const { live, sends } = installBridge({ rows: [], agentSessions: [] });
const watches = [];
const unwatches = [];
const replays = [];
/** Sessions whose reads the agent refuses, and how. */
const gone = new Map();
let thread = null;
let emitLive = null;
/** While set, every history read waits for it: the moment a read is in flight. */
let replayGate = null;
/** While set, the agent answers a send on this conversation, as when it had ended the one sent into. */
let sendAs = null;
const bridge = window.studio;
window.studio = new Proxy(bridge, {
  get: (target, key) => {
    if (key === "watch") return async (input) => void watches.push(input);
    if (key === "unwatch") return async (streamId) => void unwatches.push(streamId);
    if (key === "onLive") return (cb) => void (emitLive = cb);
    if (key === "replaySession")
      return async (input) => {
        replays.push(input.sessionId);
        if (replayGate) await replayGate;
        if (gone.has(input.sessionId)) return { gone: gone.get(input.sessionId) };
        return target.replaySession(input);
      };
    if (key === "send" && sendAs)
      return async (input) => {
        sends.push(input);
        return { sessionId: sendAs, streamIndex: 9, reply: "OK" };
      };
    if (key === "manage")
      return async (input) => {
        if (input.path === "/thread" && thread) return { ok: true, status: 200, data: thread };
        return target.manage(input);
      };
    return target[key];
  },
});
const { useStore, readOnlyReason } = await import("@/lib/store");

after(() => window.close());

before(async () => {
  await useStore.getState().signIn(() => {});
  await sleep(150);
});

/** The agent's chat as one person left it: a local transcript, on a held conversation. */
function holding(sessionId, extra = {}) {
  useStore.setState((s) => ({
    activeAgentId: ID,
    sessions: { ...s.sessions, [ID]: sessionId },
    streamIndexes: { ...s.streamIndexes, [ID]: 107 },
    conversations: { ...s.conversations, [ID]: [{ kind: "text", id: "u1", role: "user", text: "hello", at: 1 }] },
    sessionChoice: { ...s.sessionChoice, [ID]: undefined },
    goneSessions: {},
    threadIndex: {},
    threadCopy: {},
    ...extra,
  }));
  useStore.getState().stopWatching();
  watches.length = 0;
  unwatches.length = 0;
  replays.length = 0;
}

const saved = () => live.saved["conversations.json"];
const lastBlock = () => (useStore.getState().conversations[ID] ?? []).at(-1);

test("AC1/AC2: a watch refused because the conversation has gone is not retried, and the chat says so", async (t) => {
  const logs = captureLogs(t);
  holding(DEAD);
  gone.set(DEAD, "expired");
  useStore.getState().watchActive();
  assert.equal(watches.length, 1, "the held conversation is watched");
  const { streamId } = watches[0];

  emitLive({ streamId, kind: "gone" });
  await sleep(50);

  const st = useStore.getState();
  assert.equal(st.watching, null, "the watch is stopped");
  assert.equal(st.sessions[ID], undefined, "the dead id is no longer the chat's conversation");
  assert.equal(st.streamIndexes[ID], undefined, "nor is its cursor");
  assert.deepEqual(st.goneSessions[ID], [DEAD]);
  assert.equal(lastBlock().kind, "gone", "the chat says the conversation is no longer available");
  assert.equal(st.conversations[ID][0].text, "hello", "what was on screen stays");

  // Whatever asks next, nothing asks the agent for it again.
  useStore.getState().watchActive();
  await useStore.getState().hydrate(ID, "merge");
  await sleep(50);
  assert.equal(watches.length, 1, "not watched again");
  assert.equal(replays.filter((id) => id === DEAD).length, 0, "not read again");
  assert.equal(logs().filter((l) => l.startsWith("[gone]")).length, 1, "said once");
});

test("AC2: the saved state no longer names it, so a relaunch does not start the loop again", async () => {
  holding(DEAD);
  gone.set(DEAD, "expired");
  useStore.getState().watchActive();
  emitLive({ streamId: watches[0].streamId, kind: "gone" });
  await sleep(50);

  const file = saved();
  assert.equal(file.sessions[ID], undefined, "the saved choice is not the dead conversation");
  assert.deepEqual(file.goneSessions[ID], [DEAD], "and it is remembered as gone");
  assert.deepEqual(file.sessionChoice[ID]?.sessionId, null, "the saved choice is a new conversation");

  // Relaunch: the store is loaded from what was saved.
  live.state = structuredClone(file);
  useStore.setState({ sessions: {}, streamIndexes: {}, goneSessions: {}, conversations: {} });
  useStore.getState().stopWatching();
  watches.length = 0;
  await useStore.getState().restore();
  useStore.setState({ activeAgentId: ID });
  useStore.getState().watchActive();
  await useStore.getState().hydrate(ID);
  await sleep(50);
  assert.equal(watches.length, 0, "nothing to watch after a relaunch");
  assert.equal(lastBlock().kind, "gone", "and the chat still says why");
});

test("AC2: a history read refused at launch or on switching agent is the same signal", async () => {
  holding("wrun_LAUNCH", { streamIndexes: {}, conversations: {} });
  gone.set("wrun_LAUNCH", "expired");
  // No cursor yet: the watch reads the history first, as at launch.
  useStore.getState().watchActive();
  await sleep(100);
  assert.deepEqual(replays, ["wrun_LAUNCH"], "read once");
  assert.equal(watches.length, 0, "and never watched");
  assert.equal(useStore.getState().sessions[ID], undefined);
  assert.equal(lastBlock()?.kind, "gone");

  holding("wrun_SWITCH", { conversations: {} });
  gone.set("wrun_SWITCH", "missing");
  useStore.getState().select(ID);
  await sleep(100);
  assert.equal(useStore.getState().sessions[ID], undefined, "a 404 on select clears it too");
  assert.deepEqual(useStore.getState().goneSessions[ID], ["wrun_SWITCH"]);
});

test("AC2: a conversation refused while a turn of ours runs in it is left to the send", async () => {
  holding("wrun_INFLIGHT", { inflight: { [ID]: { streamId: "s1", sessionId: "wrun_INFLIGHT" } } });
  gone.set("wrun_INFLIGHT", "expired");
  await useStore.getState().hydrate(ID, "merge");
  await sleep(20);
  assert.equal(useStore.getState().sessions[ID], "wrun_INFLIGHT", "the send owns the session and starts a fresh one itself");
  assert.deepEqual(useStore.getState().goneSessions[ID], ["wrun_INFLIGHT"], "but it is never read again");
  useStore.setState({ inflight: {} });
});

test("AC2: a thread view still naming a gone conversation is not followed", async (t) => {
  const logs = captureLogs(t);
  holding(DEAD, { goneSessions: { [ID]: [DEAD] } });
  useStore.setState({ sessions: { [ID]: undefined } });
  thread = { current: DEAD, sessions: [], reports: [], fresh: [] };
  await useStore.getState().loadThread(ID);
  thread = null;
  assert.equal(useStore.getState().sessions[ID], undefined, "the chat does not move back onto it");
  assert.ok(logs().some((l) => l.includes("not following the thread")));
});

test("AC2: going back to a thread that still names a gone conversation does not open the dead id, and keeps the screen", async () => {
  holding(undefined, { goneSessions: { [ID]: [DEAD] }, threads: { [ID]: { current: DEAD, sessions: [], reports: [], fresh: [] } } });
  await useStore.getState().openThread(ID);
  assert.equal(useStore.getState().sessions[ID], undefined);
  assert.equal(replays.filter((id) => id === DEAD).length, 0, "and it is not read");
  assert.equal(useStore.getState().conversations[ID][0]?.text, "hello", "what was on screen stays");
  useStore.setState({ threads: {} });
});

test("KYB-662 AC1: Back to your thread after the thread's own conversation has gone keeps its only copy", async () => {
  for (const current of [DEAD, null]) {
    holding(DEAD, { threads: { [ID]: { current: DEAD, sessions: [], reports: [], fresh: [] } } });
    gone.set(DEAD, "expired");
    useStore.getState().watchActive();
    emitLive({ streamId: watches[0].streamId, kind: "gone" });
    await sleep(50);
    assert.equal(lastBlock().kind, "divider", "the thread's line is shown, not the gone notice");
    assert.equal(lastBlock().id, `afresh-${DEAD}`);
    useStore.setState({ threads: { [ID]: { current, sessions: [], reports: [], fresh: [] } } });
    await useStore.getState().openThread(ID);
    const conv = useStore.getState().conversations[ID];
    assert.ok(conv.some((b) => b.text === "hello"), `the thread's copy stays (thread names ${current})`);
    assert.deepEqual(saved().conversations[ID].filter((b) => b.text === "hello").length, 1, "and is what is saved");
  }
  gone.delete(DEAD);
  useStore.setState({ threads: {} });
});

test("AC2: the account's directory never adopts a gone conversation", async () => {
  holding(ALIVE, { goneSessions: { [ID]: [DEAD] } });
  // The person's own conversation is older than the directory's newest row.
  useStore.setState({ conversations: { [ID]: [] }, sessionChoice: {} });
  live.rows = [{ agent: "agent", sessionId: DEAD, label: ID, lastMessageAt: new Date().toISOString() }];
  await useStore.getState().syncSessions();
  live.rows = [];
  assert.equal(useStore.getState().sessions[ID], ALIVE);
});

test("stranded: a watch refused as stranded is not watched again, is not gone, and its history is still read", async (t) => {
  const logs = captureLogs(t);
  holding(ALIVE);
  useStore.getState().watchActive();
  assert.equal(watches.length, 1);
  emitLive({ streamId: watches[0].streamId, kind: "stranded" });
  await sleep(150);
  const st = useStore.getState();
  assert.deepEqual(st.goneSessions, {}, "not recorded as gone");
  assert.equal(st.sessions[ID], ALIVE, "still the conversation on screen");
  assert.ok(replays.includes(ALIVE), "its history is read");
  assert.equal(watches.length, 1, "and it is not watched again");
  assert.ok(!(st.conversations[ID] ?? []).some((b) => b.kind === "gone"), "no notice that it has gone");
  assert.ok(!logs().some((l) => l.includes("[gone]")));

  // Nothing else watches it again this launch either.
  useStore.getState().watchActive();
  assert.equal(watches.length, 1);
  await useStore.getState().hydrate(ID, "merge");
  assert.ok(replays.filter((x) => x === ALIVE).length >= 2, "read again on request");
});

/**
 * One thread per person. The thread carries on past a conversation that ended
 * in it: the next message goes to the thread's address. So the chat only says
 * "no longer available" over a conversation opened from the drawer to read,
 * and keeps that one read-only.
 */
const LIVE_THREAD = { current: ALIVE, sessions: [], reports: [], fresh: [] };
const EMPTY_THREAD = { current: null, sessions: [], reports: [], fresh: [] };
const merged = (id) => (useStore.getState().conversations[ID] ?? []).some((b) => b.text === `history of ${id}`);

/** Refuse `id` through the live watch, as an upgrade does to the conversation on screen. */
async function refuseByWatch(id) {
  gone.set(id, "expired");
  useStore.setState((s) => ({ streamIndexes: { ...s.streamIndexes, [ID]: 107 } }));
  useStore.getState().stopWatching();
  watches.length = 0;
  useStore.getState().watchActive();
  emitLive({ streamId: watches[0].streamId, kind: "gone" });
  await sleep(50);
}

test("AC2, one thread: the thread's own conversation ending is dropped quietly, and what is on screen stays", async (t) => {
  const logs = captureLogs(t);
  // On the thread, gone to through Back to your thread; then an upgrade
  // ends its conversation, and the thread names nothing.
  const OWN = "wrun_OWN_BACK";
  holding(undefined, { threads: { [ID]: { ...EMPTY_THREAD, current: OWN } } });
  await useStore.getState().openThread(ID);
  assert.equal(useStore.getState().sessions[ID], OWN);
  useStore.setState({ threads: { [ID]: EMPTY_THREAD } });
  await refuseByWatch(OWN);

  const st = useStore.getState();
  assert.equal(st.watching, null, "the watch is stopped");
  assert.equal(st.sessions[ID], undefined, "the dead id is dropped");
  assert.equal(st.sessionChoice[ID], undefined, "and the chat is on the thread, not a new conversation");
  assert.deepEqual(st.goneSessions[ID], [OWN]);
  assert.ok(st.conversations[ID].length > 0, "what was on screen stays");
  assert.ok(!st.conversations[ID].some((b) => b.kind === "gone"), "with no notice");
  useStore.getState().watchActive();
  assert.equal(watches.length, 1, "not watched again");
  assert.equal(logs().filter((l) => l.startsWith("[gone]")).length, 1);
  useStore.setState({ threads: {} });
});

test("AC2, one thread: the thread's conversation picked in the drawer is still the thread's, and ends quietly", async () => {
  // Picked by its row rather than Back to your thread, while the thread named it.
  const OWN = "wrun_OWN_ROW";
  holding(ALIVE, { threads: { [ID]: { ...EMPTY_THREAD, current: OWN } } });
  await useStore.getState().openSession(ID, OWN);
  assert.equal(useStore.getState().sessionChoice[ID]?.fromDrawer, undefined, "not recorded as a drawer pick");
  useStore.setState({ threads: { [ID]: EMPTY_THREAD } });
  await refuseByWatch(OWN);
  const st = useStore.getState();
  assert.equal(st.sessions[ID], undefined);
  assert.ok(!st.conversations[ID].some((b) => b.kind === "gone"), "no notice");
  assert.ok(merged(OWN), "and its copy stays on screen");
  useStore.setState({ threads: {} });
});

test("AC2, one thread: a notice put up before the thread was first read is taken down when it is", async () => {
  // At launch the watch can be refused before the thread is read, so the
  // agent is not yet known to keep one.
  holding(DEAD, { threads: {} });
  await refuseByWatch(DEAD);
  assert.equal(lastBlock().kind, "gone");
  assert.equal(useStore.getState().sessionChoice[ID]?.sessionId, null);

  thread = EMPTY_THREAD;
  await useStore.getState().loadThread(ID);
  thread = null;
  const st = useStore.getState();
  assert.ok(!st.conversations[ID].some((b) => b.kind === "gone"), "the notice is gone");
  assert.equal(st.conversations[ID][0].text, "hello", "the transcript is not");
  assert.equal(st.sessionChoice[ID], undefined, "and the chat is on the thread, not a new conversation");
  useStore.setState({ threads: {} });
});

test("AC2, one thread: a gone conversation opened from the drawer stays on screen with the notice, and the thread does not pull the chat away", async () => {
  holding(ALIVE, { threads: { [ID]: LIVE_THREAD } });
  gone.set(DEAD, "expired");
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);

  let st = useStore.getState();
  assert.equal(st.sessions[ID], DEAD, "the chat stays on the conversation the person opened");
  assert.deepEqual(st.goneSessions[ID], [DEAD]);
  assert.equal(st.conversations[ID].length, 1, "nothing of it is on this device");
  assert.equal(lastBlock().kind, "gone", "so the chat says why");

  thread = LIVE_THREAD;
  await useStore.getState().loadThread(ID);
  thread = null;
  st = useStore.getState();
  assert.equal(st.sessions[ID], DEAD, "a thread refresh does not move the chat back to the thread");
  assert.equal(lastBlock().kind, "gone", "nor take the notice down");
  assert.ok(!merged(ALIVE), "nor mix the thread into it");
  useStore.getState().watchActive();
  assert.equal(watches.filter((w) => w.sessionId === DEAD).length, 0, "and it is never watched");

  // Back to your thread: the thread's live conversation comes back.
  await useStore.getState().openThread(ID);
  st = useStore.getState();
  assert.equal(st.sessions[ID], ALIVE);
  assert.ok(!st.conversations[ID].some((b) => b.kind === "gone"), "the notice belonged to the other conversation");
  useStore.setState({ threads: {} });
});

test("AC2, one thread: a drawer pick the thread view lists as an earlier session gets the notice too", async () => {
  const listed = { ...LIVE_THREAD, sessions: [{ id: DEAD, at: "2026-10-27T10:00:00.000Z" }] };
  holding(ALIVE, { threads: { [ID]: listed } });
  gone.set(DEAD, "expired");
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  assert.equal(useStore.getState().sessions[ID], DEAD);
  assert.equal(lastBlock().kind, "gone");
  thread = listed;
  await useStore.getState().loadThread(ID);
  thread = null;
  assert.equal(useStore.getState().sessions[ID], DEAD, "not followed away from");
  assert.equal(lastBlock().kind, "gone");
  useStore.setState({ threads: {} });
});

test("AC2, one thread: a drawer pick found gone at launch, before the thread is read, keeps its place and its notice", async () => {
  // Opened from the drawer while it was live and read: its copy is on screen
  // and the choice was saved as a drawer pick. Then an upgrade, and a relaunch.
  holding(DEAD, { threads: {}, sessionChoice: { [ID]: { sessionId: DEAD, at: 1, fromDrawer: true } } });
  await refuseByWatch(DEAD);
  let st = useStore.getState();
  assert.equal(st.sessions[ID], DEAD, "the hold is kept");
  assert.equal(st.sessionChoice[ID]?.fromDrawer, true, "and so is the choice");
  assert.equal(lastBlock().kind, "gone");

  thread = LIVE_THREAD;
  await useStore.getState().loadThread(ID);
  thread = null;
  st = useStore.getState();
  assert.equal(st.sessions[ID], DEAD, "the thread does not pull the chat away");
  assert.equal(lastBlock().kind, "gone", "the notice stays");
  assert.ok(!merged(ALIVE), "and the thread is not mixed into its copy");
  assert.equal(st.conversations[ID][0].text, "hello", "which stays");
  useStore.setState({ threads: {} });
});

test("AC2, one thread: a conversation already known gone, opened from the drawer again, says why it is empty", async () => {
  holding(ALIVE, { threads: { [ID]: LIVE_THREAD }, goneSessions: { [ID]: [DEAD] } });
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  assert.equal(replays.filter((id) => id === DEAD).length, 0, "not asked for again");
  assert.equal(useStore.getState().sessions[ID], DEAD);
  assert.equal(lastBlock()?.kind, "gone", "and the empty chat is explained");
  useStore.setState({ threads: {} });
});

test("AC2/AC4, one thread: a gone drawer pick is read-only, so its copy is not thrown away by a send", async () => {
  holding(DEAD, { threads: { [ID]: LIVE_THREAD }, sessionChoice: { [ID]: { sessionId: DEAD, at: 1, fromDrawer: true } } });
  await refuseByWatch(DEAD);
  sends.length = 0;
  useStore.getState().send(ID, "still there?");
  await sleep(100);
  assert.equal(sends.length, 0, "refused, as an ended conversation is (KYB-649)");
  const conv = useStore.getState().conversations[ID];
  assert.equal(conv[0].text, "hello", "the copy on screen stays");
  assert.equal(conv.at(-1).kind, "gone");
  useStore.setState({ threads: {} });
});

test("AC2, one thread: leaving a gone drawer pick for a thread that names nothing carries nothing of it along", async () => {
  holding(DEAD, { threads: { [ID]: EMPTY_THREAD }, sessionChoice: { [ID]: { sessionId: DEAD, at: 1, fromDrawer: true } } });
  await refuseByWatch(DEAD);
  assert.equal(lastBlock().kind, "gone");
  await useStore.getState().openThread(ID);
  const st = useStore.getState();
  assert.equal(st.sessions[ID], undefined, "on the thread");
  assert.ok(!st.conversations[ID].some((b) => b.kind === "gone" || b.text === "hello"), "nothing of the drawer pick");
  useStore.setState({ threads: {} });
});

// ---- Round 2 review findings ------------------------------------------------

test("R2-B1: the thread's own conversation listed as ended keeps the composer, sends to the thread, and keeps its copy", async () => {
  // After an upgrade: the list reports the thread's conversation ended before
  // any read was refused, and the thread names nothing.
  const OWN = "wrun_OWN_ENDED";
  holding(undefined, { threads: { [ID]: { ...EMPTY_THREAD, current: OWN } } });
  thread = { ...EMPTY_THREAD, current: OWN };
  await useStore.getState().openThread(ID);
  thread = EMPTY_THREAD;
  useStore.setState({ threads: { [ID]: EMPTY_THREAD }, threadIndex: { [ID]: { [OWN]: { id: OWN, status: "ended" } } } });
  assert.equal(readOnlyReason(useStore.getState(), ID), null, "not read-only: the thread carries on");

  await useStore.getState().openThread(ID);
  assert.ok(merged(OWN), "Back to your thread keeps the thread's own copy");

  useStore.setState({ sessions: { [ID]: OWN }, sessionChoice: { [ID]: { sessionId: OWN, at: 1 } } });
  sends.length = 0;
  useStore.getState().send(ID, "carry on");
  await sleep(100);
  assert.equal(sends.length, 1, "the message is sent");
  assert.equal(sends[0].thread, true, "to the thread");
  assert.ok(merged(OWN), "and what was on screen stays");
  thread = null;
  useStore.setState({ threads: {}, threadIndex: {} });
});

test("R2-B1: from a drawer pick the thread view lists, Back to your thread leaves it even when the thread names nothing", async () => {
  // The drawer pick was read while live, so its copy ("hello") is on screen.
  const listed = { ...EMPTY_THREAD, sessions: [{ id: DEAD, at: "2026-10-27T10:00:00.000Z" }] };
  holding(DEAD, { threads: { [ID]: listed }, sessionChoice: { [ID]: { sessionId: DEAD, at: 1, fromDrawer: true } } });
  await refuseByWatch(DEAD);
  await useStore.getState().openThread(ID);
  const st = useStore.getState();
  assert.equal(st.sessions[ID], undefined);
  assert.ok(!st.conversations[ID].some((b) => b.kind === "gone" || b.text === "hello"), "nothing of the drawer pick is left");
  useStore.setState({ threads: {} });
});

test("R2-B1: sending from the thread's own copy after the thread moved on does not throw that copy away", async () => {
  const OWN = "wrun_OWN_MOVED";
  holding(undefined, { threads: { [ID]: { ...EMPTY_THREAD, current: OWN } } });
  await useStore.getState().openThread(ID);
  useStore.setState({ threads: { [ID]: LIVE_THREAD } });
  sends.length = 0;
  useStore.getState().send(ID, "and now?");
  await sleep(100);
  assert.equal(sends.length, 1);
  assert.ok(merged(OWN), "the thread's earlier copy stays on screen");
  useStore.setState({ threads: {} });
});

test("R2-B2: a conversation refused while a turn runs in it never makes the composer read-only, and the next send goes", async () => {
  holding(DEAD, { threads: { [ID]: EMPTY_THREAD } });
  gone.set(DEAD, "expired");
  useStore.getState().stopWatching();
  watches.length = 0;
  useStore.getState().watchActive();
  // A turn of ours starts in it, and then the watch is refused.
  useStore.setState({ inflight: { [ID]: "turn" } });
  emitLive({ streamId: watches[0].streamId, kind: "gone" });
  await sleep(50);
  assert.equal(useStore.getState().sessions[ID], DEAD, "left to the send while the turn runs");
  assert.equal(readOnlyReason(useStore.getState(), ID), null, "but not read-only");
  useStore.setState({ inflight: {} });
  sends.length = 0;
  useStore.getState().send(ID, "next");
  await sleep(100);
  assert.equal(sends.length, 1, "the next message is sent");
  useStore.setState({ threads: {}, inflight: {} });
});

test("R2-B2: on an agent with many conversations, a gone id held mid-turn is not read-only either", async () => {
  holding(DEAD, { threads: { [ID]: null }, goneSessions: { [ID]: [DEAD] } });
  assert.equal(readOnlyReason(useStore.getState(), ID), null);
  useStore.setState({ threads: {} });
});

// ---- KYB-662: one-thread agents -------------------------------------------

/**
 * The state AC5 starts from, reached the way a person reaches it: an answered
 * exchange in the thread, then the thread's own conversation ends on the agent
 * (a reset or an upgrade), so the thread names nothing and the transcript on
 * screen is the only copy there is.
 */
async function threadEnded(own) {
  holding(undefined, { threads: { [ID]: { ...EMPTY_THREAD, current: own } } });
  thread = { ...EMPTY_THREAD, current: own };
  await useStore.getState().openThread(ID);
  assert.ok(merged(own), "the thread's exchange is on screen");
  thread = EMPTY_THREAD;
  useStore.setState({ threads: { [ID]: EMPTY_THREAD } });
  await refuseByWatch(own);
  assert.equal(useStore.getState().sessions[ID], undefined, "the thread's conversation has ended");
}

/** Relaunch: the store is read back from what was saved. */
async function relaunch() {
  live.state = structuredClone(saved());
  useStore.setState({ conversations: {}, sessions: {}, sessionChoice: {}, threadCopy: {}, goneSessions: {}, keepsThread: {} });
  await useStore.getState().restore();
  useStore.setState({ activeAgentId: ID });
}

test("KYB-662 AC1: the thread's conversation ending leaves the transcript, one line, no notice and no read-only", async () => {
  const OWN = "wrun_662_AC1";
  await threadEnded(OWN);
  const st = useStore.getState();
  const conv = st.conversations[ID];
  assert.ok(merged(OWN), "the transcript stays on screen");
  assert.ok(!conv.some((b) => b.kind === "gone"), "no gone notice, so no Back to your thread");
  const lines = conv.filter((b) => b.kind === "divider" && b.id === `afresh-${OWN}`);
  assert.equal(lines.length, 1, "one line");
  assert.match(lines[0].label, /has started afresh in your thread/);
  assert.equal(conv.at(-1).id, `afresh-${OWN}`, "under the transcript");
  assert.equal(readOnlyReason(st, ID), null, "the composer stays");

  // Said once, whatever reads the thread again.
  await useStore.getState().loadThread(ID);
  await useStore.getState().loadThread(ID);
  assert.equal(useStore.getState().conversations[ID].filter((b) => b.id === `afresh-${OWN}`).length, 1);

  // The next message is answered in the thread.
  sends.length = 0;
  useStore.getState().send(ID, "are you there?");
  await sleep(100);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].thread, true, "to the thread's address");
  assert.equal(sends[0].sessionId, undefined, "not to the conversation that ended");

  // And after a relaunch the line and the transcript are still there.
  await relaunch();
  assert.ok(merged(OWN));
  assert.equal(useStore.getState().conversations[ID].filter((b) => b.id === `afresh-${OWN}`).length, 1);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 AC1: a notice put up before the thread was read becomes the thread's line, where it stood", async () => {
  holding(DEAD, { threads: {} });
  await refuseByWatch(DEAD);
  assert.equal(lastBlock().kind, "gone", "the agent was not yet known to keep a thread");
  thread = EMPTY_THREAD;
  await useStore.getState().loadThread(ID);
  const conv = useStore.getState().conversations[ID];
  assert.ok(!conv.some((b) => b.kind === "gone"), "the notice is gone");
  assert.equal(conv.filter((b) => b.id === `afresh-${DEAD}`).length, 1, "and the line is there instead");
  assert.equal(conv[0].text, "hello", "under the transcript");
  assert.equal(useStore.getState().sessionChoice[ID], undefined, "on the thread, not a new conversation");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 AC2: a gone drawer pick says why it is empty each time it is opened, and after a relaunch", async () => {
  const OWN = "wrun_662_AC2";
  await threadEnded(OWN);
  for (const round of [1, 2]) {
    await useStore.getState().openSession(ID, DEAD);
    await sleep(50);
    const st = useStore.getState();
    assert.equal(st.sessions[ID], DEAD, `round ${round}: on the pick`);
    assert.deepEqual(
      st.conversations[ID].map((b) => b.kind),
      ["gone"],
      `round ${round}: the chat holds the notice and nothing else, so it is never "No messages yet"`,
    );
    assert.equal(readOnlyReason(st, ID), "gone", `round ${round}: read-only`);
    await useStore.getState().openThread(ID);
  }
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  await relaunch();
  await useStore.getState().hydrate(ID);
  const st = useStore.getState();
  assert.equal(st.sessions[ID], DEAD, "the pick survives the relaunch");
  assert.deepEqual(st.conversations[ID].map((b) => b.kind), ["gone"], "and still says why");
  assert.equal(readOnlyReason(st, ID), "gone");
  gone.delete(DEAD);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 AC5: after the thread has ended, a drawer pick and Back keep the thread's transcript, across a relaunch", async () => {
  const OWN = "wrun_662_AC5";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];

  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  assert.equal(useStore.getState().sessions[ID], DEAD, "the pick is on screen");
  assert.ok(!merged(OWN), "in place of the thread");
  assert.deepEqual(saved().threadCopy[ID], before, "the thread's transcript is saved aside");

  // A relaunch while the pick is open loses nothing either.
  await relaunch();
  await useStore.getState().openThread(ID);
  const st = useStore.getState();
  assert.equal(st.sessions[ID], undefined, "back on the thread");
  assert.deepEqual(st.conversations[ID], before, "with its transcript, as it was");
  assert.equal(st.threadCopy[ID], undefined, "the copy is used once");
  assert.deepEqual(saved().conversations[ID], before, "and what is saved is the transcript");

  await relaunch();
  assert.deepEqual(useStore.getState().conversations[ID], before, "still there after a relaunch");
  gone.delete(DEAD);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 AC5: from one pick to another, Back still brings the thread back, not the first pick", async () => {
  const OWN = "wrun_662_TWO";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  assert.ok(merged(ALIVE), "the first pick is read");
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  await useStore.getState().openThread(ID);
  assert.deepEqual(useStore.getState().conversations[ID], before);
  gone.delete(DEAD);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 AC5: a message sent from a live pick goes to the thread, under the thread's transcript", async () => {
  const OWN = "wrun_662_SEND";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  sends.length = 0;
  useStore.getState().send(ID, "back to it");
  await sleep(100);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].thread, true, "to the thread");
  assert.equal(sends[0].sessionId, undefined, "not into the pick");
  assert.match(sends[0].clientContext?.earlierConversation ?? "", new RegExp(`history of ${OWN}`), "told how the thread ended, not the pick");
  assert.doesNotMatch(sends[0].clientContext?.earlierConversation ?? "", new RegExp(`history of ${ALIVE}`));
  const conv = useStore.getState().conversations[ID];
  assert.deepEqual(conv.slice(0, before.length), before, "the thread's transcript is back");
  assert.equal(conv[before.length]?.text, "back to it", "with the message under it");
  assert.ok(!merged(ALIVE), "and nothing of the pick");
  assert.equal(useStore.getState().threadCopy[ID], undefined);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 AC3: with the thread alive, Back from a pick shows the thread's transcript and what is new", async () => {
  holding(undefined, { threads: { [ID]: LIVE_THREAD } });
  thread = LIVE_THREAD;
  await useStore.getState().openThread(ID);
  const before = useStore.getState().conversations[ID];
  assert.ok(merged(ALIVE));
  gone.set(DEAD, "expired");
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  assert.equal(lastBlock().kind, "gone");
  await useStore.getState().openThread(ID);
  const st = useStore.getState();
  assert.equal(st.sessions[ID], ALIVE, "on the thread's conversation");
  assert.deepEqual(st.conversations[ID].slice(0, before.length), before, "its transcript is back");
  assert.ok(!st.conversations[ID].some((b) => b.kind === "gone"), "with nothing of the pick");
  gone.delete(DEAD);
  thread = null;
  useStore.setState({ threads: {} });
});

/** Every block of `before` is in `conv`. Order is by time, and the harness dates every read block 1. */
const holdsAll = (conv, before) => before.every((b) => conv.some((x) => x.id === b.id));

/** The thread's transcript is on screen as it was, and is what is saved. */
function threadBack(before, why) {
  const st = useStore.getState();
  assert.deepEqual(st.conversations[ID], before, `${why}: the thread's transcript is on screen`);
  assert.equal(st.sessions[ID], undefined, `${why}: on the thread`);
  assert.equal(st.threadCopy[ID], undefined, `${why}: the copy is used once`);
  assert.deepEqual(saved().conversations[ID], before, `${why}: and is what is saved`);
}

test("KYB-662 B1: ending a live drawer pick goes back to the thread, with its transcript", async () => {
  const OWN = "wrun_662_END";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  useStore.getState().endConversation(ID, ALIVE);
  await sleep(50);
  threadBack(before, "after End");
  await useStore.getState().openThread(ID);
  threadBack(before, "after Back");
  await relaunch();
  assert.deepEqual(useStore.getState().conversations[ID], before, "after a relaunch");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 B1: ending a gone drawer pick from Settings goes back to the thread, with its transcript", async () => {
  const OWN = "wrun_662_ENDG";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  gone.set(DEAD, "expired");
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  assert.equal(readOnlyReason(useStore.getState(), ID), "gone");
  useStore.getState().endConversation(ID, DEAD);
  await sleep(50);
  threadBack(before, "after End");
  gone.delete(DEAD);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 B1: New conversation on a pick, before the thread is read after a relaunch, goes back to the thread", async () => {
  const OWN = "wrun_662_NEW";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  await relaunch();
  useStore.setState({ threads: {} });
  useStore.getState().startConversation(ID);
  await sleep(50);
  threadBack(before, "after New conversation");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 B2: a relaunch on a pick does not let the directory adopt over it, and Back brings the thread and what is new", async () => {
  const OWN = "wrun_662_P5";
  const NEXT = "wrun_662_P5_NEXT";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  await relaunch();
  useStore.setState({ threads: {} });
  // The phone carried on in the thread: the directory's newest row is its new conversation.
  live.rows = [{ agent: "agent", sessionId: NEXT, label: ID, lastMessageAt: new Date().toISOString() }];
  await useStore.getState().syncSessions();
  live.rows = [];
  assert.equal(useStore.getState().sessions[ID], ALIVE, "the pick is not adopted over");
  assert.deepEqual(useStore.getState().threadCopy[ID], before, "and the copy is still aside");
  thread = { ...EMPTY_THREAD, current: NEXT };
  await useStore.getState().loadThread(ID);
  assert.equal(useStore.getState().sessions[ID], ALIVE, "the thread does not pull the chat off the pick");
  await useStore.getState().openThread(ID);
  await sleep(50);
  const conv = useStore.getState().conversations[ID];
  assert.equal(useStore.getState().sessions[ID], NEXT);
  assert.ok(holdsAll(conv, before), "the thread's transcript is back");
  assert.ok(merged(NEXT), "with the new conversation's turns below it");
  assert.ok(!merged(ALIVE), "and nothing of the pick");
  assert.equal(useStore.getState().threadCopy[ID], undefined);
  thread = null;
  useStore.setState({ threads: {} });
});

/** A turn of the thread's new conversation already on screen, here and nowhere else. */
const SAID = { kind: "text", id: "u-said-next", role: "user", text: "said before the thread was read", at: 2 };
const shows = (conv, block) => conv.some((b) => b.id === block.id);

test("KYB-662 B2: a copy stranded on the thread's own conversation is put back when the thread is read", async () => {
  const OWN = "wrun_662_STRAND";
  const NEXT = "wrun_662_STRAND_NEXT";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  // However it got there: the chat holds the thread's new conversation, not a
  // pick, and the thread's transcript is still put aside.
  useStore.setState((s) => ({
    sessions: { ...s.sessions, [ID]: NEXT },
    sessionChoice: {},
    conversations: { ...s.conversations, [ID]: [SAID] },
    threadCopy: { [ID]: before },
    threads: {},
  }));
  thread = { ...EMPTY_THREAD, current: NEXT };
  await useStore.getState().loadThread(ID);
  await sleep(50);
  const conv = useStore.getState().conversations[ID];
  assert.ok(holdsAll(conv, before), "the thread's transcript is back");
  assert.ok(shows(conv, SAID), "what was on screen stays");
  assert.ok(merged(NEXT), "with what is new");
  assert.equal(useStore.getState().threadCopy[ID], undefined);
  assert.ok(holdsAll(saved().conversations[ID], [...before, SAID]), "and saved");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 B2: a conversation opened before the thread is read, with a copy aside, is a pick and is not mixed into the thread", async () => {
  const OWN = "wrun_662_P3";
  const OTHER = "wrun_662_P3_OTHER";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  await relaunch();
  useStore.setState({ threads: {} });
  await useStore.getState().openSession(ID, OTHER);
  await sleep(50);
  let st = useStore.getState();
  assert.ok(merged(OTHER), "the conversation opened is read");
  assert.ok(!merged(OWN), "on its own, not over the thread's transcript");
  assert.deepEqual(st.threadCopy[ID], before, "the thread's copy stays aside, unchanged");
  assert.equal(st.sessionChoice[ID]?.fromDrawer, true, "and it is recorded as a pick");
  thread = EMPTY_THREAD;
  await useStore.getState().loadThread(ID);
  await useStore.getState().openThread(ID);
  threadBack(before, "after Back");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 B3: while a conversation is read for the first time the chat says so, and stops saying so when it is answered", async () => {
  const OWN = "wrun_662_B3";
  await threadEnded(OWN);
  gone.set(DEAD, "expired");
  let open;
  replayGate = new Promise((resolve) => (open = resolve));
  const opening = useStore.getState().openSession(ID, DEAD);
  await sleep(20);
  assert.equal(useStore.getState().historyReading[ID], DEAD, "being read");
  assert.deepEqual(useStore.getState().conversations[ID], []);
  replayGate = null;
  open();
  await opening;
  assert.equal(useStore.getState().historyReading[ID], undefined, "and no longer");
  assert.equal(lastBlock().kind, "gone");
  await useStore.getState().openThread(ID);
  gone.delete(DEAD);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 B2: a copy held while the screen is not a pick is never overwritten by the next pick, and the screen is kept with it", async () => {
  const OWN = "wrun_662_KEEP";
  const NEXT = "wrun_662_KEEP_NEXT";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  // Stranded, as at a launch before `/thread` is read: the chat holds the
  // thread's new conversation, not a pick, and the transcript is put aside.
  useStore.setState((s) => ({
    sessions: { ...s.sessions, [ID]: NEXT },
    sessionChoice: {},
    conversations: { ...s.conversations, [ID]: [SAID] },
    threadCopy: { [ID]: before },
    threads: {},
  }));
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  const aside = useStore.getState().threadCopy[ID];
  assert.deepEqual(aside.slice(0, before.length), before, "the copy aside is the thread's, unchanged");
  assert.ok(shows(aside, SAID), "with the screen that was left added under it");
  thread = { ...EMPTY_THREAD, current: NEXT };
  await useStore.getState().loadThread(ID);
  await useStore.getState().openThread(ID);
  await sleep(50);
  const conv = useStore.getState().conversations[ID];
  assert.ok(holdsAll(conv, before), "and Back brings it back");
  assert.ok(shows(conv, SAID), "screen and all");
  thread = null;
  useStore.setState({ threads: {} });
});

/**
 * Review round 2, N1. The thread has ended and a pick was open; after a
 * relaunch the thread's new conversation is opened before `/thread` answers
 * (the newest row of the list shown then), so it is recorded as a pick.
 */
async function ownOpenedBeforeRead(own, next) {
  await threadEnded(own);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  await relaunch();
  useStore.setState({ threads: {} });
  await useStore.getState().openSession(ID, next);
  await sleep(50);
  assert.ok(merged(next), "the thread's new conversation is read");
  assert.equal(useStore.getState().sessionChoice[ID]?.fromDrawer, true, "recorded as a pick, as nothing yet says otherwise");
  thread = { ...EMPTY_THREAD, current: next };
  await useStore.getState().loadThread(ID);
  await sleep(50);
  return before;
}

test("KYB-662 N1: the thread's own conversation, opened before the thread is read, is the thread once it is, with both transcripts", async () => {
  const OWN = "wrun_662_N1";
  const NEXT = "wrun_662_N1_NEXT";
  const before = await ownOpenedBeforeRead(OWN, NEXT);
  let st = useStore.getState();
  assert.equal(st.sessions[ID], NEXT);
  assert.notEqual(st.sessionChoice[ID]?.fromDrawer, true, "no longer a pick");
  assert.equal(st.threadCopy[ID], undefined, "nothing left aside");
  assert.ok(holdsAll(st.conversations[ID], before), "the ended conversation's transcript is on screen");
  assert.ok(merged(NEXT), "and so is the new one's");
  assert.equal(readOnlyReason(st, ID), null, "and the thread can be written to");
  await useStore.getState().openThread(ID);
  await sleep(50);
  assert.ok(holdsAll(useStore.getState().conversations[ID], before) && merged(NEXT), "Back changes nothing");

  // The new conversation ends too: neither transcript is lost (AC1).
  thread = EMPTY_THREAD;
  useStore.setState({ threads: { [ID]: EMPTY_THREAD } });
  await refuseByWatch(NEXT);
  await useStore.getState().loadThread(ID);
  st = useStore.getState();
  assert.ok(holdsAll(st.conversations[ID], before), "the first ended conversation is kept");
  assert.ok(merged(NEXT), "and the second");
  assert.ok(holdsAll(saved().conversations[ID], st.conversations[ID].filter((b) => b.kind !== "divider")), "and saved");
  await relaunch();
  assert.ok(holdsAll(useStore.getState().conversations[ID], before) && merged(NEXT), "still there after a relaunch");
  gone.delete(NEXT);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 N1: from there, a pick, the thread's conversation ending, and Back keep both transcripts", async () => {
  const OWN = "wrun_662_N1B";
  const NEXT = "wrun_662_N1B_NEXT";
  const before = await ownOpenedBeforeRead(OWN, NEXT);
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  assert.ok(merged(ALIVE) && !merged(NEXT), "the pick is on screen, on its own");
  // The thread's conversation ends while the pick is open.
  gone.set(NEXT, "expired");
  thread = EMPTY_THREAD;
  await useStore.getState().loadThread(ID);
  await useStore.getState().openThread(ID);
  await sleep(50);
  const st = useStore.getState();
  assert.equal(st.sessions[ID], undefined, "back on the thread");
  assert.ok(holdsAll(st.conversations[ID], before), "the first ended conversation is kept");
  assert.ok(merged(NEXT), "and the second");
  assert.ok(!merged(ALIVE), "and nothing of the pick");
  assert.equal(st.threadCopy[ID], undefined);
  gone.delete(NEXT);
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 N1: ending the conversation on screen while a copy is stranded keeps the screen with the copy", async () => {
  const OWN = "wrun_662_N1END";
  const NEXT = "wrun_662_N1END_NEXT";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  // Stranded, as at a launch before `/thread` is read: the screen is the
  // thread's new conversation, not a recorded pick, and the transcript is aside.
  useStore.setState((s) => ({
    sessions: { ...s.sessions, [ID]: NEXT },
    sessionChoice: {},
    conversations: { ...s.conversations, [ID]: [SAID] },
    threadCopy: { [ID]: before },
    threads: {},
  }));
  useStore.getState().endConversation(ID, NEXT);
  await sleep(50);
  const st = useStore.getState();
  assert.ok(holdsAll(st.conversations[ID], before), "the thread's transcript is back");
  assert.ok(shows(st.conversations[ID], SAID), "and what was on screen is not thrown away");
  assert.equal(st.threadCopy[ID], undefined, "the copy is used once");
  assert.ok(holdsAll(saved().conversations[ID], [...before, SAID]), "and saved");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 N3: after a relaunch, a conversation opened before the thread is read is a pick, and the thread's only copy is kept", async () => {
  const OWN = "wrun_662_N3";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  assert.equal(saved().keepsThread?.[ID], true, "that the agent keeps one thread is saved");
  await relaunch();
  useStore.setState({ threads: {} });
  assert.equal(useStore.getState().threadCopy[ID], undefined, "nothing is put aside yet");
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  let st = useStore.getState();
  assert.equal(st.sessionChoice[ID]?.fromDrawer, true, "it is recorded as a pick");
  assert.deepEqual(st.threadCopy[ID], before, "the thread's transcript is put aside");
  assert.deepEqual(saved().threadCopy[ID], before, "and saved");
  assert.ok(merged(ALIVE) && !merged(OWN), "the pick is on screen, on its own");
  await relaunch();
  thread = EMPTY_THREAD;
  await useStore.getState().loadThread(ID);
  await useStore.getState().openThread(ID);
  threadBack(before, "after Back");
  await relaunch();
  assert.deepEqual(useStore.getState().conversations[ID], before, "still there after a relaunch");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 N3: an agent found to keep no thread stops being taken for one", async () => {
  holding(ALIVE, { keepsThread: { [ID]: true }, threads: {} });
  thread = null; // `/thread` answers 404
  await useStore.getState().loadThread(ID);
  await sleep(20);
  assert.equal(useStore.getState().keepsThread[ID], undefined);
  assert.equal(saved().keepsThread?.[ID], undefined, "and that is saved");
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  assert.notEqual(useStore.getState().sessionChoice[ID]?.fromDrawer, true, "a conversation opened is not a pick");
  assert.equal(useStore.getState().threadCopy[ID], undefined, "and nothing is put aside");
  useStore.setState({ threads: {}, keepsThread: {} });
});

test("KYB-662 H2: signed out on a pick, the thread's read after signing in puts the thread back, not the pick", async () => {
  const OWN = "wrun_662_H2";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  // As a sign-out leaves it: no session held, the choice, screen and copy kept.
  useStore.setState({ sessions: {}, threads: {} });
  thread = EMPTY_THREAD;
  await useStore.getState().loadThread(ID);
  await sleep(50);
  const st = useStore.getState();
  assert.deepEqual(st.conversations[ID], before, "the thread's transcript is on screen");
  assert.ok(!merged(ALIVE), "and nothing of the pick");
  assert.equal(st.threadCopy[ID], undefined);
  assert.equal(st.sessionChoice[ID], undefined, "the pick is left");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 H1: a pick answered on a new conversation before the thread is read stays a pick", async () => {
  const OWN = "wrun_662_H1";
  const NEW = "wrun_662_H1_NEW";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  await relaunch();
  useStore.setState({ threads: {} });
  sendAs = NEW;
  useStore.getState().send(ID, "typed on the pick");
  await sleep(100);
  sendAs = null;
  let st = useStore.getState();
  assert.equal(st.sessions[ID], NEW);
  assert.equal(st.sessionChoice[ID]?.sessionId, NEW, "the choice follows the conversation the agent answered on");
  assert.equal(st.sessionChoice[ID]?.fromDrawer, true, "still a pick");
  thread = EMPTY_THREAD;
  await useStore.getState().loadThread(ID);
  await sleep(50);
  st = useStore.getState();
  assert.deepEqual(st.threadCopy[ID], before, "the thread's transcript stays aside");
  await useStore.getState().openThread(ID);
  threadBack(before, "after Back");
  thread = null;
  useStore.setState({ threads: {} });
});

test("KYB-662 R: the thread's new conversation, still being read when the thread names it, shows its turns", async () => {
  const OWN = "wrun_662_R";
  const NEXT = "wrun_662_R_NEXT";
  await threadEnded(OWN);
  const before = useStore.getState().conversations[ID];
  await useStore.getState().openSession(ID, ALIVE);
  await sleep(50);
  await relaunch();
  useStore.setState({ threads: {} });
  let open;
  replayGate = new Promise((resolve) => (open = resolve));
  const opening = useStore.getState().openSession(ID, NEXT);
  await sleep(20);
  thread = { ...EMPTY_THREAD, current: NEXT };
  const reading = useStore.getState().loadThread(ID);
  await sleep(20);
  replayGate = null;
  open();
  await opening;
  await reading;
  await sleep(50);
  const conv = useStore.getState().conversations[ID];
  assert.ok(holdsAll(conv, before), "the ended conversation's transcript is on screen");
  assert.ok(merged(NEXT), "and the new one's turns, without waiting for the next merge");
  thread = null;
  useStore.setState({ threads: {} });
});
