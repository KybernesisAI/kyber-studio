/**
 * Which of the account's threads an agent's chat should show — decided without
 * touching state, so the rules can be tested against the exact sequences that
 * broke them.
 *
 * Two rules, both earned by data loss:
 *
 * 1. **A fresh start waits for the user.** After "New conversation" the agent
 *    has no local session on purpose. The directory still lists every earlier
 *    thread, and "no local session" used to read as "adopt the newest one" — so
 *    within one sync tick the chat switched to the retired session, and once
 *    that id was blocked, to the next-older one. Now nothing whose last
 *    activity predates the latest divider is a candidate. A thread with
 *    activity AFTER the divider (another device, genuinely newer) still is.
 *
 * 2. **Adopting never deletes local blocks.** The old adoption set the
 *    transcript to `[]` and refilled it from the adopted session, which
 *    destroyed everything the stream never described — the divider, the
 *    archived conversation above it, cards, questions. Adoption now changes
 *    the session and leaves the blocks; the caller merges the replay in.
 */

export interface DirectoryEntry {
  sessionId: string;
  lastMessageAt?: string | null;
}

export interface AdoptionBlock {
  kind: string;
  at: number;
}

export type AdoptionDecision =
  | { kind: "skip" }
  /** This device's thread is the newer one: tell the directory about it. */
  | { kind: "publish"; localAt: number }
  | { kind: "adopt"; sessionId: string };

/** When the latest "New conversation" was pressed; 0 if never. */
export function lastDividerAt(blocks: readonly AdoptionBlock[]): number {
  let at = 0;
  for (const b of blocks) if (b.kind === "divider" && b.at > at) at = b.at;
  return at;
}

/**
 * A fresh start that has not been answered yet: no session, and nothing said
 * since the divider. The one state in which no existing thread may be adopted,
 * whatever the source claims.
 */
export function freshStartPending(localSession: string | undefined, blocks: readonly AdoptionBlock[]): boolean {
  return !localSession && blocks.length > 0 && blocks[blocks.length - 1].kind === "divider";
}

const entryAt = (e: DirectoryEntry): number => (e.lastMessageAt ? Date.parse(e.lastMessageAt) : 0);

/**
 * Decide for ONE agent, given the directory rows that resolve to it.
 */
export function decideAdoption(input: {
  entries: readonly DirectoryEntry[];
  localSession: string | undefined;
  localBlocks: readonly AdoptionBlock[];
  retired: readonly string[];
}): AdoptionDecision {
  const { entries, localSession, localBlocks, retired } = input;
  const freshSince = lastDividerAt(localBlocks);

  let newest: DirectoryEntry | undefined;
  for (const entry of entries) {
    if (retired.includes(entry.sessionId)) continue;
    // Older than the fresh start: the conversation the person chose to leave,
    // or one even older than that. Never a candidate.
    if (freshSince > 0 && entryAt(entry) <= freshSince) continue;
    if (!newest || entryAt(entry) > entryAt(newest)) newest = entry;
  }
  if (!newest || newest.sessionId === localSession) return { kind: "skip" };

  const localAt = localBlocks.reduce((max, b) => (b.at > max ? b.at : max), 0);
  if (localSession && localAt >= entryAt(newest)) return { kind: "publish", localAt };
  return { kind: "adopt", sessionId: newest.sessionId };
}

/**
 * The state change for adopting `sessionId`: a new session, the stream cursor
 * dropped (it belongs to the thread being left), and the transcript UNTOUCHED.
 */
export function adoptedState<B>(
  state: {
    sessions: Record<string, string | undefined>;
    conversations: Record<string, B[]>;
    streamIndexes: Record<string, number | undefined>;
  },
  agentId: string,
  sessionId: string,
): {
  sessions: Record<string, string | undefined>;
  conversations: Record<string, B[]>;
  streamIndexes: Record<string, number | undefined>;
} {
  const streamIndexes = { ...state.streamIndexes };
  delete streamIndexes[agentId];
  return {
    sessions: { ...state.sessions, [agentId]: sessionId },
    conversations: state.conversations,
    streamIndexes,
  };
}
