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

/** One question from eve's `input.requested`, as Studio keeps it. */
export interface QuestionRequest {
  requestId: string;
  prompt: string;
  options?: { id: string; label: string; description?: string; style?: string }[];
  allowFreeform?: boolean;
  /** For a tool approval: the call waiting on it, so the card can show the real email or event. */
  approval?: { tool: string; input: Record<string, unknown> };
}

/** The largest tool input kept with an approval. A long email body is fine; a pasted file is cut to the prompt alone. */
const APPROVAL_INPUT_MAX = 40_000;

/**
 * The questions in one `input.requested` event.
 *
 * The request carries its fields at the top level, and the tool call that
 * produced it carries the same shape under action.input. Read both: a question
 * the user never sees because one field sat a level deeper is
 * indistinguishable from a broken agent.
 */
export function readInputRequests(data: Record<string, unknown>): QuestionRequest[] {
  const out: QuestionRequest[] = [];
  for (const raw of Array.isArray(data.requests) ? data.requests : []) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const action = (r.action ?? {}) as Record<string, unknown>;
    const inner = (action.input && typeof action.input === "object" && !Array.isArray(action.input) ? action.input : {}) as Record<string, unknown>;
    const requestId = (typeof r.requestId === "string" && r.requestId) || (typeof action.callId === "string" && action.callId) || "";
    const prompt =
      (typeof r.prompt === "string" && r.prompt) ||
      (typeof inner.prompt === "string" && inner.prompt) ||
      (typeof inner.question === "string" && inner.question) ||
      "";
    if (!requestId || !prompt) continue;
    const options = Array.isArray(r.options) ? r.options : Array.isArray(inner.options) ? inner.options : undefined;
    const request: QuestionRequest = {
      requestId,
      prompt,
      options: options as QuestionRequest["options"],
      allowFreeform: r.allowFreeform === true || inner.allowFreeform === true,
    };
    if (r.kind === "tool-approval" && typeof action.toolName === "string" && action.toolName) {
      let size = Infinity;
      try {
        size = JSON.stringify(inner).length;
      } catch {
        // Not serialisable: keep the prompt alone.
      }
      if (size <= APPROVAL_INPUT_MAX) request.approval = { tool: action.toolName, input: inner };
    }
    out.push(request);
  }
  return out;
}
