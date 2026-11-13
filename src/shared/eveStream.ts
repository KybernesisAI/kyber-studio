/**
 * eve's session stream, in either of the two formats agents serve.
 *
 * Agents on eve 0.81 serve stream version 26: one event per NDJSON line, and a
 * stream cursor counts events. Agents on eve 1.0 serve version 27: a line holds
 * every fact one state change produced (or one progress record), the cursor
 * counts stored lines, transport records ({"$eve": …}) are never counted, and
 * most event names changed. Which one an agent speaks is in the
 * `x-eve-stream-version` response header of every stream read.
 *
 * This module reads both and hands back events in the version 26 vocabulary
 * every client here already understands (message.completed, input.requested,
 * turn.completed, session.waiting, …), so one reader serves old and new agents
 * side by side through the upgrade. It also says how to answer a question in
 * each version: `inputResponses` for 26, `answers` for 27 (an eve 1.0 agent
 * refuses the old field with a 400).
 *
 * Dependency free and identical in every app that carries a copy; change it in
 * one place and copy it to the others.
 */

export const STREAM_VERSION_HEADER = "x-eve-stream-version";
export const STREAM_TAIL_HEADER = "x-eve-stream-tail-index";

export type StreamVersion = 26 | 27;

/** The stream version a response says it carries. No header means an older agent. */
export function streamVersionOf(headers: { get(name: string): string | null } | null | undefined): StreamVersion {
  const raw = headers?.get(STREAM_VERSION_HEADER);
  const value = raw ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  return Number.isFinite(value) && value >= 27 ? 27 : 26;
}

/** One event, in the version 26 vocabulary. */
export interface StreamEvent {
  type: string;
  data: Record<string, unknown>;
  meta?: {
    at?: string;
    /** A stable id for the event (version 27: its line and place in the line). */
    id?: string;
    /** Version 27 only: the stored line and the fact's place in it. */
    position?: { line: number; index: number };
    [key: string]: unknown;
  };
}

/** An answer as the apps hold it (the version 26 shape). */
export interface InputAnswer {
  requestId: string;
  optionId?: string;
  text?: string;
}

/**
 * The request body that answers questions or approvals on an agent of this
 * stream version.
 */
export function answersBody(version: StreamVersion, answers: readonly InputAnswer[]): Record<string, unknown> {
  if (version !== 27) return { inputResponses: answers.map((a) => ({ ...a })) };
  return {
    answers: answers.map((a) => ({
      interactionId: a.requestId,
      ...(a.optionId !== undefined ? { optionId: a.optionId } : {}),
      ...(a.text !== undefined ? { text: a.text } : {}),
    })),
  };
}

/**
 * The option that declines an approval: `deny` on eve 1.0, `cancel` before.
 * Read from the request's own options, so a card never guesses.
 */
export function declineOptionId(options: readonly { id: string }[] | undefined): string {
  const ids = (options ?? []).map((o) => o.id);
  if (ids.includes("deny")) return "deny";
  if (ids.includes("cancel")) return "cancel";
  return "cancel";
}

/**
 * Where a read that asked for `startIndex` actually begins. A negative index
 * counts back from the tail, which the response reports in
 * `x-eve-stream-tail-index` (ask for it with `includeTailIndex=1`).
 */
export function resolveStart(startIndex: number, tail: number | null | undefined): number {
  if (startIndex >= 0) return startIndex;
  if (typeof tail !== "number" || !Number.isFinite(tail)) return 0;
  return Math.max(0, tail + 1 + startIndex);
}

/** The tail header as a number, or null when absent. */
export function tailIndexOf(headers: { get(name: string): string | null } | null | undefined): number | null {
  const raw = headers?.get(STREAM_TAIL_HEADER);
  if (raw === null || raw === undefined || !/^-?\d+$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

type Json = Record<string, unknown>;

const obj = (value: unknown): Json =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export interface CallMemo {
  name: string;
  kind: string;
  label?: string;
  remote?: boolean;
  hidden?: boolean;
  input?: unknown;
  turnId?: string;
  taskId?: string;
}

export interface TaskMemo {
  name?: string;
  kind?: string;
  callId?: string;
  turnId?: string;
  settled?: boolean;
}

/** What a decoder remembers about a session between reads. */
export interface StreamMemory {
  calls: Map<string, CallMemo>;
  tasks: Map<string, TaskMemo>;
  partKinds: Map<string, string>;
  outputs: Map<string, unknown>;
  interactions: Map<string, { kind: string; name?: string }>;
}

export function createStreamMemory(): StreamMemory {
  return { calls: new Map(), tasks: new Map(), partKinds: new Map(), outputs: new Map(), interactions: new Map() };
}

/** Keeps a long session's memory bounded: the oldest entries go first. */
const MEMORY_LIMIT = 500;
function trim(memory: StreamMemory): void {
  for (const map of [memory.calls, memory.tasks, memory.partKinds, memory.outputs, memory.interactions] as Map<string, unknown>[]) {
    while (map.size > MEMORY_LIMIT) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}

/**
 * Reads one stream: feed it every record of a response in order, across
 * reconnects, and it returns the events each one holds.
 *
 * `cursor` is the next line to ask for when the read resumes. For version 26
 * it counts events, for version 27 stored lines; transport records count in
 * neither.
 */
export class StreamDecoder {
  readonly version: StreamVersion;
  /** The next line to read. */
  cursor: number;
  /** The server said the session is over and its stream closed. */
  ended = false;
  /** The server ended this response's lease; reconnect from `cursor`. */
  leaseEnded = false;

  private readonly calls: Map<string, CallMemo>;
  private readonly tasks: Map<string, TaskMemo>;
  private readonly partKinds: Map<string, string>;
  private readonly outputs: Map<string, unknown>;
  private readonly interactions: Map<string, { kind: string; name?: string }>;
  private sequence = 0;

  /**
   * @param memory What earlier reads of the same session learned (which tool a
   * call id is, which kind a request is). A read that resumes mid-session,
   * such as the one after an approval, needs it to name the call it finishes;
   * share one per session with `createStreamMemory()`.
   */
  constructor(version: StreamVersion, startIndex = 0, tail?: number | null, memory: StreamMemory = createStreamMemory()) {
    this.version = version;
    this.cursor = resolveStart(startIndex, tail);
    this.calls = memory.calls;
    this.tasks = memory.tasks;
    this.partKinds = memory.partKinds;
    this.outputs = memory.outputs;
    this.interactions = memory.interactions;
    trim(memory);
  }

  /** One NDJSON line. Blank and unparseable lines yield nothing. */
  pushLine(line: string): StreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      return [];
    }
    return this.push(record);
  }

  /** One parsed record. */
  push(record: unknown): StreamEvent[] {
    const r = obj(record);
    if (typeof r.$eve === "string") {
      if (r.$eve === "position" && typeof r.next === "number") this.cursor = r.next;
      else if (r.$eve === "stream.ended") this.ended = true;
      else if (r.$eve === "stream.lease-ended") this.leaseEnded = true;
      return [];
    }
    if (this.version !== 27) {
      if (typeof r.type !== "string") return [];
      this.cursor += 1;
      return [{ type: r.type, data: obj(r.data), ...(r.meta ? { meta: obj(r.meta) } : {}) } as StreamEvent];
    }
    if (Array.isArray(r.facts)) {
      const line = this.cursor;
      this.cursor += 1;
      return this.commit(r.facts, str(r.at), line);
    }
    if (r.progress && typeof r.progress === "object") {
      const line = this.cursor;
      this.cursor += 1;
      return this.progress(obj(r.progress), line, str(r.at));
    }
    return [];
  }

  private lastAt: string | undefined;

  private commit(facts: unknown[], at: string | undefined, line: number): StreamEvent[] {
    if (at) this.lastAt = at;
    const out: StreamEvent[] = [];
    let settledTurn: string | undefined;
    let ended = false;
    facts.forEach((raw, index) => {
      const fact = obj(raw);
      const type = str(fact.type) ?? "";
      if (type === "turn.settled") settledTurn = this.turnOf(fact) ?? "";
      else if (type === "turn.started") settledTurn = undefined;
      else if (type === "session.ended") ended = true;
      this.fact(type, fact).forEach((event, k) => {
        out.push({ ...event, meta: { ...(at ? { at } : {}), id: k === 0 ? `${line}.${index}` : `${line}.${index}.${k}`, position: { line, index } } });
      });
    });
    // eve 0.81 said "the session is idle" with session.waiting after a turn
    // ended. Version 27 has no such event; a turn that settles without another
    // starting in the same line leaves the session idle, which is the moment
    // every reader here treats as the end of the turn.
    if (settledTurn !== undefined && !ended) {
      out.push({
        type: "session.waiting",
        data: { wait: "next-user-message", ...(settledTurn ? { turnId: settledTurn } : {}) },
        meta: { ...(at ? { at } : {}), id: `${line}.idle`, position: { line, index: facts.length - 1 } },
      });
    }
    return out;
  }

  private progress(record: Json, line: number, at?: string): StreamEvent[] {
    const type = str(record.type) ?? "";
    const data = obj(record.data);
    const turnId = this.turnOf(record);
    const meta = { ...((at ?? this.lastAt) ? { at: at ?? this.lastAt } : {}), id: `${line}.0`, position: { line, index: 0 } };
    if (type === "content.delta") {
      const partId = str(data.partId) ?? "";
      const kind = str(data.kind) ?? this.partKinds.get(partId) ?? "text";
      if (partId && str(data.kind)) this.partKinds.set(partId, kind);
      const delta = str(data.delta) ?? "";
      if (!delta) return [];
      if (kind === "text") return [{ type: "message.appended", data: { turnId, partId, messageDelta: delta }, meta }];
      if (kind === "reasoning") return [{ type: "reasoning.appended", data: { turnId, partId, reasoningDelta: delta }, meta }];
      return [];
    }
    if (type === "call.input") {
      const callId = str(data.callId) ?? "";
      const known = this.calls.get(callId);
      if (!known && str(data.name)) this.calls.set(callId, { name: str(data.name)!, kind: str(data.kind) ?? "tool", turnId });
      const call = this.calls.get(callId);
      if (!call || call.kind === "control") return [];
      return [
        {
          type: "action.input.appended",
          data: { turnId, callId, toolName: call.name, inputTextDelta: str(data.delta) ?? "" },
          meta,
        },
      ];
    }
    if (type === "call.progress") {
      const callId = str(data.callId) ?? "";
      const call = this.calls.get(callId);
      if (call?.hidden || call?.kind === "control") return [];
      const label = str(data.label) ?? call?.label;
      return [
        {
          type: "action.partial",
          data: {
            turnId: turnId ?? call?.turnId,
            result: { kind: "tool-result", callId, toolName: call?.name ?? "", output: data.output ?? null },
            ...(label ? { presentation: { [callId]: { label } } } : {}),
          },
          meta,
        },
      ];
    }
    return [];
  }

  private turnOf(fact: Json): string | undefined {
    return str(obj(fact.scope).turnId) ?? str(obj(fact.data).turnId);
  }

  /** One version 27 fact as the version 26 events it stands for. */
  private fact(type: string, fact: Json): Omit<StreamEvent, "meta">[] {
    const data = obj(fact.data);
    const turnId = this.turnOf(fact);
    const seq = (): number => ++this.sequence;
    switch (type) {
      case "session.started": {
        const parent = obj(data.parent);
        return [
          {
            type,
            data: {
              ...(data.runtime ? { runtime: data.runtime } : {}),
              ...(data.predecessor ? { predecessor: data.predecessor } : {}),
              ...(data.trace ? { trace: data.trace } : {}),
              ...(str(parent.sessionId) ? { invocation: { parentSessionId: parent.sessionId, callId: parent.callId } } : {}),
            },
          },
        ];
      }
      case "session.ended": {
        if (data.outcome === "failed") {
          const error = obj(data.error);
          return [
            {
              type: "session.failed",
              data: { code: str(error.code) ?? "session_failed", message: str(error.message) ?? "the session failed", error: data.error },
            },
          ];
        }
        return [{ type: "session.completed", data: {} }];
      }
      case "delivery.consumed": {
        const parts = Array.isArray(data.parts) ? data.parts.map(obj) : [];
        const texts: string[] = [];
        const mapped: Json[] = [];
        for (const part of parts) {
          if (part.kind === "text" && typeof part.text === "string") {
            texts.push(part.text);
            mapped.push({ type: "text", text: part.text });
          } else if (part.kind === "file") {
            mapped.push({
              type: "file",
              mediaType: str(part.mediaType) ?? "application/octet-stream",
              ...(str(part.filename) ? { filename: part.filename } : {}),
              ...(typeof part.size === "number" ? { size: part.size } : {}),
              ...(str(part.url) ? { url: part.url } : {}),
            });
          }
        }
        // An answer, or a delivery that only adds context, takes no part: v26
        // never reported those as a message.
        if (mapped.length === 0) return [];
        return [
          {
            type: "message.received",
            data: { turnId: str(data.turnId) ?? turnId, deliveryId: data.deliveryId, message: texts.join("\n"), parts: mapped, sequence: seq() },
          },
        ];
      }
      case "turn.started":
        return [{ type, data: { turnId: str(data.turnId) ?? turnId, sequence: seq(), ...(data.trace ? { trace: data.trace } : {}) } }];
      case "turn.paused":
        return [{ type: "turn.waiting", data: { turnId: str(data.turnId) ?? turnId, on: "input", awaiting: data.awaiting ?? [] } }];
      case "turn.settled": {
        const id = str(data.turnId) ?? turnId;
        if (data.outcome === "failed") {
          const error = obj(data.error);
          return [
            {
              type: "turn.failed",
              data: { turnId: id, code: str(error.code) ?? "turn_failed", message: str(error.message) ?? "the turn failed", error: data.error },
            },
          ];
        }
        if (data.outcome === "cancelled") return [{ type: "turn.cancelled", data: { turnId: id, cause: data.cause } }];
        return [{ type: "turn.completed", data: { turnId: id, reply: data.reply } }];
      }
      case "model.started":
        return [{ type: "step.started", data: { turnId, modelId: data.modelId, runId: data.runId, stepIndex: data.attempt ?? 0 } }];
      case "model.settled":
        return data.outcome === "completed"
          ? [{ type: "step.completed", data: { turnId, runId: data.runId, finishReason: data.finishReason ?? "stop" } }]
          : [];
      case "content.completed": {
        const kind = str(data.kind) ?? "text";
        const partId = str(data.partId);
        if (partId) this.partKinds.set(partId, kind);
        const ref = obj(data.valueRef);
        const value = data.value !== undefined ? data.value : (str(ref.preview) ?? str(data.fallbackText));
        if (kind === "text") {
          return [
            {
              type: "message.completed",
              data: {
                turnId,
                partId,
                message: typeof value === "string" ? value : "",
                // The answer is the reply phase; anything else is narration on
                // the way to more work, which v26 marked with "tool-calls".
                finishReason: data.phase === "reply" ? "stop" : "tool-calls",
                phase: data.phase,
              },
            },
          ];
        }
        if (kind === "reasoning") return [{ type: "reasoning.completed", data: { turnId, partId, reasoning: typeof value === "string" ? value : "" } }];
        if (kind === "result") return [{ type: "result.completed", data: { turnId, partId, result: value ?? null } }];
        return [];
      }
      case "call.requested": {
        const callId = str(data.callId) ?? "";
        const capability = obj(data.capability);
        const memo: CallMemo = {
          name: str(capability.name) ?? "",
          kind: str(capability.kind) ?? "tool",
          label: str(capability.label),
          remote: capability.remote === true,
          hidden: capability.hidden === true,
          input: data.input,
          turnId,
        };
        this.calls.set(callId, memo);
        if (memo.hidden || memo.kind === "control") return [];
        const input = data.input && typeof data.input === "object" && !Array.isArray(data.input) ? data.input : {};
        let action: Json;
        if (memo.kind === "agent" && memo.remote) {
          action = { kind: "remote-agent-call", callId, name: memo.name, remoteAgentName: memo.name, description: memo.label ?? "", input };
        } else if (memo.kind === "agent") {
          action = { kind: "subagent-call", callId, name: memo.name, subagentName: memo.name, description: memo.label ?? "", input };
        } else if (memo.kind === "skill") {
          action = { kind: "load-skill", callId, name: memo.name, input };
        } else {
          action = { kind: "tool-call", callId, toolName: memo.name, input };
        }
        return [
          {
            type: "actions.requested",
            data: {
              turnId,
              actions: [action],
              ...(memo.label ? { presentation: { [callId]: { label: memo.label } } } : {}),
              sequence: seq(),
            },
          },
        ];
      }
      case "call.started": {
        const callId = str(data.callId) ?? "";
        const call = this.calls.get(callId);
        const taskId = str(data.taskId);
        if (call && taskId) call.taskId = taskId;
        return [];
      }
      case "call.settled": {
        const callId = str(data.callId) ?? "";
        const call = this.calls.get(callId);
        const outputOf = str(obj(data.outputOf).callId);
        const output =
          data.output !== undefined
            ? data.output
            : outputOf && this.outputs.has(outputOf)
              ? this.outputs.get(outputOf)
              : str(obj(data.outputRef).preview);
        if (output !== undefined) this.outputs.set(callId, output);
        if (call?.hidden || call?.kind === "control") return [];
        const outcome = str(data.outcome) ?? "completed";
        const status = outcome === "completed" ? "completed" : outcome === "rejected" ? "rejected" : "failed";
        const isError = status !== "completed";
        const name = call?.name ?? "";
        let result: Json;
        if (call?.kind === "agent") {
          result = { kind: "subagent-result", callId, subagentName: name, output: output ?? null, ...(isError ? { isError: true } : {}) };
        } else if (call?.kind === "skill") {
          result = { kind: "load-skill-result", callId, name, output: output ?? null, ...(isError ? { isError: true } : {}) };
        } else {
          result = { kind: "tool-result", callId, toolName: name, output: output ?? null, ...(isError ? { isError: true } : {}) };
        }
        const error = obj(data.error);
        const label = str(data.label) ?? call?.label;
        const events: Omit<StreamEvent, "meta">[] = [
          {
            type: "action.result",
            data: {
              turnId: turnId ?? call?.turnId,
              status,
              result,
              ...(str(error.message) ? { error: { message: error.message, code: error.code } } : {}),
              ...(label ? { presentation: { [callId]: { label } } } : {}),
              sequence: seq(),
            },
          },
        ];
        // A call a task serves settles with the task's real answer. eve 0.81
        // reported that answer on task.settled, which is where readers of
        // delegations and peer replies look for it.
        const taskId = call?.taskId ?? str(obj(fact.scope).taskId);
        const task = taskId ? this.tasks.get(taskId) : undefined;
        if (taskId && task && !task.settled) {
          task.settled = true;
          events.push({
            type: "task.settled",
            data: {
              turnId: turnId ?? task.turnId,
              callId: task.callId ?? callId,
              taskId,
              ...(task.kind ? { kind: task.kind } : {}),
              ...(task.name ? { name: task.name } : {}),
              status: outcome === "completed" ? "completed" : outcome === "interrupted" ? "cancelled" : "failed",
              ...(output !== undefined ? { output } : {}),
              ...(str(error.message) ? { error: { message: error.message } } : {}),
            },
          });
        }
        return events;
      }
      case "task.started": {
        const taskId = str(data.taskId) ?? "";
        const callId = str(obj(data.startedBy).callId);
        const call = callId ? this.calls.get(callId) : undefined;
        const memo: TaskMemo = { name: str(data.name), kind: str(data.kind), callId, turnId: turnId ?? call?.turnId };
        this.tasks.set(taskId, memo);
        if (call) call.taskId = taskId;
        return [{ type, data: { turnId: memo.turnId, callId, taskId, kind: memo.kind ?? "tool", name: memo.name ?? "" } }];
      }
      case "task.ended": {
        const taskId = str(data.taskId) ?? "";
        const task = this.tasks.get(taskId);
        if (task?.settled) return [];
        if (task) task.settled = true;
        const error = obj(data.error);
        return [
          {
            type: "task.settled",
            data: {
              turnId: turnId ?? task?.turnId,
              callId: task?.callId,
              taskId,
              ...(task?.kind ? { kind: task.kind } : {}),
              ...(task?.name ? { name: task.name } : {}),
              status: data.outcome === "completed" ? "completed" : data.outcome === "cancelled" ? "cancelled" : "failed",
              ...(str(data.reason) ? { cancel: { reason: data.reason } } : {}),
              ...(str(error.message) ? { error: { message: error.message } } : {}),
            },
          },
        ];
      }
      case "child.opened": {
        const owner = obj(data.owner);
        const taskId = str(owner.taskId) ?? str(obj(fact.scope).taskId);
        const callId = str(owner.callId) ?? (taskId ? this.tasks.get(taskId)?.callId : undefined);
        return [
          {
            type: "agent.started",
            data: { turnId, callId, taskId, name: data.name, sessionId: data.sessionId, streamPath: data.stream },
          },
        ];
      }
      case "interaction.opened": {
        const interactionId = str(data.interactionId) ?? "";
        const request = obj(data.request);
        const kind = str(request.kind) ?? "question";
        const signIn = obj(request.signIn);
        this.interactions.set(interactionId, { kind, name: str(signIn.name) });
        const subject = obj(data.subject);
        if (kind === "sign-in") {
          // Another card for the same sign-in is already up.
          if (str(signIn.waitsOn)) return [];
          return [
            {
              type: "authorization.required",
              data: {
                turnId,
                name: str(signIn.displayName) ?? str(signIn.name) ?? "a connection",
                connection: signIn.name,
                description: str(request.prompt) ?? str(request.title) ?? "",
                authorization: {
                  ...(str(signIn.url) ? { url: signIn.url } : str(obj(request.link).url) ? { url: obj(request.link).url } : {}),
                  ...(str(signIn.userCode) ? { userCode: signIn.userCode } : {}),
                  ...(str(signIn.instructions) ? { instructions: signIn.instructions } : {}),
                  ...(str(signIn.expiresAt) ? { expiresAt: signIn.expiresAt } : {}),
                },
                ...(str(signIn.grant) ? { grant: signIn.grant } : {}),
                ...(signIn.principal ? { principal: signIn.principal } : {}),
                interactionId,
              },
            },
          ];
        }
        const origin = obj(data.origin);
        const originCall = obj(origin.call);
        const callId = str(originCall.callId) ?? str(subject.callId);
        const known = str(subject.callId) ? this.calls.get(str(subject.callId)!) : undefined;
        const toolName = str(originCall.name) ?? known?.name;
        const toolInput = originCall.input !== undefined ? originCall.input : known?.input;
        const action =
          callId && toolName
            ? {
                kind: "tool-call",
                callId,
                toolName,
                input: toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : {},
              }
            : undefined;
        const v26Kind = kind === "approval" ? "tool-approval" : kind === "budget" ? "session-limit" : "question";
        return [
          {
            type: "input.requested",
            data: {
              turnId,
              ...(str(subject.callId) ? { callId: subject.callId } : {}),
              ...(str(subject.taskId) ? { taskId: subject.taskId } : {}),
              requests: [
                {
                  requestId: interactionId,
                  kind: v26Kind,
                  prompt: str(request.prompt) ?? str(request.title) ?? "",
                  ...(str(request.title) ? { title: request.title } : {}),
                  ...(Array.isArray(request.options) ? { options: request.options } : {}),
                  ...(typeof request.allowFreeform === "boolean" ? { allowFreeform: request.allowFreeform } : {}),
                  ...(str(request.display) ? { display: request.display } : {}),
                  ...(request.link ? { link: request.link } : {}),
                  ...(action ? { action } : {}),
                },
              ],
              sequence: seq(),
            },
          },
        ];
      }
      case "interaction.settled": {
        const interactionId = str(data.interactionId) ?? "";
        const known = this.interactions.get(interactionId);
        const outcome = str(data.outcome) ?? "";
        if (known?.kind === "sign-in") {
          return [
            {
              type: "authorization.completed",
              data: {
                turnId,
                name: known.name ?? "a connection",
                outcome:
                  outcome === "accepted" ? "authorized" : outcome === "declined" ? "declined" : outcome === "expired" ? "timed-out" : "failed",
                interactionId,
              },
            },
          ];
        }
        // A read that began after the request opened has not seen its kind;
        // the approve and deny choices give an approval away.
        const chose = str(obj(data.response).optionId);
        const kind = known?.kind ?? (chose === "approve" || chose === "deny" ? "approval" : "question");
        const v26Kind = kind === "approval" ? "tool-approval" : kind === "budget" ? "session-limit" : "question";
        const v26Outcome =
          outcome === "accepted"
            ? kind === "approval" || kind === "budget"
              ? "approved"
              : "answered"
            : outcome === "declined"
              ? "denied"
              : outcome === "invalid" || outcome === "failed"
                ? "invalid"
                : outcome === "expired"
                  ? "ignored"
                  : "cancelled";
        return [
          {
            type: "input.resolved",
            data: {
              turnId,
              resolutions: [
                {
                  requestId: interactionId,
                  kind: v26Kind,
                  outcome: v26Outcome,
                  ...(data.response ? { response: data.response } : {}),
                },
              ],
            },
          },
        ];
      }
      case "context.started":
        return data.kind === "compaction" ? [{ type: "compaction.requested", data: { turnId: str(data.turnId) ?? turnId } }] : [];
      case "context.settled":
        if (data.outcome !== "completed") return [];
        if (data.kind === "compaction") return [{ type: "compaction.completed", data: { turnId } }];
        if (data.kind === "clear") return [{ type: "context.cleared", data: { turnId } }];
        return [];
      default:
        return [];
    }
  }
}

/**
 * Every event in a finished read, from its raw NDJSON lines.
 *
 * For replaying history: give it the response's version, the start the read
 * asked for, and the tail header when the start was negative.
 */
export function decodeLines(
  lines: readonly string[],
  version: StreamVersion,
  startIndex = 0,
  tail?: number | null,
  memory?: StreamMemory,
): { events: StreamEvent[]; cursor: number; ended: boolean } {
  const decoder = new StreamDecoder(version, startIndex, tail, memory);
  const events: StreamEvent[] = [];
  for (const line of lines) events.push(...decoder.pushLine(line));
  return { events, cursor: decoder.cursor, ended: decoder.ended };
}

/** True for a record that is a stored line of the stream (counts toward the cursor). */
export function isStoredRecord(version: StreamVersion, record: unknown): boolean {
  const r = obj(record);
  if (typeof r.$eve === "string") return false;
  if (version !== 27) return typeof r.type === "string";
  return Array.isArray(r.facts) || (!!r.progress && typeof r.progress === "object");
}
