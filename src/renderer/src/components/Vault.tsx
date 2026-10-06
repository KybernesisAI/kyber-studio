import { type ReactNode, useEffect, useRef, useState } from "react";
import type { VaultAddInput, VaultItem, VaultKind } from "@shared/ipc";
import { useStore } from "@/lib/store";
import { Icon } from "./primitives";

/**
 * The person's vault: logins, cards and addresses their agents can type into
 * a page on their own computer without ever seeing them.
 *
 * Everything on this screen is the SUMMARY half of an item — label, site,
 * username, brand and last four. The secret half is entered once, in the add
 * form, sent to the control plane over the signed-in session, and sealed
 * there; this window keeps no copy and nothing here can show one back.
 */
export function VaultView(): ReactNode {
  const { setPanel } = useStore();
  const [items, setItems] = useState<VaultItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<VaultKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const refresh = async (): Promise<void> => {
    try {
      setItems((await window.studio?.vaultList()) ?? []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  const remove = async (item: VaultItem): Promise<void> => {
    try {
      await window.studio?.vaultRemove(item.id);
      setItems((list) => (list ?? []).filter((i) => i.id !== item.id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const importCsv = async (file: File): Promise<void> => {
    try {
      const rows = parseChromeCsv(await file.text());
      if (!rows.length) {
        setNotice("No logins found in that file. Chrome exports columns name, url, username, password.");
        return;
      }
      const result = await window.studio?.vaultImport(rows);
      setNotice(
        `Imported ${result?.added ?? 0} login${result?.added === 1 ? "" : "s"}${result?.skipped.length ? `, skipped ${result.skipped.length} without a site, username or password` : ""}.`,
      );
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const grouped: Record<VaultKind, VaultItem[]> = { login: [], card: [], address: [], contact: [] };
  for (const item of items ?? []) grouped[item.kind]?.push(item);

  return (
    <>
      <div className="panel__head">
        <button className="topbar__btn" onClick={() => setPanel("settings")} style={{ WebkitAppRegion: "no-drag" } as never}>
          <Icon name="chevronLeft" />
        </button>
        <span className="panel__title">Vault</span>
        <button className="topbar__btn" onClick={() => setPanel("none")} style={{ WebkitAppRegion: "no-drag" } as never}>
          <Icon name="close" />
        </button>
      </div>
      <div className="panel__body">
        <div className="muted" style={{ marginBottom: 10 }}>
          Saved here, sealed on your account. An agent sees labels and usernames, and can type an item into a page on its own computer; it never reads the secret. A login only fills on its own site, and a card asks you first.
        </div>

        {error ? <div className="agent-portrait__error" style={{ marginBottom: 8 }}>{error}</div> : null}
        {notice ? <div className="muted" style={{ marginBottom: 8 }}>{notice}</div> : null}

        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          <button className="btn btn--small" onClick={() => setAdding("login")}>Add login</button>
          <button className="btn btn--small" onClick={() => setAdding("card")}>Add card</button>
          <button className="btn btn--small" onClick={() => setAdding("address")}>Add address</button>
          <button className="btn btn--small" onClick={() => csvRef.current?.click()}>Import Chrome passwords…</button>
          <input
            ref={csvRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importCsv(file);
            }}
          />
        </div>

        {adding ? (
          <AddForm
            kind={adding}
            onCancel={() => setAdding(null)}
            onSaved={async () => {
              setAdding(null);
              await refresh();
            }}
          />
        ) : null}

        {items === null ? <div className="muted">Loading…</div> : null}
        {items && items.length === 0 && !adding ? (
          <div className="muted">Nothing saved yet. Add a login or import the CSV Chrome exports from Settings → Passwords.</div>
        ) : null}

        <Group title="Logins" items={grouped.login} onRemove={remove} render={(i) => `${String(i.summary.username ?? "")} · ${host(i.origin)}`} />
        <Group title="Cards" items={grouped.card} onRemove={remove} render={(i) => `${cap(String(i.summary.brand ?? "card"))} ···· ${String(i.summary.last4 ?? "")} · ${String(i.summary.cardholder ?? "")}`} />
        <Group title="Addresses" items={grouped.address} onRemove={remove} render={(i) => oneLine(i.summary)} />
        <Group title="Contacts" items={grouped.contact} onRemove={remove} render={(i) => oneLine(i.summary)} />
      </div>
    </>
  );
}

function Group({ title, items, render, onRemove }: { title: string; items: VaultItem[]; render(i: VaultItem): string; onRemove(i: VaultItem): void }): ReactNode {
  if (!items.length) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="muted" style={{ marginBottom: 4, fontSize: 11.5, textTransform: "uppercase", letterSpacing: 0.4 }}>{title}</div>
      {items.map((item) => (
        <div key={item.id} className="card stack-row" style={{ marginBottom: 4 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.label}</div>
            <div className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{render(item)}</div>
          </div>
          <button className="btn btn--small" title="Remove" onClick={() => onRemove(item)}>
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

export function AddForm({ kind, onCancel, onSaved, initial, compact }: { kind: VaultKind; onCancel(): void; onSaved(item: VaultItem): Promise<void>; initial?: Record<string, string>; compact?: boolean }): ReactNode {
  const [form, setForm] = useState<Record<string, string>>(initial ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const input = buildInput(kind, form);
      const item = await window.studio?.vaultAdd(input);
      // Nothing from this form survives the save: not in state, not in the DOM.
      setForm({});
      if (item) await onSaved(item);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (k: string, label: string, props: Partial<React.InputHTMLAttributes<HTMLInputElement>> = {}): ReactNode => (
    <div className="field" key={k}>
      <div className="field__label">{label}</div>
      <input className="input" value={form[k] ?? ""} onChange={set(k)} autoComplete="off" spellCheck={false} {...props} />
    </div>
  );

  return (
    <div className={compact ? undefined : "card"} style={compact ? undefined : { marginBottom: 12 }}>
      {compact ? null : <div style={{ marginBottom: 8 }}>{kind === "login" ? "New login" : kind === "card" ? "New card" : "New address"}</div>}
      {field("label", "Label", { placeholder: kind === "login" ? "e.g. GitHub" : kind === "card" ? "e.g. Personal Visa" : "e.g. Home" })}
      {kind === "login" ? (
        <>
          {field("origin", "Site", { placeholder: "https://github.com" })}
          {field("username", "Username or email")}
          {field("password", "Password", { type: "password" })}
        </>
      ) : null}
      {kind === "card" ? (
        <>
          {field("cardholder", "Name on card")}
          {field("number", "Card number", { inputMode: "numeric" })}
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1 }}>{field("exp", "Expires (MM/YY)", { placeholder: "07/29" })}</div>
            <div style={{ flex: 1 }}>{field("cvc", "CVC", { type: "password", inputMode: "numeric" })}</div>
          </div>
        </>
      ) : null}
      {kind === "address" ? (
        <>
          {field("name", "Full name")}
          {field("line1", "Address line 1")}
          {field("line2", "Address line 2")}
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 2 }}>{field("city", "City")}</div>
            <div style={{ flex: 1 }}>{field("state", "State")}</div>
            <div style={{ flex: 1 }}>{field("postal_code", "ZIP")}</div>
          </div>
          {field("country", "Country", { placeholder: "US" })}
          {field("phone", "Phone")}
          {field("email", "Email")}
        </>
      ) : null}
      {error ? <div className="agent-portrait__error">{error}</div> : null}
      <div className="stack-row" style={{ marginTop: 8 }}>
        {compact ? null : <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>}
        <div style={{ flex: 1 }} />
        <button className="btn btn--primary" onClick={() => void submit()} disabled={busy}>{busy ? "Saving…" : compact ? "Save to vault and continue" : "Save"}</button>
      </div>
    </div>
  );
}

function buildInput(kind: VaultKind, f: Record<string, string>): VaultAddInput {
  const label = (f.label ?? "").trim();
  if (!label) throw new Error("Give it a label.");
  if (kind === "login") {
    if (!f.origin || !f.username || !f.password) throw new Error("Site, username and password are all needed.");
    return { kind, label, origin: f.origin.trim(), username: f.username, password: f.password };
  }
  if (kind === "card") {
    const m = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec((f.exp ?? "").trim());
    if (!m) throw new Error("Expiry as MM/YY.");
    const expMonth = Number(m[1]);
    const expYear = m[2]!.length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    if (expMonth < 1 || expMonth > 12) throw new Error("Expiry month must be 1–12.");
    if (!f.number || !f.cardholder) throw new Error("Name and number are needed.");
    return { kind, label, cardholder: f.cardholder.trim(), number: f.number, expMonth, expYear, ...(f.cvc ? { cvc: f.cvc } : {}) };
  }
  const address: Record<string, string> = {};
  for (const k of ["name", "line1", "line2", "city", "state", "postal_code", "country", "phone", "email"]) if (f[k]) address[k] = f[k]!.trim();
  if (!address.line1) throw new Error("Address line 1 is needed.");
  return { kind: "address", label, address };
}

/** Chrome / Google Password Manager export: a header row, then name,url,username,password[,note]. RFC 4180 quoting. */
export function parseChromeCsv(text: string): { name?: string; url?: string; username?: string; password?: string }[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (names: string[]): number => header.findIndex((h) => names.includes(h));
  const iName = idx(["name", "title"]);
  const iUrl = idx(["url", "website", "login_uri"]);
  const iUser = idx(["username", "login_username", "user"]);
  const iPass = idx(["password", "login_password"]);
  if (iUrl < 0 || iUser < 0 || iPass < 0) return [];
  return rows
    .slice(1)
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => ({
      name: iName >= 0 ? r[iName] : undefined,
      url: r[iUrl],
      username: r[iUser],
      password: r[iPass],
    }));
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell.length || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

const host = (origin: string | null): string => {
  try {
    return origin ? new URL(origin).hostname : "";
  } catch {
    return origin ?? "";
  }
};
const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const oneLine = (s: Record<string, unknown>): string =>
  ["name", "line1", "city", "state", "postal_code", "email", "phone"].map((k) => s[k]).filter(Boolean).join(", ");
