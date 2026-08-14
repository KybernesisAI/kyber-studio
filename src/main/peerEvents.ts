/**
 * Reading agent-to-agent traffic out of an eve event stream.
 *
 * Its own module with no Electron imports, so it can be exercised against a
 * recorded stream rather than by hand in a running app — the transport's
 * shapes were guessed wrong repeatedly, and a guess that typechecks is still a
 * guess. test/fixtures/a2a-kyber-sid.jsonl is a real Kyber→Sid exchange.
 */

/** Peer calls in flight, keyed by call id, so a result finds its asker. */
export interface PeerState {
  pending: Map<string, string>;
  last: string | null;
}

/**
 * Agent-to-agent traffic, read out of the event stream.
 *
 * Exported and pure so it can be replayed against a recorded stream — the
 * shapes below are not guesses, they are what a real Kyber→Sid hop emitted, and
 * the fixture in test/fixtures is that exact exchange.
 *
 * Two things are easy to get wrong here and both were:
 * - A remote peer is not a distinct event. eve lowers it to an ordinary tool
 *   call whose only argument is the message; `kind` is the only marker.
 * - Its answer arrives in the SAME `subagent-result` shape a local subagent
 *   produces, with the call id nested inside `result`. Matching on anything
 *   looser captions a local delegation as a message from a remote agent.
 */
export function readPeerEvents(
  type: string,
  data: Record<string, unknown>,
  state: PeerState,
): { direction: "inbound" | "outbound"; peer: string; text: string }[] {
  const out: { direction: "inbound" | "outbound"; peer: string; text: string }[] = [];

  if (type === "actions.requested") {
    for (const raw of Array.isArray(data.actions) ? data.actions : []) {
      const action = raw as Record<string, unknown>;
      if (action.kind !== "remote-agent-call") continue;
      const peer =
        (typeof action.name === "string" && action.name) ||
        (typeof action.remoteAgentName === "string" && action.remoteAgentName) ||
        null;
      if (!peer) continue;
      const callId =
        (typeof action.callId === "string" && action.callId) ||
        (typeof action.id === "string" && action.id) ||
        null;
      const args = (action.input ?? {}) as Record<string, unknown>;
      const asked =
        (typeof args.message === "string" && args.message) ||
        (typeof args.text === "string" && args.text) ||
        (typeof args.prompt === "string" && args.prompt) ||
        "";
      state.pending.set(callId ?? peer, peer);
      state.last = callId ?? peer;
      if (asked) out.push({ direction: "outbound", peer, text: asked });
    }
    return out;
  }

  if (type === "action.result" && state.pending.size > 0) {
    const result = (data.result ?? {}) as Record<string, unknown>;
    const callId =
      (typeof result.callId === "string" && result.callId) ||
      (typeof data.callId === "string" && data.callId) ||
      (typeof data.actionId === "string" && data.actionId) ||
      null;
    // With an id, match it or ignore the event: a local subagent finishing is
    // not the remote peer answering. Only an id-less stream falls back.
    const key: string | null = callId
      ? state.pending.has(callId)
        ? callId
        : null
      : state.last;
    const peer = key ? state.pending.get(key) : undefined;
    if (key && peer) {
      state.pending.delete(key);
      if (key === state.last) state.last = null;
      const answered = peerReplyText(data.result);
      if (answered) out.push({ direction: "inbound", peer, text: answered });
    }
  }

  return out;
}

/**
 * The peer's answer, out of whatever shape the result arrived in.
 *
 * A remote agent returns free text, but the harness may wrap it: a string, a
 * { text } object, or the content-array shape tools use. Reading only the first
 * of those showed an empty exchange for a peer that had answered perfectly.
 */
function peerReplyText(result: unknown): string {
  if (typeof result === "string") return result.trim();
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  for (const key of ["text", "message", "output", "reply"]) {
    if (typeof r[key] === "string") return (r[key] as string).trim();
  }
  const content = r.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        const p = part as Record<string, unknown>;
        return typeof p?.text === "string" ? p.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}
