/**
 * Whether an agent's answer means a conversation no longer exists there (KYB-657).
 *
 * Since eve 0.80 a private session's stored history is deleted as soon as its
 * run ends, so the conversation Studio has open can disappear at any moment:
 * an upgrade, a failed turn or the session timeout ends the run, and from then
 * on every read of it is refused. Studio used to treat that refusal like a
 * stream that had merely closed, and asked again at once, for ever.
 *
 * Only answers to a READ of a session Studio already holds (the watch and the
 * history replay) are judged here. A send has its own rules: eve answers a
 * send to an ended session with 409 `session_not_active`, and `sendTurn`
 * already starts a fresh session for that.
 *
 * - 410 `session_expired`: the run ended and its history is past retention.
 * - 404: eve has no run for that id ("Session not found.").
 * - 409 `session_stranded`: the session's durable owner is gone ("This session
 *   is no longer available."). Other 409s are not about the session being gone.
 */
export type GoneReason = "expired" | "missing" | "stranded";

export function sessionGoneReason(status: number, body?: string, code?: string): GoneReason | null {
  if (status === 410) return "expired";
  if (status === 404) return "missing";
  if (status === 409) return (code ?? codeFrom(body)) === "session_stranded" ? "stranded" : null;
  return null;
}

function codeFrom(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as { code?: unknown };
    return typeof parsed?.code === "string" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

/** What a history read returns instead of a transcript when the conversation has gone. */
export interface ReplayGone {
  gone: GoneReason;
}

export function isReplayGone(value: unknown): value is ReplayGone {
  return typeof value === "object" && value !== null && typeof (value as { gone?: unknown }).gone === "string";
}
