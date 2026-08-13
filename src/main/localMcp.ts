import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MCP servers running on the user's own machine, reachable by a remote agent.
 *
 * This is the thing a desktop chat app cannot do and a cloud agent cannot do,
 * and it falls out of having both: the agent runs in the cloud, the server runs
 * next to the data, and the relay already carries work between them. A Postgres
 * inside a company network, a private repository, an internal tool with no
 * ingress at all — none of them need a tunnel, a VPN seat, or a public endpoint,
 * because nothing ever connects INTO this machine.
 *
 * The transport is JSON-RPC over the same request/response channel local
 * execution uses. MCP's stdio framing is line-delimited JSON, which survives
 * store-and-forward intact as long as one thing holds: requests for a server go
 * to the same process, in order. That is why servers are long-lived here rather
 * than spawned per call — a server that loses its session between calls has no
 * memory of what it just told the agent.
 */

export interface LocalMcpServer {
  /** Stable id, used by the agent to address it. */
  id: string;
  name: string;
  /** The command to run, e.g. `npx`. */
  command: string;
  args: string[];
  /** Extra environment for the server process. Never logged. */
  env?: Record<string, string>;
  /** Working directory; defaults to the user's home. */
  cwd?: string;
  enabled: boolean;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  /** Recent stderr, which is where MCP servers say what is wrong. */
  log: string[];
  /** In-flight JSON-RPC calls, by id. */
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void }>;
  nextId: number;
  startedAt: number;
  /** Resolves once the MCP handshake has completed for this process. */
  ready?: Promise<void>;
}

const running = new Map<string, Running>();

function configPath(): string {
  const dir = app.getPath("userData");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "local-mcp.json");
}

export function listServers(): LocalMcpServer[] {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as { servers?: LocalMcpServer[] };
    return parsed.servers ?? [];
  } catch {
    return [];
  }
}

export function saveServers(servers: LocalMcpServer[]): void {
  writeFileSync(configPath(), JSON.stringify({ servers }, null, 2), { mode: 0o600 });
}

/**
 * Start a server, or return the one already running.
 *
 * Deliberately lazy: a server that nothing has asked for should not be holding
 * a database connection open on someone's laptop all day.
 */
function ensure(server: LocalMcpServer): Running {
  const live = running.get(server.id);
  if (live && !live.child.killed) return live;

  // Through a login shell, for the same reason local commands are: an Electron
  // app inherits a minimal PATH, and `npx` installed by nvm or Homebrew is not
  // on it. Spawning directly fails with ENOENT for a command that works
  // perfectly in the user's terminal.
  const line = [server.command, ...server.args].join(" ");
  const child = spawn(process.env.SHELL ?? "/bin/bash", ["-lc", line], {
    cwd: server.cwd ?? app.getPath("home"),
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;

  const state: Running = {
    child,
    buffer: "",
    log: [],
    pending: new Map(),
    nextId: 1,
    startedAt: Date.now(),
  };

  child.stdout.on("data", (chunk: Buffer) => {
    state.buffer += chunk.toString("utf8");
    let newline = state.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = state.buffer.slice(0, newline).trim();
      state.buffer = state.buffer.slice(newline + 1);
      newline = state.buffer.indexOf("\n");
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof message.id !== "number") continue;
        const waiting = state.pending.get(message.id);
        if (!waiting) continue;
        state.pending.delete(message.id);
        if (message.error) {
          const detail = (message.error as { message?: string }).message ?? "the server failed";
          waiting.reject(new Error(detail));
        } else {
          waiting.resolve(message.result);
        }
      } catch {
        // A server writing non-JSON to stdout is a server logging where it
        // should not. Ignore the line rather than kill the session over it.
      }
    }
  });

  // stderr is where an MCP server says what is wrong — and, for a server that
  // wants OAuth, where it prints the URL to visit. Swallowing it meant a server
  // asking to be signed in looked identical to one that was simply broken.
  //
  // Kept in memory only, and never sent to the agent: these lines routinely
  // contain connection strings.
  child.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      state.log.push(trimmed);
      if (state.log.length > 40) state.log.shift();
    }
  });

  // A command that cannot start at all — ENOENT, no permission — emits this and
  // nothing else. Without it every pending call simply waited out its timeout,
  // so a typo in a command looked identical to a server thinking hard.
  child.on("error", (error) => {
    state.log.push(`could not start: ${error.message}`);
    for (const waiting of state.pending.values()) waiting.reject(error);
    state.pending.clear();
    state.ready = undefined;
    running.delete(server.id);
  });

  child.on("exit", (code) => {
    state.ready = undefined;
    // A server that exits during startup has usually said why on stderr — and
    // has certainly not answered the call that started it.
    if (state.pending.size) {
      const said = state.log.slice(-2).join(" · ");
      const detail = said || `${server.name} exited (${code ?? "no code"}) before answering.`;
      for (const waiting of state.pending.values()) waiting.reject(new Error(detail));
      state.pending.clear();
    }
    running.delete(server.id);
  });

  running.set(server.id, state);
  return state;
}

/** Write one JSON-RPC message and wait for its answer. */
function send(
  state: Running,
  name: string,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
  notify = false,
): Promise<unknown> {
  if (notify) {
    state.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })}\n`);
    return Promise.resolve(undefined);
  }
  const id = state.nextId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`${name} did not answer in time.`));
    }, timeoutMs);

    state.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    state.child.stdin.write(`${payload}\n`);
  });
}

/**
 * The MCP handshake, once per process.
 *
 * Missing this was why a perfectly good server timed out: an MCP server ignores
 * everything until it has been initialized, so tools/list went into a process
 * that was never going to answer it, and the only symptom was silence. The
 * first call also has to allow for npx fetching the package, which on a cold
 * cache is minutes rather than seconds.
 */
function handshake(state: Running, name: string): Promise<void> {
  if (!state.ready) {
    state.ready = (async () => {
      await send(
        state,
        name,
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "kyber-studio", version: "1.0.0" },
        },
        180_000,
      );
      await send(state, name, "notifications/initialized", undefined, 5_000, true);
    })();
  }
  return state.ready;
}

/** One JSON-RPC call to a local server. */
export async function callServer(input: {
  serverId: string;
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<unknown> {
  const server = listServers().find((s) => s.id === input.serverId && s.enabled);
  if (!server) throw new Error(`No local MCP server called ${input.serverId} is set up here.`);

  const state = ensure(server);
  await handshake(state, server.name);
  return await send(state, server.name, input.method, input.params, input.timeoutMs ?? 60_000);
}

/**
 * What a server is doing, for a person looking at it.
 *
 * A sign-in URL counts as status: several MCP servers authorize by printing a
 * link on first run, and without surfacing it the only symptom is a tool that
 * never works.
 */
export function serverStatus(id: string): {
  running: boolean;
  log: string[];
  signInUrl?: string;
} {
  const state = running.get(id);
  if (!state) return { running: false, log: [] };
  const joined = state.log.join(" ");
  const url = /https?:\/\/[^\s"']+/.exec(joined)?.[0];
  return { running: !state.child.killed, log: state.log.slice(-12), ...(url ? { signInUrl: url } : {}) };
}

/**
 * Start a server and ask what it can do.
 *
 * The honest answer to "how do I know this works": try it. It also triggers
 * whatever first-run authorization the server wants, so any sign-in prompt
 * appears now rather than the first time someone asks the agent for something.
 */
export async function testServer(id: string): Promise<{
  ok: boolean;
  tools?: string[];
  error?: string;
  signInUrl?: string;
}> {
  try {
    const result = (await callServer({ serverId: id, method: "tools/list", timeoutMs: 180_000 })) as {
      tools?: { name: string }[];
    };
    return { ok: true, tools: (result?.tools ?? []).map((t) => t.name) };
  } catch (error) {
    const status = serverStatus(id);
    // The server's own last words are far more useful than our timeout: they
    // say "missing API key" or "sign in at …" where we can only say it went
    // quiet.
    const said = status.log.filter((l) => !/^\s*$/.test(l)).slice(-2).join(" · ");
    return {
      ok: false,
      error: said || (error instanceof Error ? error.message : String(error)),
      ...(status.signInUrl ? { signInUrl: status.signInUrl } : {}),
    };
  }
}

/** Stop everything. Called when the app quits, so no server outlives the window. */
export function stopAll(): void {
  for (const [, state] of running) state.child.kill();
  running.clear();
}
