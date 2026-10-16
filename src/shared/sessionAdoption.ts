/**
 * Which of the account's threads an agent's chat should show — decided without
 * touching state, so the rules can be tested against the exact sequences that
 * broke them.
 *
 * The model is main's (v0.5.17): only the directory's NEWEST thread per agent
 * is a candidate, and a thread the person picked on purpose (`sessionChoice`)
 * stays unless the directory's newest moved AFTER the pick.
 *
 * "New conversation" is a pick too: a pick of NO thread, recorded as a choice
 * without a session id. Without it, a chat with no session read as "adopt the
 * newest", and within one sync tick (≤30 s) the conversation the person just
 * left came back. A thread with activity after the fresh start — another device
 * genuinely talking — is still adopted.
 */

export interface DirectoryEntry {
  sessionId: string;
  lastMessageAt?: string | null;
}

/** A thread picked on purpose, and when. No `sessionId` = "New conversation". */
export interface SessionChoice {
  sessionId?: string;
  at: number;
}

export type AdoptionDecision =
  | { kind: "skip" }
  /** This device's thread is the newer one: tell the directory about it. */
  | { kind: "publish"; localAt: number }
  | { kind: "adopt"; sessionId: string };

const entryAt = (e: DirectoryEntry): number => (e.lastMessageAt ? Date.parse(e.lastMessageAt) : 0);

/** The directory's newest row, or undefined. */
export function newestEntry<E extends DirectoryEntry>(entries: readonly E[]): E | undefined {
  let newest: E | undefined;
  for (const entry of entries) if (!newest || entryAt(entry) > entryAt(newest)) newest = entry;
  return newest;
}

/**
 * Decide for ONE agent, given the directory rows that resolve to it.
 */
export function decideAdoption(input: {
  entries: readonly DirectoryEntry[];
  localSession: string | undefined;
  /** When this device last saw activity in its thread; 0 if never. */
  localAt: number;
  choice: SessionChoice | undefined;
}): AdoptionDecision {
  const { entries, localSession, localAt, choice } = input;
  const newest = newestEntry(entries);
  if (!newest || newest.sessionId === localSession) return { kind: "skip" };
  const remoteAt = entryAt(newest);
  // A thread the person opened on purpose — or a fresh start they asked for —
  // stays unless the directory's newest moved AFTER they picked.
  if (choice && choice.sessionId === localSession && remoteAt <= choice.at) return { kind: "skip" };
  if (localSession && localAt >= remoteAt) return { kind: "publish", localAt };
  return { kind: "adopt", sessionId: newest.sessionId };
}

/**
 * The state change for adopting `sessionId`: a new session, the stream cursor
 * dropped (it belongs to the thread being left), and the view emptied so the
 * caller can hydrate the adopted thread into it. Nothing is destroyed — the
 * earlier thread is still durable on the agent and in the conversation picker.
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
    conversations: { ...state.conversations, [agentId]: [] },
    streamIndexes,
  };
}
