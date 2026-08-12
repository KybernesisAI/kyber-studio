import { create } from "zustand";
import type { AgentSummary } from "@shared/ipc";
import { summarize } from "./agentInfo";
import type {
  Agent,
  Block,
  Section,
} from "@shared/types";

/**
 * Renderer state.
 *
 * Seeded from local fixtures so the shell is explorable before the transport
 * exists. Everything a real deployment would own — conversations, routines,
 * plugin state — is keyed by agent id, so swapping the fixture for the HTTP
 * client is a change of source, not of shape.
 */

export type PanelView = "none" | "overview" | "routine" | "settings" | "channels";

interface State {
  agents: Agent[];
  sections: Section[];
  conversations: Record<string, Block[]>;

  activeAgentId: string;
  query: string;
  panel: PanelView;
  activeRoutineId: string | null;
  pluginsOpen: boolean;
  paletteOpen: boolean;

  authState: "loading" | "signed-in" | "signed-out";
  authError: string | null;
  issuer: string;
  account: { email?: string; orgName?: string } | null;
  /** Per-agent eve session id, so a conversation keeps its thread across turns. */
  sessions: Record<string, string | undefined>;
  continuations: Record<string, string | undefined>;
  streamIndexes: Record<string, number | undefined>;
  /** Per-agent "what it is doing right now", or null when idle. */
  activity: Record<string, string | null>;
  /** Per-agent model id, read from the agent's own /eve/v1/info. */
  models: Record<string, string | undefined>;
  /**
   * What each agent reports about itself. Undefined means "not fetched yet";
   * a present-but-empty section means the agent genuinely has none. The panels
   * must not conflate those.
   */
  details: Record<string, AgentSummary | undefined>;
  /** The agent's install catalog: what can be added, and what already is. */
  catalog: Record<
    string,
    | {
        items: { name: string; title?: string; description?: string; dependencies?: string[] }[];
        installed: string[];
        writable: boolean;
        reason: string | null;
      }
    | undefined
  >;
  /** Item name currently installing, so the UI can show which row is working. */
  installing: string | null;
  manageError: string | null;
  /** Per-agent project folder on this machine, sent as context each turn. */
  workspaces: Record<string, string | undefined>;
  streaming: Record<string, string>;

  select(id: string): void;
  setQuery(q: string): void;
  setPanel(v: PanelView): void;
  openRoutine(id: string): void;
  setPluginsOpen(open: boolean): void;
  setPaletteOpen(open: boolean): void;

  send(agentId: string, text: string): void;
  patchAgent(id: string, patch: Partial<Agent>): void;

  bootstrap(): Promise<void>;
  restore(): Promise<void>;
  persist(): void;
  refreshAgents(): Promise<void>;
  loadAgentInfo(agentId: string): Promise<void>;
  loadCatalog(agentId: string): Promise<void>;
  install(agentId: string, item: string): Promise<void>;
  createSchedule(agentId: string, input: { name: string; cron: string; instruction: string }): Promise<boolean>;
  setWorkspace(agentId: string, path: string | null): void;
  chooseWorkspace(agentId: string): Promise<void>;
  signIn(onCode: (code: string) => void): Promise<boolean>;
  signOut(): Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  agents: [],
  sections: [],
  conversations: {},

  activeAgentId: "",
  query: "",
  panel: "none",
  activeRoutineId: null,
  pluginsOpen: false,
  paletteOpen: false,

  authState: "loading",
  authError: null,
  issuer: "agent.kybernesis.ai",
  account: null,
  sessions: {},
  continuations: {},
  streamIndexes: {},
  activity: {},
  models: {},
  details: {},
  catalog: {},
  installing: null,
  manageError: null,
  workspaces: {},
  streaming: {},

  select: (id) =>
    set((s) => ({
      activeAgentId: id,
      agents: s.agents.map((a) => (a.id === id ? { ...a, unread: false } : a)),
    })),
  setQuery: (query) => set({ query }),
  setPanel: (panel) => set({ panel, activeRoutineId: null }),
  openRoutine: (id) => set({ panel: "routine", activeRoutineId: id }),
  setPluginsOpen: (pluginsOpen) => set({ pluginsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),

  send: (agentId, text) => {
    const at = Date.now();
    set((s) => ({
      conversations: {
        ...s.conversations,
        [agentId]: [
          ...(s.conversations[agentId] ?? []),
          { kind: "text", id: `u${at}`, role: "user", text, at },
        ],
      },
      agents: s.agents.map((a) =>
        a.id === agentId ? { ...a, lastMessageAt: at, lastMessagePreview: text } : a,
      ),
    }));
    // Save the question immediately. If the app dies mid-turn, losing the answer
    // is annoying; losing what you asked is worse.
    get().persist();

    const agent = get().agents.find((a) => a.id === agentId);

    // Create the reply bubble on first content rather than up front. An empty
    // "…" bubble alongside the activity line says the same thing twice, and it
    // claims the agent is composing a message before it has written a word.
    const upsert = (id: string, body: string): void => {
      set((s) => {
        const conv = s.conversations[agentId] ?? [];
        const exists = conv.some((b) => b.id === id);
        return {
          conversations: {
            ...s.conversations,
            [agentId]: exists
              ? conv.map((b) => (b.id === id && b.kind === "text" ? { ...b, text: body } : b))
              : [...conv, { kind: "text", id, role: "agent", at: Date.now(), text: body }],
          },
          agents: s.agents.map((a) =>
            a.id === agentId ? { ...a, lastMessageAt: Date.now(), lastMessagePreview: body } : a,
          ),
        };
      });
    };

    if (!window.studio || !agent?.url) {
      const id = `a${Date.now()}`;
      set((s) => ({
        conversations: {
          ...s.conversations,
          [agentId]: [
            ...(s.conversations[agentId] ?? []),
            {
              kind: "text",
              id,
              role: "agent",
              at: Date.now(),
              text: "This agent has no URL on file in the control plane, so there is nowhere to send it.",
            },
          ],
        },
      }));
      return;
    }

    const streamId = `s${at}`;
    const bubbleId = `a${at}`;
    set((s) => ({ streaming: { ...s.streaming, [streamId]: "" } }));

    const stopActivity = window.studio.onActivity((payload) => {
      if (payload.streamId !== streamId) return;
      set((s) => ({ activity: { ...s.activity, [agentId]: payload.label } }));
    });

    const unsubscribe = window.studio.onDelta((payload) => {
      if (payload.streamId !== streamId) return;
      const next = (get().streaming[streamId] ?? "") + payload.text;
      set((s) => ({ streaming: { ...s.streaming, [streamId]: next } }));
      upsert(bubbleId, next);
    });

    void window.studio
      .send({
        url: agent.url,
        text,
        // A working folder, not a fence. Permission to touch this machine is
        // granted once, per effect, on the consent card — exactly as a person
        // gives a colleague access to their laptop rather than to one directory.
        // This only says where to start; the agent may still work elsewhere when
        // asked, and its absence does not mean local access is off.
        clientContext: get().workspaces[agentId]
          ? {
              workingFolder: get().workspaces[agentId],
              note: "Default working directory on the user's own computer. Other paths are still fine when they ask.",
            }
          : undefined,
        streamId,
      })
      .then((res) => {
        set((s) => ({
          sessions: { ...s.sessions, [agentId]: res.sessionId },
          continuations: { ...s.continuations, [agentId]: res.continuationToken },
          streamIndexes: { ...s.streamIndexes, [agentId]: res.streamIndex },
        }));
        upsert(bubbleId, res.reply || "(the agent returned an empty reply)");
      })
      // Report what actually failed. A generic message here is how an expired
      // grant gets mistaken for a broken agent.
      .catch((e: unknown) => upsert(bubbleId, e instanceof Error ? e.message : String(e)))
      .finally(() => {
        unsubscribe();
        stopActivity();
        get().persist();
        set((s) => ({ activity: { ...s.activity, [agentId]: null } }));
        set((s) => {
          const rest = { ...s.streaming };
          delete rest[streamId];
          return { streaming: rest };
        });
      });
  },

  patchAgent: (id, patch) =>
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)) })),

  loadCatalog: async (agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!window.studio || !agent?.url) return;
    set({ manageError: null });
    const res = await window.studio.manage({ url: agent.url, path: "/catalog" });
    if (!res.ok) {
      set({
        manageError:
          res.status === 401
            ? "This agent did not accept your sign-in. You may not have a grant for it."
            : `The agent's management routes answered ${res.status}.`,
      });
      return;
    }
    const data = res.data as {
      catalog?: { items?: { name: string; title?: string; description?: string }[] };
      installed?: string[];
      writable?: boolean;
      reason?: string | null;
    };
    set((s) => ({
      catalog: {
        ...s.catalog,
        [agentId]: {
          items: data.catalog?.items ?? [],
          installed: data.installed ?? [],
          writable: Boolean(data.writable),
          reason: data.reason ?? null,
        },
      },
    }));
  },

  install: async (agentId, item) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!window.studio || !agent?.url) return;
    set({ installing: item, manageError: null });
    try {
      const res = await window.studio.manage({
        url: agent.url,
        path: "/install",
        body: { item },
      });
      const data = (res.data ?? {}) as { ok?: boolean; error?: string; output?: string; note?: string };
      if (!res.ok || !data.ok) {
        // Show the agent's own output. An install failure is usually npm saying
        // something specific, and hiding it behind "install failed" wastes the
        // one piece of information that would fix it.
        set({
          manageError:
            data.error ??
            `Install failed${data.output ? `: ${data.output.slice(-400)}` : "."}`,
        });
        return;
      }
      // The agent is restarting; give it a moment before asking what it has now.
      await new Promise((r) => setTimeout(r, 6000));
      await get().loadCatalog(agentId);
      await get().loadAgentInfo(agentId);
    } finally {
      set({ installing: null });
    }
  },

  createSchedule: async (agentId, input) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!window.studio || !agent?.url) return false;
    set({ manageError: null });
    const res = await window.studio.manage({
      url: agent.url,
      path: "/schedule",
      body: input,
    });
    const data = (res.data ?? {}) as { ok?: boolean; error?: string; output?: string };
    if (!res.ok || !data.ok) {
      set({ manageError: data.error ?? `Could not create the routine (${res.status}).` });
      return false;
    }
    await new Promise((r) => setTimeout(r, 6000));
    await get().loadAgentInfo(agentId);
    return true;
  },

  setWorkspace: (agentId, path) => {
    set((s) => ({ workspaces: { ...s.workspaces, [agentId]: path ?? undefined } }));
    void window.studio?.saveState({ name: "workspaces.json", value: get().workspaces });
  },

  chooseWorkspace: async (agentId) => {
    const path = await window.studio?.pickFolder();
    if (path) get().setWorkspace(agentId, path);
  },

  /**
   * Rehydrate from disk. Called on launch AND after signing in — signing in
   * used to skip it, so a fresh login started empty and the next completed turn
   * saved that emptiness over the real history.
   */
  restore: async () => {
    if (!window.studio) return;
    const saved = await window.studio.loadState<{
      conversations: Record<string, Block[]>;
      sessions: Record<string, string | undefined>;
      continuations: Record<string, string | undefined>;
      streamIndexes: Record<string, number | undefined>;
    }>("conversations.json");
    if (saved?.conversations) {
      set({
        conversations: saved.conversations,
        sessions: saved.sessions ?? {},
        continuations: saved.continuations ?? {},
        streamIndexes: saved.streamIndexes ?? {},
      });
    }
    const ws = await window.studio.loadState<Record<string, string>>("workspaces.json");
    if (ws) set({ workspaces: ws });
  },

  /** Write the transcript now. Cheap, and called at every point worth surviving. */
  persist: () => {
    void window.studio?.saveState({
      name: "conversations.json",
      value: {
        conversations: get().conversations,
        sessions: get().sessions,
        continuations: get().continuations,
        streamIndexes: get().streamIndexes,
      },
    });
  },

  bootstrap: async () => {
    if (!window.studio) {
      // The bridge is missing. Do NOT quietly show fixtures — that renders a
      // fully populated app backed by nothing, which is indistinguishable from
      // a working one until the user tries to send a message.
      set({
        authState: "signed-out",
        authError:
          "The app bridge did not load, so Studio cannot reach the control plane. This is a packaging fault, not a sign-in problem.",
      });
      return;
    }
    try {
      const session = await window.studio.session();
      if (!session) {
        set({ authState: "signed-out" });
        return;
      }
      set({
        authState: "signed-in",
        account: { email: session.email, orgName: session.orgName },
      });

      // Restore before touching the network, so reopening shows the
      // conversation immediately rather than an empty window that fills in later.
      await get().restore();

      await get().refreshAgents();
    } catch (e) {
      set({ authState: "signed-out", authError: e instanceof Error ? e.message : String(e) });
    }
  },

  refreshAgents: async () => {
    if (!window.studio) return;
    try {
      const remote = await window.studio.listAgents();
      if (remote.length === 0) {
        // An honest empty state. Keeping the fixtures here would show a
        // customer three agents they do not have.
        set({
          agents: [],
          authError:
            "No agents are granted to your account yet. Register one in the control plane, or ask an admin for a grant.",
        });
        return;
      }
      // Keep local presentation (accent, pin) but let the control plane own the
      // set: an agent whose grant was revoked must disappear from the sidebar.
      const palette = ["#2ec4a6", "#f0883e", "#7c6cf0", "#4f9cf0", "#e0609a"];
      const existing = new Map(get().agents.map((a) => [a.id, a]));
      set({
        agents: remote.map((r, i) => {
          const prior = existing.get(r.id);
          return {
            id: r.id,
            name: r.name,
            url: r.url ?? "",
            accent: prior?.accent ?? palette[i % palette.length] ?? "#2ec4a6",
            pinned: prior?.pinned,
            unread: prior?.unread,
            notifications: prior?.notifications ?? true,
            status: r.reachable ? "online" : "offline",
            title: prior?.title,
            description: prior?.description,
            lastMessageAt: prior?.lastMessageAt,
            lastMessagePreview: r.reachable
              ? prior?.lastMessagePreview
              : "Registered, but no URL on file in the control plane.",
          };
        }),
        activeAgentId: remote[0]?.id ?? get().activeAgentId,
      });
    } catch (e) {
      set({ authError: e instanceof Error ? e.message : String(e) });
    }
  },

  loadAgentInfo: async (agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!window.studio || !agent?.url) return;
    const raw = await window.studio.agentInfo(agent.url);
    if (!raw) return;
    // Flatten eve's nested payload once, here, so no component has to know its
    // shape — and so a change in that shape breaks one function, not five views.
    const info = summarize(raw);
    set((s) => ({
      details: { ...s.details, [agentId]: info },
      models: info.model ? { ...s.models, [agentId]: info.model } : s.models,
    }));
  },

  signIn: async (onCode) => {
    if (!window.studio) return false;
    set({ authError: null });
    try {
      const { userCode } = await window.studio.signIn();
      onCode(userCode);
      const session = await window.studio.awaitSignIn();
      set({
        authState: "signed-in",
        account: { email: session.email, orgName: session.orgName },
        authError: null,
      });
      await get().restore();
      await get().refreshAgents();
      return true;
    } catch (e) {
      set({ authError: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  signOut: async () => {
    // Persist first, and keep the transcript. Signing out ends a SESSION, not a
    // history — the eve session ids are dropped because they will not resume,
    // but what was said stays and reappears on the next sign-in.
    get().persist();
    await window.studio?.signOut();
    set({ authState: "signed-out", account: null, sessions: {}, streamIndexes: {} });
  },
}));
