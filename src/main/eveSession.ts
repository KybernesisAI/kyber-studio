/**
 * The eve session protocol, for agents on either side of the eve 1.0 upgrade.
 *
 * Studio used eve's own client (eve 0.38) for this. That client reads stream
 * version 26 only: on an eve 1.0 agent it counts heartbeats as events, never
 * sees a turn end (`session.waiting` is gone), and answers questions with
 * `inputResponses`, which eve 1.0 refuses with a 400. eve 1.0's client reads
 * version 27 only and refuses 26. Through the upgrade Studio talks to both, so
 * it carries this small client instead: the same calls Studio made before
 * (create, send, respond, stream, cancel, reset), with the stream read by
 * `StreamDecoder`, which picks the format from each response's
 * `x-eve-stream-version` header and hands back version 26 events either way.
 *
 * What it keeps from eve 0.38's client, on purpose, because Studio's rules were
 * written against it: a send's stream starts at the cursor held BEFORE the
 * post and ends at the first session boundary; opening a stream retries the
 * statuses a restarting agent answers with; a broken connection resumes from
 * the cursor; credentials are resolved before every request.
 */
import {
  StreamDecoder,
  answersBody,
  createStreamMemory,
  type StreamMemory,
  streamVersionOf,
  tailIndexOf,
  type InputAnswer,
  type StreamEvent,
  type StreamVersion,
} from "../shared/eveStream";

export type { StreamEvent, StreamVersion, InputAnswer };

/** An HTTP answer that was not a success, with what the agent said. */
export class ClientError extends Error {
  readonly status: number;
  readonly body: string;
  readonly code?: string;
  readonly headers: Record<string, string>;
  constructor(status: number, body: string, headers?: Headers) {
    let message = body || `Server returned ${status}.`;
    let code: string | undefined;
    try {
      const parsed = JSON.parse(body) as { error?: unknown; code?: unknown };
      if (typeof parsed?.error === "string") message = parsed.error;
      if (typeof parsed?.code === "string") code = parsed.code;
    } catch {
      /* not JSON */
    }
    super(message);
    this.name = "ClientError";
    this.status = status;
    this.body = body;
    this.code = code;
    this.headers = Object.fromEntries(headers ? headers.entries() : []);
  }
}

export interface ClientOptions {
  base: string;
  /** Resolved before every request, so a refreshed token is picked up mid-turn. */
  headers(): Promise<Record<string, string>>;
}

/**
 * What earlier reads of each session learned: which tool a call id is, which
 * kind a request is. The read after an approval starts mid-session and needs
 * it to name the call it finishes. Bounded to the sessions used recently.
 */
const memories = new Map<string, StreamMemory>();
function memoryFor(sessionId: string): StreamMemory {
  let memory = memories.get(sessionId);
  if (memory) {
    memories.delete(sessionId);
  } else {
    memory = createStreamMemory();
  }
  memories.set(sessionId, memory);
  while (memories.size > 50) {
    const oldest = memories.keys().next().value;
    if (oldest === undefined) break;
    memories.delete(oldest);
  }
  return memory;
}

/** The stream version each agent served last, by base URL. */
const versions = new Map<string, StreamVersion>();

/** The stream version this agent served last, if any read has said. */
export function knownVersion(base: string): StreamVersion | undefined {
  return versions.get(base);
}

export function rememberVersion(base: string, version: StreamVersion): void {
  versions.set(base, version);
}

/** The statuses eve 0.38's client retried on opening a stream: a restarting agent says these. */
const RETRYABLE_OPEN = new Set([404, 409, 425, 500, 502, 503, 504]);
const OPEN_ATTEMPTS = 12;
const OPEN_BASE_MS = 250;
const OPEN_MAX_MS = 5_000;
/** Reconnects after a dropped connection that delivered nothing. */
const IDLE_ATTEMPTS = 5;
const IDLE_BASE_MS = 250;
const IDLE_MAX_MS = 4_000;

/** v26 and v27 both end a request's events here; v27 via the decoder's session.waiting. */
export const isBoundary = (type: string): boolean =>
  type === "session.waiting" || type === "session.completed" || type === "session.failed";

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const isDisconnect = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return false;
  return /terminated|socket|ECONNRESET|network|fetch failed|other side closed|premature/i.test(
    `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}`,
  );
};

/** NDJSON lines from a response body. */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let at = buffer.indexOf("\n");
      while (at !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (line.trim()) yield line;
        at = buffer.indexOf("\n");
      }
    }
    done = true;
    if (buffer.trim()) yield buffer;
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface StreamReadOptions {
  startIndex?: number;
  follow?: boolean;
  signal?: AbortSignal;
  /** Keep reconnecting while quiet: a turn in flight may be silent for minutes. */
  keepAlive?: boolean;
}

/** One session on one agent, addressed by id. */
export class AgentSession {
  readonly client: AgentClient;
  /** `streamIndex` is the next line to read: events for v26 agents, stored lines for v27. */
  state: { sessionId: string; streamIndex: number };
  /** The stream version this session's agent served, once a read has said. */
  version: StreamVersion | undefined;

  constructor(client: AgentClient, sessionId: string, streamIndex = 0) {
    this.client = client;
    this.state = { sessionId, streamIndex };
    this.version = knownVersion(client.base);
  }

  private path(suffix = ""): string {
    return `${this.client.base}/eve/v1/session/${encodeURIComponent(this.state.sessionId)}${suffix}`;
  }

  /**
   * Read the session's events from a cursor. The cursor in `state` advances
   * as events arrive, not only when the read ends.
   */
  async *stream(options: StreamReadOptions = {}): AsyncGenerator<StreamEvent> {
    const start = options.startIndex ?? this.state.streamIndex;
    let decoder: StreamDecoder | undefined;
    let next = start;
    let idleAttempts = 0;
    let delay = IDLE_BASE_MS;
    let first = true;
    for (;;) {
      if (options.signal?.aborted) return;
      let res: Response;
      try {
        res = await this.open(next, options);
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
      const version = streamVersionOf(res.headers);
      this.version = version;
      rememberVersion(this.client.base, version);
      if (!decoder || decoder.version !== version) {
        decoder = new StreamDecoder(version, next, tailIndexOf(res.headers), memoryFor(this.state.sessionId));
        if (start < 0 && decoder.cursor >= 0) next = decoder.cursor;
      }
      decoder.leaseEnded = false;
      let delivered = false;
      try {
        for await (const line of lines(res.body!)) {
          const events = decoder.pushLine(line);
          next = decoder.cursor;
          if (next >= 0) this.state = { sessionId: this.state.sessionId, streamIndex: next };
          for (const event of events) {
            delivered = true;
            yield event;
          }
          if (decoder.ended) return;
        }
      } catch (error) {
        if (!isDisconnect(error)) throw error;
      }
      if (decoder.ended || options.follow === false || options.signal?.aborted) return;
      // eve 1.0 ends a quiet read every minute and expects the reader back at
      // its cursor; that is not a failure and costs no attempt.
      if (decoder.leaseEnded) {
        idleAttempts = 0;
        delay = IDLE_BASE_MS;
        first = false;
        continue;
      }
      if (delivered) {
        idleAttempts = 0;
        delay = IDLE_BASE_MS;
      } else if (!options.keepAlive && !first && (idleAttempts += 1) >= IDLE_ATTEMPTS) {
        return;
      }
      first = false;
      await sleep(delay, options.signal);
      delay = Math.min(delay * 2, IDLE_MAX_MS);
    }
  }

  private async open(startIndex: number, options: StreamReadOptions): Promise<Response> {
    const url = new URL(this.path("/stream"));
    if (startIndex !== 0) url.searchParams.set("startIndex", String(startIndex));
    if (startIndex < 0) url.searchParams.set("includeTailIndex", "1");
    if (options.follow === false) {
      url.searchParams.set("includeTailIndex", "1");
      url.searchParams.set("follow", "false");
    }
    let delay = OPEN_BASE_MS;
    let last: { status: number; body: string; headers: Headers } | undefined;
    for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, {
          cache: "no-store",
          headers: await this.client.headers(),
          redirect: "manual",
          signal: options.signal ?? null,
        });
      } catch (error) {
        if (options.signal?.aborted || !isDisconnect(error) || attempt === OPEN_ATTEMPTS - 1) throw error;
        await sleep(delay, options.signal);
        delay = Math.min(delay * 2, OPEN_MAX_MS);
        continue;
      }
      if (res.ok && res.body) return res;
      if (res.ok) throw new ClientError(res.status, "Response body is null.", res.headers);
      last = { status: res.status, body: await res.text().catch(() => ""), headers: res.headers };
      if (!RETRYABLE_OPEN.has(res.status)) break;
      if (attempt < OPEN_ATTEMPTS - 1) {
        await sleep(delay, options.signal);
        delay = Math.min(delay * 2, OPEN_MAX_MS);
      }
    }
    throw new ClientError(last?.status ?? 0, last?.body ?? "Failed to open the session stream.", last?.headers);
  }

  /** The events of one request: from the cursor held before it was sent, to the first boundary. */
  private async *request(from: number, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    for await (const event of this.stream({ startIndex: from, signal, keepAlive: true })) {
      yield event;
      if (isBoundary(event.type)) return;
    }
  }

  async send(
    message: unknown,
    options: { signal?: AbortSignal; clientContext?: string } = {},
  ): Promise<AsyncGenerator<StreamEvent>> {
    const from = this.state.streamIndex;
    await this.client.post(this.path(), {
      message,
      ...(options.clientContext ? { clientContext: options.clientContext } : {}),
    }, options.signal, this.state.sessionId);
    return this.request(from, options.signal);
  }

  /**
   * Answer questions or approvals. eve 1.0 takes `answers` and refuses
   * `inputResponses` with a 400 naming the fields it accepts; eve 0.81 takes
   * `inputResponses`. The shape follows the version this agent last served,
   * and a refusal that names the other field is retried once in that shape.
   */
  async respond(answers: readonly InputAnswer[], options: { signal?: AbortSignal } = {}): Promise<AsyncGenerator<StreamEvent>> {
    if (answers.length === 0) throw new Error("respond() needs at least one answer.");
    const from = this.state.streamIndex;
    const version = this.version ?? knownVersion(this.client.base) ?? 26;
    try {
      await this.client.post(this.path(), answersBody(version, answers), options.signal, this.state.sessionId);
    } catch (error) {
      const other: StreamVersion = version === 27 ? 26 : 27;
      const field = other === 27 ? "answers" : "inputResponses";
      if (!(error instanceof ClientError) || error.status !== 400 || !error.body.includes(field)) throw error;
      await this.client.post(this.path(), answersBody(other, answers), options.signal, this.state.sessionId);
      this.version = other;
      rememberVersion(this.client.base, other);
    }
    return this.request(from, options.signal);
  }

  /** Stop the running turn. Older agents answer `{status}`, eve 1.0 a delivery receipt; both are accepted. */
  async cancel(options: { turnId?: string } = {}): Promise<{ status: string }> {
    const body = await this.client.post(this.path("/cancel"), options.turnId ? { turnId: options.turnId } : {});
    const status = typeof (body as { status?: unknown })?.status === "string" ? (body as { status: string }).status : "accepted";
    return { status };
  }

  /** Retire the session. eve 1.0 still serves `/reset` (and `/end`). */
  async reset(): Promise<void> {
    await this.client.post(this.path("/reset"), {});
  }
}

export class AgentClient {
  readonly base: string;
  private readonly resolveHeaders: () => Promise<Record<string, string>>;

  constructor(options: ClientOptions) {
    this.base = options.base.replace(/\/$/, "");
    this.resolveHeaders = options.headers;
  }

  async headers(): Promise<Headers> {
    return new Headers(await this.resolveHeaders());
  }

  /** POST JSON; a non-2xx answer throws ClientError. Returns the parsed body. */
  async post(url: string, body: unknown, signal?: AbortSignal, expectSession?: string): Promise<unknown> {
    const headers = await this.headers();
    headers.set("content-type", "application/json");
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "manual",
      signal: signal ?? null,
    });
    const text = await res.text();
    if (!res.ok) throw new ClientError(res.status, text, res.headers);
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (expectSession) {
      const id = (parsed as { sessionId?: unknown })?.sessionId ?? res.headers.get("x-eve-session-id");
      if (typeof id === "string" && id && id !== expectSession) throw new Error("The agent answered for a different session.");
    }
    return parsed;
  }

  attach(sessionId: string, options: { streamIndex?: number } = {}): AgentSession {
    if (!sessionId) throw new Error("sessionId must be a non-empty string.");
    return new AgentSession(this, sessionId, options.streamIndex ?? 0);
  }

  /** Open a session with its first message. */
  async create(input: {
    message: unknown;
    clientContext?: string;
    signal?: AbortSignal;
  }): Promise<{ session: AgentSession; response: AsyncGenerator<StreamEvent> }> {
    const headers = await this.headers();
    headers.set("content-type", "application/json");
    const res = await fetch(`${this.base}/eve/v1/session`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: input.message, ...(input.clientContext ? { clientContext: input.clientContext } : {}) }),
      redirect: "manual",
      signal: input.signal ?? null,
    });
    const text = await res.text();
    if (!res.ok) throw new ClientError(res.status, text, res.headers);
    let id: unknown;
    try {
      id = (JSON.parse(text) as { sessionId?: unknown }).sessionId;
    } catch {
      id = undefined;
    }
    id = typeof id === "string" && id ? id : res.headers.get("x-eve-session-id")?.trim();
    if (typeof id !== "string" || !id) throw new Error("The agent did not return a session id.");
    const session = new AgentSession(this, id, 0);
    const response = (async function* () {
      for await (const event of session.stream({ startIndex: 0, signal: input.signal, keepAlive: true })) {
        yield event;
        if (isBoundary(event.type)) return;
      }
    })();
    return { session, response };
  }
}
