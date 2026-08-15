import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcile } from "../src/shared/sessionReplay.ts";

/**
 * The duplication this exists to stop was real and compounding: a message
 * written locally is named by the client, the same message read back from the
 * agent is named by the durable event, so an id comparison matches nothing and
 * every refresh re-adds the conversation. Both devices refreshing turned one
 * greeting into four.
 */
const local = (id, role, text, at) => ({ kind: "text", id, role, text, at });
const fromAgent = (id, role, text, at) => ({ kind: "text", id, role, text, at });

test("the same message under two ids is kept once", () => {
  const out = reconcile(
    [local("u100", "user", "hi", 100), local("a101", "agent", "Hi! What can I help with?", 101)],
    [fromAgent("evt_1", "user", "hi", 100), fromAgent("evt_2", "agent", "Hi! What can I help with?", 101)],
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((b) => b.id), ["evt_1", "evt_2"], "the durable id wins");
});

test("an already-reconciled transcript is stable across refreshes", () => {
  const agentSide = [fromAgent("evt_1", "user", "hi", 100), fromAgent("evt_2", "agent", "hello", 101)];
  const once = reconcile([local("u100", "user", "hi", 100), local("a101", "agent", "hello", 101)], agentSide);
  const twice = reconcile(once, agentSide);
  assert.equal(twice.length, once.length, "refreshing again must add nothing");
  assert.deepEqual(twice.map((b) => b.id), once.map((b) => b.id));
});

test("an existing duplicate is collapsed, not preserved", () => {
  // What the user's transcript already looked like: both copies on disk.
  const dirty = [
    local("u100", "user", "hi", 100),
    local("evt_1", "user", "hi", 100),
    local("a101", "agent", "hello", 101),
    local("evt_2", "agent", "hello", 101),
  ];
  const out = reconcile(dirty, [fromAgent("evt_1", "user", "hi", 100), fromAgent("evt_2", "agent", "hello", 101)]);
  assert.equal(out.length, 2, "a refresh should heal a transcript that is already doubled");
});

test("saying the same thing twice on purpose keeps both", () => {
  const out = reconcile(
    [local("u1", "user", "hi", 100), local("u2", "user", "hi", 200)],
    [fromAgent("evt_1", "user", "hi", 100), fromAgent("evt_2", "user", "hi", 200)],
  );
  assert.equal(out.length, 2, "matching is one-to-one, not by set membership");
});

test("a local-only block survives", () => {
  // A failed send never reaches the agent's stream; losing it would erase the
  // only evidence the user has that something went wrong.
  const out = reconcile(
    [local("u1", "user", "hi", 100), local("a1", "agent", "Error invoking remote method", 101)],
    [fromAgent("evt_1", "user", "hi", 100)],
  );
  assert.equal(out.length, 2);
  assert.ok(out.some((b) => b.text.startsWith("Error invoking")));
});

test("cards and prompts are never replaced by the stream", () => {
  const question = { kind: "question", id: "q1", at: 150 };
  const out = reconcile([local("u1", "user", "hi", 100), question], [fromAgent("evt_1", "user", "hi", 100)]);
  assert.ok(out.some((b) => b.kind === "question"), "the stream never described it, so nothing can stand in");
});

test("a peer exchange is matched by what was said, not by id", () => {
  const exchange = (id, at) => ({
    kind: "peer-activity",
    id,
    at,
    events: [{ text: "what is your role?" }, { text: "I keep the schedule." }],
  });
  const out = reconcile([exchange("peer-stream1", 120)], [exchange("peer-sess-turn_0", 120)]);
  assert.equal(out.length, 1, "the same exchange read twice is one block");
  assert.equal(out[0].id, "peer-sess-turn_0");
});

test("order follows time, not source", () => {
  const out = reconcile(
    [local("a-local", "agent", "later local", 300)],
    [fromAgent("evt_1", "user", "first", 100), fromAgent("evt_2", "agent", "second", 200)],
  );
  assert.deepEqual(out.map((b) => b.text), ["first", "second", "later local"]);
});
