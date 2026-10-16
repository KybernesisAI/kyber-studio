import { test } from "node:test";
import assert from "node:assert/strict";
import { adoptedState, decideAdoption, newestEntry } from "../src/shared/sessionAdoption.ts";

/**
 * The regression these exist for, as it was driven on 2026-09-25 (Tuber):
 * "New conversation" retired session A and left the chat with no session.
 * Within one sync tick the chat had adopted a thread from the directory again
 * — A itself, or once A was blocked, the next-older B.
 *
 * Since the v0.5.17 merge the sync model is main's: newest thread per agent,
 * and a `sessionChoice` that a sync may only override with a thread that moved
 * after the pick. "New conversation" is recorded as a choice of no thread.
 */

const iso = (ms) => new Date(ms).toISOString();

const T_OLD_B = Date.parse("2026-09-24T09:00:00Z");
const T_A = Date.parse("2026-09-25T08:00:00Z");
const T_RESET = Date.parse("2026-09-25T08:30:00Z");

const directory = [
  { sessionId: "sess_A", lastMessageAt: iso(T_A) },
  { sessionId: "sess_B", lastMessageAt: iso(T_OLD_B) },
];
const freshStart = { at: T_RESET };

test("positive control: with no choice recorded, an empty chat adopts the newest thread — the gap a plain reset leaves", () => {
  const decision = decideAdoption({ entries: directory, localSession: undefined, localAt: 0, choice: undefined });
  assert.deepEqual(decision, { kind: "adopt", sessionId: "sess_A" }, "the thread just left would come back");
});

test("regression: after New conversation, sync adopts nothing — not the retired thread, not an older one", () => {
  const decision = decideAdoption({ entries: directory, localSession: undefined, localAt: 0, choice: freshStart });
  assert.deepEqual(decision, { kind: "skip" }, "no local session after a reset means: wait for the next message");
});

test("a thread with activity AFTER the fresh start (another device) is still adopted", () => {
  const decision = decideAdoption({
    entries: [...directory, { sessionId: "sess_C", lastMessageAt: iso(T_RESET + 60_000) }],
    localSession: undefined,
    localAt: 0,
    choice: freshStart,
  });
  assert.deepEqual(decision, { kind: "adopt", sessionId: "sess_C" });
});

test("an older thread opened from the picker survives the next sync", () => {
  const pickedAt = T_RESET;
  const decision = decideAdoption({
    entries: directory,
    localSession: "sess_B",
    localAt: T_OLD_B,
    choice: { sessionId: "sess_B", at: pickedAt },
  });
  assert.deepEqual(decision, { kind: "skip" });
});

test("…unless the newest thread really moved after the pick", () => {
  const decision = decideAdoption({
    entries: [...directory, { sessionId: "sess_A", lastMessageAt: iso(T_RESET + 5_000) }],
    localSession: "sess_B",
    localAt: T_OLD_B,
    choice: { sessionId: "sess_B", at: T_RESET },
  });
  assert.deepEqual(decision, { kind: "adopt", sessionId: "sess_A" });
});

test("once the person speaks in the fresh thread, ordinary two-way sync resumes", () => {
  const decision = decideAdoption({
    entries: directory,
    localSession: "sess_new",
    localAt: T_RESET + 10_000,
    choice: freshStart,
  });
  assert.deepEqual(decision, { kind: "publish", localAt: T_RESET + 10_000 });
});

test("ordinary two-way sync is unchanged", () => {
  assert.deepEqual(
    decideAdoption({ entries: [{ sessionId: "r", lastMessageAt: iso(1_000) }], localSession: "l", localAt: 5_000, choice: undefined }),
    { kind: "publish", localAt: 5_000 },
    "this device is newer: publish it",
  );
  assert.deepEqual(
    decideAdoption({ entries: [{ sessionId: "r", lastMessageAt: iso(9_000) }], localSession: "l", localAt: 5_000, choice: undefined }),
    { kind: "adopt", sessionId: "r" },
    "the account's thread is newer: adopt it",
  );
  assert.deepEqual(
    decideAdoption({ entries: [{ sessionId: "l", lastMessageAt: iso(9_000) }], localSession: "l", localAt: 5_000, choice: undefined }),
    { kind: "skip" },
    "already on it",
  );
});

test("adopting drops the cursor and empties the view for hydrate", () => {
  const state = {
    sessions: { tuber: undefined },
    conversations: { tuber: [{ kind: "text", at: 1 }], other: [{ kind: "text", at: 2 }] },
    streamIndexes: { tuber: 7 },
  };
  const next = adoptedState(state, "tuber", "sess_C");
  assert.equal(next.sessions.tuber, "sess_C");
  assert.equal("tuber" in next.streamIndexes, false, "the cursor belonged to the thread being left");
  assert.deepEqual(next.conversations.tuber, []);
  assert.deepEqual(next.conversations.other, state.conversations.other, "other agents untouched");
});

test("newestEntry picks by lastMessageAt", () => {
  assert.equal(newestEntry(directory)?.sessionId, "sess_A");
  assert.equal(newestEntry([]), undefined);
});
