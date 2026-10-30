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
 * - 404: eve has no run for that id. eve gives this 404 no code to match.
 *   The installed eve (0.81.1, dist/src/eve-channel/request.js) answers it
 *   with, verbatim:
 *
 *     Response.json({error:n?`Session not found.`:`Session stream unavailable.`,ok:!1},{status:n?404:503})
 *
 *   while the 410 beside it carries code:`session_expired`. So only the
 *   shape is checked: a JSON body whose `error` is a string. A server
 *   framework whose own 404 has a string `error` would also pass. A hosting
 *   platform in front of the agent also answers 404 when the deployment is not
 *   up or the URL is wrong (Vercel in plain text, or with an `error` object;
 *   Render in plain text; Railway with a `message`), and the conversation may
 *   be alive behind it. Being gone is saved and permanent, so anything that is
 *   not plainly eve is left to the ordinary retry.
 *
 * Not gone: 409 `session_stranded` ("This session is no longer available.").
 * The session's durable owner is another eve version, so it can no longer be
 * followed or continued, but its recorded history can still be read with a
 * bounded read (`follow=false`). See {@link isSessionStranded}. Other 409s
 * are not about the session at all.
 */
export type GoneReason = "expired" | "missing";

export function sessionGoneReason(status: number, body?: string, code?: string): GoneReason | null {
  if (status === 410) return "expired";
  if (status === 404) return isEveNotFound(body) ? "missing" : null;
  return null;
}

/**
 * The agent refused to FOLLOW the session because it is stranded (409
 * `session_stranded`): built by another eve version, so it cannot be followed
 * or continued. Its history is still there, and a bounded read returns it
 * (eve: "A bounded read only reads recorded history, so it also works for a
 * stranded session"). Studio stops watching it and keeps reading it.
 */
export function isSessionStranded(status: number, body?: string, code?: string): boolean {
  return status === 409 && (code ?? codeFrom(body)) === "session_stranded";
}

function isEveNotFound(body: string | undefined): boolean {
  if (!body) return false;
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    return typeof parsed?.error === "string";
  } catch {
    return false;
  }
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
