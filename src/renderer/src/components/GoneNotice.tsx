import type { ReactNode } from "react";

/** What the chat says when the agent no longer has the conversation on screen (KYB-657). */
export const GONE_LINE = "This conversation is no longer available on";

/**
 * Drawn where a conversation ended on the agent. Since eve 0.80 the agent
 * deletes a private conversation's history when its run ends, so it can be
 * neither read again nor continued there. What is above this line is this
 * device's own copy, and the next message starts a new conversation.
 *
 * The action is offered only while this is the last thing in the chat: once
 * the person has carried on below it, the way forward is already taken.
 */
export function GoneNotice({
  agentName,
  oneThread,
  showAction,
  onNewConversation,
  onBackToThread,
}: {
  agentName: string;
  /** The agent keeps one thread per person: the way back is that thread, not a new conversation. */
  oneThread: boolean;
  showAction: boolean;
  onNewConversation: () => void;
  onBackToThread: () => void;
}): ReactNode {
  return (
    <div className="card stack-row" role="status" data-testid="gone-notice">
      <span style={{ flex: 1 }} className="muted">
        {GONE_LINE} {agentName}. It ended there, and the agent deleted its history when it did. What is above is
        this device's copy.{" "}
        {oneThread ? "Anything you send now goes to your thread." : "Anything you send now starts a new conversation."}
      </span>
      {showAction ? (
        oneThread ? (
          <button className="btn" onClick={onBackToThread}>
            Back to your thread
          </button>
        ) : (
          <button className="btn" onClick={onNewConversation}>
            New conversation
          </button>
        )
      ) : null}
    </div>
  );
}
