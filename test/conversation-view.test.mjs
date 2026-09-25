import { test } from "node:test";
import assert from "node:assert/strict";
import { currentConversation, isFreshStart } from "../src/shared/conversationView.ts";

/**
 * "New conversation" must CLEAR the view (David, 2026-09-25: "if I do a new
 * conversation, I want it cleared"). It must not delete anything: the earlier
 * blocks and their dividers stay stored for a future past-conversations list.
 */
const text = (id, at) => ({ kind: "text", id, role: "user", text: id, at });
const divider = (at) => ({ kind: "divider", id: `new-${at}`, at });

test("the view is only what came after the latest divider, and the stored blocks are untouched", () => {
  const stored = [text("a", 1), text("b", 2), divider(3), text("c", 4), divider(5), text("d", 6), text("e", 7)];
  const before = structuredClone(stored);
  assert.deepEqual(currentConversation(stored).map((b) => b.id), ["d", "e"]);
  assert.deepEqual(stored, before, "deriving the view must not mutate or trim the stored transcript");
});

test("right after New conversation the view is empty — no archive, no divider line", () => {
  const stored = [text("a", 1), text("b", 2), divider(3)];
  assert.deepEqual(currentConversation(stored), []);
  assert.equal(isFreshStart(stored), true, "the fresh-start hint shows");
});

test("a chat that never had New conversation shows everything", () => {
  const stored = [text("a", 1), text("b", 2)];
  assert.deepEqual(currentConversation(stored).map((b) => b.id), ["a", "b"]);
  assert.equal(isFreshStart(stored), false);
  assert.equal(isFreshStart([]), false, "an empty chat is empty, not a fresh start");
});
