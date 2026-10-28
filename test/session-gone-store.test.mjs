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

const { live } = installBridge({ rows: [], agentSessions: [] });
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

test("AC2: going back to a thread that still names a gone conversation opens it empty, not on the dead id", async () => {
  holding(undefined, { goneSessions: { [ID]: [DEAD] }, threads: { [ID]: { current: DEAD, sessions: [], reports: [], fresh: [] } } });
  await useStore.getState().openThread(ID);
  assert.equal(useStore.getState().sessions[ID], undefined);
  assert.equal(replays.filter((id) => id === DEAD).length, 0, "and it is not read");
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
