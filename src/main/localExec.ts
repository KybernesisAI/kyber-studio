import { callServer } from "./localMcp";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { app, type WebContents } from "electron";
import { ISSUER, activeSession, currentSession, deviceId } from "./controlPlane";

/**
 * Local execution: the desktop half.
 *
 * A cloud agent cannot open a connection into this machine, so Studio connects
 * out — it heartbeats, long-polls the control plane for work, runs what the user
 * allows, and posts results back. Nothing listens on a port here.
 *
 * Permission is enforced on THIS side, per effect rather than per tool. Two
 * different tools that both read a file out both request `read-file`, so an
 * agent cannot reach an approved effect through an unapproved name.
 *
 * Known deviation from the reference design: exec runs in this process rather
 * than a separate supervised daemon. Commands are still spawned as children, so
 * a runaway command cannot take the window down, but a bug in this file can.
 * Splitting it out is the next hardening step, not something already done.
 */

export const LOCAL_ACTIONS = [
  "run-command",
  "read-file",
  "write-file",
  "list-directory",
  // An MCP server on this machine, called by the remote agent. Its own effect,
  // not run-command: the user approved a named server with a known job, which
  // is a narrower thing than approving arbitrary commands, and folding it into
  // one would take the wider permission for the narrower ask.
  "local-mcp",
] as const;
export type LocalAction = (typeof LOCAL_ACTIONS)[number];

export type LocalPermission = "always" | "ask" | "never";

/** Ask by default. A fresh install must never hand an agent this machine silently. */
const DEFAULT_PERMISSION: LocalPermission = "ask";

export function actionLabel(action: LocalAction): string {
  switch (action) {
    case "run-command":
      return "Run a command on this computer?";
    case "read-file":
      return "Read a file from this computer?";
    case "write-file":
      return "Write a file on this computer?";
    case "list-directory":
      return "List a folder on this computer?";
    case "local-mcp":
      return "Use a service running on this computer?";
  }
}

// ── permission store ────────────────────────────────────────────────────────

function permsPath(): string {
  return join(app.getPath("userData"), "local-permissions.json");
}

export function readPermissions(): Record<LocalAction, LocalPermission> {
  const base = Object.fromEntries(LOCAL_ACTIONS.map((a) => [a, DEFAULT_PERMISSION])) as Record<
    LocalAction,
    LocalPermission
  >;
  try {
    const raw = JSON.parse(readFileSync(permsPath(), "utf8")) as Record<string, string>;
    for (const a of LOCAL_ACTIONS) {
      const v = raw[a];
      if (v === "always" || v === "ask" || v === "never") base[a] = v;
    }
  } catch {
    /* defaults */
  }
  return base;
}

export function setPermission(action: LocalAction, value: LocalPermission): void {
  const next = { ...readPermissions(), [action]: value };
  writeFileSync(permsPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
}

// ── the ask flow ────────────────────────────────────────────────────────────

interface PendingAsk {
  resolve(decision: { allow: boolean; remember: boolean }): void;
}
const asks = new Map<string, PendingAsk>();

export function answerAsk(id: string, allow: boolean, remember: boolean): void {
  asks.get(id)?.resolve({ allow, remember });
  asks.delete(id);
}

async function authorize(
  sender: WebContents | null,
  request: { id: string; agent: string; action: LocalAction; payload: Record<string, unknown> },
): Promise<boolean> {
  const perms = readPermissions();
  const setting = perms[request.action];
  if (setting === "never") return false;
  if (setting === "always") return true;

  // No window to ask in: refuse rather than assume consent.
  if (!sender || sender.isDestroyed()) return false;

  sender.send("studio:local-ask", {
    id: request.id,
    agent: request.agent,
    action: request.action,
    label: actionLabel(request.action),
    detail: describe(request.action, request.payload),
  });

  const decision = await new Promise<{ allow: boolean; remember: boolean }>((res) => {
    asks.set(request.id, { resolve: res });
    // An unanswered card must not hold the agent forever. Two minutes matches
    // the relay's own patience, after which it reports a timeout the user can act on.
    setTimeout(() => {
      if (asks.has(request.id)) {
        asks.delete(request.id);
        res({ allow: false, remember: false });
      }
    }, 120_000);
  });

  if (decision.allow && decision.remember) setPermission(request.action, "always");
  if (!decision.allow && decision.remember) setPermission(request.action, "never");
  return decision.allow;
}

/** One line describing exactly what was asked for, shown on the card. */
function describe(action: LocalAction, payload: Record<string, unknown>): string {
  switch (action) {
    case "run-command":
      return `${String(payload.command ?? "")}${payload.cwd ? `  ·  in ${String(payload.cwd)}` : ""}`;
    case "read-file":
      return payload.op === "search"
        ? `search "${String(payload.pattern ?? "")}" under ${String(payload.path ?? "")}`
        : String(payload.path ?? "");
    case "write-file":
      return payload.op === "edit"
        ? `edit ${String(payload.path ?? "")}`
        : String(payload.path ?? "");
    case "list-directory":
      return String(payload.path ?? "");
    case "local-mcp":
      // The server's name, not the method: "use Postgres on this machine" is
      // the decision the user is making, and `tools/call` tells them nothing.
      return String(payload.server ?? "a local service");
  }
}

// ── executors ───────────────────────────────────────────────────────────────

function runCommand(
  payload: Record<string, unknown>,
  onFrame?: (chunk: string) => void,
): Promise<unknown> {
  const command = String(payload.command ?? "");
  const cwd = payload.cwd ? String(payload.cwd) : app.getPath("home");
  const timeoutMs = Number(payload.timeoutMs ?? 120_000);

  return new Promise((res) => {
    // A login shell so the user's own PATH and toolchains are present — an agent
    // told "run npm test" should get the npm the user has, not a bare PATH.
    const child = spawn(process.env.SHELL ?? "/bin/bash", ["-lc", command], {
      cwd: existsSync(cwd) ? cwd : app.getPath("home"),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cap = 200_000;

    // Report output as it appears. The relay does not need this to display
    // anything — it needs it to know the command is alive, so a long build keeps
    // resetting the idle clock instead of tripping a deadline.
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      if (stdout.length < cap) stdout += text;
      onFrame?.(text);
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      if (stderr.length < cap) stderr += text;
      onFrame?.(text);
    });

    // A command can be legitimately silent for minutes (a long compile, a slow
    // install). A bare tick keeps it distinguishable from a hang without
    // pretending there was output.
    const tick = setInterval(() => onFrame?.(""), 20_000);
    const stopTick = (): void => clearInterval(tick);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        stopTick();
        child.kill("SIGKILL");
        res({ exitCode: null, stdout, stderr, timedOut: true, timeoutMs });
      }
    }, timeoutMs);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      stopTick();
      clearTimeout(timer);
      res({ exitCode: null, stdout, stderr: String(err), failedToStart: true });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      stopTick();
      clearTimeout(timer);
      res({ exitCode: code, stdout, stderr, cwd });
    });
  });
}

function readLocalFile(payload: Record<string, unknown>): unknown {
  const path = resolve(String(payload.path ?? ""));
  const maxBytes = Number(payload.maxBytes ?? 500_000);
  if (!existsSync(path)) throw new Error(`No such file: ${path}`);
  const stat = statSync(path);
  if (stat.isDirectory()) throw new Error(`${path} is a directory — use local_list.`);
  const buf = readFileSync(path);
  const truncated = buf.length > maxBytes;
  const text = buf.subarray(0, maxBytes).toString("utf8");

  // A line window, for an agent that is about to edit rather than read.
  const startLine = payload.startLine ? Number(payload.startLine) : null;
  const endLine = payload.endLine ? Number(payload.endLine) : null;
  if (startLine) {
    const lines = text.split("\n");
    const from = Math.max(1, startLine);
    const to = Math.min(lines.length, endLine ?? from + 200);
    return {
      path,
      bytes: stat.size,
      startLine: from,
      endLine: to,
      totalLines: lines.length,
      content: lines.slice(from - 1, to).join("\n"),
    };
  }
  return { path, bytes: stat.size, truncated, content: text };
}

/**
 * Replace an exact string in a file.
 *
 * Declares the WRITE-FILE effect, not an effect of its own: editing a file and
 * writing a file are the same thing happening to the user's code, and giving
 * this its own permission would let an agent reach an approved effect through
 * a name the user never approved.
 *
 * Refuses when the target is absent or ambiguous, because a silent no-op and a
 * wrong-occurrence replacement are both worse than an error the model can fix.
 */
function editLocalFile(payload: Record<string, unknown>): unknown {
  const path = resolve(String(payload.path ?? ""));
  const oldString = String(payload.oldString ?? "");
  const newString = String(payload.newString ?? "");
  const replaceAll = Boolean(payload.replaceAll);

  if (!existsSync(path)) throw new Error(`No such file: ${path}`);
  if (!oldString) throw new Error("oldString is required — use local_write to create a file.");

  const before = readFileSync(path, "utf8");
  const occurrences = before.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error(
      `That exact text is not in ${path}. Read the file again — it may differ in whitespace or have changed.`,
    );
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `That text appears ${occurrences} times in ${path}. Include more surrounding lines to make it unique, or pass replaceAll.`,
    );
  }

  const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString);
  writeFileSync(path, after, "utf8");
  return { path, replaced: replaceAll ? occurrences : 1, bytes: Buffer.byteLength(after) };
}

/** Search file contents under a directory. Declares the read-file effect. */
function searchLocal(payload: Record<string, unknown>): unknown {
  const root = resolve(String(payload.path ?? ""));
  const pattern = String(payload.pattern ?? "");
  const glob = payload.glob ? String(payload.glob) : null;
  const maxResults = Math.min(Number(payload.maxResults ?? 60), 200);
  if (!pattern) throw new Error("pattern is required");
  if (!existsSync(root)) throw new Error(`No such directory: ${root}`);

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    throw new Error(`Not a valid regular expression: ${pattern}`);
  }

  const skip = new Set([".git", "node_modules", ".next", "dist", "out", "build", ".cache"]);
  const hits: { path: string; line: number; text: string }[] = [];

  const walk = (dir: string): void => {
    if (hits.length >= maxResults) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (hits.length >= maxResults) return;
      if (skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (glob && !name.endsWith(glob.replace(/^\*/, ""))) continue;
      // Skip anything large or binary rather than streaming megabytes back.
      if (st.size > 2_000_000) continue;
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
        const line = lines[i] ?? "";
        if (re.test(line)) hits.push({ path: full, line: i + 1, text: line.trim().slice(0, 240) });
      }
    }
  };
  walk(root);
  return { root, pattern, count: hits.length, truncated: hits.length >= maxResults, hits };
}

function writeLocalFile(payload: Record<string, unknown>): unknown {
  const path = resolve(String(payload.path ?? ""));
  const content = String(payload.content ?? "");
  mkdirSync(dirname(path), { recursive: true });
  const existed = existsSync(path);
  writeFileSync(path, content, "utf8");
  return { path, bytes: Buffer.byteLength(content), created: !existed };
}

function listLocalDir(payload: Record<string, unknown>): unknown {
  const root = resolve(String(payload.path ?? ""));
  const depth = Math.min(Number(payload.depth ?? 1), 3);
  if (!existsSync(root)) throw new Error(`No such directory: ${root}`);

  // Directories an agent almost never wants and which would swamp the reply.
  const skip = new Set([".git", "node_modules", ".next", "dist", "out", ".DS_Store"]);
  const entries: { path: string; type: "file" | "dir"; bytes?: number }[] = [];

  const walk = (dir: string, level: number): void => {
    if (level > depth || entries.length > 800) return;
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        entries.push({ path: full, type: "dir" });
        walk(full, level + 1);
      } else {
        entries.push({ path: full, type: "file", bytes: st.size });
      }
    }
  };
  walk(root, 1);
  return { root, count: entries.length, entries };
}

async function execute(
  action: LocalAction,
  payload: Record<string, unknown>,
  onFrame?: (chunk: string) => void,
): Promise<unknown> {
  // `op` narrows WHAT runs; `action` decides what the user consented to. Editing
  // and writing share the write-file effect on purpose — same consequence for
  // the user's files, so the same consent.
  const op = typeof payload.op === "string" ? payload.op : null;
  switch (action) {
    case "run-command":
      return runCommand(payload, onFrame);
    case "read-file":
      return op === "search" ? searchLocal(payload) : readLocalFile(payload);
    case "write-file":
      return op === "edit" ? editLocalFile(payload) : writeLocalFile(payload);
    case "list-directory":
      return listLocalDir(payload);
    case "local-mcp":
      return callServer({
        serverId: String(payload.server ?? ""),
        method: String(payload.method ?? "tools/list"),
        params: (payload.params ?? {}) as Record<string, unknown>,
      });
  }
}

// ── the loop ────────────────────────────────────────────────────────────────

let running = false;
let sender: WebContents | null = null;

export function setLocalExecWindow(contents: WebContents): void {
  sender = contents;
}

async function post(path: string, body: unknown): Promise<Response | null> {
  const s = await activeSession();
  if (!s) return null;
  try {
    return await fetch(`${ISSUER}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return null;
  }
}

/**
 * Announce this machine and poll for work until sign-out.
 *
 * Heartbeat and poll are separate: the heartbeat is what lets an agent say
 * "your computer is disconnected" instead of hanging, and it must keep beating
 * even while a long poll is parked.
 */
export function startLocalExec(): void {
  if (running) return;
  running = true;
  const id = deviceId();

  const heartbeat = async (): Promise<void> => {
    while (running) {
      if (await activeSession()) {
        const hello = await post("/api/local-exec/hello", {
          deviceId: id,
          label: hostname().replace(/\.local$/, ""),
          platform: platform(),
        });
        console.log(`[local] hello ${hello ? hello.status : "no session/failed"}`);
      }
      await new Promise((r) => setTimeout(r, 10_000));
    }
  };

  const poll = async (): Promise<void> => {
    while (running) {
      const s = await activeSession();
      if (!s) {
        await new Promise((r) => setTimeout(r, 3_000));
        continue;
      }
      try {
        const res = await fetch(
          `${ISSUER}/api/local-exec/requests?deviceId=${encodeURIComponent(id)}`,
          {
            headers: { authorization: `Bearer ${s.token}` },
            signal: AbortSignal.timeout(60_000),
          },
        );
        if (!res.ok) {
          console.log(`[local] poll HTTP ${res.status}`);
          await new Promise((r) => setTimeout(r, 3_000));
          continue;
        }
        const body = (await res.json()) as {
          requests?: { id: string; agent: string; action: LocalAction; payload: Record<string, unknown> }[];
        };
        if ((body.requests ?? []).length) console.log(`[local] ${body.requests!.length} request(s)`);
        for (const request of body.requests ?? []) {
          void handle(request);
        }
      } catch (e) {
        console.log(`[local] poll error: ${e instanceof Error ? e.message : String(e)}`);
        // A poll that times out or drops is normal; just poll again.
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  };

  const handle = async (request: {
    id: string;
    agent: string;
    action: LocalAction;
    payload: Record<string, unknown>;
  }): Promise<void> => {
    if (!LOCAL_ACTIONS.includes(request.action)) {
      await post("/api/local-exec/responses", {
        id: request.id,
        error: `Unknown action ${request.action}.`,
      });
      return;
    }

    console.log(`[local] request ${request.action} from ${request.agent}`);
    const allowed = await authorize(sender, request);
    if (!allowed) {
      await post("/api/local-exec/responses", { id: request.id, denied: true });
      if (sender && !sender.isDestroyed()) sender.send("studio:local-done", { id: request.id });
      return;
    }

    try {
      // Throttle: the clock only needs a pulse, and a chatty build would
      // otherwise turn every line into an HTTP request.
      let buffered = "";
      let lastPost = 0;
      const flush = (force = false): void => {
        const now = Date.now();
        if (!force && now - lastPost < 3_000) return;
        lastPost = now;
        const chunk = buffered.slice(-4_000);
        buffered = "";
        void post("/api/local-exec/frames", { id: request.id, chunk });
      };
      const result = await execute(request.action, request.payload, (chunk) => {
        buffered += chunk;
        flush();
      });
      await post("/api/local-exec/responses", { id: request.id, result });
    } catch (e) {
      await post("/api/local-exec/responses", {
        id: request.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    if (sender && !sender.isDestroyed()) sender.send("studio:local-done", { id: request.id });
  };

  void heartbeat();
  void poll();
}

export function stopLocalExec(): void {
  running = false;
}
