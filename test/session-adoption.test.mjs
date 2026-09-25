import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptedState, decideAdoption, freshStartPending, lastDividerAt } from "../src/shared/sessionAdoption.ts";
import { reconcile } from "../src/shared/sessionReplay.ts";

/**
 * The regression these exist for, as it was driven on 2026-09-25 (Tuber):
 * "New conversation" retired session A and left the chat with no session, four
 * archived messages and a divider. Within one sync tick the chat had adopted
 * session B — older, not retired — and the transcript was `[]`: the archive
 * and the divider deleted from conversations.json. The retired-id guard held;
 * the fall-through to the next-newest thread and the wipe-on-adopt did not.
 */

const iso = (ms) => new Date(ms).toISOString();
const text = (id, at) => ({ kind: "text", id, role: "user", text: `m-${id}`, at });

const T_OLD_B = Date.parse("2026-09-24T09:00:00Z");
const T_A = Date.parse("2026-09-25T08:00:00Z");
const T_DIVIDER = Date.parse("2026-09-25T08:30:00Z");

const archived = [text("u1", T_A - 4000), text("a1", T_A - 3000), text("u2", T_A - 2000), text("a2", T_A - 1000)];
const divider = { kind: "divider", id: `new-${T_DIVIDER}`, at: T_DIVIDER, retiredSessionId: "sess_A" };
const afterReset = [...archived, divider];

const directory = [
  { sessionId: "sess_A", lastMessageAt: iso(T_A) },
  { sessionId: "sess_B", lastMessageAt: iso(T_OLD_B) },
];

test("regression: after New conversation, sync adopts nothing — not the retired session, not an older one", () => {
  const decision = decideAdoption({
    entries: directory,
    localSession: undefined,
    localBlocks: afterReset,
    retired: ["sess_A"],
  });
  assert.deepEqual(decision, { kind: "skip" }, "no local session after a reset means: wait for the next message");
});

test("the same holds if the retired id was never recorded — the divider alone is enough", () => {
  // Belt and braces: a retiredSessions list lost or never persisted must not
  // reopen the hole. The fresh-start rule does not depend on it.
  const decision = decideAdoption({ entries: directory, localSession: undefined, localBlocks: afterReset, retired: [] });
  assert.deepEqual(decision, { kind: "skip" });
});

test("positive control: without a divider, the same directory IS adopted — the rule above is what stops it", () => {
  const decision = decideAdoption({ entries: directory, localSession: undefined, localBlocks: archived, retired: ["sess_A"] });
  assert.deepEqual(decision, { kind: "adopt", sessionId: "sess_B" });
});

test("a thread with activity AFTER the fresh start (another device) is still adopted", () => {
  const decision = decideAdoption({
    entries: [...directory, { sessionId: "sess_C", lastMessageAt: iso(T_DIVIDER + 60_000) }],
    localSession: undefined,
    localBlocks: afterReset,
    retired: ["sess_A"],
  });
  assert.deepEqual(decision, { kind: "adopt", sessionId: "sess_C" });
});

test("adopting never deletes a local block — the divider and the archive above it survive", () => {
  const state = {
    sessions: { tuber: undefined },
    conversations: { tuber: afterReset, other: [text("x", 1)] },
    streamIndexes: { tuber: 7 },
  };
  const next = adoptedState(state, "tuber", "sess_C");
  assert.equal(next.sessions.tuber, "sess_C");
  assert.equal("tuber" in next.streamIndexes, false, "the cursor belonged to the thread being left");
  assert.deepEqual(next.conversations, state.conversations, "the transcript is untouched by adoption");
});

test("and the merge that follows adoption keeps them too", () => {
  // What hydrate(…, "merge") does with the adopted thread's replay.
  const replayOfC = [{ kind: "text", id: "evt_c1", role: "agent", text: "from the phone", at: T_DIVIDER + 60_000 }];
  const merged = reconcile(afterReset, replayOfC);
  assert.deepEqual(
    merged.map((b) => b.id),
    ["u1", "a1", "u2", "a2", divider.id, "evt_c1"],
  );
});

test("the full sequence: reset → older non-retired session in the directory → sync tick → nothing changes", () => {
  let state = {
    sessions: { tuber: undefined },
    conversations: { tuber: afterReset },
    streamIndexes: { tuber: 0 },
  };
  // One sync tick, as the store runs it.
  const decision = decideAdoption({
    entries: directory,
    localSession: state.sessions.tuber,
    localBlocks: state.conversations.tuber,
    retired: ["sess_A"],
  });
  if (decision.kind === "adopt") state = adoptedState(state, "tuber", decision.sessionId);
  assert.equal(state.sessions.tuber, undefined, "the session stays unset until the person speaks");
  assert.deepEqual(state.conversations.tuber, afterReset, "archive and divider intact");
});

test("ordinary two-way sync is unchanged", () => {
  const local = [text("l1", 5_000)];
  assert.deepEqual(
    decideAdoption({ entries: [{ sessionId: "r", lastMessageAt: iso(1_000) }], localSession: "l", localBlocks: local, retired: [] }),
    { kind: "publish", localAt: 5_000 },
    "this device is newer: publish it",
  );
  assert.deepEqual(
    decideAdoption({ entries: [{ sessionId: "r", lastMessageAt: iso(9_000) }], localSession: "l", localBlocks: local, retired: [] }),
    { kind: "adopt", sessionId: "r" },
    "the account's thread is newer: adopt it",
  );
  assert.deepEqual(
    decideAdoption({ entries: [{ sessionId: "l", lastMessageAt: iso(9_000) }], localSession: "l", localBlocks: local, retired: [] }),
    { kind: "skip" },
    "already on it",
  );
});

test("fresh-start detection", () => {
  assert.equal(freshStartPending(undefined, afterReset), true);
  assert.equal(freshStartPending("sess_new", afterReset), false, "a session means the person already spoke");
  assert.equal(freshStartPending(undefined, [...afterReset, text("u9", T_DIVIDER + 1)]), false);
  assert.equal(freshStartPending(undefined, []), false, "an empty chat is not a fresh start, just empty");
  assert.equal(lastDividerAt(afterReset), T_DIVIDER);
  assert.equal(lastDividerAt(archived), 0);
});
