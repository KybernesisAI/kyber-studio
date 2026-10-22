/**
 * Where a turn stops, for this client.
 *
 * Its own module with no Electron imports so the rule can be tested against
 * recorded streams.
 *
 * eve ≥0.69 no longer ends a turn at a question or sign-in from inside a tool:
 * it emits `turn.waiting` with `on: "input"` and holds the turn open. For
 * Studio that is where the turn stops, exactly as `session.waiting` did on
 * older agents, because nothing more comes until the person answers, and the
 * answer (`respond`) resumes the same turn. Reading on instead would hold the
 * composer behind a turn that cannot move until the composer answers.
 *
 * `turn.waiting` with `on: "tasks"` is not a stop: delegated work is running
 * and the final reply is still to come in this turn.
 */
export const isHeldForInput = (type: string, data: Record<string, unknown>): boolean =>
  type === "turn.waiting" && data.on === "input";
