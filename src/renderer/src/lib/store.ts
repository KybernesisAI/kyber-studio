import { create } from "zustand";
import type { AgentInfo } from "@shared/ipc";
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

const now = Date.now();
const mins = (n: number) => now - n * 60_000;

const AGENTS: Agent[] = [
  {
    id: "sid",
    name: "Chief of Staff",
    title: "Personal chief of staff",
    description: "Holds commitments, follow-ups, and the calendar. Pulls you in for decisions.",
    url: "https://sid-agent.exe.xyz",
    accent: "#2ec4a6",
    pinned: true,
    notifications: true,
    status: "online",
    lastMessageAt: mins(4),
    lastMessagePreview: "OPS-13 is on the board — renew the DE registered agent.",
  },
  {
    id: "gtm",
    name: "Content",
    title: "GTM content agent",
    description: "Drafts, edits, and ships go-to-market content.",
    url: "https://eve-gtm.vercel.app",
    accent: "#f0883e",
    status: "online",
    lastMessageAt: mins(52),
    lastMessagePreview: "Draft is ready for the launch note.",
  },
  {
    id: "builder",
    name: "Developer",
    title: "Engineer",
    description: "Builds and ships software. Screenshots what it makes.",
    url: "https://sid-agent.exe.xyz",
    accent: "#7c6cf0",
    status: "online",
    unread: true,
    lastMessageAt: mins(96),
    lastMessagePreview: "Preview is up — the pricing page renders correctly now.",
  },
];

const SECTIONS: Section[] = [];

const CONVERSATIONS: Record<string, Block[]> = {
  sid: [
    {
      kind: "text",
      id: "m1",
      role: "user",
      at: mins(14),
      text: "What's on the Company Operations Board right now?",
    },
    {
      kind: "text",
      id: "m2",
      role: "agent",
      at: mins(13),
      text: "Ten live rows. The ones that actually want you this week:\n\nBOI setup — incorporate Thai entity (In Progress)\nUnblock Vertex Retail onboarding — client data access (In Progress)\nFollow up with Harrison Assessments on the consulting agreement (Planning)",
    },
    {
      kind: "peer-activity",
      id: "p1",
      at: mins(12),
      events: [
        {
          id: "pe1",
          direction: "outbound",
          peer: { id: "builder", name: "Developer", accent: "#7c6cf0" },
          text: "Can you check whether the Vertex data-access blocker is on our side?",
          at: mins(12),
        },
        {
          id: "pe2",
          direction: "inbound",
          peer: { id: "builder", name: "Developer", accent: "#7c6cf0" },
          text: "Their IP allowlist is missing our egress range. Not a code issue — needs their IT.",
          at: mins(11),
        },
        {
          id: "pe3",
          direction: "outbound",
          peer: { id: "gtm", name: "Content", accent: "#f0883e" },
          text: "Hold the Vertex case study until onboarding clears.",
          at: mins(11),
        },
      ],
    },
    {
      kind: "text",
      id: "m3",
      role: "agent",
      at: mins(10),
      text: "Vertex is not blocked on us — their IP allowlist is missing our egress range, so it needs their IT, not a fix here. I've asked Content to hold the case study until it clears.",
    },
    {
      kind: "connection",
      id: "c1",
      at: mins(9),
      name: "Notion",
      description: "Company boards — tasks, meetings, projects, goals, and the team directory.",
      toolCount: 14,
      icon: "N",
      accounts: [
        { id: "kyb", label: "kybernesis", connected: true },
        { id: "personal", label: "personal", connected: false },
      ],
    },
    {
      kind: "text",
      id: "m4",
      role: "user",
      at: mins(6),
      text: "Add a task: renew the DE registered agent. Operations, high priority, due Sept 15.",
    },
    {
      kind: "text",
      id: "m5",
      role: "agent",
      at: mins(4),
      text: "Added OPS-13: renew the DE registered agent. High priority, Operations, due September 15, 2026.",
    },
  ],
  gtm: [
    {
      kind: "text",
      id: "g1",
      role: "agent",
      at: mins(52),
      text: "Draft is ready for the launch note. Two open questions in the margin — pricing line and whether we name the pilot client.",
    },
  ],
  builder: [
    {
      kind: "text",
      id: "b1",
      role: "agent",
      at: mins(96),
      text: "Preview is up — the pricing page renders correctly now. The overflow was a grid-template on the comparison table, not the cards.",
    },
  ],
};

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
  details: Record<string, AgentInfo | undefined>;
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
  refreshAgents(): Promise<void>;
  loadAgentInfo(agentId: string): Promise<void>;
  setWorkspace(agentId: string, path: string | null): void;
  chooseWorkspace(agentId: string): Promise<void>;
  signIn(onCode: (code: string) => void): Promise<boolean>;
  signOut(): Promise<void>;
}

export const useStore = create<State>((set, get) => ({
  agents: AGENTS,
  sections: SECTIONS,
  conversations: CONVERSATIONS,

  activeAgentId: "sid",
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
        void window.studio?.saveState({
          name: "conversations.json",
          value: {
            conversations: get().conversations,
            sessions: get().sessions,
            continuations: get().continuations,
            streamIndexes: get().streamIndexes,
          },
        });
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

  setWorkspace: (agentId, path) => {
    set((s) => ({ workspaces: { ...s.workspaces, [agentId]: path ?? undefined } }));
    void window.studio?.saveState({ name: "workspaces.json", value: get().workspaces });
  },

  chooseWorkspace: async (agentId) => {
    const path = await window.studio?.pickFolder();
    if (path) get().setWorkspace(agentId, path);
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

      // Restore the last session before touching the network, so reopening the
      // app shows the conversation immediately rather than an empty window that
      // fills in later.
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
    const info = await window.studio.agentInfo(agent.url);
    if (!info) return;
    const model = typeof info.model === "string" ? info.model : info.model?.id;
    set((s) => ({
      details: { ...s.details, [agentId]: info },
      models: model ? { ...s.models, [agentId]: model } : s.models,
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
      await get().refreshAgents();
      return true;
    } catch (e) {
      set({ authError: e instanceof Error ? e.message : String(e) });
      return false;
    }
  },

  signOut: async () => {
    await window.studio?.signOut();
    set({ authState: "signed-out", account: null, sessions: {} });
  },
}));
