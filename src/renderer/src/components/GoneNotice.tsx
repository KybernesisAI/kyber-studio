import type { ReactNode } from "react";

/** What the chat says when the agent no longer has the conversation on screen (KYB-657). */
export const GONE_LINE = "This conversation is no longer available on";

/** Said when nothing of the conversation is on screen above the notice (KYB-662). */
export const NO_COPY_LINE = "Studio has no copy of it on this device.";

/**
 * Drawn where a conversation ended on the agent. Since eve 0.80 the agent
 * deletes a private conversation's history when its run ends, so it can be
 * neither read again nor continued there. What is above this line, if
 * anything, is this device's own copy.
 *
 * On an agent that keeps one thread per person it is drawn only over a
 * conversation opened from the drawer: the thread itself carries on, and says
 * so with a line of its own (KYB-662). That conversation is read-only, and the
 * card in place of the composer offers the way back to the thread, so the
 * notice only says why.
 *
 * On an agent with many conversations the next message starts a new one, and
 * the action is offered only while this is the last thing in the chat: once
 * the person has carried on below it, the way forward is already taken.
 *
 * Until the agent's thread has been read this launch, whether it keeps one is
 * known only if an earlier launch saved that it does (KYB-668), and then its
 * own conversation gets the thread's line, not this notice. Otherwise it is
 * not known, and the two kinds of agent need opposite advice: a new
 * conversation there could be Start fresh. So nothing is said about what
 * sending does, and nothing is offered, until it is known.
 */
export function GoneNotice({
  agentName,
  oneThread,
  hasCopy,
  showAction,
  onNewConversation,
}: {
  agentName: string;
  /**
   * The agent keeps one thread per person. Undefined while its thread has not
   * been read yet.
   */
  oneThread: boolean | undefined;
  /** Something of the conversation is on screen above the notice. */
  hasCopy: boolean;
  showAction: boolean;
  onNewConversation: () => void;
}): ReactNode {
  return (
    <div className="card stack-row" role="status" data-testid="gone-notice">
      <span style={{ flex: 1 }} className="muted">
        {GONE_LINE} {agentName}. It has ended there, and the agent no longer keeps its history.{" "}
        {hasCopy ? "What is above is this device's copy." : NO_COPY_LINE}
        {oneThread === false ? " Anything you send now starts a new conversation." : null}
      </span>
      {showAction && oneThread === false ? (
        <button className="btn" onClick={onNewConversation}>
          New conversation
        </button>
      ) : null}
    </div>
  );
}
