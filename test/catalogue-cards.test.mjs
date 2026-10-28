import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { approvalCard, cardPrompt, formPrompt, parseCardPrompt, readFormAnswer } from "@kybernesis/cards";
import { readInputRequests } from "../src/shared/asks.ts";
import { workFromEvents } from "../src/shared/sessionReplay.ts";
import { ApprovalAskCard, FormAskCard, SpendRequestCard } from "@/components/Asks";
import { CardView } from "@/components/Cards";

/**
 * The card catalogue's asks: an approval drawn as the email or event it would
 * send, a form, a purchase that stays on record once answered, and the cards
 * Studio makes itself from a stream (a memory save).
 */

const html = (el) => renderToStaticMarkup(el);
const noop = () => {};
const question = (extra = {}) => ({ kind: "question", id: "q1", at: 0, requestId: "r1", prompt: "Approve Send email?", ...extra });

const email = {
  to: ["dana@example.com"],
  cc: "lee@example.com",
  subject: "Thursday",
  body: "Hi Dana,\n\nThursday at 2 works for me.",
};

test("an approval request keeps the call it holds, and a question does not invent one", () => {
  const [approval, plain] = readInputRequests({
    requests: [
      { kind: "tool-approval", requestId: "r1", prompt: "Approve Send email?", options: [{ id: "approve", label: "Approve" }, { id: "cancel", label: "Cancel" }], action: { kind: "tool-call", callId: "c1", toolName: "gmail__send_email", input: email } },
      { kind: "question", requestId: "r2", prompt: "Which one?", action: { kind: "tool-call", callId: "c2", toolName: "ask_question", input: { prompt: "Which one?" } } },
    ],
  });
  assert.deepEqual(approval.approval, { tool: "gmail__send_email", input: email });
  assert.equal(approval.options.length, 2);
  assert.equal(plain.approval, undefined);
  assert.equal(plain.prompt, "Which one?");
});

test("an email approval shows who, what and the words, with Send it, Edit and Don't send", () => {
  const card = approvalCard("gmail__send_email", email, "r1");
  const out = html(createElement(ApprovalAskCard, { block: question(), card, onAnswer: noop }));
  for (const piece of ["Send email", "Gmail", "dana@example.com", "lee@example.com", "Thursday", "Thursday at 2 works for me.", "Send it", "Edit", "Don&#x27;t send"]) {
    assert.ok(out.includes(piece), piece);
  }
  assert.ok(!out.includes("Allow"), "not the old tool-name prompt");
});

test("an event approval shows its time, place and people", () => {
  const card = approvalCard("googlecalendar__create_event", {
    summary: "Planning review",
    start: { dateTime: "2026-10-29T14:00:00Z" },
    end: { dateTime: "2026-10-29T15:00:00Z" },
    location: "Room 4",
    attendees: [{ email: "dana@example.com" }],
  });
  const out = html(createElement(ApprovalAskCard, { block: question(), card, onAnswer: noop }));
  for (const piece of ["Create event", "Planning review", "When", "Room 4", "dana@example.com", "Approve", "Decline"]) assert.ok(out.includes(piece), piece);
});

test("an answered approval stays as the thing with its outcome", () => {
  const card = approvalCard("gmail__send_email", email);
  const approved = html(createElement(ApprovalAskCard, { block: question({ answered: "Approved", answeredOption: "approve" }), card, onAnswer: noop }));
  assert.match(approved, /Approved/);
  assert.match(approved, /Thursday/);
  const declined = html(createElement(ApprovalAskCard, { block: question({ answered: "Declined", answeredOption: "cancel" }), card, onAnswer: noop }));
  assert.match(declined, /Declined/);
});

test("a form ask draws its fields and the answer reads back as values", () => {
  const prompt = formPrompt(
    [
      { id: "arrival", label: "Arrival date", kind: "date", required: true },
      { id: "room", label: "Room", kind: "choice", options: ["Single", "Double"] },
      { id: "notes", label: "Anything else", kind: "long" },
    ],
    "I need a few details to book the hotel.",
    { title: "Hotel booking" },
  );
  const carded = parseCardPrompt(prompt);
  const out = html(createElement(FormAskCard, { block: question({ prompt, options: [{ id: "cancel", label: "Never mind" }] }), card: carded.card, text: carded.text, onAnswer: noop }));
  for (const piece of ["Hotel booking", "Arrival date", "Single", "Double", "Anything else", "Send", "Never mind", "I need a few details"]) assert.ok(out.includes(piece), piece);
  assert.deepEqual(readFormAnswer('[kyb:form] {"arrival":"2026-11-02"}'), { values: { arrival: "2026-11-02" } });
});

test("a purchase stays on record once approved or cancelled", () => {
  const ask = { id: "lsrq_1", amount: 4299, currency: "usd", merchant: "Example Store", status: "pending_approval" };
  const approved = html(createElement(SpendRequestCard, { block: question({ answered: "Approved in Link", answeredOption: "approved" }), ask, text: "", onAnswer: noop }));
  assert.match(approved, /Approved/);
  assert.match(approved, /Example Store/);
  assert.match(approved, /42\.99/);
  const cancelled = html(createElement(SpendRequestCard, { block: question({ answered: "Purchase cancelled", answeredOption: "cancel" }), ask, text: "", onAnswer: noop }));
  assert.match(cancelled, /Cancelled/);
});

test("a memory save in a replayed turn becomes a remembered card with Correct it and Forget it", () => {
  const ev = (type, data, n) => JSON.stringify({ type, data, meta: { id: `e${n}`, at: new Date(Date.UTC(2026, 9, 24, 9, 0, n)).toISOString() } });
  const events = [
    ev("turn.started", { turnId: "t1" }, 1),
    ev("actions.requested", { turnId: "t1", actions: [{ callId: "m1", kind: "tool-call", toolName: "arcana__memory__arcana_remember", input: { text: "Dana prefers morning meetings." } }] }, 2),
    ev("action.result", { turnId: "t1", status: "completed", result: { callId: "m1", kind: "tool-call", toolName: "arcana__memory__arcana_remember", output: { ok: true } } }, 3),
  ];
  const work = workFromEvents(events);
  const cards = work.flatMap((w) => w.steps ?? []).flatMap((s) => s.cards ?? []);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].card, "remembered");
  const out = html(createElement(CardView, { card: cards[0], ctx: { onSay: noop, onOpenArtifact: noop } }));
  for (const piece of ["Dana prefers morning meetings.", "Correct it", "Forget it", "Memory"]) assert.ok(out.includes(piece), piece);
});

test("a card ask is not mistaken for an approval", () => {
  const prompt = cardPrompt({ kyb: 1, card: "link", data: { url: "https://example.com" } }, "Here it is.");
  const [q] = readInputRequests({ requests: [{ kind: "question", requestId: "r9", prompt, action: { kind: "tool-call", callId: "x", toolName: "show", input: {} } }] });
  assert.equal(q.approval, undefined);
});
