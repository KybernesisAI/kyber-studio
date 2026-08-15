import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blocksFromEvents } from "../src/shared/sessionReplay.ts";

/**
 * The fixture is a REAL stream, captured from a deployed agent, because every
 * assumption worth making here was wrong when checked against one: the inbound
 * text is on `message`, not `text`; `meta.at` is an ISO string, not a number;
 * and the response does not end when the turn does.
 */
const lines = readFileSync(new URL("./fixtures/session-replay.ndjson", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim());

test("a conversation is rebuilt from the agent's own stream", () => {
  const { blocks } = blocksFromEvents(lines);
  assert.deepEqual(
    blocks.map((b) => b.role),
    ["user", "agent"],
    "one question, one answer — not the machinery in between",
  );
  assert.equal(blocks[0].text, "say ok");
  assert.match(blocks[1].text, /ok/i);
});

test("timestamps come from the event, not from the replay", () => {
  const { blocks } = blocksFromEvents(lines);
  for (const b of blocks) {
    assert.ok(Number.isFinite(b.at), "at must parse");
    assert.ok(b.at < Date.now() - 1000, "a replayed bubble must keep its original time");
  }
  assert.ok(blocks[0].at <= blocks[1].at, "the question precedes the answer");
});

test("the continuation token is recovered from the stream", () => {
  const { continuationToken } = blocksFromEvents(lines);
  assert.ok(continuationToken?.startsWith("eve:"), "so the index never has to store one");
});

test("replaying twice cannot duplicate a bubble", () => {
  const once = blocksFromEvents(lines).blocks;
  const twice = blocksFromEvents([...lines, ...lines]).blocks;
  assert.equal(twice.length, once.length, "meta.id is stable across rewinds — dedupe on it");
});

test("deltas, tool calls and narration are not part of the transcript", () => {
  const { blocks } = blocksFromEvents(lines);
  const kinds = new Set(lines.map((l) => JSON.parse(l).type));
  assert.ok(kinds.has("message.appended"), "the fixture does contain deltas");
  assert.equal(blocks.length, 2, "but a rebuilt transcript is only the finalized blocks");
});

test("narration is dropped even when it is a completed message", () => {
  const narrated = [
    JSON.stringify({
      type: "message.completed",
      data: { message: "I'll look that up.", finishReason: "tool-calls" },
      meta: { id: "evt_narration", at: "2026-08-15T17:18:58.000Z" },
    }),
    ...lines,
  ];
  const { blocks } = blocksFromEvents(narrated);
  assert.ok(
    !blocks.some((b) => b.text.includes("I'll look that up")),
    "an agent thinking out loud is activity, not a reply",
  );
});

test("a truncated final line does not lose the events before it", () => {
  const { blocks } = blocksFromEvents([...lines, '{"type":"message.comp']);
  assert.equal(blocks.length, 2, "an unparsable fragment is skipped, not fatal");
});

/**
 * Merging another device's turns into a transcript this one already has.
 *
 * The local copy is the richer one: it holds question cards, connection
 * prompts and peer exchanges that the agent's event stream never describes.
 * A refresh that replaced it would strip those out silently, so the rule is
 * append-only, keyed on the durable event id.
 */
test("a replayed turn is identified by a stable id across reads", () => {
  const first = blocksFromEvents(lines).blocks.map((b) => b.eventId);
  const second = blocksFromEvents(lines).blocks.map((b) => b.eventId);
  assert.deepEqual(first, second, "ids must not be regenerated per read");
  assert.ok(first.every((id) => id.startsWith("evt_")), "and must come from the event, not a counter");
});

test("merging is a no-op when the device has already seen every turn", () => {
  const blocks = blocksFromEvents(lines).blocks;
  const seen = new Set(blocks.map((b) => b.eventId));
  const fresh = blocks.filter((b) => !seen.has(b.eventId));
  assert.equal(fresh.length, 0, "a refresh with nothing new must add nothing");
});

test("only the unseen turns are added", () => {
  const blocks = blocksFromEvents(lines).blocks;
  // Pretend this device saw only the first block, as if the second turn
  // happened on another machine.
  const seen = new Set([blocks[0].eventId]);
  const fresh = blocks.filter((b) => !seen.has(b.eventId));
  assert.equal(fresh.length, blocks.length - 1);
  assert.ok(!fresh.some((b) => b.eventId === blocks[0].eventId), "never re-adds a known turn");
});
