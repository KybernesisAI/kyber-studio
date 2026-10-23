/**
 * Turning a recorded event stream back into a conversation.
 *
 * Its own module, with no electron and no network in it, because the only way
 * to know this parser is right is to run it over a stream a real agent actually
 * produced — and a module that reaches the app cannot be loaded by a test. The
 * same reason peerEvents lives apart.
 */
import { newStepState, readStep, type Step } from "@kybernesis/cards";

export interface ReplayedBlock {
  /** "agent" to match the app's own vocabulary — the stream says "assistant". */
  role: "user" | "agent";
  text: string;
  at: number;
  /** The event's durable id, so replaying twice cannot duplicate a bubble. */
  eventId: string;
  /** The turn it belongs to; a later answer in the same turn replaces it. */
  turnId?: string;
}

/**
 * One turn's worth of agent-to-agent traffic, rebuilt from the stream.
 *
 * Without it a synced conversation shows the answer an agent gave after
 * consulting a colleague with no sign the consultation ever happened — so the
 * same turn reads as two different events depending which machine you open it
 * on, and the one that syncs is the one missing the evidence.
 */
export interface ReplayedPeerBlock {
  /** The turn it belongs to, which is also what keeps one block per exchange. */
  turnId: string;
  at: number;
  events: { direction: "inbound" | "outbound"; peer: string; text: string }[];
}

/**
 * One turn's tool calls and the cards they returned, rebuilt from the stream
 * with the same reader the live turn uses.
 */
export interface ReplayedWorkBlock {
  turnId: string;
  at: number;
  steps: Step[];
}

export interface Replayed {
  blocks: ReplayedBlock[];
  /** Agent-to-agent exchanges, one entry per turn that had any. */
  peerBlocks: ReplayedPeerBlock[];
  /** Tool steps and cards, one entry per turn that had any. Absent from an older main process. */
  workBlocks?: ReplayedWorkBlock[];
  /** How many events were consumed, so streaming can resume after them. */
  streamIndex: number;
  /** True when older events were skipped to bound the read. */
  truncated: boolean;
}

/** First line of a message the agent sent into the conversation to start background work. */
export const BACKGROUND_TURN_MARKER = "[kyb:magic]";

/** Turn recorded stream events into the bubbles a transcript is made of. */
export function blocksFromEvents(lines: string[], limit = Number.POSITIVE_INFINITY): { blocks: ReplayedBlock[]; consumed: number } {
  const blocks: ReplayedBlock[] = [];
  const seen = new Set<string>();
  let consumed = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (consumed >= limit) break;
    let event: { type?: string; data?: Record<string, unknown>; meta?: { id?: string; at?: string | number } };
    try { event = JSON.parse(line); } catch { continue; }
    consumed += 1;
    const id = event.meta?.id ?? `${event.type}:${consumed}`;
    const parsed = event.meta?.at ? Date.parse(String(event.meta.at)) : Number.NaN;
    const at = Number.isNaN(parsed) ? Date.now() : parsed;
    const data = event.data ?? {};
    if (event.type === "message.completed" && typeof data.message === "string") {
      if (data.finishReason === "tool-calls") continue;
      if (seen.has(id)) continue;
      seen.add(id);
      /**
       * One answer per turn: a later final message REPLACES an earlier one.
       *
       * An agent can end a turn twice — two `message.completed` events with
       * finishReason "stop", seconds apart, both durable. Live, the second
       * overwrites the first because they share a bubble, so a person sees one
       * answer. Replayed, each event became its own block and the same turn
       * showed two near-identical answers, which reads as the agent repeating
       * itself and as a bug in sync. Sync only revealed it.
       *
       * Matching the live rule keeps the two views of one conversation
       * identical, which matters more than preserving an event the app has
       * never shown. Whether the agent SHOULD end a turn twice is a separate
       * question, and not one a transcript reader can answer.
       */
      const openTurn = typeof data.turnId === "string" ? data.turnId : null;
      const previous = openTurn === null ? -1 : blocks.findIndex((b) => b.turnId === openTurn && b.role === "agent");
      if (previous >= 0) blocks.splice(previous, 1);
      blocks.push({ role: "agent", text: data.message, at, eventId: id, turnId: openTurn ?? undefined });
    } else if (event.type === "message.received") {
      const text = typeof data.message === "string" ? data.message : "";
      if (!text || seen.has(id)) continue;
      seen.add(id);
      // A background turn the agent started on its own speaks first as the
      // person; nobody typed it, so only its reply is shown.
      if (text.startsWith(BACKGROUND_TURN_MARKER)) continue;
      blocks.push({ role: "user", text, at, eventId: id });
    }
  }
  return { blocks, consumed };
}


/**
 * Each turn's steps, in order, from recorded stream events.
 *
 * A call whose request fell before the replay window still counts when its
 * result is inside it: the reader builds a step from the result alone, so a
 * card at the edge of the window is not lost.
 */
export function workFromEvents(lines: string[]): ReplayedWorkBlock[] {
  const state = newStepState();
  for (const line of lines) {
    if (!line.trim()) continue;
    let event: { type?: string; data?: unknown; meta?: { at?: unknown } };
    try { event = JSON.parse(line); } catch { continue; }
    readStep(state, event.type ?? "", event.data, event.meta);
  }
  const turns: ReplayedWorkBlock[] = [];
  for (const step of state.steps.values()) {
    const turnId = step.turnId ?? "turn";
    const open = turns.find((t) => t.turnId === turnId);
    if (open) open.steps.push(step);
    else turns.push({ turnId, at: step.at ?? Date.now(), steps: [step] });
  }
  return turns;
}

/** The subset of a transcript block this reconciliation needs to reason about. */
export interface ReconcilableBlock {
  kind: string;
  id: string;
  at: number;
  role?: string;
  text?: string;
  events?: { text: string }[];
  steps?: { callId: string }[];
}

/**
 * A turn's steps, read back from the agent, laid over what this device holds.
 *
 * The agent's copy of a step wins, so a newer reader's chip or line shows on
 * an old reply. But the replay reads only a window of the stream, so a long
 * turn can come back missing its opening steps: those are kept from here.
 */
function mergeSteps<T extends ReconcilableBlock>(block: T, local: T[]): T {
  const fresh = block.steps ?? [];
  const calls = new Set(fresh.map((s) => s.callId));
  const mine = local.find(
    (b) => b.kind === "work" && (b.id === block.id || (b.steps ?? []).some((s) => calls.has(s.callId))),
  );
  const earlier = (mine?.steps ?? []).filter((s) => !calls.has(s.callId));
  if (!earlier.length) return block;
  const byCall = new Map(fresh.map((s) => [s.callId, s]));
  // In this device's order, each step in its newest reading; then any it never saw.
  const known = new Set((mine?.steps ?? []).map((s) => s.callId));
  const steps = [...(mine?.steps ?? []).map((s) => byCall.get(s.callId) ?? s), ...fresh.filter((s) => !known.has(s.callId))];
  return { ...block, steps };
}

/**
 * Merge what the agent remembers with what this device has, without saying
 * anything twice.
 *
 * The trap is that the same message carries two different identities. A block
 * written locally is named by the client (`u1786…`), while the same message
 * read back from the agent is named by the durable event (`evt_01M0…`). Dedupe
 * by id alone and NOTHING ever matches, so every refresh appends the entire
 * conversation again — and because both devices refresh, it compounds until a
 * greeting appears four times.
 *
 * So identity falls back to content. The agent's copy wins where both exist:
 * it carries the durable id, which is what makes the NEXT reconciliation
 * cheap and exact. Local blocks with no counterpart are kept, because they are
 * the things the event stream never described — a failed send, a question
 * card, a turn that has not reached the replay window yet.
 *
 * Matching is one-to-one and in order, so someone who genuinely says "hi"
 * twice keeps both.
 */
export function reconcile<T extends ReconcilableBlock>(local: T[], replayedIn: T[]): T[] {
  const replayed = replayedIn.map((b) => (b.kind === "work" ? mergeSteps(b, local) : b));
  const replayedIds = new Set(replayed.map((b) => b.id));
  const unconsumed = replayed.filter((b) => b.kind === "text");
  const taken = new Set<number>();

  const signature = (b: ReconcilableBlock): string =>
    b.kind === "text"
      ? `t|${b.role}|${(b.text ?? "").trim()}`
      : `p|${(b.events ?? []).map((e) => e.text.trim()).join("¶")}`;

  const keep = local.filter((block) => {
    // Already the agent's own copy — this device read it back earlier.
    if (replayedIds.has(block.id)) return false;

    if (block.kind === "text") {
      const want = signature(block);
      const at = unconsumed.findIndex((r, i) => !taken.has(i) && signature(r) === want);
      if (at >= 0) {
        taken.add(at);
        return false;
      }
      return true;
    }

    if (block.kind === "peer-activity") {
      const want = signature(block);
      return !replayed.some((r) => r.kind === "peer-activity" && signature(r) === want);
    }

    // The same turn's work, drawn live here and read back from the agent: the
    // call ids come from the stream, so they match exactly. The agent's copy
    // wins, because it holds every step even when this device joined late.
    if (block.kind === "work") {
      const calls = new Set((block.steps ?? []).map((s) => s.callId));
      return !replayed.some((r) => r.kind === "work" && (r.steps ?? []).some((s) => calls.has(s.callId)));
    }

    // Cards, prompts, anything else this device drew: the stream never
    // described them, so nothing can stand in for them.
    return true;
  });

  return [...replayed, ...keep].sort((a, b) => a.at - b.at);
}
