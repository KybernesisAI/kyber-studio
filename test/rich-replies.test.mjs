import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blocksFromEvents, reconcile, workFromEvents } from "../src/shared/sessionReplay.ts";
import { placeCards } from "@/lib/placeCards";
import { Markdown } from "@/components/Markdown";
import { CardView, withUnit } from "@/components/Cards";
import { WorkSteps } from "@/components/Work";

/**
 * Rich replies: the steps under a turn, the cards its tools returned, and the
 * markdown a reply is drawn with.
 *
 * Steps and cards are read off the agent's own stream, so they are tested
 * against one: a recorded delegation (anonymised), and a synthetic turn whose
 * tool returned cards in the shape eve puts on `action.result`.
 */

const recorded = readFileSync(new URL("./fixtures/agent-to-agent-tasks.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.trim());

const at = (n) => new Date(Date.UTC(2026, 9, 23, 9, 0, n)).toISOString();
const line = (type, data, n) => JSON.stringify({ type, data, meta: { id: `evt_${n}`, at: at(n) } });

const stats = { kyb: 1, card: "stats", title: "Last 7 days", source: "PostHog", data: { tiles: [{ label: "Visitors", value: "12,480", change: "+8%", tone: "good" }] } };
const chart = { kyb: 1, card: "chart", id: "traffic", data: { kind: "line", x: ["Mon", "Tue", "Wed"], series: [{ name: "Visitors", values: [10, 30, 20] }] } };

/** One turn: a memory recall, a PostHog query that returns two cards, then the answer. */
const turn = [
  line("turn.started", { turnId: "turn_1" }, 1),
  line("message.received", { message: "how was traffic this week?", turnId: "turn_1" }, 2),
  line("actions.requested", {
    turnId: "turn_1",
    actions: [{ callId: "c1", kind: "tool-call", toolName: "arcana__arcana_recall", input: {} }],
    presentation: { c1: { label: "Recalling the traffic goal" } },
  }, 3),
  line("action.result", { turnId: "turn_1", status: "completed", result: { callId: "c1", kind: "tool-call", toolName: "arcana__arcana_recall", output: { facts: [] } } }, 4),
  line("actions.requested", { turnId: "turn_1", actions: [{ callId: "c2", kind: "tool-call", toolName: "posthog__query_trends", input: {} }] }, 5),
  line("action.result", {
    turnId: "turn_1",
    status: "completed",
    result: { callId: "c2", kind: "tool-call", toolName: "posthog__query_trends", output: { rows: 3, kyb: [stats, chart] } },
  }, 6),
  line("message.completed", { message: "Traffic is up 8% on last week.", finishReason: "stop", turnId: "turn_1" }, 7),
  line("session.waiting", { turnId: "turn_1" }, 8),
];

test("a recorded delegation becomes one step, settled when its task settles", () => {
  const work = workFromEvents(recorded);
  assert.equal(work.length, 1, "one turn did work");
  const [step] = work[0].steps;
  assert.equal(step.chip, "Field ops");
  assert.equal(step.status, "done", "the receipt alone is not the end; task.settled is");
  assert.ok(step.label.length > 0);
});

test("a turn's steps and cards are rebuilt from the stream, the same on every read", () => {
  const first = workFromEvents(turn);
  const second = workFromEvents(turn);
  assert.deepEqual(first, second, "replay is deterministic");
  assert.equal(first.length, 1);
  const { steps, turnId } = first[0];
  assert.equal(turnId, "turn_1");
  assert.deepEqual(steps.map((s) => [s.chip, s.status]), [["Memory", "done"], ["PostHog", "done"]]);
  assert.equal(steps[0].label, "Recalling the traffic goal", "eve's own label is used when the tool has one");
  assert.deepEqual(steps[1].cards.map((c) => c.card), ["stats", "chart"]);
});

test("the agent's copy of a turn's work replaces the one drawn live, matched on call ids", () => {
  const [w] = workFromEvents(turn);
  const live = { kind: "work", id: "w123", at: w.at, turnId: "turn_1", steps: w.steps.slice(0, 1) };
  const replayed = { kind: "work", id: "work-s-turn_1", at: w.at, turnId: "turn_1", steps: w.steps };
  const other = { kind: "work", id: "w999", at: w.at + 1, steps: [{ ...w.steps[0], callId: "c-other" }] };
  const merged = reconcile([live, other], [replayed]);
  assert.deepEqual(merged.map((b) => b.id), ["work-s-turn_1", "w999"]);
});

test("cards are drawn under the reply that follows the work, not above it", () => {
  const [w] = workFromEvents(turn);
  const blocks = [
    { kind: "text", id: "u1", role: "user", text: "how was traffic?", at: 1 },
    { kind: "work", id: "w1", at: 2, steps: w.steps },
    { kind: "text", id: "a1", role: "agent", text: "Up 8%.", at: 3 },
  ];
  const { under, atWork } = placeCards(blocks);
  assert.deepEqual(under.get("a1")?.map((c) => c.card), ["stats", "chart"]);
  assert.equal(atWork.size, 0);
});

test("until the reply arrives, or when there is none, cards stay with the steps", () => {
  const [w] = workFromEvents(turn);
  const working = placeCards([
    { kind: "text", id: "u1", role: "user", text: "q", at: 1 },
    { kind: "work", id: "w1", at: 2, steps: w.steps },
  ]);
  assert.equal(working.atWork.get("w1")?.length, 2);
  const interrupted = placeCards([
    { kind: "work", id: "w1", at: 2, steps: w.steps },
    { kind: "text", id: "u2", role: "user", text: "never mind", at: 3 },
    { kind: "text", id: "a2", role: "agent", text: "ok", at: 4 },
  ]);
  assert.equal(interrupted.atWork.get("w1")?.length, 2);
  assert.equal(interrupted.under.size, 0, "a reply to a later message does not take an earlier turn's cards");
});

test("in a room, cards go under the reply of the member that did the work", () => {
  const [w] = workFromEvents(turn);
  const { under } = placeCards([
    { kind: "work", id: "w1", at: 1, speakerId: "analyst", steps: w.steps },
    { kind: "text", id: "a1", role: "agent", text: "not me", at: 2, speaker: { id: "planner", name: "planner", accent: "#000" } },
    { kind: "text", id: "a2", role: "agent", text: "here", at: 3, speaker: { id: "analyst", name: "analyst", accent: "#000" } },
  ]);
  assert.equal(under.get("a1"), undefined);
  assert.equal(under.get("a2")?.length, 2);
});

test("a later card with the same id replaces the earlier one", () => {
  const blocks = [
    { kind: "work", id: "w1", at: 1, steps: [
      { callId: "c1", tool: "t", chip: "Tool", label: "one", status: "done", cards: [{ ...chart, title: "first" }] },
      { callId: "c2", tool: "t", chip: "Tool", label: "two", status: "done", cards: [{ ...chart, title: "second" }] },
    ] },
    { kind: "text", id: "a1", role: "agent", text: "done", at: 2 },
  ];
  assert.deepEqual(placeCards(blocks).under.get("a1")?.map((c) => c.title), ["second"]);
});

const html = (el) => renderToStaticMarkup(el);
const md = (text) => html(createElement(Markdown, { text }));

test("markdown: a block with no text draws nothing instead of crashing", () => {
  // What an older Studio meets when a newer one saved a block kind it does not know.
  assert.doesNotThrow(() => md(undefined));
});

test("markdown: tables, numbered lists that keep their start, quotes and task lists", () => {
  const out = md("| Page | Views |\n|:--|--:|\n| /pricing | 1,204 |\n\n3. third\n4. fourth\n\n> quoted\n\n- [x] done\n- [ ] open");
  assert.match(out, /<table>/);
  assert.match(out, /text-align:right/);
  assert.match(out, /<ol class="md-ol" start="3">/);
  assert.match(out, /<blockquote class="md-quote">/);
  assert.match(out, /md-task--done/);
  assert.match(out, /md-task--open/);
  assert.doesNotMatch(out, /\[x\]|\[ \]/, "the task markers are drawn, not printed");
});

test("markdown: raw HTML is text, and only http(s) and mailto links are links", () => {
  const out = md('<script>alert(1)</script> [bad](javascript:alert(1)) [good](https://example.com)');
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;/);
  assert.doesNotMatch(out, /href="javascript/);
  assert.match(out, /href="https:\/\/example.com"/);
});

test("markdown: a fence still being streamed renders as code, with its copy button", () => {
  const out = md("Here:\n\n```ts\nconst a = 1;");
  assert.match(out, /class="code"/);
  assert.match(out, /const a = 1;/);
  assert.match(out, /code__lang">ts</);
});

const ctx = { agentUrl: "https://agent.example", onSay() {}, onOpenArtifact() {} };
const draw = (card) => html(createElement(CardView, { card, ctx }));

test("every known card type draws, with its title and source", () => {
  const cards = [
    stats,
    chart,
    { kyb: 1, card: "table", data: { columns: [{ key: "p", label: "Page" }, { key: "v", label: "Views", align: "right" }], rows: [{ p: "/", v: 10 }], total: 40 } },
    { kyb: 1, card: "checklist", data: { items: [{ text: "Build", state: "done" }, { text: "Ship", state: "waiting" }] } },
    { kyb: 1, card: "brief", data: { name: "Example Co", subtitle: "Prospect", points: ["Series A"], facts: [{ label: "Size", value: "40" }] } },
    { kyb: 1, card: "link", data: { url: "https://example.com", title: "Example" } },
    { kyb: 1, card: "screenshot", data: { image: "/eve/v1/kyb/files/shot.png", caption: "Checkout" } },
    { kyb: 1, card: "file", data: { url: "https://example.com/a.pdf", name: "a.pdf", size: 2048 } },
    { kyb: 1, card: "artifact", title: "Weekly report", data: { artifactId: "a1", version: 2, format: "html" } },
    { kyb: 1, card: "pull-request", data: { repo: "acme/web", number: 7, title: "Fix nav", url: "https://example.com/pr/7", additions: 3, deletions: 1, checks: [{ name: "ci", state: "passed" }], diff: { file: "nav.ts", lines: ["+a", "-b"] } } },
    { kyb: 1, card: "receipt", data: { merchant: "Store", amount: 255600, currency: "usd", orderId: "A-1" } },
    { kyb: 1, card: "remembered", data: { fact: "Prefers mornings" } },
    { kyb: 1, card: "routine", data: { name: "Digest", schedule: "Every Monday at 9:00 AM", posts: ["Slack"] } },
  ];
  for (const card of cards) {
    const out = draw(card);
    assert.match(out, new RegExp(`kcard--${card.card}`), `${card.card} draws`);
  }
  assert.match(draw(stats), /Last 7 days/);
  assert.match(draw(stats), /PostHog/);
  assert.match(draw(stats), /is-good/);
  assert.match(draw(cards[10]), /\$2,556\.00/);
  assert.match(draw(cards[2]), /Showing 1 of 40 rows/);
  assert.match(draw(cards[8]), />Open</, "an artifact always offers Open");
});

test("a card of a type this app does not know draws its text", () => {
  const out = draw({ kyb: 1, card: "weather", title: "Forecast", text: "Sunny, 21°" });
  assert.match(out, /kcard--unknown/);
  assert.match(out, /Sunny, 21°/);
});

test("steps: live while running, folded to one line when done, stopped when the turn ended mid-call", () => {
  const steps = workFromEvents(turn)[0].steps;
  const running = [{ ...steps[0] }, { ...steps[1], status: "running" }];
  assert.match(html(createElement(WorkSteps, { steps: running, live: true })), /step__chip">PostHog</);
  const folded = html(createElement(WorkSteps, { steps, live: false }));
  assert.match(folded, /Used Memory and PostHog · 2 steps/);
  assert.doesNotMatch(folded, /step__chip/);
  // A turn that ended while a call was running is not spinning forever.
  const stopped = html(createElement(WorkSteps, { steps: running, live: false }));
  assert.match(stopped, /Used Memory and PostHog/);
});

test("a background turn the agent started shows only its reply", () => {
  const { blocks } = blocksFromEvents([
    line("message.received", { message: "[kyb:magic] check the inbox for anything urgent", turnId: "turn_9" }, 1),
    line("message.completed", { message: "Nothing urgent this morning.", finishReason: "stop", turnId: "turn_9" }, 2),
    line("message.received", { message: "thanks", turnId: "turn_10" }, 3),
  ]);
  assert.deepEqual(blocks.map((b) => [b.role, b.text]), [["agent", "Nothing urgent this morning."], ["user", "thanks"]]);
});

test("chart units read as words, a week of bars labels every day, a document artifact shows a preview", () => {
  assert.equal(withUnit("30", "emails"), "30 emails");
  assert.equal(withUnit("2.5", "%"), "2.5%");
  assert.equal(withUnit("12", undefined), "12");
  const days = ["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"];
  const bars = draw({ kyb: 1, card: "chart", data: { kind: "bar", x: days, series: [{ name: "Inbox", values: [3, 5, 8, 2, 9, 4, 30] }], unit: "emails" } });
  for (const d of days) assert.match(bars, new RegExp(`<span>${d}</span>`), `${d} is labelled`);
  assert.match(bars, /30 emails/);
  const doc = draw({ kyb: 1, card: "artifact", title: "Calendar", data: { artifactId: "a1", display: "document", format: "html" } });
  assert.match(doc, /kartifact__preview/);
  const inline = draw({ kyb: 1, card: "artifact", title: "Chart", data: { artifactId: "a2", display: "inline", format: "html" } });
  assert.doesNotMatch(inline, /kartifact__preview/);
});

test("open steps turn their arrow", () => {
  const steps = workFromEvents(turn)[0].steps;
  const running = [{ ...steps[0] }, { ...steps[1], status: "running" }];
  assert.doesNotMatch(html(createElement(WorkSteps, { steps, live: false })), /work__toggle--open/);
  assert.doesNotMatch(html(createElement(WorkSteps, { steps: running, live: true })), /work__toggle--open/, "no toggle while it works");
});
