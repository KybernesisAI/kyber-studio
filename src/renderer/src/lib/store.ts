import { create } from "zustand";
import type { AgentSummary } from "@shared/ipc";
import { summarize } from "./agentInfo";
import type { Agent, Block, PeerEvent, Room, Section } from "@shared/types";
import { ROOM_PREFIX, isRoomId } from "@shared/types";
import { recipientsFor, type RoomPolicy } from "@shared/addressing";

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

/**
 * Which agent is behind a stream, when the conversation has more than one.
 *
 * The reply bubble is created by the first delta, before the turn returns — so
 * attributing it only when the turn finishes leaves the bubble anonymous for
 * the whole time it is being written, which in a room is exactly when you need
 * to know who is talking. Registered with the stream, read when the bubble is
 * created.
 */
const streamSpeakers = new Map<string, { id: string; name: string; accent: string }>();
let listenersReady = false;
let crossDeviceReady = false;

/**
 * Notice what was said on this account's other machines.
 *
 * Driven by ATTENTION rather than by a clock: the moment someone looks at this
 * window is the moment a stale transcript starts being wrong, and it is also
 * the only moment the freshness is worth anything. A window nobody is watching
 * can be as stale as it likes for free.
 *
 * The slow tick behind it exists for the case attention never changes — two
 * machines side by side, both focused-ish, one being typed into. Half a minute
 * is far below the threshold where a conversation feels broken and far above
 * the rate at which polling costs anything.
 */
function startCrossDeviceRefresh(get: () => State): void {
  if (crossDeviceReady) return;
  crossDeviceReady = true;

  const refresh = (): void => void get().refreshFromOthers();

  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
  setInterval(() => {
    if (document.visibilityState === "visible") refresh();
  }, 30_000);

  refresh();
}

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
    upsertBlock(get, set, agentId, `a${streamId.slice(1)}`, next, streamSpeakers.get(streamId));
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
   * what happened before, and it reads as the agent using a tool named after a
   * colleague rather than as two agents talking. Grouping them keeps it about
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
      // Compared loosely on purpose. A discovered peer's name reaches us through
      // a TOOL NAME, where punctuation cannot survive — a hyphenated agent name
      // arrives with underscores. An exact match would leave that agent
      // unrecognised and paint the exchange in a stranger's colour, directly
      // beside its own row in the sidebar.
      const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
      const known = s.agents.find((a) => key(a.name) === key(event.peer));
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

/** Send the next message that was waiting on this member. */
function flushRoomQueue(
  get: () => State,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  room: Room,
  member: Agent,
): void {
  const key = `${room.id}::${member.id}`;
  const pending = get().roomQueue[key];
  if (!pending?.length) return;
  const [next, ...rest] = pending;
  set((s) => ({ roomQueue: { ...s.roomQueue, [key]: rest } }));
  if (next) {
    setTimeout(() => void deliverToMember(get, set, room, member, next.text, next.from, next.relayDepth), 0);
  }
}

/**
 * One member's turn inside a room.
 *
 * Deliberately a thin wrapper over the same transport a one-to-one chat uses:
 * a room is a routing decision, not a second way of talking to an agent, and
 * anything special-cased here would drift from the path that gets exercised
 * every day.
 */
type Speaker = { id: string; name: string; accent: string };

/** A pair that addresses each other every turn has to stop somewhere. */
const MAX_RELAY_DEPTH = 3;

/**
 * What an agent is told about the room, once per turn.
 *
 * Sent as text rather than as structured context because it has to work with
 * ANY agent — one we wrote, one a customer wrote, one running a different
 * framework. An agent that has never heard of this app still reads a line at
 * the top of the message it was sent.
 *
 * It is short on purpose. This is prepended to every turn, so anything wordy
 * here is paid for on every message in every room forever.
 */
function roomPreamble(room: Room, members: Agent[], me: Agent, speaker?: string): string {
  const others = members.filter((m) => m.id !== me.id).map((m) => m.name);
  const who = others.length ? others.join(", ") : "no one else yet";
  return [
    `[Group chat. You are "${me.name}". Also here: ${who}.`,
    `Address someone by writing @TheirName — that is what delivers a message to them.`,
    `Only reply to what was sent to you; do not repeat another agent's answer back to the room.`,
    speaker ? `This message is from ${speaker}, not from the user.]` : `]`,
  ].join(" ");
}

/**
 * What was said in the room while this member was not being spoken to.
 *
 * Without it a hand-off is incoherent: the engineer is tagged with "can you
 * build this?" and has never seen what "this" is, so it asks the room for
 * context the room already has. With it, being brought into a conversation
 * works the way it does for a person who has been listening.
 *
 * Bounded on purpose. This is prepended to a turn, so an unbounded transcript
 * is an unbounded bill; the last dozen messages is what a person would skim.
 */
function catchUp(blocks: Block[] | undefined, since: number, upToId: string): string | null {
  const missed = (blocks ?? [])
    .filter((b) => b.kind === "text" && b.at > since && b.id !== upToId)
    .slice(-12)
    .map((b) => {
      if (b.kind !== "text") return "";
      const who = b.role === "user" ? "User" : (b.speaker?.name ?? "Agent");
      const text = b.text.length > 400 ? `${b.text.slice(0, 400)}…` : b.text;
      return `${who}: ${text}`;
    })
    .filter(Boolean);
  if (missed.length === 0) return null;
  return `[Since you last spoke:\n${missed.join("\n")}]`;
}

async function deliverToMember(
  get: () => State,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  room: Room,
  member: Agent,
  text: string,
  from: { id: string; name: string; accent: string } | undefined,
  relayDepth: number,
): Promise<void> {
  if (!window.studio || !member.url) return;
  const key = `${room.id}::${member.id}`;

  // One turn at a time per member. A second message arriving mid-turn waits
  // rather than being posted into a session that has not parked.
  if (get().inflight[key]) {
    set((s) => ({
      roomQueue: {
        ...s.roomQueue,
        [key]: [...(s.roomQueue[key] ?? []), { text, from, relayDepth }],
      },
    }));
    return;
  }
  const at = Date.now();
  const streamId = `s${at}-${member.id}`;
  const bubbleId = `a${at}-${member.id}`;
  const speaker = { id: member.id, name: member.name, accent: member.accent };

  ensureListeners(get, set);
  streamOwners.set(streamId, room.id);
  streamSpeakers.set(streamId, speaker);
  armDeadMan(get, set, key, room.id, speaker);
  set((s) => ({
    inflight: { ...s.inflight, [key]: { streamId } },
    streaming: { ...s.streaming, [streamId]: "" },
  }));

  const write = (body: string): void => {
    upsertBlock(get, set, room.id, bubbleId, body, speaker);
    set((s) => ({
      rooms: s.rooms.map((r) =>
        r.id === room.id ? { ...r, lastMessageAt: Date.now(), lastMessagePreview: body } : r,
      ),
    }));
  };

  try {
    const members = room.memberIds
      .map((id) => get().agents.find((a) => a.id === id))
      .filter((a): a is Agent => Boolean(a));
    const missed = catchUp(get().conversations[room.id], get().roomSeen[key] ?? 0, bubbleId);
    const body = [
      roomPreamble(room, members, member, from?.name),
      missed,
      from ? `${from.name}: ${text}` : text,
    ]
      .filter(Boolean)
      .join("\n\n");

    const res = await window.studio.send({
      url: member.url,
      text: body,
      sessionId: get().sessions[key],
      continuationToken: get().continuations[key],
      streamIndex: get().streamIndexes[key],
      streamId,
    });
    set((s) => ({
      sessions: { ...s.sessions, [key]: res.sessionId },
      continuations: { ...s.continuations, [key]: res.continuationToken },
      streamIndexes: { ...s.streamIndexes, [key]: res.streamIndex },
    }));
    const reply = res.reply?.trim();
    if (reply) {
      write(reply);
      // Carry it to anyone this agent addressed by name — and only them.
      get().sendToRoom(room.id, reply, speaker, relayDepth + 1);
    }
  } catch (error) {
    write(`(${member.name} could not be reached: ${(error as Error).message})`);
  } finally {
    disarmDeadMan(key);
    set((s) => {
      const inflight = { ...s.inflight };
      delete inflight[key];
      const streaming = { ...s.streaming };
      delete streaming[streamId];
      return {
        inflight,
        streaming,
        // Everything up to now has been put in front of this member.
        roomSeen: { ...s.roomSeen, [key]: Date.now() },
        activity: { ...s.activity, [room.id]: null },
      };
    });
    streamOwners.delete(streamId);
    streamSpeakers.delete(streamId);
    get().persist();
    flushRoomQueue(get, set, room, member);
  }
}

function upsertBlock(
  get: () => State,
  set: (partial: Partial<State> | ((s: State) => Partial<State>)) => void,
  agentId: string,
  id: string,
  body: string,
  speaker?: { id: string; name: string; accent: string },
): void {
  set((s) => {
    const conv = s.conversations[agentId] ?? [];
    const exists = conv.some((b) => b.id === id);
    return {
      conversations: {
        ...s.conversations,
        [agentId]: exists
          ? conv.map((b) => (b.id === id && b.kind === "text" ? { ...b, text: body } : b))
          : [
              ...conv,
              { kind: "text", id, role: "agent", at: Date.now(), text: body, ...(speaker ? { speaker } : {}) },
            ],
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
  flightKey: string,
  // Where to write the notice, when that is not the same as the flight key: a
  // room's flight keys are per MEMBER, and the message belongs in the room.
  chatId: string = flightKey,
  speaker?: Speaker,
): void {
  clearTimeout(deadMan.get(flightKey));
  deadMan.set(
    flightKey,
    setTimeout(() => {
      if (!get().inflight[flightKey]) return;
      set((s) => {
        const flight = { ...s.inflight };
        delete flight[flightKey];
        return { inflight: flight, activity: { ...s.activity, [chatId]: null } };
      });
      upsertBlock(
        get,
        set,
        chatId,
        `a${Date.now()}`,
        speaker
          ? `${speaker.name} stopped responding, so I let that turn go. Nothing was lost — send it again.`
          : "That turn stopped responding, so I let it go. Nothing was lost — send it again.",
        speaker,
      );
      if (chatId === flightKey) flushQueue(get, flightKey);
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
   * Conversations with more than one agent in them.
   *
   * A room lives entirely in this app. Each member keeps its OWN session with
   * its own deployment — they are separate services and sharing a session
   * between them would mean one agent's context leaking into another's — and
   * this app is what puts a message in front of all of them.
   */
  rooms: Room[];
  /**
   * Deliveries waiting on a member that is mid-turn.
   *
   * Keyed by `<roomId>::<agentId>` like everything else per-member. A room
   * without this drops messages on the floor: a hand-off arriving while that
   * agent is still answering someone else simply never happens, and nothing
   * anywhere says so.
   */
  roomQueue: Record<string, { text: string; from?: Speaker; relayDepth: number }[]>;
  /** The last moment each member was shown the room, so catch-up has a floor. */
  roomSeen: Record<string, number>;
  /** Cancel every member still working in this room. */
  stopRoom: (roomId: string) => void;
  setRoomPolicy: (roomId: string, policy: "all" | "lead" | "silent") => void;
  /** The user's decisions about a room — pinned, renamed, read. */
  patchRoom: (roomId: string, patch: Partial<Room>) => void;
  sendToRoom: (
    roomId: string,
    text: string,
    from?: { id: string; name: string; accent: string },
    relayDepth?: number,
  ) => void;
  createRoom: (memberIds: string[]) => string;
  setRoomMembers: (roomId: string, memberIds: string[]) => void;
  deleteRoom: (roomId: string) => void;
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
  /**
   * Read a thread from the agent that holds it.
   *
   * "fill" builds a conversation this device has never seen; "merge" adds only
   * the turns that happened somewhere else.
   */
  hydrate(agentId: string, mode?: "fill" | "merge"): Promise<void>;
  /** Learn which threads this account has, from the control-plane directory. */
  syncSessions(): Promise<void>;
  /** Pick up turns that happened on another device. Cheap; safe to call often. */
  refreshFromOthers(): Promise<void>;
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
  rooms: [],
  roomQueue: {},
  roomSeen: {},
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

  select: (id) => {
    set((s) => ({
      activeAgentId: id,
      agents: s.agents.map((a) => (a.id === id ? { ...a, unread: false } : a)),
    }));
    // Opening is when a conversation is worth fetching, not launch: a person
    // with thirty agents would otherwise pay for thirty replays to read one.
    void get().hydrate(id);
  },
  /**
   * Learn which conversations this account has, wherever they were started.
   *
   * Only fills in what this device is missing. A local transcript is the richer
   * copy — it holds the cards, the questions, the local-execution blocks that
   * the agent's own stream does not describe — so the directory is treated as
   * news about threads this machine has never met, never as a correction of
   * one it has.
   */
  syncSessions: async () => {
    if (!window.studio) return;
    const indexed = await window.studio.listSessions();
    if (indexed.length === 0) return;

    for (const entry of indexed) {
      const localSession = get().sessions[entry.agent];
      if (localSession === entry.sessionId) continue;

      /**
       * Adopt the account's thread when it is the more recent one.
       *
       * The first version only filled in agents this device had never used —
       * which sounds conservative and is useless: every device that has ever
       * talked to an agent already has a session for it, so the directory was
       * fetched, read, and ignored. Sync appeared to do nothing at all unless
       * you were on a fresh install, which was the only case ever tested.
       *
       * Worse, each device MINTED ITS OWN session on first message, so two
       * machines held two threads with the same agent and neither would ever
       * converge. Continuing the same conversation somewhere else — the whole
       * point — requires actually taking the other session over.
       *
       * The trade: this device's view of the older thread is replaced. Nothing
       * is destroyed, because that session is still durable on the agent, but
       * it is no longer what this agent's chat shows.
       */
      const local = get().conversations[entry.agent] ?? [];
      const localAt = local.length ? Math.max(...local.map((b) => b.at)) : 0;
      const remoteAt = entry.lastMessageAt ? Date.parse(entry.lastMessageAt) : 0;
      if (localSession && localAt >= remoteAt) continue;

      set((s) => {
        const continuations = { ...s.continuations };
        const streamIndexes = { ...s.streamIndexes };
        // Both belong to the session being replaced; carrying them over would
        // post the next message into a thread this device is no longer on.
        delete continuations[entry.agent];
        delete streamIndexes[entry.agent];
        return {
          sessions: { ...s.sessions, [entry.agent]: entry.sessionId },
          conversations: { ...s.conversations, [entry.agent]: [] },
          continuations,
          streamIndexes,
        };
      });
      await get().hydrate(entry.agent);
    }
    get().persist();
  },

  /**
   * Rebuild a conversation from the agent that has been holding it.
   *
   * Runs only when this device has a session id and no transcript for it —
   * the case that used to look like a brand-new chat with an agent you have
   * been talking to for a month. Anything already here is left alone, because
   * replacing a live transcript with a reconstruction can only lose detail.
   */
  hydrate: async (agentId, mode = "fill") => {
    if (!window.studio) return;
    const sessionId = get().sessions[agentId];
    if (!sessionId) return;
    if (mode === "fill" && (get().conversations[agentId] ?? []).length > 0) return;
    const agent = get().agents.find((a) => a.id === agentId);
    if (!agent?.url) return;

    const replayed = await window.studio.replaySession({ url: agent.url, sessionId });
    if (!replayed || replayed.blocks.length === 0) return;
    if (mode === "fill" && (get().conversations[agentId] ?? []).length > 0) return;

    /**
     * "merge" adds what this device has not seen; "fill" builds from nothing.
     *
     * The difference matters because a local transcript holds things the
     * agent's stream never described — the question cards, the connection
     * prompts, the peer exchanges. Replacing it on every refresh would quietly
     * strip those out, so a refresh only ever APPENDS turns that happened
     * elsewhere, keyed on the durable event id so the same turn cannot arrive
     * twice.
     */
    const existing = get().conversations[agentId] ?? [];
    const seen = new Set(existing.map((b) => b.id));

    // Peers keep their own identity here for the same reason they do live: the
    // exchange should name a recognisable colleague, in that colleague's own
    // colour, rather than a generic peer.
    const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const identify = (name: string): { id: string; name: string; accent: string } => {
      const known = get().agents.find((a) => key(a.name) === key(name));
      return {
        id: known?.id ?? name,
        name: known?.name ?? name,
        accent: known?.accent ?? "#7c6cf0",
      };
    };

    const fresh: Block[] = [
      ...replayed.blocks
        .filter((b) => !seen.has(b.eventId))
        .map((b): Block => ({ kind: "text", id: b.eventId, role: b.role, text: b.text, at: b.at })),
      ...(replayed.peerBlocks ?? [])
        .map((p): Block => ({
          kind: "peer-activity",
          // Keyed on the TURN, so re-reading the same exchange cannot add it
          // twice — the stream ids differ per event, the turn does not.
          id: `peer-${sessionId}-${p.turnId}`,
          at: p.at,
          events: p.events.map((e, i) => ({
            id: `pe-${p.turnId}-${i}`,
            direction: e.direction,
            peer: identify(e.peer),
            text: e.text,
            at: p.at,
          })),
        }))
        .filter((b) => !seen.has(b.id)),
    ];

    if (mode === "merge" && fresh.length === 0) return;

    const next =
      mode === "merge" ? [...existing, ...fresh].sort((a, b) => a.at - b.at) : [...fresh].sort((a, b) => a.at - b.at);

    set((s) => ({
      conversations: { ...s.conversations, [agentId]: next },
      // Taken from the stream rather than stored anywhere: the token is a live
      // handle to the session, and the agent is the one that knows the current
      // one.
      continuations: replayed.continuationToken
        ? { ...s.continuations, [agentId]: replayed.continuationToken }
        : s.continuations,
      // Resume streaming after what was just read, so the next turn does not
      // replay the history it already has.
      streamIndexes: { ...s.streamIndexes, [agentId]: replayed.streamIndex },
    }));
    get().persist();
  },

  /**
   * Pick up what was said on another device.
   *
   * Launch-only sync meant a machine sitting open all evening showed a stale
   * conversation until it was quit and reopened, which is not synchronised in
   * any sense a person would recognise.
   *
   * Two layers, and neither needs a push service. The AGENT already holds the
   * conversation and streams it, and since both devices now share one session,
   * re-reading the open thread is the whole of "live". The control plane is
   * only asked about threads that are NEW to this device, which is rare — so
   * it is checked on the same beat rather than on its own.
   *
   * Only while the window is focused. A background window polling every half
   * minute is a battery cost paid for nothing: nobody is reading it, and the
   * moment they look, focus fires.
   */
  refreshFromOthers: async () => {
    if (!window.studio) return;
    await get().syncSessions();
    const active = get().activeAgentId;
    // The open conversation only. Refreshing every thread would multiply the
    // cost by the size of the sidebar to update something nobody is looking at.
    if (active && !isRoomId(active) && !get().inflight[active]) {
      await get().hydrate(active, "merge");
    }
  },

  setQuery: (query) => set({ query }),
  setPanel: (panel) => set({ panel, activeRoutineId: null }),
  openRoutine: (id) => set({ panel: "routine", activeRoutineId: id }),
  setPluginsOpen: (pluginsOpen) => set({ pluginsOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  createRoom: (memberIds) => {
    const id = `${ROOM_PREFIX}${Date.now().toString(36)}`;
    set((s) => ({
      rooms: [...s.rooms, { id, memberIds, createdAt: Date.now(), policy: "lead" }],
      activeAgentId: id,
    }));
    get().persist();
    return id;
  },
  setRoomMembers: (roomId, memberIds) => {
    set((s) => ({
      rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, memberIds } : r)),
    }));
    get().persist();
  },
  deleteRoom: (roomId) => {
    set((s) => {
      const conversations = { ...s.conversations };
      delete conversations[roomId];
      return {
        rooms: s.rooms.filter((r) => r.id !== roomId),
        conversations,
        activeAgentId: s.activeAgentId === roomId ? (s.agents[0]?.id ?? "") : s.activeAgentId,
      };
    });
    get().persist();
  },
  openExchange: (agentId, blockId) => set({ exchange: { agentId, blockId } }),
  closeExchange: () => set({ exchange: null }),

  /**
   * Put a message in front of every member of a room, and carry what they say
   * back to each other.
   *
   * The app is the router. Each member is a separate deployment with its own
   * session — `<roomId>::<agentId>` — so a room never contaminates the
   * one-to-one conversation with the same agent, and two agents in a room never
   * share a context.
   *
   * Relay is driven by ADDRESSING, not by chatter. When an agent's reply names
   * another member, that member hears it; when it does not, the round ends.
   * Without that rule two agents politely acknowledging each other is an
   * infinite loop, billed per turn. `relayDepth` is the backstop for a pair
   * that addresses each other every time.
   */
  sendToRoom: (roomId, text, from, relayDepth = 0) => {
    const room = get().rooms.find((r) => r.id === roomId);
    if (!room) return;
    const at = Date.now();

    if (!from) {
      set((s) => ({
        conversations: {
          ...s.conversations,
          [roomId]: [
            ...(s.conversations[roomId] ?? []),
            { kind: "text", id: `u${at}`, role: "user", text, at },
          ],
        },
        rooms: s.rooms.map((r) =>
          r.id === roomId ? { ...r, lastMessageAt: at, lastMessagePreview: text } : r,
        ),
      }));
      get().persist();
    }

    const members = room.memberIds
      .map((id) => get().agents.find((a) => a.id === id))
      .filter((a): a is Agent => Boolean(a?.url));
    if (members.length === 0) return;

    /**
     * An agent's message reaches another agent ONLY when it names them.
     *
     * A person's unaddressed message can fall back to the room's policy —
     * they are in the room and expect to be heard. An agent's cannot: with a
     * fallback, one reply becomes a reply from everyone, each of which is
     * another message that could trigger another round. That is not a
     * conversation, it is a fork bomb with a billing account.
     */
    const policy: RoomPolicy = from ? "silent" : (room.policy ?? "lead");
    const recipients = recipientsFor(text, members, policy).filter((id) => id !== from?.id);

    // A hand-off chain is fine; a pair addressing each other forever is not.
    if (from && relayDepth >= MAX_RELAY_DEPTH) return;
    if (recipients.length === 0) return;

    for (const id of recipients) {
      const member = members.find((m) => m.id === id);
      if (member) void deliverToMember(get, set, room, member, text, from, relayDepth);
    }
  },

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
        /**
         * Tell the account where this conversation lives.
         *
         * Fire and forget, never awaited: this machine already has the thread,
         * and the only thing at stake is whether the person's OTHER devices can
         * find it. A directory that is briefly stale is a much smaller problem
         * than a reply that waits on a call to a third service.
         */
        void window.studio?.recordSession({
          agent: agentId,
          sessionId: res.sessionId ?? "",
          label: agentId,
          lastMessageAt: Date.now(),
          lastMessagePreview: (res.reply ?? "").slice(0, 200),
        });
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

  patchRoom: (roomId, patch) => {
    set((s) => ({ rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, ...patch } : r)) }));
    get().persist();
  },

  setRoomPolicy: (roomId, policy) => {
    set((s) => ({ rooms: s.rooms.map((r) => (r.id === roomId ? { ...r, policy } : r)) }));
    get().persist();
  },

  stopRoom: (roomId) => {
    const room = get().rooms.find((r) => r.id === roomId);
    if (!room) return;
    for (const memberId of room.memberIds) {
      const key = `${roomId}::${memberId}`;
      const live = get().inflight[key];
      const agent = get().agents.find((a) => a.id === memberId);
      if (live?.sessionId && agent?.url && window.studio) {
        void window.studio
          .cancelTurn({ url: agent.url, sessionId: live.sessionId, turnId: live.turnId })
          .catch(() => undefined);
      }
      disarmDeadMan(key);
      set((s) => {
        const flight = { ...s.inflight };
        delete flight[key];
        // Anything still waiting on this member is dropped too: stop means
        // stop, not "stop this one and start the next".
        const queue = { ...s.roomQueue };
        delete queue[key];
        return { inflight: flight, roomQueue: queue };
      });
    }
    set((s) => ({ activity: { ...s.activity, [roomId]: null } }));
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
      rooms: Room[];
    }>("conversations.json");
    if (saved?.rooms) set({ rooms: saved.rooms });
    if (saved?.prefs && !saved?.conversations) set({ prefs: saved.prefs });
    if (saved?.conversations) {
      set({
        conversations: saved.conversations,
        sessions: saved.sessions ?? {},
        continuations: saved.continuations ?? {},
        streamIndexes: saved.streamIndexes ?? {},
        prefs: saved.prefs ?? {},
        rooms: saved.rooms ?? [],
      });
    }
    const ws = await window.studio.loadState<Record<string, string>>("workspaces.json");
    if (ws) set({ workspaces: ws });

    // After the local state, so the directory can only add threads this device
    // does not have. Not awaited by the caller: a slow control plane must not
    // hold up an app whose conversations are already on disk.
    void get().syncSessions();
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
        rooms: get().rooms,
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
      startCrossDeviceRefresh(get);
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
