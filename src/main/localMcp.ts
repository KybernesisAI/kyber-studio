import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, safeStorage } from "electron";
import { writeAtomic } from "./atomicWrite";
import { isSealed, sealEnv, unsealEnv } from "./mcpSecrets";

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

/**
 * Values the user typed that could not be sealed, kept for this session only.
 *
 * Same protocol as the session token: if the OS will not encrypt, we do not
 * write the secret in the clear, but we do not throw the user's work away
 * either. The server runs with what they typed until Studio restarts, and the
 * warning says so.
 */
const unpersistedEnv = new Map<string, Record<string, string>>();

/**
 * Ask the OS about encryption at most once.
 *
 * Measured: the answer is latched for the life of the process anyway — a run
 * that starts with the keyring locked stays broken after an unlock, and one
 * that starts unlocked keeps working after a lock. Asking twice cannot produce
 * a different answer, and each ask is what can raise an unlock dialog. So the
 * first answer is the answer.
 */
let availabilityAnswer: boolean | null = null;
const credentialStore = {
  isEncryptionAvailable: (): boolean => {
    if (availabilityAnswer === null) availabilityAnswer = safeStorage.isEncryptionAvailable();
    return availabilityAnswer;
  },
  getSelectedStorageBackend: () => safeStorage.getSelectedStorageBackend(),
  encryptString: (plain: string) => safeStorage.encryptString(plain),
  decryptString: (buf: Buffer) => safeStorage.decryptString(buf),
};

/** Why a server's stored credentials would not open, once we have tried. */
const credentialFailure = new Map<
  string,
  { reason: "store-unavailable" | "needs-re-entry"; keys: string[] }
>();

export function listServers(): LocalMcpServer[] {
  const path = configPath();
  // Absent is a first run, and `[]` is the honest answer to it.
  if (!existsSync(path)) return [];
  // Present-but-unreadable is NOT a first run, and answering `[]` is what let a
  // damaged file become an empty one: the renderer holds that `[]` and the next
  // toggle writes it back over the user's servers. Let it throw. KYB-590.
  //
  // Note this deliberately does NOT decrypt. `listServers` runs on every agent
  // request, and asking the OS about the keyring is what raises the unlock
  // prompt — see `ensure`, which opens the values at the one point that needs
  // them.
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { servers?: LocalMcpServer[] };
  return parsed.servers ?? [];
}

export function saveServers(servers: LocalMcpServer[]): void {
  // Atomic, and 0600, and both halves matter here — see ./atomicWrite. A torn
  // write of this file loses the user's configured servers including `env`,
  // and `listServers` answers a torn file with `[]`, which the next save then
  // makes permanent. KYB-582.
  // Read what is stored BEFORE writing. A value we cannot seal is left exactly
  // as it was rather than replaced by a plaintext copy of itself — and if this
  // read throws, the file is damaged and we must not write over it.
  const stored = new Map(listServers().map((s) => [s.id, s] as const));

  const next = servers.map((server) => {
    const previous = stored.get(server.id)?.env;

    // The store is shut: stored secrets are untouchable, in BOTH directions.
    // Not merely "we cannot write a new one" — we must not destroy one either,
    // and clearing the env box is a destruction. Review found the asymmetry:
    // an empty env used to be written through before this check ran, so on a
    // machine that provably cannot re-seal, a stored value could be deleted
    // and never recreated. Whatever is on disk stays on disk until the user is
    // somewhere the OS will encrypt.
    if (!credentialStore.isEncryptionAvailable()) {
      const typed = Object.fromEntries(
        Object.entries(server.env ?? {}).filter(([, value]) => !isSealed(value)),
      );
      if (Object.keys(typed).length > 0) {
        unpersistedEnv.set(server.id, typed);
        console.warn(
          `[mcp] OS encryption unavailable — ${server.id}'s environment is kept in memory only. Unlock your keyring and restart Studio to store it.`,
        );
      } else {
        unpersistedEnv.delete(server.id);
      }
      return previous ? { ...server, env: previous } : { ...server, env: {} };
    }

    if (!server.env || Object.keys(server.env).length === 0) {
      unpersistedEnv.delete(server.id);
      return server;
    }

    const sealed = sealEnv(credentialStore, server.env);
    if (sealed.ok) {
      unpersistedEnv.delete(server.id);
      return { ...server, env: sealed.env };
    }

    // store-unavailable. controlPlane.ts makes the same call for the session
    // token: if the OS refuses encryption we do not silently fall back to
    // plaintext. Keep the values usable for this session, persist nothing new,
    // and leave anything already stored untouched.
    // Unreachable: availability was checked above. Kept as a total function
    // rather than a cast, so a future change to sealEnv cannot silently fall
    // through into writing plaintext.
    unpersistedEnv.set(server.id, server.env);
    return { ...server, env: previous ?? {} };
  });

  // A deleted server's key must not outlive the delete. Plugins.tsx removes by
  // saving the list without it, so neither delete above ever runs for it.
  const live = new Set(servers.map((s) => s.id));
  for (const id of unpersistedEnv.keys()) if (!live.has(id)) unpersistedEnv.delete(id);

  writeAtomic(configPath(), JSON.stringify({ servers: next }, null, 2), { mode: 0o600 });
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
  // Open the stored credentials HERE, at the one point in the codebase that
  // needs the plaintext — not at list time, which is hot and would prompt.
  const opened = unsealEnv(credentialStore, server.env ?? {});
  const pending = unpersistedEnv.get(server.id);
  let env: Record<string, string>;
  if (opened.ok) {
    credentialFailure.delete(server.id);
    // Session-typed values layer OVER the opened ones. Both halves are
    // plaintext here: `pending` is filtered to unsealed values at save time.
    env = { ...opened.env, ...(pending ?? {}) };
  } else {
    // Review found the hole this closes. The previous code fell back to
    // `pending` whenever it existed — but `pending` came from the renderer,
    // and the renderer holds SEALED strings for every value the user did not
    // personally retype. That handed the child process `kyb:v1:...` as its
    // DATABASE_URL, and cleared the failure marker on the way past, so the
    // server reported healthy while its connection string was base64.
    //
    // If the stored values will not open we cannot build a correct
    // environment, whatever the user typed this session. Refuse and say so.
    credentialFailure.set(server.id, {
      reason: opened.reason,
      keys: opened.reason === "needs-re-entry" ? opened.keys : [],
    });
    // Refuse loudly rather than starting a server that cannot authenticate and
    // failing later in a way nobody can read. The two messages are different
    // because the remedies are: one is the environment, the other is the value.
    throw new Error(
      opened.reason === "store-unavailable"
        ? `${server.name}'s credentials could not be read: the OS credential store is not open. Unlock your keyring and restart Studio.`
        : `${server.name}'s stored credentials could not be decrypted (${opened.keys.join(", ")}). Remove the server and add it again.`,
    );
  }

  const line = [server.command, ...server.args].join(" ");
  const child = spawn(process.env.SHELL ?? "/bin/bash", ["-lc", line], {
    cwd: server.cwd ?? app.getPath("home"),
    env: { ...process.env, ...env },
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
    // A rejected handshake must not be cached. The process can outlive a failed
    // initialize (a cold npx, a server waiting on an OAuth prompt), and a stuck
    // promise made every later call — including the user pressing Test — fail
    // instantly with "did not answer in time" until Studio was restarted.
    state.ready = state.ready.catch((error: unknown) => {
      if (state.ready) state.ready = undefined;
      throw error;
    });
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
  credentials?: { reason: "store-unavailable" | "needs-re-entry"; keys: string[] };
} {
  const failure = credentialFailure.get(id);
  const state = running.get(id);
  if (!state) return { running: false, log: [], ...(failure ? { credentials: failure } : {}) };
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

/**
 * Sign in to a local MCP server, the way a person expects to.
 *
 * There is no single way MCP servers ask for authorization, so this tries the
 * two that exist in practice. Most expose a tool called login (or authenticate,
 * or connect) which either completes on the spot or hands back a URL. Others
 * print a URL to stderr on first run and wait. Either way the user's part is a
 * button and, at most, a browser tab.
 *
 * The alternative — telling people to ask the agent to log in — is folklore
 * dressed as a feature. It works, and nobody outside this company would ever
 * discover it.
 */
export async function authenticate(id: string): Promise<{
  ok: boolean;
  message: string;
  signInUrl?: string;
}> {
  const server = listServers().find((s) => s.id === id);
  if (!server) return { ok: false, message: "That server is not set up here." };

  let loginTool: string | undefined;
  try {
    const listed = (await callServer({ serverId: id, method: "tools/list", timeoutMs: 180_000 })) as {
      tools?: { name: string }[];
    };
    loginTool = (listed?.tools ?? [])
      .map((t) => t.name)
      .find((name) => /^(login|log_in|sign_in|signin|authenticate|connect|authorize)$/i.test(name));
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "That server did not answer.",
    };
  }

  if (loginTool) {
    try {
      const result = (await callServer({
        serverId: id,
        method: "tools/call",
        params: { name: loginTool, arguments: {} },
        timeoutMs: 180_000,
      })) as { content?: { text?: string }[]; isError?: boolean };

      const text = (result?.content ?? []).map((c) => c.text ?? "").join(" ").trim();
      // Some servers answer with a URL to visit rather than completing inline.
      const url = /https?:\/\/[^\s"']+/.exec(text)?.[0] ?? serverStatus(id).signInUrl;
      if (url) return { ok: true, message: "Finish signing in in your browser.", signInUrl: url };
      if (result?.isError) return { ok: false, message: text || "Sign-in failed." };
      return { ok: true, message: text || `Signed in to ${server.name}.` };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Sign-in failed.",
      };
    }
  }

  // No login tool: the server may have printed a link while starting.
  const url = serverStatus(id).signInUrl;
  if (url) return { ok: true, message: "Finish signing in in your browser.", signInUrl: url };

  return {
    ok: false,
    message: `${server.name} offers no sign-in step — it either needs no account or expects credentials in its command.`,
  };
}
