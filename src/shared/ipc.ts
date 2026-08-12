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
    clientContext?: Record<string, unknown>;
    streamId: string;
  }): Promise<{
    reply: string;
    sessionId?: string;
    continuationToken?: string;
    streamIndex: number;
  }>;
  /** Subscribe to streaming deltas. Returns an unsubscribe function. */
  onDelta(handler: (payload: { streamId: string; text: string }) => void): () => void;
  /** Subscribe to "what the agent is doing" updates. null clears the line. */
  onActivity(
    handler: (payload: { streamId: string; label: string | null }) => void,
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
  setLocalPermission(input: {
    action: LocalAction;
    value: LocalPermission;
  }): Promise<Record<LocalAction, LocalPermission>>;
}

/**
 * What an agent reports about itself at `/eve/v1/info`.
 *
 * Shapes mirror eve's own schema. Everything is optional because this is a
 * remote agent that may run a different eve version than we expect — a missing
 * field must render as "not reported", never as an empty list that looks like a
 * confident "you have none".
 */
export interface AgentInfo {
  name?: string;
  model?: string | { id?: string };
  instructions?: { name: string; markdown: string }[];
  skills?: { name: string; description?: string; markdown?: string }[];
  tools?: {
    name: string;
    description?: string;
    origin?: "authored" | "framework";
    requiresApproval?: boolean;
  }[];
  connections?: { connectionName: string; description?: string; hasAuthorization?: boolean }[];
  subagents?: {
    name: string;
    description?: string;
    summary?: { tools?: number; skills?: number; connections?: number; schedules?: number };
  }[];
  channels?: { name: string; method?: string; urlPath?: string; origin?: string }[];
  schedules?: { name: string; cron?: string; hasRun?: boolean; markdown?: string }[];
}
