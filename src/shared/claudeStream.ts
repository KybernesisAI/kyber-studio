/**
 * Claude Code as an agent transport: the pure half.
 *
 * A local coding agent is the user's own `claude` CLI run in a project folder.
 * Studio launches it exactly as a terminal would and reads its stream-json
 * output — it never sees a login, a token, or anything under ~/.claude. These
 * functions build the command line and read the stream; the process itself is
 * src/main/claudeCode.ts. No Electron imports, so node --test loads this file.
 */

import type { AgentSchedule } from "./schedule";

export interface LocalAgentConfig {
  id: string;
  name: string;
  /** Absolute path the CLI runs in. Its CLAUDE.md is what makes it this agent. */
  folder: string;
  /** Passed to --model as-is: an alias ("sonnet") or a full model id. */
  model: string;
  /** A daily turn posted into this agent's conversation. See ./schedule. */
  schedule?: AgentSchedule;
}

/** Arguments for one turn. The first turn starts a session; later ones resume it. */
export function buildClaudeArgs(cfg: LocalAgentConfig, message: string, sessionId?: string): string[] {
  const args = [
    "-p",
    message,
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    cfg.model,
    // A headless run cannot answer a prompt. In auto mode anything the
    // classifier would ask about is denied instead, and the denial is reported
    // back in the reply — never retried with looser flags.
    "--permission-mode",
    "auto",
  ];
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

export type StreamEvent =
  /** The session this turn belongs to. Only ever read from the stream itself. */
  | { kind: "session"; sessionId: string }
  | { kind: "text"; text: string }
  /** A tool the agent is running, phrased for the activity line. */
  | { kind: "activity"; label: string; toolUseId?: string }
  /** A tool call that came back as an error, kept so a denial can be quoted. */
  | { kind: "tool-error"; toolUseId: string; text: string }
  | {
      kind: "result";
      sessionId?: string;
      isError: boolean;
      result?: string;
      denials: { toolName: string; toolUseId?: string; input?: unknown }[];
    };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** What a tool call is doing, in a few words. */
export function describeToolUse(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const detail =
    str(i.description) ?? str(i.command) ?? str(i.file_path) ?? str(i.pattern) ?? str(i.url) ?? str(i.path);
  const short = detail ? (detail.length > 80 ? `${detail.slice(0, 77)}…` : detail) : "";
  return short ? `${name}: ${short}` : name;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? str((c as Record<string, unknown>).text) ?? "" : ""))
      .join("");
  }
  return "";
}

/**
 * Read one line of `--output-format stream-json`.
 *
 * Returns every event the line carries — an assistant message can hold text and
 * tool calls together. Lines it does not understand (hooks, rate limits,
 * thinking) yield nothing rather than throwing: a newer CLI adding an event
 * type must not break a conversation.
 */
export function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let d: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") return [];
    d = parsed as Record<string, unknown>;
  } catch {
    return [];
  }

  if (d.type === "system" && d.subtype === "init") {
    const sessionId = str(d.session_id);
    return sessionId ? [{ kind: "session", sessionId }] : [];
  }

  if (d.type === "assistant" || d.type === "user") {
    const message = d.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
    const out: StreamEvent[] = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      if (d.type === "assistant" && c.type === "text" && str(c.text)) {
        out.push({ kind: "text", text: c.text as string });
      } else if (d.type === "assistant" && c.type === "tool_use") {
        out.push({
          kind: "activity",
          label: describeToolUse(str(c.name) ?? "tool", c.input),
          toolUseId: str(c.id),
        });
      } else if (d.type === "user" && c.type === "tool_result" && c.is_error === true) {
        out.push({ kind: "tool-error", toolUseId: str(c.tool_use_id) ?? "", text: toolResultText(c.content) });
      }
    }
    return out;
  }

  if (d.type === "result") {
    const denials = Array.isArray(d.permission_denials)
      ? (d.permission_denials as Record<string, unknown>[]).map((p) => ({
          toolName: str(p?.tool_name) ?? "tool",
          toolUseId: str(p?.tool_use_id),
          input: p?.tool_input,
        }))
      : [];
    return [
      {
        kind: "result",
        sessionId: str(d.session_id),
        isError: d.is_error === true,
        result: str(d.result),
        denials,
      },
    ];
  }

  return [];
}

/**
 * Turn the denials a run reported into text for the reply.
 *
 * Auto mode refuses rather than asks, and a refusal the user never sees reads
 * as an agent that silently did nothing. The CLI's own wording is quoted when
 * the tool result carried it.
 */
export function describeDenials(
  denials: { toolName: string; toolUseId?: string; input?: unknown }[],
  toolErrors: Map<string, string>,
): string {
  if (denials.length === 0) return "";
  const lines = denials.map((d) => {
    const said = d.toolUseId ? toolErrors.get(d.toolUseId)?.trim() : undefined;
    const what = describeToolUse(d.toolName, d.input);
    return said ? `- ${what} — ${said}` : `- ${what}`;
  });
  return `Claude Code's permission check refused ${denials.length === 1 ? "an action" : `${denials.length} actions`}:\n${lines.join("\n")}`;
}

/** The last few lines of stderr, for a turn that crashed. */
export function stderrTail(stderr: string, lines = 12): string {
  return stderr.trimEnd().split("\n").slice(-lines).join("\n");
}
