import { create } from "zustand";
import type { AgentSummary } from "@shared/ipc";
import { summarize } from "./agentInfo";
import type {
  Agent,
  Block,
  PeerEvent,
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

/**
 * Stream listeners are registered ONCE, not per turn.
 *
 * Subscribing inside send() and unsubscribing in its finally() looks tidy and
 * is a race: IPC delivery to the renderer is asynchronous, so a message emitted
 * just before the turn resolved can arrive just after the listener is removed.
 * That is exactly how a question the agent asked — dispatched to a live window,
 * confirmed in the logs — vanished before anything rendered it, intermittently,
 * which is the worst way for it to fail.
 *
 * Instead each stream registers its owning agent here, and the listeners route
 * by that. Nothing is torn down mid-flight because nothing is scoped to a turn.
 */
const streamOwners = new Map<string, string>();
let listenersReady = false;

function ensureListeners(
  get: () => State,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
): void {
  if (listenersReady || !window.studio) return;
  listenersReady = true;

  window.studio.onDelta(({ streamId, text }) => {
    const agentId = streamOwners.get(streamId);
    if (!agentId) return;
    const next = (get().streaming[streamId] ?? "") + text;
    set((s) => ({ streaming: { ...s.streaming, [streamId]: next } }));
    upsertBlock(get, set, agentId, `a${streamId.slice(1)}`, next);
  });

  window.studio.onTurn(({ streamId, sessionId, turnId }) => {
    const agentId = streamOwners.get(streamId);
    if (!agentId) return;
    set((s) => ({
      inflight: { ...s.inflight, [agentId]: { streamId, sessionId, turnId } },
    }));
  });

  window.studio.onReset(({ streamId }) => {
    const agentId = streamOwners.get(streamId);
    if (!agentId) return;
    // The block that just ended was the agent saying what it was about to do.
    // Drop it from the transcript: it has already been shown as activity, and
    // keeping it would leave a paragraph of intentions above the answer.
    set((s) => ({ streaming: { ...s.streaming, [streamId]: "" } }));
    const bubbleId = `a${streamId.slice(1)}`;
    set((s) => ({
      conversations: {
        ...s.conversations,
        [agentId]: (s.conversations[agentId] ?? []).filter((b) => b.id !== bubbleId),
      },
    }));
  });

  window.studio.onActivity(({ streamId, label }) => {
    const agentId = streamOwners.get(streamId);
    if (!agentId) return;
    set((s) => ({ activity: { ...s.activity, [agentId]: label } }));
    if (get().inflight[agentId]) armDeadMan(get, set, agentId);
  });

  window.studio.onCursor(({ streamId, index }) => {
    const agentId = streamOwners.get(streamId);
    if (!agentId) return;
    // Saved continuously, not just on success: a stale cursor makes the next
    // turn replay old questions.
    set((s) => ({ streamIndexes: { ...s.streamIndexes, [agentId]: index } }));
  });

  /**
   * Agent-to-agent traffic, collapsed into one openable line per turn.
   *
   * The alternative — letting each hop through as ordinary tool activity — is
   * what happened before, and it reads as the agent using a tool called "sid"
   * rather than as two agents talking. Grouping them keeps the transcript about
   * the conversation the user is having, with the exchange one click away when
   * they want to see who said what.
   *
   * Merged into the block only while it is still the LAST thing in the
   * transcript. Once the agent has said something else, a later exchange is a
   * new event in the conversation, not more of the old one — folding it back in
   * would put it above a reply that came first.
   */
  window.studio.onPeer(({ streamId, event }) => {
    const agentId = streamOwners.get(streamId);
    if (!agentId) return;

    set((s) => {
      const conv = s.conversations[agentId] ?? [];
      // Peers that are also agents in this sidebar keep their own identity —
      // the same avatar and colour as their row above, so the exchange names a
      // recognisable agent rather than a generic peer.
      const known = s.agents.find((a) => a.name.toLowerCase() === event.peer.toLowerCase());
      const peer = {
        id: known?.id ?? event.peer,
        name: known?.name ?? event.peer,
        accent: known?.accent ?? "#7c6cf0",
      };
      const entry: PeerEvent = {
        id: `pe${Date.now()}-${conv.length}`,
        direction: event.direction,
        peer,
        text: event.text,
        at: Date.now(),
      };

      const last = conv[conv.length - 1];
      if (last?.kind === "peer-activity" && last.id === `peer-${streamId}`) {
        return {
          conversations: {
            ...s.conversations,
            [agentId]: conv.map((b) =>
              b.id === last.id && b.kind === "peer-activity"
                ? { ...b, events: [...b.events, entry] }
                : b,
            ),
          },
        };
      }

      return {
        conversations: {
          ...s.conversations,
          [agentId]: [
            ...conv,
            { kind: "peer-activity", id: `peer-${streamId}`, at: Date.now(), events: [entry] },
          ],
        },
      };
    });
    get().persist();
  });

  window.studio.onAuthorization(({ streamId, event }) => {
    const agentId = streamOwners.get(streamId);
    if (!agentId) return;
    // One card per connection, updated in place. The completed event carries the
    // outcome for the same connection, so a second card would be the same
    // question twice with different answers.
    const id = `auth-${event.name}`;
    set((s) => {
      const conv = s.conversations[agentId] ?? [];
      const existing = conv.find((b) => b.id === id);
      if (existing) {
        return {
          conversations: {
            ...s.conversations,
            [agentId]: conv.map((b) =>
              b.id === id && b.kind === "authorization" ? { ...b, ...event } : b,
            ),
          },
        };
      }
      return {
        conversations: {
          ...s.conversations,
          [agentId]: [...conv, { kind: "authorization", id, at: Date.now(), ...event }],
        },
      };
    });
    get().persist();
  });

  window.studio.onQuestion(({ streamId, request }) => {
    const agentId = streamOwners.get(streamId);
    if (!agentId) return;
    const id = `q${request.requestId}`;
    set((s) => {
      const conv = s.conversations[agentId] ?? [];
      // A resumed turn can re-emit a request it already asked; keep one card.
      if (conv.some((b) => b.id === id)) return {};
      return {
        conversations: {
          ...s.conversations,
          [agentId]: [
            ...conv,
            {
              kind: "question",
              id,
              at: Date.now(),
              requestId: request.requestId,
              prompt: request.prompt,
              options: request.options,
              allowFreeform: request.allowFreeform,
            },
          ],
        },
      };
    });
    get().persist();
  });
}

/** Append the agent's reply block, or update it as more text arrives. */
function upsertBlock(
  get: () => State,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  agentId: string,
  id: string,
  body: string,
): void {
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
}

/**
 * Retire questions the agent has moved past.
 *
 * A turn that ends with a real answer and no new question means anything still
 * unanswered above it is moot — the agent is not waiting on it. Leaving those
 * cards live invites the user to answer a question that will never be read.
 */
function retireStaleQuestions(
  get: () => State,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  agentId: string,
): void {
  set((s) => ({
    conversations: {
      ...s.conversations,
      [agentId]: (s.conversations[agentId] ?? []).map((b) =>
        b.kind === "question" && !b.answered ? { ...b, answered: "— no longer needed" } : b,
      ),
    },
  }));
}

/**
 * A turn cannot hold the composer hostage, whatever the transport does.
 *
 * Every fix so far has been a timeout somewhere in the send path, and each one
 * only covered the failure that had already happened. This is the layer that
 * does not care WHERE it broke: the window arms its own timer when it marks an
 * agent busy, and if nothing has come back by the time it fires, the user gets
 * their input back. A client whose usability depends on the transport being
 * correct is a client that will wedge in front of someone who is paying for it.
 *
 * Generous on purpose — a long tool run is normal, and any real activity
 * (a delta, a tool call, a question) rearms it.
 */
const DEAD_MAN_MS = 240_000;
const deadMan = new Map<string, ReturnType<typeof setTimeout>>();

function armDeadMan(
  get: () => State,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  agentId: string,
): void {
  clearTimeout(deadMan.get(agentId));
  deadMan.set(
    agentId,
    setTimeout(() => {
      if (!get().inflight[agentId]) return;
      set((s) => {
        const flight = { ...s.inflight };
        delete flight[agentId];
        return { inflight: flight, activity: { ...s.activity, [agentId]: null } };
      });
      upsertBlock(
        get,
        set,
        agentId,
        `a${Date.now()}`,
        "That turn stopped responding, so I let it go. Nothing was lost — send it again.",
      );
      flushQueue(get, agentId);
    }, DEAD_MAN_MS),
  );
}

function disarmDeadMan(agentId: string): void {
  clearTimeout(deadMan.get(agentId));
  deadMan.delete(agentId);
}

/**
 * Send the next message that was typed while the agent was busy.
 *
 * One at a time, and only once the previous turn has actually settled — the
 * queue exists precisely because posting them together is what breaks ordering.
 */
function flushQueue(get: () => State, agentId: string): void {
  const pending = get().queued[agentId];
  if (!pending?.length) return;
  const [next, ...rest] = pending;
  useStore.setState((s) => ({ queued: { ...s.queued, [agentId]: rest } }));
  setTimeout(() => get().send(agentId, next, true), 0);
}

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
  /**
   * What the user decided about each agent, as opposed to what the control
   * plane says about it.
   *
   * The agent LIST belongs to the control plane — a revoked grant has to remove
   * an agent from the sidebar. But renaming one, pinning it, or hiding it are
   * decisions about this person's own workspace, and rebuilding the list on
   * every launch was quietly discarding all three. Kept apart so the two
   * cannot overwrite each other: the server owns the set, the user owns the
   * presentation.
   */
  prefs: Record<
    string,
    { name?: string; pinned?: boolean; hidden?: boolean; notifications?: boolean; accent?: string }
  >;
  /**
   * The agent-to-agent exchange being read, if any.
   *
   * Its own view rather than an accordion in the transcript: the exchange is a
   * conversation between two agents, and inlining it makes the user's own
   * thread the container for someone else's. Opened from the summary line,
   * closed back to where you were.
   */
  exchange: { agentId: string; blockId: string } | null;
  openExchange: (agentId: string, blockId: string) => void;
  closeExchange: () => void;
  /** Per-agent eve session id, so a conversation keeps its thread across turns. */
  sessions: Record<string, string | undefined>;
  continuations: Record<string, string | undefined>;
  streamIndexes: Record<string, number | undefined>;
  /** Per-agent "what it is doing right now", or null when idle. */
  activity: Record<string, string | null>;
  /**
   * The turn each agent is running right now, if any.
   *
   * eve accepts one turn at a time per session and parks between them. A client
   * that posts a second message before the first has settled is racing the
   * runtime: the message is held, arrives out of order, or lands on a session
   * that is not waiting yet. So a turn in flight is state the UI has to know
   * about, not something to discover by failing.
   */
  inflight: Record<string, { streamId: string; sessionId?: string; turnId?: string } | undefined>;
  /** Messages typed while a turn was running, sent in order once it settles. */
  queued: Record<string, string[] | undefined>;
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

  send(agentId: string, text: string, fromQueue?: boolean): void;
  /** Ask the agent to stop the turn it is running. */
  stopTurn(agentId: string): void;
  /**
   * Retire the eve session and start a fresh one.
   *
   * The escape hatch for a conversation that cannot move: a turn interrupted by
   * an agent restart never settles, so the session never parks and every later
   * message queues behind it forever.
   */
  resetConversation(agentId: string): void;
  answerQuestion(agentId: string, blockId: string, answer: { optionId?: string; text?: string }): void;
  patchAgent(id: string, patch: Partial<Agent>): void;

  bootstrap(): Promise<void>;
  restore(): Promise<void>;
  persist(): void;
  refreshAgents(): Promise<void>;
  loadAgentInfo(agentId: string): Promise<void>;
  loadCatalog(agentId: string): Promise<void>;
  install(agentId: string, item: string): Promise<void>;
  createSchedule(agentId: string, input: { name: string; cron: string; instruction: string }): Promise<boolean>;
  deleteSchedule(agentId: string, name: string): Promise<boolean>;
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
  exchange: null,
  prefs: {},
  activity: {},
  inflight: {},
  queued: {},
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
  openExchange: (agentId, blockId) => set({ exchange: { agentId, blockId } }),
  closeExchange: () => set({ exchange: null }),

  send: (agentId, text, fromQueue) => {
    const at = Date.now();
    // A queued message was already shown when the user typed it. Adding it again
    // on flush is how one message becomes two identical bubbles.
    if (!fromQueue) {
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
    }
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

    // A turn is already running: hold this one rather than post it into a
    // session that has not parked. It goes out, in order, the moment the
    // current turn settles.
    if (get().inflight[agentId]) {
      set((s) => ({
        queued: { ...s.queued, [agentId]: [...(s.queued[agentId] ?? []), text] },
      }));
      return;
    }

    const streamId = `s${at}`;
    const bubbleId = `a${at}`;
    set((s) => ({ streaming: { ...s.streaming, [streamId]: "" } }));
    ensureListeners(get, set);
    streamOwners.set(streamId, agentId);
    set((s) => ({ inflight: { ...s.inflight, [agentId]: { streamId } } }));
    armDeadMan(get, set, agentId);

    void window.studio
      .send({
        url: agent.url,
        text,
        sessionId: get().sessions[agentId],
        continuationToken: get().continuations[agentId],
        streamIndex: get().streamIndexes[agentId],
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
        if (res.reply) {
          if (!res.askedQuestion) retireStaleQuestions(get, set, agentId);
          upsertBlock(get, set, agentId, bubbleId, res.reply);
        } else if (!res.askedQuestion) {
          upsertBlock(get, set, agentId, bubbleId, "(the agent returned no text for this turn)");
        }
      })
      .catch((e: unknown) =>
        upsertBlock(get, set, agentId, bubbleId, e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        set((s) => ({ activity: { ...s.activity, [agentId]: null } }));
        set((s) => {
          const rest = { ...s.streaming };
          delete rest[streamId];
          const flight = { ...s.inflight };
          delete flight[agentId];
          return { streaming: rest, inflight: flight };
        });
        // Keep the owner mapping briefly: a late event that arrives after the
        // response is exactly what this whole change is about.
        disarmDeadMan(agentId);
        setTimeout(() => streamOwners.delete(streamId), 30_000);
        get().persist();
        flushQueue(get, agentId);
      });
  },

  stopTurn: (agentId) => {
    const live = get().inflight[agentId];
    const agent = get().agents.find((a) => a.id === agentId);
    if (!live || !window.studio) return;

    if (live.sessionId && agent?.url) {
      void window.studio
        .cancelTurn({ url: agent.url, sessionId: live.sessionId, turnId: live.turnId })
        .catch(() => undefined);
    }

    // Release the composer here, without waiting to hear back. Cancellation is a
    // request to a runtime that may be gone, and pressing stop must always give
    // the user their input back — a stop button that can itself hang is not a
    // stop button. The stream's own cleanup is idempotent when it arrives.
    disarmDeadMan(agentId);
    set((s) => {
      const flight = { ...s.inflight };
      delete flight[agentId];
      return { inflight: flight, activity: { ...s.activity, [agentId]: null } };
    });
    flushQueue(get, agentId);
  },

  resetConversation: (agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!agent?.url || !window.studio) return;
    const url = agent.url;
    const sessionId = get().sessions[agentId];
    const continuationToken = get().continuations[agentId];
    // Drop the local handles first. Even if the agent cannot retire the session
    // (its owner may already be gone), the next message must not be posted into
    // the session that was stuck — that is the whole point of resetting.
    disarmDeadMan(agentId);
    set((s) => ({
      sessions: { ...s.sessions, [agentId]: undefined },
      continuations: { ...s.continuations, [agentId]: undefined },
      streamIndexes: { ...s.streamIndexes, [agentId]: 0 },
      inflight: { ...s.inflight, [agentId]: undefined },
      activity: { ...s.activity, [agentId]: null },
    }));
    get().persist();
    void window.studio.resetSession({ url, sessionId, continuationToken }).catch(() => undefined);
  },

  answerQuestion: (agentId, blockId, answer) => {
    const block = (get().conversations[agentId] ?? []).find((b) => b.id === blockId);
    if (!block || block.kind !== "question") return;

    const label =
      answer.text ??
      block.options?.find((o) => o.id === answer.optionId)?.label ??
      answer.optionId ??
      "";

    set((s) => ({
      conversations: {
        ...s.conversations,
        [agentId]: (s.conversations[agentId] ?? []).map((b) =>
          b.id === blockId && b.kind === "question" ? { ...b, answered: label } : b,
        ),
      },
    }));
    get().persist();

    const agent = get().agents.find((a) => a.id === agentId);
    if (!window.studio || !agent?.url) return;

    const at = Date.now();
    const streamId = `s${at}`;
    const bubbleId = `a${at}`;
    ensureListeners(get, set);
    streamOwners.set(streamId, agentId);
    set((s) => ({ inflight: { ...s.inflight, [agentId]: { streamId } } }));
    armDeadMan(get, set, agentId);

    void window.studio
      .send({
        url: agent.url,
        // No new message: this turn resumes on the answer alone.
        text: "",
        sessionId: get().sessions[agentId],
        continuationToken: get().continuations[agentId],
        streamIndex: get().streamIndexes[agentId],
        inputResponses: [
          { requestId: block.requestId, optionId: answer.optionId, text: answer.text },
        ],
        streamId,
      })
      .then((res) => {
        set((s) => ({
          sessions: { ...s.sessions, [agentId]: res.sessionId },
          continuations: { ...s.continuations, [agentId]: res.continuationToken },
          streamIndexes: { ...s.streamIndexes, [agentId]: res.streamIndex },
        }));
        if (res.reply) {
          if (!res.askedQuestion) retireStaleQuestions(get, set, agentId);
          upsertBlock(get, set, agentId, bubbleId, res.reply);
        } else if (!res.askedQuestion) {
          upsertBlock(get, set, agentId, bubbleId, "(the agent returned no text for this turn)");
        }
      })
      .catch((e: unknown) =>
        upsertBlock(get, set, agentId, bubbleId, e instanceof Error ? e.message : String(e)),
      )
      .finally(() => {
        set((s) => {
          const flight = { ...s.inflight };
          delete flight[agentId];
          return { activity: { ...s.activity, [agentId]: null }, inflight: flight };
        });
        disarmDeadMan(agentId);
        setTimeout(() => streamOwners.delete(streamId), 30_000);
        get().persist();
        flushQueue(get, agentId);
      });
  },

  patchAgent: (id, patch) => {
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
      // Only the fields a person chooses. Status, previews, and unread counts
      // are observations about the world and must not survive a relaunch.
      prefs: {
        ...s.prefs,
        [id]: {
          ...s.prefs[id],
          ...("name" in patch ? { name: patch.name } : {}),
          ...("pinned" in patch ? { pinned: patch.pinned } : {}),
          ...("hidden" in patch ? { hidden: patch.hidden } : {}),
          ...("notifications" in patch ? { notifications: patch.notifications } : {}),
          ...("accent" in patch ? { accent: patch.accent } : {}),
        },
      },
    }));
    get().persist();
  },

  loadCatalog: async (agentId) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!window.studio || !agent?.url) return;
    set({ manageError: null });
    const res = await window.studio.manage({ url: agent.url, path: "/catalog" });
    if (!res.ok) {
      set({
        manageError:
          res.status === 440
            ? "Your sign-in expired and could not be renewed. Sign out and back in."
            : res.status === 401
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

  deleteSchedule: async (agentId, name) => {
    const agent = get().agents.find((a) => a.id === agentId);
    if (!window.studio || !agent?.url) return false;
    set({ manageError: null });
    const res = await window.studio.manage({
      url: agent.url,
      path: "/schedule/delete",
      body: { name },
    });
    const data = (res.data ?? {}) as { ok?: boolean; error?: string };
    if (!res.ok || !data.ok) {
      set({ manageError: data.error ?? `Could not remove the routine (${res.status}).` });
      return false;
    }
    // The agent restarts after a schedule change; wait before asking again.
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
      prefs: State["prefs"];
    }>("conversations.json");
    if (saved?.prefs && !saved?.conversations) set({ prefs: saved.prefs });
    if (saved?.conversations) {
      set({
        conversations: saved.conversations,
        sessions: saved.sessions ?? {},
        continuations: saved.continuations ?? {},
        streamIndexes: saved.streamIndexes ?? {},
        prefs: saved.prefs ?? {},
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
        prefs: get().prefs,
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
          const chosen = get().prefs[r.id] ?? {};
          return {
            id: r.id,
            // The user's name for it, if they gave one. The control plane's
            // name is the default, not the authority.
            name: chosen.name ?? r.name,
            url: r.url ?? "",
            peers: r.peers ?? [],
            accent: chosen.accent ?? prior?.accent ?? palette[i % palette.length] ?? "#2ec4a6",
            pinned: chosen.pinned ?? prior?.pinned,
            hidden: chosen.hidden ?? prior?.hidden,
            unread: prior?.unread,
            notifications: chosen.notifications ?? prior?.notifications ?? true,
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
