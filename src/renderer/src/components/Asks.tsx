import { type ReactNode, useState } from "react";
import { cardTitle, formAnswer, type FormField, type KnownCard } from "@kybernesis/cards";
import type { Block } from "@shared/types";
import { type SpendRequestAsk, type VaultItemAsk, money, vaultSavedAnswer } from "@shared/asks";
import { useStore } from "@/lib/store";
import { ApprovalBody } from "./Cards";
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
export function SpendRequestCard({ block, ask, text, onAnswer }: { block: QuestionBlock; ask: SpendRequestAsk; text: string; onAnswer(a: Answer): void }): ReactNode {
  const merchant = ask.merchant ?? (ask.merchant_url ? host(ask.merchant_url) : "a merchant");
  // Answered, the same card stays with its outcome, so the purchase is still on record in the thread.
  if (block.answered) {
    const cancelled = block.answeredOption === "cancel" || /cancel/i.test(block.answered);
    return (
      <div className="kcard kcard--spend is-done">
        <div className="kcard__head">
          <span className="kcard__title">Purchase approval</span>
          <span className={`kpill${cancelled ? "" : " is-good"}`}>{cancelled ? "Cancelled" : "Approved"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{money(ask.amount, ask.currency)}</span>
          <span className="muted">at {merchant}</span>
        </div>
      </div>
    );
  }
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

/** What an approval decided, in the words its card uses. */
function approvalOutcome(block: QuestionBlock): { label: string; good: boolean } {
  if (block.answeredOption === "approve") return { label: "Approved", good: true };
  if (/changes/i.test(block.answered ?? "")) return { label: "Sent back with changes", good: false };
  return { label: "Declined", good: false };
}

/**
 * A tool waiting for the person's yes, drawn as what it would do.
 *
 * eve's approval carries the call's real input, so an email shows its
 * recipients, subject and body and an event its time and people, instead of
 * "Allow gmail send email?". Edit sends it back with the changes in the
 * person's words; the agent makes the call again and asks again, so nothing
 * goes out that was not approved as written.
 */
export function ApprovalAskCard({ block, card, onAnswer }: { block: QuestionBlock; card: Extract<KnownCard, { card: "approval" }>; onAnswer(a: Answer): void }): ReactNode {
  const d = card.data;
  const editable = d.kind !== "action" && (d.subject !== undefined || d.body !== undefined);
  const [editing, setEditing] = useState(false);
  const [subject, setSubject] = useState(d.subject ?? "");
  const [body, setBody] = useState(d.body ?? "");
  const title = cardTitle(card) ?? d.action;
  const sends = d.kind === "email" || d.kind === "message";

  if (block.answered) {
    const outcome = approvalOutcome(block);
    return (
      <div className="kcard kcard--approval is-done">
        <div className="kcard__head">
          <span className="kcard__title">{title}</span>
          <span className={`kpill${outcome.good ? " is-good" : ""}`}>{outcome.label}</span>
        </div>
        {d.subject ? <div className="muted">{d.subject}</div> : null}
      </div>
    );
  }

  const sendBack = (): void => {
    const lines = ["Not as written. Make it again with these changes, then ask me again."];
    if (subject.trim() !== (d.subject ?? "")) lines.push(`${d.kind === "event" ? "Title" : "Subject"}: ${subject.trim()}`);
    if (body !== (d.body ?? "")) lines.push(`${d.kind === "event" ? "Description" : "Body"}:\n${body.trim()}`);
    onAnswer({ optionId: "cancel", text: lines.join("\n"), label: "Sent back with changes" });
  };

  return (
    <div className="kcard kcard--approval">
      <div className="kcard__head">
        <span className="kcard__title">{title}</span>
        {d.service ? <span className="klabel kcard__source">{d.service}</span> : null}
      </div>
      {editing ? (
        <div className="kform">
          {d.subject !== undefined ? (
            <label className="kform__field">
              <span className="klabel">{d.kind === "event" ? "Event" : "Subject"}</span>
              <input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </label>
          ) : null}
          <label className="kform__field">
            <span className="klabel">{d.kind === "event" ? "Description" : "Message"}</span>
            <textarea className="input kform__long" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        </div>
      ) : (
        <ApprovalBody data={d} />
      )}
      <div className="kcard__actions">
        {editing ? (
          <>
            <button className="btn btn--primary" onClick={sendBack}>
              Send back with changes
            </button>
            <button className="btn" onClick={() => setEditing(false)}>
              Never mind
            </button>
          </>
        ) : (
          <>
            <button className="btn btn--primary" onClick={() => onAnswer({ optionId: "approve", label: "Approved" })}>
              {sends ? (d.action === "Save draft" ? "Save it" : "Send it") : "Approve"}
            </button>
            {editable ? (
              <button className="btn" onClick={() => setEditing(true)}>
                Edit
              </button>
            ) : null}
            <button className="btn" onClick={() => onAnswer({ optionId: "cancel", label: "Declined" })}>
              {sends ? "Don't send" : "Decline"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FieldInput({ field, value, onChange }: { field: FormField; value: string; onChange(v: string): void }): ReactNode {
  if (field.kind === "long") {
    return <textarea className="input kform__long" rows={4} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
  if (field.kind === "choice" && field.options?.length) {
    return (
      <div className="kform__choices">
        {field.options.map((o) => (
          <button key={o} type="button" className={`btn btn--small${value === o ? " btn--primary" : ""}`} onClick={() => onChange(o)}>
            {o}
          </button>
        ))}
      </div>
    );
  }
  const type = field.kind === "number" ? "number" : field.kind === "date" ? "date" : field.kind === "email" ? "email" : "text";
  return <input className="input" type={type} value={value} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * The agent asking for several things at once. Studio draws the fields; the
 * answer goes back as one `formAnswer` line the tool reads, and the
 * transcript keeps the values in words.
 */
export function FormAskCard({ block, card, text, onAnswer }: { block: QuestionBlock; card: Extract<KnownCard, { card: "form" }>; text: string; onAnswer(a: Answer): void }): ReactNode {
  const fields = card.data.fields;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.id, f.value ?? ""])));
  const missing = fields.some((f) => f.required && !values[f.id]?.trim());
  const cancel = block.options?.find((o) => o.id === "cancel");

  if (block.answered) {
    return (
      <div className="kcard kcard--form is-done">
        <div className="kcard__head">
          <span className="kcard__title">{card.title ?? "Your answers"}</span>
          <span className={`kpill${block.answeredOption === "cancel" ? "" : " is-good"}`}>{block.answeredOption === "cancel" ? "Skipped" : "Sent"}</span>
        </div>
        {block.answeredOption === "cancel" ? null : <div className="kcard__text">{block.answered}</div>}
      </div>
    );
  }

  const submit = (): void => {
    const filled = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    const summary = fields.filter((f) => filled[f.id]).map((f) => `${f.label}: ${filled[f.id]}`).join("\n");
    onAnswer({ text: formAnswer(filled), label: summary || "Sent" });
  };

  return (
    <div className="kcard kcard--form">
      <div className="kcard__head">
        <span className="kcard__title">{card.title ?? "A few details"}</span>
        <span className="klabel kcard__source">Question</span>
      </div>
      {text ? <div className="muted" style={{ marginBottom: 10 }}>{text}</div> : null}
      <div className="kform">
        {fields.map((f) => (
          <label key={f.id} className="kform__field">
            <span className="klabel">
              {f.label}
              {f.required ? " *" : ""}
            </span>
            <FieldInput field={f} value={values[f.id] ?? ""} onChange={(v) => setValues((cur) => ({ ...cur, [f.id]: v }))} />
          </label>
        ))}
      </div>
      <div className="kcard__actions">
        <button className="btn btn--primary" disabled={missing} onClick={submit}>
          {card.data.submit ?? "Send"}
        </button>
        {cancel ? (
          <button className="btn" onClick={() => onAnswer({ optionId: cancel.id, label: cancel.label })}>
            {cancel.label}
          </button>
        ) : null}
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
