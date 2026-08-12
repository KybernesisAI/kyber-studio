import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage, shell } from "electron";
import type { RemoteAgent, Session } from "@shared/ipc";

/**
 * Control-plane identity for KYBER Studio.
 *
 * Studio never holds an agent's own credentials. The user signs in to the
 * Kybernesis control plane with RFC 8628 device flow, and the resulting
 * identity token is what every agent's HTTP door verifies — the same governance
 * path as Slack and iMessage, so revoking a grant revokes the desktop too.
 *
 * The token is encrypted at rest with Electron's safeStorage (Keychain on
 * macOS). If the OS refuses encryption we do NOT silently fall back to
 * plaintext: a token on disk in the clear is exactly the failure a customer's
 * security review would find, so we keep it in memory and make them sign in
 * again next launch.
 */

export type { RemoteAgent, Session };

export const ISSUER = process.env.KYBERNESIS_ISSUER ?? "https://agent.kybernesis.ai";

let session: Session | null = null;

function storePath(): string {
  const dir = app.getPath("userData");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "session.bin");
}

export function deviceId(): string {
  const p = join(app.getPath("userData"), "device-id");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const id = randomUUID();
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(p, id, { mode: 0o600 });
  return id;
}

export function loadSession(): Session | null {
  if (session) return session;
  try {
    const p = storePath();
    if (!existsSync(p) || !safeStorage.isEncryptionAvailable()) return null;
    const decrypted = safeStorage.decryptString(readFileSync(p));
    const parsed = JSON.parse(decrypted) as Session;
    // An expired token is not a session. Returning one produces 401s that look
    // like a broken agent instead of a sign-in prompt.
    if (parsed.expiresAt < Date.now() + 30_000) return null;
    session = parsed;
    return session;
  } catch {
    return null;
  }
}

function saveSession(next: Session | null): void {
  session = next;
  if (!next) return;
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("[auth] OS encryption unavailable — keeping the session in memory only.");
    return;
  }
  writeFileSync(storePath(), safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
}

/** Claims are display-only; enforcement happens at the agent. Decode, never trust. */
function readClaims(jwt: string): { email?: string; org_name?: string; exp?: number } {
  try {
    const [, payload] = jwt.split(".");
    if (!payload) return {};
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export async function startDeviceAuth(): Promise<DeviceStart> {
  const res = await fetch(`${ISSUER}/api/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceId: deviceId(), deviceLabel: "KYBER Studio" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Control plane refused the device request (HTTP ${res.status}) at ${ISSUER}.`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const start: DeviceStart = {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri_complete ?? body.verification_uri),
    interval: Number(body.interval ?? 5),
    expiresIn: Number(body.expires_in ?? 600),
  };
  void shell.openExternal(start.verificationUri);
  return start;
}

/** Poll until the user approves in the browser, the code expires, or we are told to stop. */
export async function pollDeviceAuth(start: DeviceStart): Promise<Session> {
  const deadline = Date.now() + start.expiresIn * 1000;
  let interval = start.interval * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await fetch(`${ISSUER}/api/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: start.deviceCode }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;

    if (res.ok && typeof body.token === "string") {
      const claims = readClaims(body.token);
      const next: Session = {
        token: body.token,
        bundle: typeof body.bundle === "string" ? body.bundle : undefined,
        refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : undefined,
        expiresAt: claims.exp ? claims.exp * 1000 : Date.now() + 3_600_000,
        email: claims.email,
        orgName: claims.org_name,
      };
      saveSession(next);
      return next;
    }

    const error = String(body.error ?? "");
    if (error === "slow_down") {
      interval += 5_000;
      continue;
    }
    if (error === "authorization_pending" || res.status === 428 || res.status === 202) continue;
    if (error) throw new Error(`Sign-in failed: ${error}`);
  }
  throw new Error("Sign-in timed out. Start again and approve the code in your browser.");
}

export function signOut(): void {
  saveSession(null);
  session = null;
  try {
    const p = storePath();
    if (existsSync(p)) writeFileSync(p, Buffer.alloc(0));
  } catch {
    /* best effort */
  }
}

export async function listAgents(): Promise<RemoteAgent[]> {
  const s = loadSession();
  if (!s) throw new Error("Not signed in.");
  const res = await fetch(`${ISSUER}/api/me/agents`, {
    headers: { authorization: `Bearer ${s.token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status === 401) throw new Error("Session expired. Sign in again.");
  if (!res.ok) throw new Error(`Could not list agents (HTTP ${res.status}).`);
  const body = (await res.json()) as { agents?: RemoteAgent[] };
  return body.agents ?? [];
}


/**
 * Turn an HTTP failure into a sentence that names the actual cause.
 *
 * "The agent rejected your identity" is a guess, and a wrong one for most 401s
 * here: a Vercel-protected deployment answers 401 with an SSO web page before
 * eve ever sees the request, and an issuer mismatch fails for reasons the user
 * cannot act on by signing in again. Read the body and say which it is —
 * telling someone to re-authenticate when the deployment is gated wastes their
 * afternoon.
 */
async function describeFailure(res: Response, base: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  const isHtml = /^\s*<(!doctype|html)/i.test(body);
  const snippet = body.replace(/\s+/g, " ").slice(0, 220);

  if (isHtml) {
    return new Error(
      `${base} answered ${res.status} with a web page, not the eve API. That is almost always ` +
        `deployment protection (Vercel SSO) or a URL pointing at a site rather than the agent. ` +
        `Studio's token never reached eve.`,
    );
  }

  switch (res.status) {
    case 401:
      return new Error(
        `The agent refused Studio's identity token (401). Check that its KYBERNESIS_ISSUER matches ` +
          `the control plane you signed in to, and that it can fetch that issuer's JWKS. ${snippet}`,
      );
    case 403:
      return new Error(
        `You are authenticated but have no grant for this agent (403). Grant your user access to it ` +
          `in the control plane — the agent's KYBERNESIS_AGENT must match its registered name. ${snippet}`,
      );
    case 404:
      return new Error(
        `No eve API at ${base} (404). The registered URL may be wrong, or the deployment is not ` +
          `serving /eve/v1/session.`,
      );
    case 502:
    case 503:
    case 504:
      return new Error(`${base} is not responding (${res.status}). The agent may be down.`);
    default:
      return new Error(`Agent returned HTTP ${res.status}. ${snippet}`);
  }
}


/**
 * Turn one stream event into a short phrase describing what the agent is doing.
 *
 * Without this the window shows nothing between "sent" and "answered", which on
 * a long turn is indistinguishable from a hang. eve's event vocabulary already
 * says precisely what is happening — reasoning, tool calls, subagent
 * delegation, compaction — so this reports it rather than animating a generic
 * "working…" that would be true even when the agent is stuck.
 *
 * Returns null for events that say nothing about activity.
 */
function activityLabel(
  type: string,
  data: Record<string, unknown>,
  memo: { lastTool: string | null },
): { label: string; specific: boolean } | null {
  const actions = Array.isArray(data.actions) ? (data.actions as Record<string, unknown>[]) : [];
  // Field names differ by action kind, verified against a real stream:
  // tool-call carries toolName, subagent-call and remote-agent-call carry name.
  // Reading only `name` silently loses every tool call, which is most of them.
  const first = actions[0];
  const named =
    typeof first?.toolName === "string"
      ? first.toolName
      : typeof first?.name === "string"
        ? first.name
        : null;
  const kind = typeof first?.kind === "string" ? first.kind : null;

  switch (type) {
    case "turn.started":
    case "step.started":
      // Generic harness milestones. They fire repeatedly through a turn —
      // including AFTER a tool result — so they must never overwrite a specific
      // label, or a tool call flashes past and the line reads "Working" for a
      // turn that plainly did something nameable.
      return { label: "Working", specific: false };
    case "message.received":
      return { label: "Reading your message", specific: false };
    case "reasoning.appended":
    case "reasoning.completed":
      return { label: "Thinking", specific: true };
    case "actions.requested": {
      if (named) memo.lastTool = named;
      if (!named) return { label: "Taking an action", specific: true };
      switch (kind) {
        case "load-skill":
          return { label: `Loading skill ${named}`, specific: true };
        case "subagent-call":
          return { label: `Delegating to ${named}`, specific: true };
        case "remote-agent-call":
          return { label: `Messaging ${named}`, specific: true };
        default:
          return { label: `Using ${named}`, specific: true };
      }
    }
    case "action.partial":
      return named ? { label: `Using ${named}`, specific: true } : null;
    case "action.result":
      return {
        label: memo.lastTool ? `Reading ${memo.lastTool} result` : "Reading the result",
        specific: true,
      };
    case "subagent.started":
    case "subagent.called":
      return typeof data.subagentName === "string"
        ? { label: `Delegating to ${data.subagentName}`, specific: true }
        : { label: "Delegating", specific: true };
    case "subagent.completed":
      return { label: "Subagent finished", specific: true };
    case "compaction.requested":
      return { label: "Compacting context", specific: true };
    case "authorization.required":
      return { label: "Waiting for authorization", specific: true };
    case "input.requested":
      return { label: "Waiting for your input", specific: true };
    default:
      return null;
  }
}

/** What the agent reports about itself — model, name, description. */
export async function agentInfo(url: string): Promise<Record<string, unknown> | null> {
  const s = loadSession();
  if (!s?.bundle) return null;
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/eve/v1/info`, {
      headers: { authorization: `Bearer ${s.token}`, "x-kybernesis-bundle": s.bundle },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Send one turn to an agent's eve HTTP door and stream the reply back.
 *
 * eve's HTTP API is two calls, not one: POST /eve/v1/session starts the turn and
 * returns immediately with a sessionId, and the assistant's actual words arrive
 * on GET /eve/v1/session/:id/stream as newline-delimited JSON. A client that
 * only reads the POST response gets an empty reply and no error — it looks like
 * the agent had nothing to say.
 *
 * Deltas are pushed to the renderer as they arrive, because a chat window that
 * sits blank for thirty seconds reads as broken even when it is working.
 */
export async function sendTurn(input: {
  url: string;
  text: string;
  sessionId?: string;
  continuationToken?: string;
  /** Events already consumed on this session; the stream resumes after them. */
  streamIndex?: number;
  clientContext?: Record<string, unknown>;
  onDelta(text: string): void;
  onActivity(label: string | null): void;
}): Promise<{
  reply: string;
  sessionId?: string;
  continuationToken?: string;
  streamIndex: number;
}> {
  const s = loadSession();
  if (!s) throw new Error("Not signed in.");
  const base = input.url.replace(/\/$/, "");
  if (!s.bundle) {
    // Fail here rather than at the agent: without the bundle the agent reads the
    // request as an A2A call and answers "Authorization is required", which
    // reads like a broken token instead of a missing header.
    throw new Error(
      "Your session has no policy bundle, so no agent can check your grants. Sign out and sign in again.",
    );
  }
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${s.token}`,
    "x-kybernesis-bundle": s.bundle,
  };

  // A follow-up posts to the existing session so the agent keeps its thread.
  const startUrl = input.sessionId
    ? `${base}/eve/v1/session/${encodeURIComponent(input.sessionId)}`
    : `${base}/eve/v1/session`;

  const started = await fetch(startUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: input.text,
      ...(input.clientContext ? { clientContext: input.clientContext } : {}),
      ...(input.continuationToken ? { continuationToken: input.continuationToken } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!started.ok) throw await describeFailure(started, base);

  const startBody = (await started.json().catch(() => ({}))) as Record<string, unknown>;
  const sessionId = String(startBody.sessionId ?? input.sessionId ?? "");
  const continuationToken =
    typeof startBody.continuationToken === "string"
      ? startBody.continuationToken
      : input.continuationToken;
  if (!sessionId) throw new Error("The agent started no session (no sessionId in its response).");

  // Resume the stream after the events we have already seen. The session's
  // event log is cumulative: streaming from 0 on every turn replays the whole
  // conversation and stops at the FIRST turn boundary, so every message comes
  // back with the first reply the agent ever gave. startIndex is not an
  // optimization — without it a follow-up is silently answered with old words.
  const startIndex = input.sessionId === sessionId ? (input.streamIndex ?? 0) : 0;
  let consumed = startIndex;
  const streamUrl = new URL(`${base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`);
  if (startIndex > 0) streamUrl.searchParams.set("startIndex", String(startIndex));

  const stream = await fetch(streamUrl, {
    headers: { authorization: `Bearer ${s.token}`, "x-kybernesis-bundle": s.bundle },
    signal: AbortSignal.timeout(300_000),
  });
  if (!stream.ok) throw await describeFailure(stream, base);
  if (!stream.body) throw new Error("The agent opened no event stream for this turn.");

  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let done = false;
  // A turn ends with turn.completed AND THEN session.waiting. Breaking on the
  // first of those leaves the second unconsumed, so the NEXT turn opens its
  // stream on a stale boundary and ends before the agent has said anything —
  // an empty reply with no error. Only honour a boundary once this turn has
  // actually started, and treat leading stale boundaries as cursor advance.
  let turnStarted = false;
  // Tool names arrive on actions.requested; action.result carries only a callId,
  // so remember the last one to keep the line specific while the tool runs.
  const memo: { lastTool: string | null } = { lastTool: null };
  let sawSpecific = false;

  while (!done) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });

    // NDJSON: complete lines only; a partial line stays in the buffer.
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;

      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      // Every parsed event advances the cursor, including ones we ignore —
      // startIndex counts stream position, not messages.
      consumed += 1;

      const type = String(event.type ?? "");
      const data = (event.data ?? {}) as Record<string, unknown>;

      // Set KYBER_STUDIO_DEBUG_STREAM=1 to see exactly what the agent emits.
      // Guessing at an event vocabulary is how the activity line ends up lying.
      if (process.env.KYBER_STUDIO_DEBUG_STREAM) {
        console.log(`[stream] ${type} ${JSON.stringify(data).slice(0, 220)}`);
      }
      const next = activityLabel(type, data, memo);
      if (next) {
        // A generic milestone never replaces something specific we already
        // showed this turn; a specific one always wins.
        if (next.specific) {
          sawSpecific = true;
          input.onActivity(next.label);
        } else if (!sawSpecific) {
          input.onActivity(next.label);
        }
      }

      if (type === "turn.started") {
        turnStarted = true;
      } else if (type === "message.appended" && typeof data.messageDelta === "string") {
        turnStarted = true;
        // The answer is arriving; the status line has served its purpose.
        sawSpecific = false;
        memo.lastTool = null;
        input.onActivity(null);
        reply += data.messageDelta;
        input.onDelta(data.messageDelta);
      } else if (type === "message.completed" && typeof data.text === "string" && !reply) {
        // Some turns emit only a completed message with no deltas.
        reply = data.text;
        input.onDelta(data.text);
      } else if (type === "turn.failed" || type === "session.failed") {
        const message = typeof data.message === "string" ? data.message : "the turn failed";
        throw new Error(`Agent error: ${message}`);
      } else if (
        type === "turn.completed" ||
        type === "session.waiting" ||
        type === "turn.cancelled"
      ) {
        // Stale boundary from the previous turn: consume it and keep reading.
        if (!turnStarted && !reply) continue;
        done = true;
        break;
      }
    }
  }
  await reader.cancel().catch(() => undefined);

  return { reply: reply.trim(), sessionId, continuationToken, streamIndex: consumed };
}

export function currentSession(): Session | null {
  return loadSession();
}

/**
 * Management calls against an agent's own /eve/v1/kyb routes.
 *
 * These carry the SAME identity and policy bundle as every other call to the
 * agent. Installing software on an agent is governed by the same grant as
 * talking to it — there is no separate key, because a credential a user has to
 * copy out of a server's env file is not authentication.
 */
export async function manageCall(input: {
  url: string;
  path: string;
  body?: unknown;
}): Promise<{ ok: boolean; status: number; data: unknown }> {
  const s = loadSession();
  if (!s?.bundle) {
    return { ok: false, status: 401, data: { error: "Not signed in." } };
  }
  const base = input.url.replace(/\/$/, "");
  const res = await fetch(`${base}/eve/v1/kyb${input.path}`, {
    method: input.body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${s.token}`,
      "x-kybernesis-bundle": s.bundle,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    // Installs run npm and a full rebuild; a short timeout here would report a
    // failure for work that is actually still going.
    signal: AbortSignal.timeout(420_000),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}
