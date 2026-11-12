import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  StreamDecoder,
  answersBody,
  createStreamMemory,
  declineOptionId,
  decodeLines,
  resolveStart,
  streamVersionOf,
} from "../src/shared/eveStream.ts";
import { readInputRequests } from "../src/shared/asks.ts";
import { isHeldForInput } from "../src/main/turnBoundary.ts";
import { blocksFromEvents } from "../src/shared/sessionReplay.ts";

/**
 * eve 1.0 serves stream version 27. The fixtures in test/fixtures/eve-v27 are
 * real reads from an eve 1.0.0-rc.10 agent with a scripted model: a plain
 * reply, a tool call, an approval and its answer, a question and its answer,
 * and a delegation to a subagent. Each read starts with a heartbeat, which is
 * no line of the stream.
 */
const fixture = (name) => readFileSync(new URL(`./fixtures/eve-v27/${name}.ndjson`, import.meta.url), "utf8").split("\n");
const decode = (name, start = 0) => decodeLines(fixture(name), 27, start);

test("the version comes from the response header; no header is an older agent", () => {
  assert.equal(streamVersionOf(new Headers({ "x-eve-stream-version": "27" })), 27);
  assert.equal(streamVersionOf(new Headers({ "x-eve-stream-version": "26" })), 26);
  assert.equal(streamVersionOf(new Headers()), 26);
});

test("a v27 reply reads as the v26 events Studio already handles, and the cursor counts lines", () => {
  const { events, cursor } = decode("plain");
  // x-eve-stream-tail-index was 7 for this read: eight stored lines, the heartbeat not among them.
  assert.equal(cursor, 8);
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "session.started",
    "turn.started",
    "message.received",
    "step.started",
    "message.appended",
    "message.completed",
    "step.completed",
    "turn.completed",
    "session.waiting",
  ]);
  const reply = events.find((e) => e.type === "message.completed");
  assert.equal(reply.data.message, "Echo: hello there");
  assert.equal(reply.data.finishReason, "stop");
  assert.equal(reply.data.turnId, "turn_0");
  assert.equal(events.find((e) => e.type === "message.received").data.message, "hello there");
  assert.deepEqual(events.find((e) => e.type === "message.completed").meta.position, { line: 5, index: 0 });
});

test("narration before a tool call is marked tool-calls, so it never becomes the reply", () => {
  const { events } = decode("delegate");
  const said = events.filter((e) => e.type === "message.completed");
  assert.equal(said[0].data.message, "Asking the helper.");
  assert.equal(said[0].data.finishReason, "tool-calls");
  assert.equal(said.at(-1).data.finishReason, "stop");
});

test("an approval reads as input.requested with the waiting call, and the turn is held for input", () => {
  const { events, cursor } = decode("approval");
  assert.equal(cursor, 8);
  const asked = events.find((e) => e.type === "input.requested");
  const [request] = readInputRequests(asked.data);
  assert.equal(request.requestId, "Y1k71YhpCI8PlwtB");
  assert.equal(request.prompt, "Approve Send note?");
  assert.deepEqual(request.approval, { tool: "send_note", input: { to: "planner", body: "Hello" } });
  assert.deepEqual(request.options.map((o) => o.id), ["approve", "deny"]);
  assert.equal(declineOptionId(request.options), "deny");
  const held = events.find((e) => e.type === "turn.waiting");
  assert.ok(isHeldForInput(held.type, held.data));
  // A paused turn is not an ended one.
  assert.ok(!events.some((e) => e.type === "session.waiting"));
});

test("the answered approval runs the call and ends the turn", () => {
  const { events } = decode("approval-answered", 8);
  assert.ok(events.some((e) => e.type === "input.resolved" && e.data.resolutions[0].outcome === "approved"));
  const result = events.find((e) => e.type === "action.result");
  assert.deepEqual(result.data.result.output, { delivered: true, to: "planner" });
  // The answer carried no text, so it is not a message from the person.
  assert.ok(!events.some((e) => e.type === "message.received"));
  assert.equal(events.at(-1).type, "session.waiting");
});

test("a read that resumes after an approval still names the call, given the session's memory", () => {
  const memory = createStreamMemory();
  decodeLines(fixture("approval"), 27, 0, null, memory);
  const { events } = decodeLines(fixture("approval-answered"), 27, 8, null, memory);
  assert.equal(events.find((e) => e.type === "action.result").data.result.toolName, "send_note");
});

test("a question reads with its prompt and options", () => {
  const { events } = decode("question");
  const [request] = readInputRequests(events.find((e) => e.type === "input.requested").data);
  assert.equal(request.prompt, "Which colour?");
  assert.deepEqual(request.options.map((o) => o.id), ["Red", "Blue"]);
  assert.equal(request.allowFreeform, true);
  assert.equal(request.approval, undefined);
});

test("a delegation reports the subagent's answer on task.settled, where peer and step readers look", () => {
  const { events } = decode("delegate");
  const started = events.find((e) => e.type === "task.started");
  assert.equal(started.data.kind, "agent");
  assert.equal(started.data.name, "helper");
  const settled = events.find((e) => e.type === "task.settled");
  assert.equal(settled.data.callId, started.data.callId);
  assert.equal(settled.data.status, "completed");
  assert.match(String(settled.data.output), /Summarize the plan/);
  const requested = events.find((e) => e.type === "actions.requested");
  assert.equal(requested.data.actions[0].kind, "subagent-call");
});

test("heartbeats, lease ends and position markers never move the cursor; stream.ended is noted", () => {
  const decoder = new StreamDecoder(27, 5);
  assert.deepEqual(decoder.push({ $eve: "heartbeat" }), []);
  assert.equal(decoder.cursor, 5);
  decoder.push({ $eve: "stream.lease-ended" });
  assert.equal(decoder.leaseEnded, true);
  assert.equal(decoder.cursor, 5);
  decoder.push({ $eve: "position", next: 9 });
  assert.equal(decoder.cursor, 9);
  decoder.push({ progress: { type: "content.delta", data: { partId: "p", kind: "text", delta: "x" } } });
  assert.equal(decoder.cursor, 10);
  decoder.push({ $eve: "stream.ended" });
  assert.equal(decoder.ended, true);
});

test("a v26 stream passes through untouched, one event per counted line", () => {
  const decoder = new StreamDecoder(26, 3);
  const [event] = decoder.push({ type: "message.completed", data: { message: "hi", finishReason: "stop" }, meta: { at: "x" } });
  assert.equal(event.type, "message.completed");
  assert.equal(event.data.message, "hi");
  assert.equal(decoder.cursor, 4);
  decoder.push({ $eve: "heartbeat" });
  assert.equal(decoder.cursor, 4);
});

test("a negative start counts back from the tail", () => {
  assert.equal(resolveStart(-3, 22), 20);
  assert.equal(resolveStart(-400, 22), 0);
  assert.equal(resolveStart(-3, null), 0);
  assert.equal(resolveStart(7, 22), 7);
});

test("answers go as inputResponses to eve 0.81 and as answers to eve 1.0", () => {
  const given = [{ requestId: "r1", optionId: "approve" }, { requestId: "r2", text: "Blue" }];
  assert.deepEqual(answersBody(26, given), { inputResponses: given });
  assert.deepEqual(answersBody(27, given), {
    answers: [
      { interactionId: "r1", optionId: "approve" },
      { interactionId: "r2", text: "Blue" },
    ],
  });
  assert.equal(declineOptionId([{ id: "approve" }, { id: "cancel" }]), "cancel");
});

test("a replayed v27 conversation becomes the same bubbles as a v26 one", () => {
  const { events } = decode("plain");
  const { blocks } = blocksFromEvents(events.map((e) => JSON.stringify(e)));
  assert.deepEqual(
    blocks.map((b) => [b.role, b.text]),
    [
      ["user", "hello there"],
      ["agent", "Echo: hello there"],
    ],
  );
});
