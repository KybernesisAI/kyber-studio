import type { ReactNode } from "react";

/** What the chat says when the agent no longer has the conversation on screen (KYB-657). */
export const GONE_LINE = "This conversation is no longer available on";

/**
 * Drawn where a conversation ended on the agent. Since eve 0.80 the agent
 * deletes a private conversation's history when its run ends, so it can be
 * neither read again nor continued there. What is above this line, if
 * anything, is this device's own copy, and the next message starts a new
 * conversation.
 *
 * On an agent that keeps one thread per person it is drawn only over a
 * conversation opened from the drawer, since the thread itself carries on.
 * That conversation is read-only, and the composer's own card offers the way
 * back to the thread, so the notice only says why.
 *
 * The action is offered only while this is the last thing in the chat: once
 * the person has carried on below it, the way forward is already taken.
 */
export function GoneNotice({
  agentName,
  oneThread,
  hasCopy,
  showAction,
  onNewConversation,
}: {
  agentName: string;
  /** The agent keeps one thread per person: the composer below offers the way back, so this says only why. */
  oneThread: boolean;
  /** Something of the conversation is on screen above the notice. */
  hasCopy: boolean;
  showAction: boolean;
  onNewConversation: () => void;
}): ReactNode {
  return (
    <div className="card stack-row" role="status" data-testid="gone-notice">
      <span style={{ flex: 1 }} className="muted">
        {GONE_LINE} {agentName}. It has ended there, and the agent no longer keeps its history.{" "}
        {hasCopy ? "What is above is this device's copy." : "Studio has no copy of it on this device."}{" "}
        {oneThread ? null : "Anything you send now starts a new conversation."}
      </span>
      {showAction && !oneThread ? (
        <button className="btn" onClick={onNewConversation}>
          New conversation
        </button>
      ) : null}
    </div>
  );
}
