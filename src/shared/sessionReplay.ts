/**
 * Turning a recorded event stream back into a conversation.
 *
 * Its own module, with no electron and no network in it, because the only way
 * to know this parser is right is to run it over a stream a real agent actually
 * produced — and a module that reaches the app cannot be loaded by a test. The
 * same reason peerEvents lives apart.
 */
export interface ReplayedBlock {
  /** "agent" to match the app's own vocabulary — the stream says "assistant". */
  role: "user" | "agent";
  text: string;
  at: number;
  /** The event's durable id, so replaying twice cannot duplicate a bubble. */
  eventId: string;
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

export interface Replayed {
  blocks: ReplayedBlock[];
  /** Agent-to-agent exchanges, one entry per turn that had any. */
  peerBlocks: ReplayedPeerBlock[];
  /** The live continuation token, read off the stream rather than stored. */
  continuationToken?: string;
  /** How many events were consumed, so streaming can resume after them. */
  streamIndex: number;
  /** True when older events were skipped to bound the read. */
  truncated: boolean;
}

/** Turn recorded stream events into the bubbles a transcript is made of. */
export function blocksFromEvents(lines: string[], limit = Number.POSITIVE_INFINITY): { blocks: ReplayedBlock[]; continuationToken?: string; consumed: number } {
  const blocks: ReplayedBlock[] = [];
  const seen = new Set<string>();
  let continuationToken: string | undefined;
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
      blocks.push({ role: "agent", text: data.message, at, eventId: id });
    } else if (event.type === "message.received") {
      const text = typeof data.message === "string" ? data.message : "";
      if (!text || seen.has(id)) continue;
      seen.add(id);
      blocks.push({ role: "user", text, at, eventId: id });
    } else if (event.type === "session.waiting") {
      if (typeof data.continuationToken === "string") continuationToken = data.continuationToken;
    }
  }
  return { blocks, continuationToken, consumed };
}


/** The subset of a transcript block this reconciliation needs to reason about. */
export interface ReconcilableBlock {
  kind: string;
  id: string;
  at: number;
  role?: string;
  text?: string;
  events?: { text: string }[];
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
export function reconcile<T extends ReconcilableBlock>(local: T[], replayed: T[]): T[] {
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

    // Cards, prompts, anything else this device drew: the stream never
    // described them, so nothing can stand in for them.
    return true;
  });

  return [...replayed, ...keep].sort((a, b) => a.at - b.at);
}
