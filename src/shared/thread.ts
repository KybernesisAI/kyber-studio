/**
 * One continuous thread per person (@kybernesis/manage 0.30+).
 *
 * The agent keeps one address per person, and the desktop and the phone both
 * talk through it, so they show the same conversation without a directory
 * deciding which thread is newest. Routines run in the background; the agent
 * adds what they produce to the thread as reports, which arrive here through
 * `GET /eve/v1/kyb/thread` and are drawn among the messages by time.
 *
 * Pure functions only, so the rules are tested without a window.
 */

import type { Card } from "@kybernesis/cards";
import { readInputRequests } from "./asks";
import type { Block } from "./types";

/** One report, as the agent's thread route returns it. */
export interface ThreadReport {
  id: string;
  kind: "report" | "question";
  routine: string;
  text: string;
  cards?: Card[];
  at: string;
  runSessionId: string;
  requests?: unknown[];
  settled?: boolean;
}

/** The person's thread on one agent. */
export interface ThreadView {
  /** The session the thread's address holds now; null before the first message. */
  current: string | null;
  sessions: { id: string; at: string }[];
  reports: ThreadReport[];
  /** When the person chose Start fresh, newest last. */
  fresh: string[];
}

/** Read a thread route's answer; anything else is an agent without threads. */
export function readThreadView(data: unknown): ThreadView | null {
  const d = (data ?? {}) as Partial<ThreadView>;
  if (!Array.isArray(d.sessions) || !Array.isArray(d.reports)) return null;
  return {
    current: typeof d.current === "string" ? d.current : null,
    sessions: d.sessions.filter((s) => s && typeof s.id === "string"),
    reports: d.reports.filter((r) => r && typeof r.id === "string" && typeof r.runSessionId === "string"),
    fresh: Array.isArray(d.fresh) ? d.fresh.filter((f) => typeof f === "string") : [],
  };
}

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};

/**
 * The blocks a thread adds to the conversation: each report, each question a
 * routine is waiting on, and a divider where the person started fresh.
 * Ids are stable, so placing them again replaces rather than repeats.
 */
export function threadBlocks(view: ThreadView): Block[] {
  const out: Block[] = [];
  for (const r of view.reports) {
    if (r.kind === "report") {
      out.push({
        kind: "report",
        id: `report:${r.id}`,
        at: time(r.at),
        routine: r.routine,
        text: r.text,
        ...(r.cards?.length ? { cards: r.cards } : {}),
        runSessionId: r.runSessionId,
      });
      continue;
    }
    for (const q of readInputRequests({ requests: r.requests ?? [] })) {
      out.push({
        kind: "question",
        id: `rq:${r.id}:${q.requestId}`,
        at: time(r.at),
        requestId: q.requestId,
        prompt: q.prompt,
        options: q.options,
        allowFreeform: q.allowFreeform,
        ...(q.approval ? { approval: q.approval } : {}),
        runSessionId: r.runSessionId,
        // Answered on another device, or the run ended without an answer.
        ...(r.settled ? { answered: "Answered" } : {}),
      });
    }
  }
  for (const at of view.fresh) {
    out.push({ kind: "divider", id: `fresh:${at}`, at: time(at), label: "Started fresh" });
  }
  return out;
}

/**
 * Put thread blocks into a conversation by time. A block already there is
 * updated in place (a question answered elsewhere), except that an answer
 * given here is never undone by a stale read.
 */
export function placeThreadBlocks(conversation: Block[], add: Block[]): Block[] {
  const out = [...conversation];
  for (const block of add) {
    const at = out.findIndex((b) => b.id === block.id);
    if (at >= 0) {
      const held = out[at]!;
      if (held.kind === "question" && held.answered) continue;
      out[at] = block;
      continue;
    }
    const after = out.findIndex((b) => b.at > block.at);
    if (after < 0) out.push(block);
    else out.splice(after, 0, block);
  }
  return out;
}

/** The reports in a view this device has not shown yet, for a notification. */
export function newReports(view: ThreadView, seen: ReadonlySet<string>): ThreadReport[] {
  return view.reports.filter((r) => !r.settled && !seen.has(r.id));
}

const RECAP_BLOCKS = 8;
const RECAP_TEXT = 400;

/**
 * The end of the conversation this device had before the agent kept threads,
 * for the first message into the thread. The thread starts a new session on
 * the agent, which would not otherwise know what was just said.
 */
export function recapOf(conversation: Block[]): string | undefined {
  const said = conversation.filter((b): b is Extract<Block, { kind: "text" }> => b.kind === "text" && b.text.trim().length > 0);
  const tail = said.slice(-RECAP_BLOCKS);
  if (tail.length === 0) return undefined;
  const lines = tail.map((b) => {
    const text = b.text.length > RECAP_TEXT ? `${b.text.slice(0, RECAP_TEXT)}…` : b.text;
    return `${b.role === "user" ? "Person" : "You"}: ${text}`;
  });
  return `This conversation continues from an earlier session. The last exchanges were:\n${lines.join("\n")}`;
}

/** How a report is labelled in the thread. */
export function reportLabel(routine: string): string {
  if (routine === "magic") return "Heads-up";
  const words = routine.replace(/[-_]+/g, " ").trim();
  return words ? `Routine · ${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Routine";
}
