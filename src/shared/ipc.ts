export interface LocalMcpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
}

/**
 * The renderer's whole view of the outside world.
 *
 * These types live in `shared`, not `main`, so the dependency points one way:
 * main imports from shared. The reverse makes the renderer's typecheck pull in
 * Electron main-process code, which then fails to compile for the web target.
 */

export interface Session {
  token: string;
  /**
   * The short-TTL policy bundle minted alongside the token. kybernesisAuth
   * needs BOTH: the token says who you are, the bundle says which agents you
   * hold grants for. A request carrying only the token is treated as an
   * agent-to-agent call and refused.
   */
  bundle?: string;
  refreshToken?: string;
  expiresAt: number;
  email?: string;
  orgName?: string;
}

export interface RemoteAgent {
  id: string;
  name: string;
  runtime: string;
  url: string | null;
  accessMode: string;
  audience: string | null;
  reachable: boolean;
  daemonLabel: string | null;
}

export type LocalAction = "run-command" | "read-file" | "write-file" | "list-directory";
export type LocalPermission = "always" | "ask" | "never";

/** One pending request for something on this machine, awaiting the user. */
export interface LocalAsk {
  id: string;
  agent: string;
  action: LocalAction;
  label: string;
  detail: string;
}

export interface StudioApi {
  session(): Promise<Session | null>;
  signIn(): Promise<{ userCode: string; verificationUri: string }>;
  awaitSignIn(): Promise<Session>;
  signOut(): Promise<void>;
  listAgents(): Promise<RemoteAgent[]>;
  send(input: {
    url: string;
    text: string;
    sessionId?: string;
    continuationToken?: string;
    streamIndex?: number;
    inputResponses?: { requestId: string; optionId?: string; text?: string }[];
    clientContext?: Record<string, unknown>;
    streamId: string;
  }): Promise<{
    reply: string;
    sessionId?: string;
    continuationToken?: string;
    streamIndex: number;
    askedQuestion: boolean;
  }>;
  /** Subscribe to streaming deltas. Returns an unsubscribe function. */
  onDelta(handler: (payload: { streamId: string; text: string }) => void): () => void;
  /** Subscribe to "what the agent is doing" updates. null clears the line. */
  provisionLocal(input: { url: string; agent: string }): Promise<{ ok: boolean; error?: string; restarted?: boolean }>;
  localAccess(agent: string): Promise<boolean>;
  revokeLocal(agent: string): Promise<boolean>;
  connectors(agent: string): Promise<{
    configured: boolean;
    connectors: {
      slug: string;
      name: string;
      description?: string;
      provider: string;
      scope: string;
      needsAdmin: boolean;
      mark?: string;
      logo?: string;
      connected: boolean;
    }[];
  }>;
  connectService(input: { agent: string; slug: string }): Promise<{ ok: boolean; error?: string }>;
  disconnectService(input: {
    agent: string;
    slug: string;
    shared?: boolean;
  }): Promise<{ ok: boolean; error?: string }>;
  addCustomConnector(input: {
    agent: string;
    name: string;
    url: string;
    token?: string;
    shared?: boolean;
  }): Promise<{ ok: boolean; error?: string }>;
  connectMcpServer(id: string): Promise<{ ok: boolean; message: string; signInUrl?: string }>;
  testMcpServer(id: string): Promise<{
    ok: boolean;
    tools?: string[];
    error?: string;
    signInUrl?: string;
  }>;
  mcpServers(): Promise<LocalMcpServer[]>;
  saveMcpServers(servers: LocalMcpServer[]): Promise<LocalMcpServer[]>;
  openExternal(url: string): Promise<void>;
  cancelTurn(input: { url: string; sessionId: string; turnId?: string }): Promise<string>;
  resetSession(input: {
    url: string;
    sessionId?: string;
    continuationToken?: string;
  }): Promise<void>;
  onTurn(
    handler: (payload: { streamId: string; sessionId: string; turnId?: string }) => void,
  ): () => void;
  onActivity(
    handler: (payload: { streamId: string; label: string | null }) => void,
  ): () => void;
  onCursor(handler: (payload: { streamId: string; index: number }) => void): () => void;
  onAuthorization(
    handler: (payload: {
      streamId: string;
      event: {
        name: string;
        description?: string;
        url?: string;
        userCode?: string;
        instructions?: string;
        expiresAt?: string;
        outcome?: string;
      };
    }) => void,
  ): () => void;
  onQuestion(
    handler: (payload: {
      streamId: string;
      request: {
        requestId: string;
        prompt: string;
        options?: { id: string; label: string; description?: string; style?: string }[];
        allowFreeform?: boolean;
      };
    }) => void,
  ): () => void;
  agentInfo(url: string): Promise<AgentInfo | null>;

  /** A remote agent wants to do something on this machine. */
  onLocalAsk(handler: (ask: LocalAsk) => void): () => void;
  /** The request finished (or was refused) — dismiss its card. */
  onLocalDone(handler: (payload: { id: string }) => void): () => void;
  localAnswer(input: { id: string; allow: boolean; remember: boolean }): Promise<void>;
  localPermissions(): Promise<Record<LocalAction, LocalPermission>>;

  loadState<T>(name: string): Promise<T | null>;
  saveState(input: { name: string; value: unknown }): Promise<void>;
  /** Native folder picker; null when cancelled. */
  pickFolder(): Promise<string | null>;
  manage(input: { url: string; path: string; body?: unknown }): Promise<{ ok: boolean; status: number; data: unknown }>;
  setLocalPermission(input: {
    action: LocalAction;
    value: LocalPermission;
  }): Promise<Record<LocalAction, LocalPermission>>;
}

/**
 * A flat, safe view of what an agent reports at `/eve/v1/info`.
 *
 * eve's own payload nests and groups: tools arrive as
 * { authored, available, framework, … }, skills as { static, dynamic },
 * channels as { authored, available, … }, subagents as { local, total }, and
 * the model under an `agent` object. Consuming that shape directly in five
 * components is how one wrong assumption crashed the window — so it is
 * normalized once, defensively, and the UI only ever sees arrays.
 */
export interface AgentSummary {
  name?: string;
  model?: string;
  schedules: { name: string; cron?: string; hasRun?: boolean; markdown?: string }[];
  connections: { name: string; description?: string }[];
  channels: { name: string; urlPath?: string }[];
  skills: { name: string; description?: string }[];
  tools: { name: string; description?: string }[];
  subagents: { name: string; description?: string }[];
}

/** Raw payload, deliberately loose: a remote agent may run a different eve. */
export type AgentInfo = Record<string, unknown>;
