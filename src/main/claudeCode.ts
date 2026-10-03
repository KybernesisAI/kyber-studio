import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import {
  type LocalAgentConfig,
  buildClaudeArgs,
  describeDenials,
  parseStreamLine,
  stderrTail,
} from "../shared/claudeStream";
import { loadState, saveState } from "./store";

/**
 * Local coding agents: the user's own Claude Code CLI, one process per turn.
 *
 * Studio only launches the `claude` binary the user already installed and
 * signed in to, in the agent's folder, the same way a terminal does. It never
 * reads, stores or forwards a Claude login or token, and it opens nothing under
 * ~/.claude — the session id comes from the CLI's own stream. Transcripts stay
 * where Claude Code writes them.
 *
 * This exists on the `appydave` branch only. Offering claude.ai login to other
 * people's products needs Anthropic's approval; see
 * docs/planning/claude-code-agents/north-star.md.
 */

const FILE = "local-agents.json";

const SEED: LocalAgentConfig[] = [
  {
    id: "local:kybsite",
    name: "kybsite",
    folder: "/Users/davidcruwys/dev/kybernesis/kybernesis-site",
    model: "sonnet",
  },
];

export function listLocalAgents(): LocalAgentConfig[] {
  const saved = loadState<LocalAgentConfig[] | null>(FILE, null);
  if (Array.isArray(saved)) return saved;
  saveState(FILE, SEED);
  return SEED;
}

/** Where `claude` lives and the PATH it expects, from the user's login shell. */
interface Resolved {
  bin: string;
  path: string;
}
let resolved: Promise<Resolved | null> | null = null;

/**
 * Find `claude` the way a terminal would.
 *
 * An app opened from the Dock inherits launchd's bare PATH, which does not
 * include ~/.local/bin or a Homebrew prefix, so asking only this process's
 * environment would find nothing on most machines. Not found is reported, never
 * papered over with a guessed path.
 */
function resolveClaude(): Promise<Resolved | null> {
  if (resolved) return resolved;
  resolved = new Promise((done) => {
    const script = `printf '\\n@@BIN@@%s\\n@@PATH@@%s\\n' "$(command -v claude)" "$PATH"`;
    execFile(process.env.SHELL ?? "/bin/zsh", ["-lc", script], { timeout: 15_000 }, (_err, stdout) => {
      const bin = /@@BIN@@(.*)/.exec(stdout ?? "")?.[1]?.trim() ?? "";
      const path = /@@PATH@@(.*)/.exec(stdout ?? "")?.[1]?.trim() ?? process.env.PATH ?? "";
      done(bin && existsSync(bin) ? { bin, path } : null);
    });
  });
  // A miss is not cached: the user may install the CLI and try again.
  void resolved.then((r) => {
    if (!r) resolved = null;
  });
  return resolved;
}

const running = new Map<string, ChildProcessWithoutNullStreams>();
/** Turns the user stopped, so their exit reads as "stopped", not as a crash. */
const stopped = new WeakSet<ChildProcessWithoutNullStreams>();

/** Signal the CLI and every tool process it started (its own process group). */
function killTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** Stop the turn running for this agent, if any. */
export function stopLocalTurn(agentId: string): boolean {
  const child = running.get(agentId);
  if (!child) return false;
  stopped.add(child);
  killTree(child, "SIGTERM");
  // A CLI busy in a tool call may not exit on TERM; don't leave it running.
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) killTree(child, "SIGKILL");
  }, 3_000);
  return true;
}

/** Stop every local turn; the app is going away. */
export function stopAllLocalTurns(): void {
  for (const id of [...running.keys()]) stopLocalTurn(id);
}

export async function sendLocalTurn(input: {
  agentId: string;
  text: string;
  sessionId?: string;
  onDelta(text: string): void;
  onActivity(label: string | null): void;
}): Promise<{ reply: string; sessionId?: string; streamIndex: number; askedQuestion: boolean }> {
  const cfg = listLocalAgents().find((a) => a.id === input.agentId);
  if (!cfg) throw new Error(`No local agent called ${input.agentId}.`);
  if (!existsSync(cfg.folder)) throw new Error(`The folder for ${cfg.name} does not exist: ${cfg.folder}`);
  if (running.has(cfg.id)) throw new Error(`${cfg.name} is already working on a turn.`);

  const claude = await resolveClaude();
  if (!claude) {
    throw new Error(
      "claude CLI not found. Studio runs your own installed Claude Code — install it and make sure `command -v claude` works in a terminal, then send again.",
    );
  }

  const child = spawn(claude.bin, buildClaudeArgs(cfg, input.text, input.sessionId), {
    cwd: cfg.folder,
    env: { ...process.env, PATH: claude.path },
    stdio: ["pipe", "pipe", "pipe"],
    // Its own process group, so Stop reaches the tools it spawned as well.
    detached: true,
  }) as ChildProcessWithoutNullStreams;
  child.stdin.end();
  running.set(cfg.id, child);
  input.onActivity("Claude Code is starting");

  let sessionId: string | undefined;
  let reply = "";
  let buffer = "";
  let stderr = "";
  let resultText: string | undefined;
  let resultError = false;
  let denials: { toolName: string; toolUseId?: string; input?: unknown }[] = [];
  const toolErrors = new Map<string, string>();

  const handle = (line: string): void => {
    for (const ev of parseStreamLine(line)) {
      switch (ev.kind) {
        case "session":
          sessionId = ev.sessionId;
          break;
        case "text": {
          // Each assistant message is its own paragraph in one reply bubble.
          const piece = reply ? `\n\n${ev.text}` : ev.text;
          reply += piece;
          input.onDelta(piece);
          input.onActivity(null);
          break;
        }
        case "activity":
          input.onActivity(ev.label);
          break;
        case "tool-error":
          toolErrors.set(ev.toolUseId, ev.text);
          break;
        case "result":
          sessionId = ev.sessionId ?? sessionId;
          resultText = ev.result;
          resultError = ev.isError;
          denials = ev.denials;
          break;
      }
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      handle(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-16_000);
  });

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(
    (done) => {
      child.once("error", (error) => done({ code: null, signal: null, error }));
      child.once("close", (code, signal) => done({ code, signal }));
    },
  );
  running.delete(cfg.id);
  if (buffer.trim()) handle(buffer);
  input.onActivity(null);

  if (exit.error) throw new Error(`Could not start Claude Code: ${exit.error.message}`);
  // The CLI traps TERM and exits 143 rather than dying by signal, so the flag is what tells a stop from a crash.
  if (exit.signal || stopped.has(child)) {
    return { reply: reply ? `${reply}\n\n(stopped)` : "(stopped)", sessionId, streamIndex: 0, askedQuestion: false };
  }

  const denied = describeDenials(denials, toolErrors);
  // Arrives with the final reply, which replaces the streamed text wholesale.
  if (denied) reply += reply ? `\n\n${denied}` : denied;

  if (exit.code !== 0 || resultError) {
    const tail = stderrTail(stderr);
    const why = resultError && resultText ? resultText : tail || `exited with code ${exit.code}`;
    const msg = `Claude Code failed: ${why}`;
    if (!reply) throw new Error(msg);
    return { reply: `${reply}\n\n${msg}`, sessionId, streamIndex: 0, askedQuestion: false };
  }

  if (!reply && resultText) reply = resultText;
  return { reply, sessionId, streamIndex: 0, askedQuestion: false };
}
