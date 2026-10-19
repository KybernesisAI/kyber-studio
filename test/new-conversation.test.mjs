import { before, after, test } from "node:test";
import assert from "node:assert/strict";

import { OLD_THREAD, REMOTE_AGENT, captureLogs, installBridge, sleep } from "./fixtures/session-sync-harness.mjs";

/**
 * KYB-649, PR 1: "New conversation" opens a new conversation and retires
 * nothing, and the new conversation stays new until the person sends a message
 * or picks a thread.
 *
 * Before this change `startConversation` sent `POST /session/<id>/reset` for
 * whatever thread was selected — on 19 Oct that ended a live Buzz conversation
 * mid-turn — and left nothing to stop either adoption path (the directory sync,
 * or `loadAgentInfo`) from filling the new chat with another thread.
 *
 * The real store, through a fake bridge that records every reset.
 */

const ID = REMOTE_AGENT.id;
const future = (ms = 60_000) => new Date(Date.now() + ms).toISOString();

/** A live thread on the agent, labelled `chat` — as a Buzz thread is while KYB-645 stands. */
const BUZZ_ON_AGENT = {
  id: "wrun_BUZZ",
  title: "a buzz thread",
  surface: "chat",
  trigger: "http",
  status: "alive",
  createdAt: "2026-10-19T07:06:00.000Z",
  updatedAt: "2026-10-19T11:12:43.000Z",
};
/** The same thread in the account directory, republished with a recent time. */
const BUZZ_IN_DIRECTORY = { agent: "agent", sessionId: "wrun_BUZZ", label: "agent-id", lastMessageAt: future() };

const bridge = installBridge({ rows: [OLD_THREAD], agentSessions: [BUZZ_ON_AGENT] });
const { useStore } = await import("@/lib/store");

after(() => window.close());

before(async () => {
  await useStore.getState().signIn(() => {});
  await sleep(150);
  assert.equal(useStore.getState().directoryLoading, false, "the directory gate never settled");
});

/** Put the chat on `sessionId` the way the drawer does, with its history on screen. */
async function holding(sessionId) {
  useStore.setState((s) => ({ inflight: { ...s.inflight, [ID]: undefined } }));
  await useStore.getState().openSession(ID, sessionId);
  assert.equal(useStore.getState().sessions[ID], sessionId);
  assert.ok((useStore.getState().conversations[ID] ?? []).length > 0, "the thread's history did not load");
}

function assertStillNew(what) {
  const st = useStore.getState();
  assert.equal(st.sessions[ID], undefined, `${what}: a thread was put into the new conversation`);
  assert.deepEqual(st.conversations[ID], [], `${what}: the new conversation is not empty`);
  assert.equal(st.sessionChoice[ID]?.sessionId, null, `${what}: the fresh-start choice is gone`);
}

test("AC1: New conversation sends no reset, empties the chat, and records a fresh-start choice", async () => {
  await holding(OLD_THREAD.sessionId);
  const before = bridge.resets.length;

  useStore.getState().startConversation(ID);
  await sleep(20);

  assert.equal(bridge.resets.length, before, `New conversation sent ${bridge.resets.length - before} reset(s)`);
  assertStillNew("straight after the press");
  const saved = bridge.live.saved["conversations.json"];
  assert.equal(saved?.sessionChoice?.[ID]?.sessionId, null, "the fresh-start choice was not persisted");
});

test("AC1b: a directory pass — focus, the 30 s tick — adopts nothing, even a row newer than the choice", async (t) => {
  const logs = captureLogs(t);
  bridge.live.rows = [OLD_THREAD, BUZZ_IN_DIRECTORY];

  await useStore.getState().syncSessions();
  assertStillNew("after a directory pass");
  window.dispatchEvent(new window.Event("focus"));
  await sleep(100);
  assertStillNew("after a focus");

  assert.ok(
    logs().some((l) => l.startsWith("[index] sync: ") && l.includes("1 kept (new conversation)")),
    "the pass did not report keeping the new conversation",
  );
  assert.equal(bridge.resets.length, 0);
});

test("AC1b: switching agent and back (loadAgentInfo) adopts nothing over the new conversation", async (t) => {
  const logs = captureLogs(t);
  await useStore.getState().loadAgentInfo(ID);
  assertStillNew("after loadAgentInfo");
  assert.ok(!logs().some((l) => l.startsWith("[sessions] ") && l.includes("adopted")), "loadAgentInfo logged an adoption");
});

test("AC1b: quit and relaunch — the choice is restored from disk and still holds", async () => {
  const onDisk = bridge.live.saved["conversations.json"];
  // A blank store, as at launch, reading back what was saved.
  useStore.setState({ sessions: {}, sessionChoice: {}, conversations: {} });
  bridge.live.state = onDisk;
  await useStore.getState().restore();

  await useStore.getState().syncSessions();
  await useStore.getState().loadAgentInfo(ID);
  assertStillNew("after a relaunch");
});

test("a replay in flight when New conversation is pressed does not land in the new conversation", async () => {
  bridge.live.rows = [OLD_THREAD];
  useStore.setState((s) => ({ conversations: { ...s.conversations, [ID]: [] } }));
  const delays = { replaySession: 200 };
  const realReplay = window.studio.replaySession;
  window.studio.replaySession = async (input) => {
    await sleep(delays.replaySession);
    return realReplay(input);
  };
  try {
    const opening = useStore.getState().openSession(ID, OLD_THREAD.sessionId);
    await sleep(50);
    useStore.getState().startConversation(ID);
    await opening;
    await sleep(50);
    assertStillNew("after the slow replay resolved");
  } finally {
    window.studio.replaySession = realReplay;
  }
});

test("the first message replaces the fresh-start choice, and ordinary sync resumes", async () => {
  useStore.getState().startConversation(ID);
  const sent = bridge.sends.length;

  useStore.getState().send(ID, "a new topic");
  await sleep(100);

  const out = bridge.sends.slice(sent);
  assert.equal(out.length, 1);
  assert.equal(out[0].sessionId, undefined, "the first message went into an existing thread");
  assert.equal(useStore.getState().sessions[ID], "wrun_NEW");
  assert.equal(useStore.getState().sessionChoice[ID]?.sessionId, "wrun_NEW", "the send did not replace the fresh-start choice");

  // From here it is an ordinary choice: a thread that moved after it is adopted, as before.
  bridge.live.rows = [{ ...BUZZ_IN_DIRECTORY, lastMessageAt: future(120_000) }];
  await useStore.getState().syncSessions();
  assert.equal(useStore.getState().sessions[ID], "wrun_BUZZ", "ordinary sync did not resume after the first message");
  assert.equal(bridge.resets.length, 0);
});

test("AC4: endConversation resets exactly the id it is given, not whatever is selected when it runs", async () => {
  await holding(OLD_THREAD.sessionId);
  bridge.resets.length = 0;

  // The confirmation named wrun_SHOWN; adoption has since moved the chat to wrun_OLD.
  useStore.getState().endConversation(ID, "wrun_SHOWN");
  await sleep(10);
  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["wrun_SHOWN"]);
  assert.equal(useStore.getState().sessions[ID], OLD_THREAD.sessionId, "ending another thread moved the chat");

  // Ending the thread on screen also starts the chat fresh, as New conversation does.
  useStore.getState().endConversation(ID, OLD_THREAD.sessionId);
  await sleep(10);
  assert.deepEqual(bridge.resets.map((r) => r.sessionId), ["wrun_SHOWN", OLD_THREAD.sessionId]);
  assertStillNew("after ending the selected thread");
});

test("control: with no thread and no fresh-start choice, loadAgentInfo does adopt — and now says so", async (t) => {
  const logs = captureLogs(t);
  useStore.setState({ sessions: {}, sessionChoice: {}, conversations: {} });
  await useStore.getState().loadAgentInfo(ID);
  assert.equal(useStore.getState().sessions[ID], BUZZ_ON_AGENT.id, "the guard, not a broken fixture, is what stops adoption above");
  assert.ok(
    logs().some((l) => l.startsWith(`[sessions] ${ID}: no thread held; adopted the newest live chat thread ${BUZZ_ON_AGENT.id}`)),
    "the adoption was not logged",
  );
});
