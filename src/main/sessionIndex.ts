import { activeSession, ISSUER } from "./controlPlane";
import {
  blocksFromEvents,
  type Replayed,
  type ReplayedBlock,
  type ReplayedPeerBlock,
} from "../shared/sessionReplay";
import { readPeerEvents } from "./peerEvents";

export { blocksFromEvents };
export type { Replayed, ReplayedBlock, ReplayedPeerBlock };

/**
 * The same conversations on every machine you sign in from.
 *
 * Studio kept the map of "this chat is that session" in a JSON file next to the
 * app. Everything else about an account is central — the agents, the grants,
 * the connections — so signing in on a second machine produced an app that was
 * correct in every respect except that it had never met you. The conversations
 * were not lost; nothing knew where to look for them.
 *
 * Two halves, deliberately separate:
 *
 *   - This file keeps a DIRECTORY in the control plane: which sessions are
 *     mine, with which agent, last touched when. Small, per-person, and free of
 *     conversation content.
 *   - {@link replaySession} reads the CONVERSATION from the agent, which has
 *     had it all along — the event stream is durable and replays from the
 *     start with stable ids.
 *
 * Keeping them apart is what stops the control plane accumulating a second
 * copy of everyone's conversations, and it means a device that has been away
 * for a month catches up by asking the agent rather than by syncing a diff.
 */

export interface IndexedSession {
  agent: string;
  sessionId: string;
  label?: string | null;
  title?: string | null;
  lastMessageAt?: string | null;
  lastMessagePreview?: string | null;
}

/** This person's threads, newest first. Empty on any failure — never fatal. */
export async function listSessions(agent?: string): Promise<IndexedSession[]> {
  const s = await activeSession();
  // Logged at both ends: "asked and got nothing" and "never asked" are
  // different faults with the same symptom, and guessing between them is how
  // an afternoon goes.
  if (!s) {
    console.log("[index] list skipped — no active control-plane session");
    return [];
  }
  console.log(`[index] listing threads${agent ? ` for ${agent}` : ""} …`);
  try {
    const url = new URL(`${ISSUER}/api/sessions`);
    if (agent) url.searchParams.set("agent", agent);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${s.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.log(`[index] list failed ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { sessions?: IndexedSession[] };
    const rows = body.sessions ?? [];
    console.log(`[index] ${rows.length} thread(s) known to this account`);
    return rows;
  } catch (error) {
    // A directory that cannot be reached must not stop someone using the app
    // on the machine they are already sitting at.
    console.log(`[index] list error: ${(error as Error)?.message ?? String(error)}`);
    return [];
  }
}

/** Record or update one thread. Fire and forget: the local copy is authoritative. */
export async function recordSession(entry: {
  agent: string;
  sessionId: string;
  label?: string;
  title?: string;
  lastMessageAt?: number;
  lastMessagePreview?: string;
  archived?: boolean;
}): Promise<void> {
  const s = await activeSession();
  if (!s) {
    console.log("[index] not signed in — thread not recorded");
    return;
  }
  try {
    const res = await fetch(`${ISSUER}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
      body: JSON.stringify(entry),
      signal: AbortSignal.timeout(15_000),
    });
    /**
     * Say when this fails.
     *
     * Recording is non-blocking on purpose, and the first version swallowed the
     * outcome entirely — so a rejected call looked exactly like a working one
     * until someone opened their other machine and found nothing there. A sync
     * that fails quietly is worse than one that fails loudly: it costs you the
     * trust you had in it retroactively, for every thread you assumed was safe.
     */
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.log(`[index] record failed ${res.status}: ${detail.slice(0, 200)}`);
      return;
    }
    console.log(`[index] recorded ${entry.agent} ${entry.sessionId.slice(0, 20)}`);
  } catch (error) {
    console.log(`[index] record error: ${(error as Error)?.message ?? String(error)}`);
  }
}

/**
 * Rebuild a conversation from the agent's own event stream.
 *
 * Only finalized blocks are kept. The stream also carries every delta, every
 * tool call, and the agent's narration before it acts — replaying those would
 * reproduce the machinery of a conversation rather than the conversation, and
 * narration in particular arrives as a completed message whose finishReason is
 * "tool-calls". Rendering those as replies is how a transcript ends up reading
 * like someone thinking out loud.
 *
 * Bounded on purpose. A year-old thread can hold tens of thousands of events,
 * and opening it should not mean reading all of them; `limit` reads from the
 * tail and reports that it did.
 */
export async function replaySession(input: {
  url: string;
  sessionId: string;
  limit?: number;
}): Promise<Replayed | null> {
  const s = await activeSession();
  if (!s?.bundle) return null;

  const base = input.url.replace(/\/$/, "");
  const limit = input.limit ?? 400;

  // A negative startIndex reads relative to the tail, which is exactly the
  // "last N events" this needs — and avoids pulling a long history to throw
  // most of it away.
  const endpoint = `${base}/eve/v1/session/${encodeURIComponent(input.sessionId)}/stream?startIndex=-${limit}&includeTailIndex=1`;

  try {
    const res = await fetch(endpoint, {
      headers: { authorization: `Bearer ${s.token}`, "x-kybernesis-bundle": s.bundle },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok || !res.body) return null;

    const tailHeader = res.headers.get("x-eve-stream-tail-index");
    const tail = tailHeader === null ? -1 : Number(tailHeader);
    /**
     * How many events this read will produce before it is caught up.
     *
     * `includeTailIndex=1` REPORTS the tail; it does not end the response. The
     * stream follows the live session either way, so a reader that waits for
     * the connection to close waits forever — which is the same mistake that
     * made every agent-to-agent call time out against a long-lived host. The
     * cursor is ours to advance and ours to stop.
     */
    const expected = tail < 0 ? 0 : Math.min(limit, tail + 1);

    // Collect the raw lines, then parse once. The transport concern here is
    // knowing when to stop; what the events MEAN is blocksFromEvents' job, and
    // keeping them apart is what lets the parser be tested against a captured
    // stream instead of only against a live agent.
    const lines: string[] = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      // Keep the trailing fragment: chunk boundaries land mid-line often
      // enough that dropping it loses whole events under load.
      buffer = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) lines.push(line);

      if (expected > 0 && lines.length >= expected) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (buffer.trim()) lines.push(buffer);

    const { blocks, continuationToken } = blocksFromEvents(lines);

    /**
     * Rebuild the agent-to-agent exchanges too, with the same reader the live
     * stream uses.
     *
     * Reusing it rather than writing a second parser is the point: peer traffic
     * has already been misread twice, and two implementations of the same rule
     * drift the moment one of them is fixed.
     */
    const peerBlocks: ReplayedPeerBlock[] = [];
    const peerState = { pending: new Map<string, string>(), last: null as string | null };
    for (const line of lines) {
      let event: { type?: string; data?: Record<string, unknown>; meta?: { at?: string } };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const found = readPeerEvents(event.type ?? "", event.data ?? {}, peerState);
      if (found.length === 0) continue;
      const turnId = String((event.data as { turnId?: unknown })?.turnId ?? "turn");
      const at = event.meta?.at ? Date.parse(String(event.meta.at)) : Date.now();
      const open = peerBlocks.find((b) => b.turnId === turnId);
      if (open) open.events.push(...found);
      else peerBlocks.push({ turnId, at: Number.isNaN(at) ? Date.now() : at, events: [...found] });
    }

    return {
      blocks,
      peerBlocks,
      continuationToken,
      streamIndex: tail >= 0 ? tail + 1 : lines.length,
      truncated: tail >= 0 && tail + 1 > limit,
    };
  } catch {
    return null;
  }
}
