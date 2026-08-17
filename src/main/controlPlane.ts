import { Client, ClientError, type MessageResponse } from "eve/client";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage, shell } from "electron";
import type { RemoteAgent, Session } from "@shared/ipc";
import { readPeerEvents, type PeerState } from "./peerEvents";

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
    // An expired ACCESS token is not a signed-out user. The refresh token
    // stored beside it exists for exactly this moment, and throwing the whole
    // session away here meant refreshSession had nothing to read on a cold
    // start — so every relaunch more than an hour after signing in demanded a
    // new sign-in while a perfectly good refresh token sat on disk unused.
    //
    // Only a session with no way back is no session.
    if (parsed.expiresAt < Date.now() + 30_000 && !parsed.refreshToken) return null;
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

/**
 * When the policy bundle dies, which is not when the token does.
 *
 * Both are verified by every agent, so the pair is only as good as its earlier
 * half. Tracking the token alone is how a session that looked healthy for
 * another fifty minutes was already being refused — and why signing out was the
 * only thing that fixed it, because that is the one path that mints both.
 */
function bundleExpiry(bundle: string | undefined): number {
  if (!bundle) return Number.POSITIVE_INFINITY;
  const exp = readClaims(bundle).exp;
  return exp ? exp * 1000 : Number.POSITIVE_INFINITY;
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
/**
 * Abandon a sign-in that is still waiting.
 *
 * The code is valid for ten minutes, and until now those ten minutes were
 * unconditional: open the wrong browser profile and there was nothing to do but
 * watch a screen that could not succeed. Cancelling has to reach the POLL, not
 * just the window — a loop left running would go on holding the old code and
 * could sign the app in from an approval the person had already given up on.
 */
let deviceAbort: AbortController | null = null;
export function cancelDeviceAuth(): void {
  deviceAbort?.abort();
  deviceAbort = null;
}

/** Thrown when the person asked to start again; not a failure worth reporting. */
export const SIGN_IN_CANCELLED = "sign-in cancelled";

export async function pollDeviceAuth(start: DeviceStart): Promise<Session> {
  const deadline = Date.now() + start.expiresIn * 1000;
  let interval = start.interval * 1000;
  const abort = new AbortController();
  deviceAbort = abort;

  while (Date.now() < deadline) {
    if (abort.signal.aborted) throw new Error(SIGN_IN_CANCELLED);
    // Wake early when cancelled, rather than finishing a five-second sleep the
    // person is watching.
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, interval);
      abort.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
    if (abort.signal.aborted) throw new Error(SIGN_IN_CANCELLED);
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
      console.log(
        `[auth] pair: token ${Math.round((next.expiresAt - Date.now()) / 1000)}s, bundle ${Math.round((bundleExpiry(next.bundle) - Date.now()) / 1000)}s`,
      );
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

/**
 * Keep the session alive without asking the user to sign in again.
 *
 * Identity tokens last an hour by design — that is the revocation SLA, not an
 * inconvenience to work around by issuing longer ones. The control plane mints a
 * refresh token alongside, and re-checks the user is still active on every
 * refresh, so a suspended user drops out within one interval. Studio simply
 * never used it, which is why an hour of work ended at a sign-in screen.
 */
let refreshing: Promise<Session | null> | null = null;

async function refreshSession(): Promise<Session | null> {
  const current = session ?? loadSession();
  if (!current?.refreshToken) return null;

  // One refresh at a time: a stream, a poll, and a turn can all notice the
  // expiry at once, and three parallel refreshes rotate the token out from
  // under each other.
  if (refreshing) return refreshing;

  refreshing = (async () => {
    try {
      const res = await fetch(`${ISSUER}/api/oauth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: current.refreshToken }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        // Logged because a silent refresh that silently fails is the hardest
        // kind of session bug to see: everything downstream reports a 401 from
        // somewhere else, and nothing says the refresh was the thing that went.
        console.log(`[auth] refresh failed ${res.status}`);
        // 401 means the refresh token itself is done; 403 means the user was
        // suspended. Both are real sign-outs, not retryable.
        if (res.status === 401 || res.status === 403) signOut();
        return null;
      }
      console.log("[auth] refreshed");
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.token !== "string") return null;
      const claims = readClaims(body.token);
      const next: Session = {
        token: body.token,
        bundle: typeof body.bundle === "string" ? body.bundle : undefined,
        refreshToken:
          typeof body.refresh_token === "string" ? body.refresh_token : current.refreshToken,
        expiresAt: claims.exp ? claims.exp * 1000 : Date.now() + 3_600_000,
        email: claims.email ?? current.email,
        orgName: claims.org_name ?? current.orgName,
      };
      saveSession(next);
      return next;
    } catch {
      return null;
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * The session to use right now, refreshed if it is close to expiring.
 *
 * Every outbound call goes through this rather than reading the stored session
 * directly, so expiry is handled in one place instead of surfacing as a 401 in
 * whichever feature happened to be in use.
 */
/**
 * Refresh regardless of what the clock says.
 *
 * The stored expiry is a claim, not a fact: a token can be rejected while it
 * still looks valid here — a rotated signing key, a clock a minute out, a
 * bundle that aged separately. When the agent says the credential is bad, the
 * agent is right, and the only useful response is to get a new one rather than
 * to argue from an expiry we computed ourselves.
 */
export async function forceRefresh(): Promise<Session | null> {
  return await refreshSession();
}

export async function activeSession(): Promise<Session | null> {
  const current = loadSession();
  // The earlier of the two: a credential is a pair, and the pair expires when
  // its first half does.
  const good =
    current &&
    Math.min(current.expiresAt, bundleExpiry(current.bundle)) > Date.now() + 120_000;
  if (current && good) return current;

  const refreshed = await refreshSession();
  if (refreshed) return refreshed;

  // Refresh failed. Handing back an expired token would only produce 401s that
  // read as a broken agent, so that is a real sign-out; a token with life left
  // is still usable and the refresh can be retried on the next call.
  return current && current.expiresAt > Date.now() + 30_000 ? current : null;
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
  const s = await activeSession();
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
/**
 * The agent could not fetch the control plane's signing keys, so it never got
 * to judge the token at all. It reports that with a 401 like any other refusal,
 * but the meaning is the opposite: nothing is wrong with the user's session.
 */
const UNVERIFIABLE = "verification_unavailable";

/**
 * Whether a failed POST is worth trying again rather than reporting.
 *
 * The agent restarts whenever a routine or plugin is applied, including on the
 * very turn that asked for it, and a restart lands as a 502/503 on whatever is
 * in flight. A 401 is normally final — but not the one an agent returns when it
 * could not reach the control plane to check the token, which is an outage on
 * its side and clears on its own.
 */
async function isTransient(res: Response): Promise<boolean> {
  if (res.status === 502 || res.status === 503 || res.status === 504) return true;
  if (res.status !== 401) return false;
  // clone(), so describeFailure can still read the body if the retries fail.
  const peek = await res
    .clone()
    .text()
    .catch(() => "");
  return peek.includes(UNVERIFIABLE);
}

async function describeFailure(res: Response, base: string): Promise<Error> {
  const body = await res.text().catch(() => "");
  const isHtml = /^\s*<(!doctype|html)/i.test(body);
  const snippet = body.replace(/\s+/g, " ").slice(0, 220);

  // An HTML body means something other than eve answered — but WHAT depends
  // entirely on the status. Blaming Vercel SSO for a 503 is wrong on a host
  // that has nothing to do with Vercel, and it sends the user hunting through
  // deployment settings while their agent is simply restarting.
  if (isHtml && (res.status === 401 || res.status === 403)) {
    return new Error(
      `${base} answered ${res.status} with a sign-in page rather than the eve API — deployment ` +
        `protection (such as Vercel SSO) is in front of it, so Studio's token never reached the agent.`,
    );
  }
  if (isHtml && res.status >= 500) {
    return new Error(
      `${base} is not answering right now (${res.status}). The agent is usually restarting — ` +
        `applying a new routine or capability does that — so this normally clears in a few seconds.`,
    );
  }
  if (isHtml) {
    return new Error(
      `${base} answered ${res.status} with a web page, not the eve API. The registered URL may ` +
        `point at a site rather than at the agent.`,
    );
  }

  switch (res.status) {
    case 401:
      // Told apart deliberately: one of these is about the user's sign-in and
      // the other is about the agent's network. Sending someone to check their
      // issuer config when their credentials were never even read is the kind
      // of message that costs an hour.
      if (body.includes(UNVERIFIABLE)) {
        return new Error(
          `${base} could not reach the Kybernesis control plane to check your sign-in, so it kept ` +
            `refusing the turn. Your session is fine — this clears once the agent can reach the ` +
            `control plane again.`,
        );
      }
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
    case 410:
      return new Error(`That conversation no longer exists on ${base}.`);
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
          return { label: `Asking ${named}`, specific: true };
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
  const s = await activeSession();
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
 * One eve Client per agent host.
 *
 * `eve/client` is the framework's own implementation of the session protocol,
 * and using it is not a refactor — it is the fix. Studio used to hand-roll the
 * POST and the NDJSON loop, which meant re-deriving three rules by inference:
 *
 *   - A turn ends at `session.waiting`, NOT at `turn.completed`. The two are
 *     different events and there is real time between them. Treating the first
 *     as the end let Studio release the composer while the session was still
 *     settling, so the next message raced the runtime that had not parked yet.
 *   - `session.waiting` carries the CURRENT continuation token. A session has
 *     one active continuation and rejects a stale one, so a client that never
 *     reads that event is holding a handle that expires under it.
 *   - The stream cursor, reconnects, and credential refresh all have to move
 *     together, or a reconnect resumes at the wrong index with a dead token.
 *
 * Every one of those was wrong here, in ways that surfaced as "sometimes it
 * answers and sometimes it doesn't". The framework already gets them right.
 */
const clients = new Map<string, Client>();

function clientFor(base: string): Client {
  const existing = clients.get(base);
  if (existing) return existing;
  const client = new Client({
    host: base,
    // Resolved before every request INCLUDING stream reconnects, so a long turn
    // that outlives the access token it started with refreshes mid-flight
    // instead of dying at the first reconnect.
    auth: { bearer: async () => (await activeSession())?.token ?? "" },
    headers: async (): Promise<Record<string, string>> => {
      const s = await activeSession();
      return s?.bundle ? { "x-kybernesis-bundle": s.bundle } : {};
    },
    // Credential-bearing client: never let fetch forward these headers to
    // another origin behind a redirect.
    redirect: "manual",
  });
  clients.set(base, client);
  return client;
}

/**
 * The absolute index of the last event durably recorded for a session.
 *
 * eve answers this from a header when a catch-up read asks for it, so it costs
 * one request and no body. Null means we could not find out — the caller then
 * falls back to its remembered cursor rather than guessing at zero, which would
 * replay the entire conversation.
 */
async function tailIndex(base: string, sessionId: string, from: number): Promise<number | null> {
  const s = await activeSession();
  if (!s?.bundle) return null;
  const url = new URL(`${base}/eve/v1/session/${encodeURIComponent(sessionId)}/stream`);
  // Start from the cursor we already hold rather than 0: includeTailIndex makes
  // this a catch-up read that stops at the tail instead of following the live
  // stream, so an accurate cursor means an empty body and an immediate close.
  url.searchParams.set("startIndex", String(Math.max(0, from)));
  url.searchParams.set("includeTailIndex", "1");
  const controller = new AbortController();
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${s.token}`, "x-kybernesis-bundle": s.bundle },
      // Both signals: the controller stops the body once the header is read, and
      // the timeout stops US. Every fetch on the way to sending a turn needs a
      // deadline — this one had none, so an agent that accepted the connection
      // and then said nothing hung the send before a single stream event, which
      // left the composer queueing behind a turn that had not begun.
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
    });
    const header = res.headers.get("x-eve-stream-tail-index");
    // The body is a full replay of the session; we only ever wanted the header.
    controller.abort();
    if (!res.ok || header === null) return null;
    const tail = Number.parseInt(header, 10);
    if (!Number.isFinite(tail)) return null;
    // The header is the index of the LAST recorded event; resuming means the
    // one after it. -1 (nothing recorded yet) correctly becomes 0.
    return tail + 1;
  } catch {
    controller.abort();
    return null;
  }
}

/** Turn a ClientError into something that says what to do about it. */
function describeClientError(error: unknown, base: string): Error {
  if (!(error instanceof ClientError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const body = typeof error.body === "string" ? error.body : JSON.stringify(error.body ?? "");
  const snippet = body.replace(/\s+/g, " ").slice(0, 220);

  switch (error.status) {
    case 401:
      if (body.includes(UNVERIFIABLE)) {
        return new Error(
          `${base} could not reach the Kybernesis control plane to check your sign-in. Your ` +
            `session is fine — this clears once the agent can reach the control plane again.`,
        );
      }
      if (/^\s*<(!doctype|html)/i.test(body)) {
        return new Error(
          `${base} answered with a sign-in page rather than the eve API — deployment protection ` +
            `(such as Vercel SSO) is in front of it, so Studio's token never reached the agent.`,
        );
      }
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
    case 409:
      // Reached only when starting a FRESH session also came back 409, since a
      // 409 on a session we hold is retried as a new conversation. So this is
      // the agent itself refusing to open one, not a stuck thread of ours.
      return new Error(
        `${base} would not start a conversation (409). The agent is usually mid-restart — wait a ` +
          `few seconds and send it again.`,
      );
    default:
      if (error.status >= 500) {
        return new Error(
          `${base} is not answering right now (${error.status}). The agent is usually restarting — ` +
            `applying a new routine or capability does that — so this normally clears in a few seconds.`,
        );
      }
      return new Error(`Agent returned HTTP ${error.status}. ${snippet}`);
  }
}

/**
 * How long a turn may emit NOTHING before Studio stops believing in it.
 *
 * Not a limit on how long the agent may think: every event resets it, so a turn
 * that streams tool calls for an hour is fine. It catches the turn that is not
 * running at all — the one whose step died with a restarted process. eve does
 * not resume a step killed mid-flight, so that turn never emits again, the
 * session never parks, and every later message queues behind a turn that will
 * never end. Waiting forever on that is indistinguishable from a hang, which
 * is exactly what it is.
 */
const SILENCE_LIMIT_MS = 150_000;

/**
 * Send one turn to an agent and stream the reply back.
 *
 * Deltas are pushed to the renderer as they arrive, because a chat window that
 * sits blank for thirty seconds reads as broken even when it is working.
 */
export async function sendTurn(input: {
  url: string;
  text: string;
  sessionId?: string;
  /** Events already consumed on this session; the stream resumes after them. */
  streamIndex?: number;
  /** Answers to questions the agent asked, resuming a parked turn. */
  inputResponses?: { requestId: string; optionId?: string; text?: string }[];
  clientContext?: Record<string, unknown>;
  onDelta(text: string): void;
  /** Clear what has been streamed so far: the block just ended was narration. */
  onReset?(): void;
  onActivity(label: string | null): void;
  /**
   * The stream position, reported as it advances.
   *
   * A turn that throws never returns a result, so a cursor saved only on
   * success goes stale the moment anything fails — and the next turn resumes
   * from an old position and REPLAYS history, re-emitting questions the user
   * already answered as if the agent had just asked them.
   */
  onCursor(index: number): void;
  /** The live turn, as soon as it is known, so the user can stop it. */
  onTurn?(turn: { sessionId: string; turnId?: string }): void;
  /**
   * The agent is asking the user something and will not continue until it is
   * answered. Dropping this event is why a turn that ended in a question looked
   * like an empty reply.
   */
  /**
   * A connection needs the user to sign in before the parked turn can continue.
   *
   * eve emits this, parks the turn, and resumes after the callback — the whole
   * OAuth flow is already in the framework. A client that does not render it
   * shows a turn that simply stopped, which is the exact failure eve's own
   * troubleshooting table names: "authorization.required appears but no UI".
   */
  /**
   * One side of an agent-to-agent hop: this agent asking a peer, or the peer
   * answering. Emitted as it happens rather than assembled at the end, so a
   * slow peer is visible while it is still thinking.
   */
  onPeer?(event: { direction: "inbound" | "outbound"; peer: string; text: string }): void;
  onAuthorization(event: {
    name: string;
    description?: string;
    url?: string;
    userCode?: string;
    instructions?: string;
    expiresAt?: string;
    /** Present on the completed event: authorized | declined | failed | timed-out. */
    outcome?: string;
  }): void;
  onQuestion(request: {
    requestId: string;
    prompt: string;
    options?: { id: string; label: string; description?: string; style?: string }[];
    allowFreeform?: boolean;
  }): void;
}): Promise<{
  reply: string;
  sessionId?: string;
  streamIndex: number;
  /** The turn parked on a question; there is no reply because none is due. */
  askedQuestion: boolean;
}> {
  console.log(`[send] start ${input.url} session=${input.sessionId ?? "new"}`);
  const s = await activeSession();
  console.log(`[send] session=${s ? "ok" : "none"} bundle=${s?.bundle ? "yes" : "no"}`);
  if (!s) throw new Error("Not signed in.");
  if (!s.bundle) {
    // Fail here rather than at the agent: without the bundle the agent reads the
    // request as an A2A call and answers "Authorization is required", which
    // reads like a broken token instead of a missing header.
    throw new Error(
      "Your session has no policy bundle, so no agent can check your grants. Sign out and sign in again.",
    );
  }

  const base = input.url.replace(/\/$/, "");

  /**
   * Start this turn at the stream's CURRENT tail, not at a remembered cursor.
   *
   * A cursor that falls behind never recovers on its own, and it fails in the
   * most misleading way available: the client resumes at the old position,
   * reads the previous turn's events, stops at the boundary it finds there, and
   * hands back that turn's reply. The agent looks like it is answering the
   * wrong question. Ask three things and you get three answers, each one behind
   * — and because each turn only advances to the boundary it just replayed, the
   * lag is self-sustaining.
   *
   * Studio renders its own persisted transcript, so it never wants history from
   * this stream — only the turn it is about to send. The tail is therefore the
   * only correct starting point, and reading it fresh each time makes any drift
   * self-correcting rather than permanent.
   */
  const resumeAt = input.sessionId
    ? ((await tailIndex(base, input.sessionId, input.streamIndex ?? 0)) ?? input.streamIndex ?? 0)
    : 0;

  console.log(`[send] resume=${resumeAt}`);
  // Sessions are ID-addressed: attach to one we already have, or let the first
  // message create it. Nothing is carried between turns except the id and the
  // cursor, so there is no longer a token that can go stale and make a live
  // session refuse an otherwise valid turn.
  let session = input.sessionId
    ? clientFor(base).sessions.attach(input.sessionId, { streamIndex: resumeAt })
    : null;

  let reply = "";
  let askedQuestion = false;
  let turnId: string | undefined;
  const memo = { lastTool: null as string | null };
  const peerState: PeerState = { pending: new Map(), last: null };
  let sawSpecific = false;

  /**
   * Publish the cursor only once the turn is over.
   *
   * `ClientSession.state` advances in the stream generator's finally block, so
   * reading it mid-turn returns the value we passed IN. Publishing that on every
   * event raced the correct value through IPC and could overwrite it with the
   * pre-turn position — re-creating the very drift this is meant to avoid.
   */
  const publishCursor = (): void => {
    const at = session?.state.streamIndex;
    if (typeof at === "number") input.onCursor(at);
  };

  /**
   * Abandoning a dead turn, as distinct from asking it to stop.
   *
   * Requesting cancellation is a message to a runtime that may not be listening
   * — the executor that would honour it is exactly the one that died. Without
   * aborting the read too, `for await` keeps waiting on a stream that will
   * never yield, this function never returns, and the caller's "a turn is in
   * flight" flag never clears. The user is then unable to send ANYTHING,
   * because the client is politely queueing behind a turn that ended long ago.
   * That is a worse failure than the hang it was meant to report.
   */
  const abandon = new AbortController();

  /**
   * Everything up to the first event has to be bounded too.
   *
   * The idle watchdog below only arms once send() has resolved, so anything
   * that hangs before that — a POST that never answers, a proxy holding the
   * connection, a resolve that never finishes — was outside every timeout in
   * this file. That is how a turn could wedge with no stream events at all and
   * nothing to cancel.
   */
  const dispatchGuard = setTimeout(() => abandon.abort(), 45_000);

  // A message and a set of answers are mutually exclusive now: `send` carries
  // new text, `respond` carries answers to a question the agent already asked.
  // Serialized clientContext rather than an object: eve JSON-serializes it into
  // one user-role context message either way, and a string keeps this code free
  // of the framework's internal JSON types.
  const options = {
    signal: abandon.signal,
    ...(input.clientContext ? { clientContext: JSON.stringify(input.clientContext) } : {}),
  };

  const dispatch = async (): Promise<MessageResponse> => {
    // A resumed turn may carry only answers, with no new message. That can only
    // happen on a session we are already attached to — there is nothing to
    // answer in a conversation that does not exist yet.
    if (input.inputResponses?.length && session) {
      return await session.respond(input.inputResponses, options);
    }
    if (session) return await session.send(input.text, options);
    const created = await clientFor(base).sessions.create({ message: input.text, ...options });
    session = created.session;
    return created.response;
  };

  let response: Awaited<ReturnType<typeof dispatch>>;
  try {
    try {
      response = await dispatch();
    } catch (error) {
      // A 401 here is not a conversation to have with the user. Refresh and try
      // once more: sessions are meant to renew silently, and "sign out and back
      // in" is not an instruction any product should give.
      if (error instanceof ClientError && error.status === 401) {
        console.log("[auth] agent refused the token; refreshing and retrying once");
        const renewed = await forceRefresh();
        if (!renewed) throw error;
        response = await dispatch();
      } else if (
        error instanceof ClientError &&
        (error.status === 404 || error.status === 409) &&
        input.sessionId
      ) {
        // Two ways a session we hold can refuse a follow-up, and neither is
        // worth telling a person about.
        //
        // 404: the agent no longer has that session — its durable owner was
        // retired, or a redeploy took it. The route is obviously present, so
        // reporting "no eve API here" sends someone to check a URL that was
        // never wrong.
        //
        // 409 (`session_not_active`): the session is there but cannot take a
        // turn, which is what a restart mid-turn leaves behind — the interrupted
        // turn never settles, so the session never parks and every later message
        // queues behind one that will never finish. Studio used to report this
        // as "that conversation is busy: wait for it", and waiting was precisely
        // the wrong advice: nothing was going to finish.
        //
        // Either way the conversation cannot be resumed, so start a new one. The
        // transcript is ours and stays on screen; only the agent's thread
        // restarts, which is what Reset does and does not need to be asked for.
        console.log(`[send] session cannot continue (${error.status}); starting a fresh one`);
        session = null;
        response = await dispatch();
      } else {
        throw error;
      }
    }
  } catch (error) {
    clearTimeout(dispatchGuard);
    if (abandon.signal.aborted) {
      throw new Error(
        `${base} accepted the connection but never started the turn. Nothing was sent — try again.`,
      );
    }
    throw describeClientError(error, base);
  } finally {
    clearTimeout(dispatchGuard);
  }

  console.log(`[send] dispatched session=${session?.state.sessionId ?? "?"}`);
  if (session?.state.sessionId) {
    input.onTurn?.({ sessionId: session.state.sessionId });
  }

  /**
   * A watchdog over the gap BETWEEN events rather than over the turn.
   *
   * `for await` on a silent stream simply never yields, so without this the UI
   * spins on a dead turn until something else gives up. Each event rearms it.
   */
  let silenceTimer: NodeJS.Timeout | undefined;
  let silent = false;
  const rearm = (): void => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      silent = true;
      // Ask the agent to stop, then stop listening regardless of the answer.
      void session?.cancel({ ...(turnId ? { turnId } : {}) }).catch(() => undefined);
      abandon.abort();
    }, SILENCE_LIMIT_MS);
  };

  try {
    rearm();
    for await (const event of response) {
      rearm();
      const type = String(event.type ?? "");
      const data = ((event as { data?: unknown }).data ?? {}) as Record<string, unknown>;

      if (process.env.KYBER_STUDIO_DEBUG_STREAM) {
        console.log(`[stream] ${type} ${JSON.stringify(data).slice(0, 220)}`);
      }

      if (typeof data.turnId === "string" && data.turnId !== turnId) {
        turnId = data.turnId;
        if (session?.state.sessionId) {
          input.onTurn?.({ sessionId: session.state.sessionId, turnId });
        }
      }

      const nextLabel = activityLabel(type, data, memo);
      if (nextLabel) {
        if (nextLabel.specific) {
          sawSpecific = true;
          input.onActivity(nextLabel.label);
        } else if (!sawSpecific) {
          input.onActivity(nextLabel.label);
        }
      }

      for (const peerEvent of readPeerEvents(type, data, peerState)) {
        input.onPeer?.(peerEvent);
      }

      if (type === "authorization.required" || type === "authorization.completed") {
        const challenge = (data.authorization ?? {}) as Record<string, unknown>;
        const name =
          (typeof data.name === "string" && data.name) ||
          (typeof data.connection === "string" && data.connection) ||
          "a connection";
        input.onAuthorization({
          name,
          description: typeof data.description === "string" ? data.description : undefined,
          url: typeof challenge.url === "string" ? challenge.url : undefined,
          userCode: typeof challenge.userCode === "string" ? challenge.userCode : undefined,
          instructions:
            typeof challenge.instructions === "string" ? challenge.instructions : undefined,
          expiresAt: typeof challenge.expiresAt === "string" ? challenge.expiresAt : undefined,
          outcome: typeof data.outcome === "string" ? data.outcome : undefined,
        });
      }

      if (type === "input.requested") {
        if (process.env.KYBER_STUDIO_DEBUG_STREAM) {
          console.log(`[question] ${JSON.stringify(data)}`);
        }
        for (const raw of Array.isArray(data.requests) ? data.requests : []) {
          const r = raw as Record<string, unknown>;
          // The request carries its fields at the top level, and the tool call
          // that produced it carries the same shape under action.input. Read
          // both: a question the user never sees because one field sat a level
          // deeper is indistinguishable from a broken agent.
          const action = (r.action ?? {}) as Record<string, unknown>;
          const inner = (action.input ?? {}) as Record<string, unknown>;
          const requestId =
            (typeof r.requestId === "string" && r.requestId) ||
            (typeof action.callId === "string" && action.callId) ||
            "";
          const prompt =
            (typeof r.prompt === "string" && r.prompt) ||
            (typeof inner.prompt === "string" && inner.prompt) ||
            (typeof inner.question === "string" && inner.question) ||
            "";
          if (!requestId || !prompt) continue;
          const options = Array.isArray(r.options)
            ? r.options
            : Array.isArray(inner.options)
              ? inner.options
              : undefined;
          askedQuestion = true;
          input.onQuestion({
            requestId,
            prompt,
            options: options as
              | { id: string; label: string; description?: string; style?: string }[]
              | undefined,
            allowFreeform: r.allowFreeform === true || inner.allowFreeform === true,
          });
        }
      } else if (type === "message.appended" && typeof data.messageDelta === "string") {
        sawSpecific = false;
        memo.lastTool = null;
        input.onActivity(null);
        reply += data.messageDelta;
        input.onDelta(data.messageDelta);
      } else if (type === "message.completed" && typeof data.message === "string") {
        /**
         * An agent narrates before it acts: "I'll pull your recordings and
         * check memory." eve emits each of those as its own completed message
         * with finishReason "tool-calls", and only the last block — finishing
         * on "stop" — is the answer.
         *
         * Treating them all as one reply concatenates a dozen intentions into a
         * wall of text where the actual answer arrives last and unannounced. It
         * reads like the model thinking out loud into the transcript, which is
         * precisely what it is.
         *
         * So narration becomes the activity line, where a running commentary
         * belongs, and the bubble is cleared for the real reply.
         */
        if (data.finishReason === "tool-calls") {
          const narration = data.message.trim();
          if (narration) input.onActivity(narration.slice(0, 120));
          reply = "";
          input.onReset?.();
        } else {
          reply = data.message;
          input.onReset?.();
          input.onDelta(data.message);
        }
      } else if (type === "turn.failed" || type === "session.failed" || type === "step.failed") {
        const message = typeof data.message === "string" ? data.message : "the turn failed";
        throw new Error(`Agent error: ${message}`);
      }
    }
  } catch (error) {
    if (!silent) throw describeClientError(error, base);
  } finally {
    if (silenceTimer) clearTimeout(silenceTimer);
    input.onActivity(null);
    publishCursor();
  }

  if (silent && !reply) {
    throw new Error(
      `The agent accepted this message and then went silent for ${Math.round(
        SILENCE_LIMIT_MS / 1000,
      )} seconds without producing anything. That usually means the agent restarted mid-turn — ` +
        `applying a routine does that — and the interrupted turn does not resume. Studio asked it ` +
        `to stop, so you can send the message again.`,
    );
  }

  return {
    reply: reply.trim(),
    sessionId: session?.state.sessionId,
    streamIndex: session?.state.streamIndex ?? 0,
    askedQuestion,
  };
}

/**
 * Stop the turn a session is currently running.
 *
 * Both outcomes are success: `accepted` means the turn took the signal, and
 * `no_active_turn` means it had already settled.
 */
export async function cancelTurn(input: {
  url: string;
  sessionId: string;
  turnId?: string;
}): Promise<string> {
  const base = input.url.replace(/\/$/, "");
  const session = clientFor(base).sessions.attach(input.sessionId, { streamIndex: 0 });
  try {
    const result = await session.cancel({ ...(input.turnId ? { turnId: input.turnId } : {}) });
    return result.status;
  } catch (error) {
    throw describeClientError(error, base);
  }
}

/**
 * Retire a session so the next message starts a fresh one.
 *
 * The escape hatch for a conversation that cannot move: a turn interrupted by a
 * restart never settles, so the session never parks, and every later message
 * queues behind it forever. Cancelling a turn whose executor is gone does not
 * always land — reset releases the durable owner regardless.
 */
export async function resetSession(input: { url: string; sessionId?: string }): Promise<void> {
  const base = input.url.replace(/\/$/, "");
  // Nothing to retire: with ID-addressed sessions there is no handle to a
  // conversation that was never started, and the next message opens a fresh one
  // anyway. Returning quietly beats a 404 the user cannot act on.
  if (!input.sessionId) return;
  const session = clientFor(base).sessions.attach(input.sessionId, { streamIndex: 0 });
  try {
    await session.reset();
  } catch (error) {
    throw describeClientError(error, base);
  }
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
  const s = await activeSession();
  if (!s?.bundle) {
    // 440, not 401: the agent never saw this request. Reporting it as the
    // agent's refusal sends someone to check grants for a session that expired
    // on this side.
    return { ok: false, status: 440, data: { error: "Your sign-in has expired." } };
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
  if (!res.ok) {
    // What we actually sent, in the terms the agent judges it by: which key
    // signed it, who issued it, and whether it is still in date. A 401 is one
    // of those three and guessing between them has cost hours.
    const peek = (jwt: string | undefined, label: string): string => {
      if (!jwt) return `${label}=absent`;
      try {
        const [head, body] = jwt.split(".");
        const h = JSON.parse(Buffer.from(head!, "base64url").toString()) as { kid?: string };
        const c = JSON.parse(Buffer.from(body!, "base64url").toString()) as {
          iss?: string;
          exp?: number;
          sub?: string;
        };
        const left = c.exp ? Math.round((c.exp * 1000 - Date.now()) / 1000) : NaN;
        return `${label}: kid=${h.kid ?? "?"} iss=${c.iss ?? "?"} expires_in=${left}s`;
      } catch {
        return `${label}=unparseable`;
      }
    };
    console.log(`[manage] ${peek(s.token, "token")} | ${peek(s.bundle, "bundle")}`);
    // The agent's own words, not our summary. A 401 from a manage route can be
    // an expired token, a bundle that does not match, or a missing grant, and
    // those need three different fixes.
    console.log(`[manage] ${input.path} -> ${res.status} ${JSON.stringify(data)?.slice(0, 240)}`);
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Give an agent what it needs to reach this machine, without anyone touching a
 * credential.
 *
 * Three things have to be true before an agent can work on someone's files: it
 * must be able to prove which agent it is, the person must have allowed it on
 * this machine, and the desktop must be reachable. Only the middle one is a
 * decision — the other two are plumbing, and plumbing is not something to hand
 * a user as a setup checklist.
 *
 * Studio is the one place where all three are already available: it is signed
 * in as the owner, so it can mint from the control plane; it talks to the agent
 * over an authenticated channel, so it can install; and it IS the device, so it
 * knows what it is granting. The credential passes between two pieces of
 * software and is never displayed, logged, or persisted here.
 */
export async function provisionLocalAccess(input: {
  url: string;
  agent: string;
}): Promise<{ ok: boolean; error?: string; restarted?: boolean }> {
  const s = await activeSession();
  if (!s?.bundle) return { ok: false, error: "Not signed in." };

  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${s.token}`,
    "x-kybernesis-bundle": s.bundle,
  };

  // 1. Mint. Owner-or-manage only, enforced at the control plane.
  const minted = await fetch(`${ISSUER}/api/agents/credential`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: input.agent }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!minted.ok) {
    const detail = await minted.text().catch(() => "");
    return {
      ok: false,
      error:
        minted.status === 403
          ? `You need manage access to "${input.agent}" to connect it to this computer.`
          : `The control plane would not issue a credential for "${input.agent}" (${minted.status}). ${detail.slice(0, 160)}`,
    };
  }
  const { credential } = (await minted.json()) as { credential?: string };
  if (!credential) return { ok: false, error: "The control plane returned no credential." };

  // 2. Install it on the agent, over the channel it already authenticates.
  const base = input.url.replace(/\/$/, "");
  const installed = await fetch(`${base}/eve/v1/kyb/credential`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key: "KYBERNESIS_AGENT_CREDENTIAL", value: credential }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!installed.ok) {
    const detail = await installed.text().catch(() => "");
    return {
      ok: false,
      error:
        installed.status === 404
          ? `${input.agent} has no management routes — @kybernesis/manage is not installed ` +
            `or not deployed. On the agent: npx eve add @kybernesis/manage, then redeploy.`
          : `${input.agent} refused the credential (${installed.status}). ${detail.slice(0, 160)}`,
    };
  }
  const result = (await installed.json().catch(() => ({}))) as { restarted?: boolean };

  // 3. Record the standing permission. Deliberately last: an agent that is
  // allowed but cannot identify itself is a grant that does nothing, and a
  // half-finished setup should look unfinished rather than allowed.
  const granted = await fetch(`${ISSUER}/api/local-exec/grant`, {
    method: "POST",
    headers,
    body: JSON.stringify({ agent: input.agent, deviceId: deviceId() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!granted.ok) {
    return { ok: false, error: `Could not record the permission (${granted.status}).` };
  }

  return { ok: true, restarted: result.restarted };
}

/** Whether this agent is already allowed to work on this machine. */
export async function localAccessGranted(agent: string): Promise<boolean> {
  const s = await activeSession();
  if (!s?.bundle) return false;
  try {
    const res = await fetch(
      `${ISSUER}/api/local-exec/grant?deviceId=${encodeURIComponent(deviceId())}`,
      {
        headers: { authorization: `Bearer ${s.token}`, "x-kybernesis-bundle": s.bundle },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { grants?: { agent: string }[] };
    return (body.grants ?? []).some((g) => g.agent === agent);
  } catch {
    return false;
  }
}

/** Withdraw it. The agent keeps its credential; what it loses is permission. */
export async function revokeLocalAccess(agent: string): Promise<boolean> {
  const s = await activeSession();
  if (!s?.bundle) return false;
  const res = await fetch(`${ISSUER}/api/local-exec/grant`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.token}`,
      "x-kybernesis-bundle": s.bundle,
    },
    body: JSON.stringify({ agent, deviceId: deviceId(), revoke: true }),
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok;
}

export interface ConnectorCard {
  slug: string;
  name: string;
  description?: string;
  provider: string;
  /** "user" — acts as you; "app" — acts as the company and can run unattended. */
  scope: string;
  needsAdmin: boolean;
  mark?: string;
  /** Real logo from the broker catalog; the mark is the fallback. */
  logo?: string;
  connected: boolean;
}

/**
 * The connector library, as this person sees it.
 *
 * The catalog is the org's approved shelf; the connected flags come from the
 * broker, live. Reading state from our own table instead would let a card claim
 * "connected" after someone revoked access at Google, which is the one lie a
 * connections screen must never tell.
 */
/**
 * Logos, fetched here and handed over as data URLs.
 *
 * The renderer's CSP is `img-src 'self' data:` and stays that way. Loosening it
 * to https: so a chat window can load images from wherever a catalog points is
 * the kind of small concession that makes the next one easier, and it would
 * have every user's machine announcing itself to a third party each time the
 * library opens. The main process already does the network; it can do this too.
 *
 * Failures are silent on purpose: a card without a logo falls back to its mark,
 * which is a cosmetic loss, where a thrown error would cost the whole library.
 */
const logoCache = new Map<string, string>();

async function asDataUrl(url: string): Promise<string | undefined> {
  const cached = logoCache.get(url);
  if (cached) return cached;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return undefined;
    const type = res.headers.get('content-type') ?? 'image/png';
    const body = Buffer.from(await res.arrayBuffer());
    // A logo that large is not a logo; something else is at that URL.
    if (body.byteLength > 512_000) return undefined;
    const data = `data:${type};base64,${body.toString('base64')}`;
    logoCache.set(url, data);
    return data;
  } catch {
    return undefined;
  }
}

export async function listConnectors(
  agent: string,
): Promise<{ configured: boolean; connectors: ConnectorCard[] }> {
  const s = await activeSession();
  if (!s?.bundle) return { configured: false, connectors: [] };
  try {
    const res = await fetch(`${ISSUER}/api/connectors?agent=${encodeURIComponent(agent)}`, {
      headers: { authorization: `Bearer ${s.token}`, "x-kybernesis-bundle": s.bundle },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { configured: false, connectors: [] };
    const body = (await res.json()) as { configured: boolean; connectors: ConnectorCard[] };
    const connectors = await Promise.all(
      body.connectors.map(async (c) =>
        c.logo?.startsWith('http') ? { ...c, logo: await asDataUrl(c.logo) } : c,
      ),
    );
    return { ...body, connectors };
  } catch {
    return { configured: false, connectors: [] };
  }
}

/**
 * Begin connecting a service: opens the user's own browser and reports back.
 *
 * Sign-in happens where their sessions and password manager already are. An
 * in-app window asking for a Google password is indistinguishable from the
 * thing every security training tells people not to trust, and we are not going
 * to teach customers to ignore that instinct.
 */
export async function connectService(input: {
  agent: string;
  slug: string;
  /**
   * What to call this account when the person already has one of this service.
   * It becomes the suffix on the tool names, so an agent can be told which
   * mailbox to send from rather than picking whichever the broker defaults to.
   */
  label?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await activeSession();
  if (!s?.bundle) return { ok: false, error: "Not signed in." };

  const res = await fetch(`${ISSUER}/api/connectors/link`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.token}`,
      "x-kybernesis-bundle": s.bundle,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { redirectUrl?: string; error?: string };
  if (!res.ok) return { ok: false, error: body.error ?? `The control plane refused (${res.status}).` };
  if (!body.redirectUrl) {
    return { ok: false, error: "No sign-in URL came back for that service." };
  }
  await shell.openExternal(body.redirectUrl);
  return { ok: true };
}

export async function disconnectService(input: {
  agent: string;
  slug: string;
  shared?: boolean;
  /** One account, when the service has more than one connected. */
  account?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await activeSession();
  if (!s?.bundle) return { ok: false, error: "Not signed in." };
  const res = await fetch(`${ISSUER}/api/connectors/disconnect`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.token}`,
      "x-kybernesis-bundle": s.bundle,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { ok: false, error: `Could not disconnect (${res.status}).` };
  return { ok: true };
}

/** Add a remote MCP server the user pasted, and connect it in one step. */
export async function addCustomConnector(input: {
  agent: string;
  name: string;
  url: string;
  token?: string;
  shared?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const s = await activeSession();
  if (!s?.bundle) return { ok: false, error: "Not signed in." };
  const res = await fetch(`${ISSUER}/api/connectors/custom`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${s.token}`,
      "x-kybernesis-bundle": s.bundle,
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) return { ok: false, error: body.error ?? `The control plane refused (${res.status}).` };
  return { ok: true };
}

/** Ask the control plane whether a remote MCP server actually answers. */
export async function testRemoteMcp(
  slug: string,
): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  const s = await activeSession();
  if (!s?.bundle) return { ok: false, error: "Not signed in." };
  try {
    const res = await fetch(`${ISSUER}/api/connectors/mcp/test`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${s.token}`,
        "x-kybernesis-bundle": s.bundle,
      },
      body: JSON.stringify({ slug }),
      signal: AbortSignal.timeout(40_000),
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      tools?: string[];
      error?: string;
    };
    if (!res.ok) return { ok: false, error: body.error ?? `The control plane answered ${res.status}.` };
    return { ok: Boolean(body.ok), tools: body.tools, error: body.error };
  } catch {
    return { ok: false, error: "Could not reach the control plane." };
  }
}
