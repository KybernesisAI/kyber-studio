/**
 * Structured questions from Kybernesis agents.
 *
 * eve's question carries a prompt and options, nothing more. Two agent tools
 * put a marker on the prompt's first line — `[kyb:vault-item] {json}` and
 * `[kyb:spend-request] {json}` — and the plain sentence after it. Studio draws
 * a form or a card from the JSON; every other surface shows the sentence and
 * the buttons. The formats are owned by @kybernesis/vault and
 * @kybernesis/payments; these parsers mirror them.
 */
export const VAULT_ITEM_MARKER = "[kyb:vault-item]";
export const SPEND_REQUEST_MARKER = "[kyb:spend-request]";

export interface VaultItemAsk {
  kind: "login" | "card" | "address" | "contact";
  site?: string;
  label?: string;
  reason?: string;
  fields?: string[];
}

export interface SpendRequestAsk {
  id: string;
  amount: number;
  currency: string;
  merchant?: string;
  merchant_url?: string;
  approval_url?: string;
  status: string;
}

function parseMarked<T>(marker: string, prompt: string): { ask: T; text: string } | null {
  if (!prompt.startsWith(marker)) return null;
  const nl = prompt.indexOf("\n");
  const head = nl === -1 ? prompt : prompt.slice(0, nl);
  try {
    const ask = JSON.parse(head.slice(marker.length).trim()) as T;
    if (!ask || typeof ask !== "object") return null;
    return { ask, text: nl === -1 ? "" : prompt.slice(nl + 1).trim() };
  } catch {
    return null;
  }
}

export const parseVaultItemAsk = (prompt: string) => parseMarked<VaultItemAsk>(VAULT_ITEM_MARKER, prompt);
export const parseSpendRequestAsk = (prompt: string) => parseMarked<SpendRequestAsk>(SPEND_REQUEST_MARKER, prompt);

/** The answer a client gives after saving the item itself: the tool reads the id, never the secret. */
export const vaultSavedAnswer = (itemId: string): string => `vault:${itemId}`;

/** eve's own approval prompt is `Approve tool call: <name>`; people read "create spend request" better than snake_case. */
export function approvalPrompt(prompt: string): { tool: string; title: string } | null {
  const m = /^Approve tool call:\s*([a-z0-9_:.-]+)\s*$/i.exec(prompt);
  if (!m) return null;
  const tool = m[1]!;
  const words = tool.split(/__|[_:.]/).filter(Boolean).join(" ");
  return { tool, title: `Allow ${words}?` };
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
