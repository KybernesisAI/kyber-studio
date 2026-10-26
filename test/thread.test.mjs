import assert from "node:assert/strict";
import { test } from "node:test";
import { newReports, placeThreadBlocks, readThreadView, recapOf, reportLabel, threadBlocks } from "../src/shared/thread.ts";

const view = (over = {}) => ({
  current: "s_1",
  sessions: [{ id: "s_1", at: "2026-10-26T06:00:00.000Z" }],
  reports: [],
  fresh: [],
  ...over,
});

const report = (over = {}) => ({
  id: "run_1:0",
  kind: "report",
  routine: "daily-calendar",
  text: "Two meetings today.",
  at: "2026-10-26T07:00:00.000Z",
  runSessionId: "run_1",
  ...over,
});

test("an agent without threads answers with something else, and is read as none", () => {
  assert.equal(readThreadView(null), null);
  assert.equal(readThreadView({ ok: false, error: "no" }), null);
  assert.deepEqual(readThreadView({ current: null, sessions: [], reports: [] }), { current: null, sessions: [], reports: [], fresh: [] });
});

test("a report becomes a labelled block, and a routine's question a question for its own run", () => {
  const blocks = threadBlocks(
    view({
      reports: [
        report({ cards: [{ card: "artifact", title: "Daily calendar", data: {} }] }),
        report({
          id: "run_2:0",
          kind: "question",
          text: "Send it?",
          runSessionId: "run_2",
          requests: [{ requestId: "req_1", prompt: "Send it?", kind: "tool-approval", action: { toolName: "send_email", input: { to: "a@b.c" } }, options: [{ id: "approve", label: "Approve" }] }],
        }),
      ],
      fresh: ["2026-10-26T08:00:00.000Z"],
    }),
  );
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].kind, "report");
  assert.equal(blocks[0].id, "report:run_1:0");
  assert.equal(blocks[0].cards.length, 1);
  assert.equal(blocks[1].kind, "question");
  assert.equal(blocks[1].runSessionId, "run_2");
  assert.equal(blocks[1].requestId, "req_1");
  assert.equal(blocks[1].approval.tool, "send_email");
  assert.equal(blocks[1].answered, undefined);
  assert.deepEqual({ kind: blocks[2].kind, label: blocks[2].label }, { kind: "divider", label: "Started fresh" });
});

test("a question answered elsewhere shows as answered", () => {
  const [q] = threadBlocks(view({ reports: [report({ kind: "question", settled: true, requests: [{ requestId: "r", prompt: "Ok?" }] })] }));
  assert.equal(q.answered, "Answered");
});

test("thread blocks go in by time, and placing them twice adds nothing", () => {
  const conv = [
    { kind: "text", id: "u1", role: "user", text: "morning", at: Date.parse("2026-10-26T06:30:00.000Z") },
    { kind: "text", id: "a1", role: "agent", text: "hi", at: Date.parse("2026-10-26T07:30:00.000Z") },
  ];
  const add = threadBlocks(view({ reports: [report()] }));
  const once = placeThreadBlocks(conv, add);
  assert.deepEqual(once.map((b) => b.id), ["u1", "report:run_1:0", "a1"]);
  assert.deepEqual(placeThreadBlocks(once, add).map((b) => b.id), ["u1", "report:run_1:0", "a1"]);
});

test("an answer given here is not undone by a read from before it", () => {
  const q = { kind: "question", id: "rq:x:r", at: 1, requestId: "r", prompt: "Ok?", runSessionId: "run", answered: "Approve" };
  const stale = { ...q, answered: undefined };
  assert.equal(placeThreadBlocks([q], [stale])[0].answered, "Approve");
});

test("only reports this device has not shown are new", () => {
  const v = view({ reports: [report(), report({ id: "run_3:0" }), report({ id: "run_4:0", kind: "question", settled: true })] });
  assert.deepEqual(newReports(v, new Set(["run_1:0"])).map((r) => r.id), ["run_3:0"]);
});

test("the recap is the end of what was said, never cards or questions", () => {
  const conv = [
    { kind: "text", id: "u1", role: "user", text: "Book the dentist", at: 1 },
    { kind: "question", id: "q", at: 2, requestId: "r", prompt: "Tuesday?" },
    { kind: "text", id: "a1", role: "agent", text: "Booked for Tuesday.", at: 3 },
  ];
  assert.equal(recapOf(conv), "This conversation continues from an earlier session. The last exchanges were:\nPerson: Book the dentist\nYou: Booked for Tuesday.");
  assert.equal(recapOf([]), undefined);
});

test("reports are labelled in words", () => {
  assert.equal(reportLabel("magic"), "Heads-up");
  assert.equal(reportLabel("daily-calendar"), "Routine · Daily calendar");
  assert.equal(reportLabel(""), "Routine");
});
