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
const bridge = window.studio;
window.studio = new Proxy(bridge, {
  get: (target, key) => {
    if (key === "watch") return async (input) => void watches.push(input);
    if (key === "unwatch") return async (streamId) => void unwatches.push(streamId);
    if (key === "onLive") return (cb) => void (emitLive = cb);
    if (key === "replaySession")
      return async (input) => {
        replays.push(input.sessionId);
        if (gone.has(input.sessionId)) return { gone: gone.get(input.sessionId) };
        return target.replaySession(input);
      };
    if (key === "manage")
      return async (input) => {
        if (input.path === "/thread" && thread) return { ok: true, status: 200, data: thread };
        return target.manage(input);
      };
    return target[key];
  },
});
const { useStore, rewatchDelay } = await import("@/lib/store");

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

test("AC2: going back to a thread that still names a gone conversation does not open the dead id, and keeps what is on screen", async () => {
  holding(DEAD, { goneSessions: { [ID]: [DEAD] }, threads: { [ID]: { current: DEAD, sessions: [], reports: [], fresh: [] } } });
  await useStore.getState().openThread(ID);
  assert.equal(useStore.getState().sessions[ID], undefined);
  assert.equal(replays.filter((id) => id === DEAD).length, 0, "and it is not read");
  assert.equal(useStore.getState().conversations[ID][0]?.text, "hello", "the thread's own copy is not thrown away");
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

// Under the drawer's Active filter the agent leaves ended conversations out
// rather than marking them, so only a list that includes them can say so: All,
// which is also what choosing a thread for the chat always reads.
test("AC4: a conversation the list reports ended or failed stops being watched", async () => {
  for (const status of ["ended", "failed"]) {
    holding(ALIVE);
    useStore.getState().watchActive();
    assert.equal(watches.length, 1);
    live.agentSessions = [{ id: ALIVE, title: "t", surface: "chat", trigger: "http", status, createdAt: "", updatedAt: "" }];
    await useStore.getState().loadSessions(ID, "all");
    assert.equal(useStore.getState().watching, null, `stopped on ${status}`);
    useStore.getState().watchActive();
    assert.equal(watches.length, 1, `not watched again while it is ${status}`);
  }
  live.agentSessions = [];
});

test("AC5: a watch that ends for any other reason waits before watching again, longer each time", async (t) => {
  const logs = captureLogs(t);
  holding(ALIVE);
  useStore.getState().watchActive();
  emitLive({ streamId: watches[0].streamId, kind: "ended" });
  await sleep(1_000);
  assert.equal(watches.length, 1, "not restarted at once");
  await sleep(1_300);
  assert.equal(watches.length, 2, "restarted after the first wait");

  emitLive({ streamId: watches[1].streamId, kind: "ended" });
  assert.ok(logs().some((l) => l.includes("2 in a row") && l.includes("in 4 s")), "the second wait is longer");
  useStore.getState().stopWatching();
});

test("AC5: the waits double from 2 s and stop growing at a minute", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 20].map(rewatchDelay), [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
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

test("AC2, one thread: leaving a gone drawer pick for a thread that names nothing leaves an empty chat", async () => {
  // Opening the drawer pick already replaced what was on screen (KYB-657
  // leaves that as it was); going back must not carry the notice along.
  holding(undefined, { threads: { [ID]: EMPTY_THREAD } });
  gone.set(DEAD, "expired");
  await useStore.getState().openSession(ID, DEAD);
  await sleep(50);
  assert.equal(useStore.getState().sessions[ID], DEAD);
  await useStore.getState().openThread(ID);
  const st = useStore.getState();
  assert.equal(st.sessions[ID], undefined, "on the thread");
  assert.deepEqual(st.conversations[ID], [], "with nothing of the other conversation");
  useStore.setState({ threads: {} });
});

test("AC6: the log says what the agent's thread names, once per change", async (t) => {
  const logs = captureLogs(t);
  holding(undefined, { goneSessions: { [ID]: [DEAD] } });
  // A view no other test uses first, so what earlier tests logged does not matter.
  const views = [
    { ...EMPTY_THREAD, current: "wrun_AC6_FIRST" },
    EMPTY_THREAD,
    EMPTY_THREAD,
    { ...EMPTY_THREAD, current: DEAD, sessions: [{ id: DEAD, at: "" }, { id: "wrun_OTHER", at: "" }] },
    { ...EMPTY_THREAD, current: ALIVE },
  ];
  for (const view of views) {
    thread = view;
    await useStore.getState().loadThread(ID);
  }
  thread = null;
  const said = logs().filter((l) => l.startsWith(`[thread] ${ID}: the thread names`));
  assert.deepEqual(said, [
    `[thread] ${ID}: the thread names wrun_AC6_FIRST; it lists 0 earlier`,
    `[thread] ${ID}: the thread names no conversation; it lists 0 earlier`,
    `[thread] ${ID}: the thread names ${DEAD}, which has gone; it lists 2 earlier, gone: ${DEAD}`,
    `[thread] ${ID}: the thread names ${ALIVE}; it lists 0 earlier`,
  ]);
  useStore.setState({ threads: {} });
});

test("AC6: the log line carries a real conversation id whole", async (t) => {
  const logs = captureLogs(t);
  const real = "wrun_01M613KXXFZFTKPR873JTK3HHN";
  holding(undefined);
  thread = { ...EMPTY_THREAD, current: real };
  await useStore.getState().loadThread(ID);
  thread = null;
  assert.ok(logs().some((l) => l.includes(`names ${real};`)));
  useStore.setState({ threads: {} });
});
