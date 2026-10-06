import { type ReactNode, useState } from "react";
import type { Block } from "@shared/types";
import { type SpendRequestAsk, type VaultItemAsk, money, vaultSavedAnswer } from "@shared/asks";
import { useStore } from "@/lib/store";
import { Icon } from "./primitives";
import { AddForm } from "./Vault";

type QuestionBlock = Extract<Block, { kind: "question" }>;
export type Answer = { optionId?: string; text?: string; label?: string };

/**
 * The agent needs a login, card or address that is not in the vault.
 *
 * Three ways out, all without the secret touching the agent: save it to the
 * vault right here (Studio stores it on the account and answers with the new
 * item's id), take over the agent's screen and type it yourself, or cancel.
 */
export function VaultAskCard({ block, ask, text, onAnswer }: { block: QuestionBlock; ask: VaultItemAsk; text: string; onAnswer(a: Answer): void }): ReactNode {
  const { setComputerOpen, computerOpen, activeAgentId, computers } = useStore();
  const [adding, setAdding] = useState(true);
  const hasComputer = Boolean(computers[activeAgentId]);
  const what = ask.kind === "login" ? "a login" : ask.kind === "card" ? "a card" : ask.kind === "address" ? "an address" : "contact details";
  const site = ask.site ? host(ask.site) : null;
  const initial: Record<string, string> = {};
  if (ask.label) initial.label = ask.label;
  else if (site) initial.label = site;
  if (ask.kind === "login" && ask.site) initial.origin = originOf(ask.site);

  return (
    <div className="ask">
      <div className="ask__title" style={{ marginBottom: 4 }}>
        Needs {what}
        {site ? <> for <strong>{site}</strong></> : null}
      </div>
      {ask.reason ? <div className="muted" style={{ marginBottom: 10 }}>{ask.reason}</div> : text ? <div className="muted" style={{ marginBottom: 10 }}>{text}</div> : null}
      {adding ? (
        <AddForm
          kind={ask.kind}
          initial={initial}
          compact
          onCancel={() => setAdding(false)}
          onSaved={async (item) => {
            onAnswer({ text: vaultSavedAnswer(item.id), label: `Saved “${item.label}” to the vault` });
          }}
        />
      ) : null}
      <div className="ask__options" style={{ marginTop: adding ? 8 : 0 }}>
        {!adding ? (
          <button className="btn btn--primary" onClick={() => setAdding(true)}>
            Add to vault
          </button>
        ) : null}
        <button
          className="btn"
          disabled={!hasComputer}
          title={hasComputer ? "Opens the agent's screen so you can type it yourself; nothing is saved." : "This agent has no computer to take over."}
          onClick={() => {
            if (!computerOpen) setComputerOpen(true);
            onAnswer({ optionId: "manual", label: "Typing it on the agent's screen" });
          }}
        >
          I'll type it myself
        </button>
        <button className="btn" onClick={() => onAnswer({ optionId: "cancel", label: "Cancelled" })}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A purchase waiting for the person's approval in Link.
 *
 * Link's approval happens in the Link app; this card opens it, then takes the
 * person's word that it is done ("I approved it") and the agent checks with
 * Link before spending. Cancel cancels the spend request itself.
 */
export function SpendRequestCard({ ask, text, onAnswer }: { block: QuestionBlock; ask: SpendRequestAsk; text: string; onAnswer(a: Answer): void }): ReactNode {
  const merchant = ask.merchant ?? (ask.merchant_url ? host(ask.merchant_url) : "a merchant");
  return (
    <div className="ask">
      <div className="ask__title" style={{ marginBottom: 2 }}>
        Purchase approval
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{money(ask.amount, ask.currency)}</span>
        <span className="muted">
          at {merchant}
          {ask.merchant_url ? <> · {host(ask.merchant_url)}</> : null}
        </span>
      </div>
      {text && !ask.approval_url ? <div className="muted" style={{ marginBottom: 8 }}>{text}</div> : null}
      <div className="ask__options">
        {ask.approval_url ? (
          <button className="btn btn--primary" onClick={() => void window.studio?.openExternal(ask.approval_url!)}>
            <Icon name="chevronRight" size={12} /> Approve in Link
          </button>
        ) : null}
        <button className="btn" onClick={() => onAnswer({ optionId: "approved", label: "Approved in Link" })}>
          I approved it
        </button>
        <button className="btn" onClick={() => onAnswer({ optionId: "cancel", label: "Purchase cancelled" })}>
          Cancel purchase
        </button>
      </div>
      <div className="muted" style={{ marginTop: 8, fontSize: 11.5 }}>
        Approving in Link issues a one-time card for exactly this amount. The agent checks with Link before paying.
      </div>
    </div>
  );
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}
