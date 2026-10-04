/**
 * Scheduled turns for local agents: the pure half.
 *
 * A schedule is a daily local time and a prompt. It fires as an ordinary turn
 * in the agent's conversation — never as a hidden background run — so the
 * person can see it, read the reply, and ask follow-up questions in place.
 *
 * Due means: today's slot has passed and today's run has not happened. That
 * one rule covers both the on-time fire and the catch-up after Studio was
 * closed at the slot, and it can never fire twice in a day because the run is
 * keyed by the local date.
 */

export interface AgentSchedule {
  /** Local wall-clock time, "HH:MM", 24-hour. */
  at: string;
  /** Sent as the user turn. */
  prompt: string;
}

/** Minutes after midnight, or null when `at` is not a valid HH:MM. */
export function parseAt(at: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** The local calendar date, "YYYY-MM-DD" — the key a day's run is recorded under. */
export function localDateKey(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Whether this schedule should fire now, given the date of its last run. */
export function isDue(schedule: AgentSchedule | undefined, now: Date, lastRun: string | undefined): boolean {
  if (!schedule || !schedule.prompt?.trim()) return false;
  const slot = parseAt(schedule.at);
  if (slot === null) return false;
  if (lastRun === localDateKey(now)) return false;
  return now.getHours() * 60 + now.getMinutes() >= slot;
}
