import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import {
  filesFromClipboard,
  formatSize,
  readFiles,
  type PendingAttachment,
} from "../lib/attachments";
import type { Block, PeerEvent } from "@shared/types";
import { peerSummaryLabel, summarizePeerEvents } from "@shared/types";
import { useStore } from "@/lib/store";
import * as composerDom from "@/lib/composerDom";
import { Autocomplete, type Suggestion } from "./Autocomplete";
import { LocalAskCard } from "./LocalAsk";
import { Markdown } from "./Markdown";
import { Spinner } from "./Spinner";
import { Avatar, Icon, RichText, timeLabel } from "./primitives";

/**
 * Agent-to-agent traffic, collapsed.
 *
 * When agents talk to each other the transcript can drown the human's own
 * conversation, so a run of hops collapses to one line the user can open. The
 * summary distinguishes a single hop from a broadcast from a back-and-forth,
 * because those read very differently and a generic "3 events" tells you
 * nothing about who is talking to whom.
 */
/**
 * When a message was sent, shown only where it tells you something.
 *
 * A timestamp on every message is noise: in a live exchange you already know
 * when it happened, because you were there. What carries information is the
 * SEAM — the point where a conversation was picked up again after a gap. So one
 * marker per sitting, and the same wording a messages app uses, because that is
 * the reading people already have.
 */
function whenLabel(at: number, previous?: number): string | null {
  const GAP_MS = 60 * 60_000;
  if (previous !== undefined && at - previous < GAP_MS) return null;

  const date = new Date(at);
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return time;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

  const within7 = now.getTime() - at < 7 * 24 * 60 * 60_000;
  const day = date.toLocaleDateString([], within7 ? { weekday: "long" } : { month: "short", day: "numeric" });
  return `${day} ${time}`;
}

/**
 * One line saying two agents talked, with the other agent as a chip you can
 * follow into the exchange.
 *
 * Deliberately not an accordion. The exchange is a conversation between two
 * agents; unfolding it inside this thread makes the user's own conversation the
 * container for someone else's, and the two read as one jumbled transcript.
 */
function PeerActivity({
  events,
  agentId,
  blockId,
}: {
  events: PeerEvent[];
  agentId: string;
  blockId: string;
}): ReactNode {
  const openExchange = useStore((s) => s.openExchange);
  const summary = summarizePeerEvents(events);
  if (!summary) return null;
  const { text, peers } = peerSummaryLabel(summary);

  return (
    <div className="sysline">
      <span>{text}</span>
      {peers.slice(0, 3).map((peer) => (
        <button
          key={peer.id}
          className="agent-chip"
          title={`Open the exchange with ${peer.name}`}
          onClick={() => openExchange(agentId, blockId)}
        >
          {/* Same markup as a mention chip, so both read as one design. */}
          <span className="mention__icon" style={{ background: peer.accent }}>
            {peer.name.trim().charAt(0).toUpperCase()}
          </span>
          {peer.name}
        </button>
      ))}
    </div>
  );
}

/**
 * The exchange itself, read as its own conversation.
 *
 * Attribution is by DIRECTION, which is the bug this replaces: every row used
 * to be captioned with the peer's name, so a thread where this agent asked and
 * the peer answered read as the peer asking itself. Outbound is this agent
 * speaking; inbound is the peer.
 */
function ExchangeView(): ReactNode {
  const exchange = useStore((s) => s.exchange);
  const closeExchange = useStore((s) => s.closeExchange);
  const conversations = useStore((s) => s.conversations);
  const agents = useStore((s) => s.agents);
  if (!exchange) return null;

  const self = agents.find((a) => a.id === exchange.agentId);
  const block = (conversations[exchange.agentId] ?? []).find((b) => b.id === exchange.blockId);
  if (!self || !block || block.kind !== "peer-activity") return null;

  const peer = block.events[0]?.peer;

  return (
    <div className="exchange">
      <div className="exchange__head">
        <Avatar name={self.name} accent={self.accent} size={20} />
        <span>{self.name}</span>
        <span className="exchange__arrow">⇄</span>
        {peer ? <Avatar name={peer.name} accent={peer.accent} size={20} /> : null}
        <span>{peer?.name}</span>
      </div>

      <div className="exchange__body">
        {block.events.map((e) => {
          const speaker = e.direction === "outbound" ? self : e.peer;
          return (
            <div className="exchange__turn" key={e.id}>
              <Avatar name={speaker.name} accent={speaker.accent} size={22} />
              <div style={{ minWidth: 0 }}>
                <div className="exchange__who">
                  {speaker.name} · {timeLabel(e.at)}
                </div>
                <div className="exchange__bubble">{e.text}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="exchange__foot">
        <Icon name="lock" size={12} />
        <span>This exchange is view-only</span>
        <button className="btn" onClick={closeExchange}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * A question the agent asked, with its answer kept beside it.
 *
 * eve parks a turn on input.requested and waits. Studio used to drop the event,
 * so the agent looked like it had returned nothing when it was in fact waiting
 * on the user — the most confusing possible failure, because the conversation
 * had simply stopped.
 */
function QuestionCard({
  block,
  onAnswer,
}: {
  block: Extract<Block, { kind: "question" }>;
  onAnswer(answer: { optionId?: string; text?: string }): void;
}): ReactNode {
  const [text, setText] = useState("");

  if (block.answered) {
    return (
      <div className="ask ask--done">
        <div className="ask__title" style={{ fontWeight: 500 }}>{block.prompt}</div>
        <div className="ask__answered">
          <Icon name="check" size={13} /> {block.answered}
        </div>
      </div>
    );
  }

  return (
    <div className="ask">
      <div className="ask__title" style={{ marginBottom: 10 }}>{block.prompt}</div>
      {block.options?.length ? (
        <div className="ask__options">
          {block.options.map((o) => (
            <button
              key={o.id}
              className={`btn${o.style === "primary" ? " btn--primary" : ""}`}
              title={o.description}
              onClick={() => onAnswer({ optionId: o.id })}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      {block.allowFreeform !== false ? (
        <div className="ask__freeform">
          <input
            className="input"
            value={text}
            placeholder="Or type an answer"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && text.trim()) onAnswer({ text: text.trim() });
            }}
          />
          <button className="btn" disabled={!text.trim()} onClick={() => onAnswer({ text: text.trim() })}>
            Send
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A connection asking the user to sign in, mid-conversation.
 *
 * eve parks the turn and resumes it after the callback, so this card is the
 * whole interaction: the turn is not failing, it is waiting on a browser tab.
 * Rendering it is what turns "the agent stopped" into "Gmail wants you to sign
 * in", and it is the same card whatever brokered the connection.
 *
 * The link opens in the real browser, never in an app window. A window that
 * asks for a Google password while pretending to be Chrome is indistinguishable
 * from the thing security training tells people never to trust.
 */
function AuthorizationCard({
  block,
}: {
  block: Extract<Block, { kind: "authorization" }>;
}): ReactNode {
  const settled = block.outcome && block.outcome !== "pending";
  const good = block.outcome === "authorized";

  if (settled) {
    return (
      <div className="ask ask--done">
        <div className="ask__title" style={{ fontWeight: 500 }}>
          {good ? `${block.name} connected` : `${block.name} was not connected`}
        </div>
        {!good ? <div className="muted">{block.outcome}</div> : null}
      </div>
    );
  }

  return (
    <div className="ask">
      <div className="ask__title" style={{ marginBottom: 4 }}>
        Sign in to {block.name}
      </div>
      <div className="muted" style={{ marginBottom: 10 }}>
        {block.instructions ?? block.description ?? "The agent needs access before it can continue."}
      </div>
      <div className="ask__options">
        <button
          className="btn btn--primary"
          disabled={!block.url}
          onClick={() => block.url && void window.studio?.openExternal(block.url)}
        >
          Open sign-in
        </button>
        {block.userCode ? <span className="ask__code">{block.userCode}</span> : null}
      </div>
    </div>
  );
}

function ConnectionCard({ block }: { block: Extract<Block, { kind: "connection" }> }): ReactNode {
  return (
    <div className="conn">
      <div className="conn__head">
        <div className="conn__icon">{block.icon ?? "🔌"}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="conn__name">{block.name}</div>
          <div className="conn__desc">{block.description}</div>
          <div className="conn__tools">{block.toolCount} tools</div>
        </div>
      </div>
      <div className="conn__accounts">
        {block.accounts.map((a) => (
          <button className="chip" key={a.id}>
            {a.label}
            <Icon name={a.connected ? "check" : "plus"} size={12} />
          </button>
        ))}
        <button className="chip chip--ghost">
          <Icon name="plus" size={12} /> Add another account
        </button>
      </div>
    </div>
  );
}

export function Conversation(): ReactNode {
  const {
    agents,
    activeAgentId,
    conversations,
    send,
    panel,
    setPanel,
    details,
    setPluginsOpen,
    answerQuestion,
    inflight,
    queued,
    stopTurn,
    activity,
    models,
    loadAgentInfo,
    workspaces,
    chooseWorkspace,
    setWorkspace,
  } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  const rooms = useStore((s) => s.rooms);
  const sendToRoom = useStore((s) => s.sendToRoom);
  const stopRoom = useStore((s) => s.stopRoom);
  const roomQueue = useStore((s) => s.roomQueue);
  const setRoomPolicy = useStore((s) => s.setRoomPolicy);
  const room = rooms.find((r) => r.id === activeAgentId);
  const roomMembers = (room?.memberIds ?? [])
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  // Who this agent can be asked to talk to — the control plane's list, reused
  // for both the @ menu and for drawing mentions in what was sent.
  const mentionable = room
    ? [
        ...roomMembers.map((m) => ({ name: m.name, accent: m.accent })),
        { name: "everyone", accent: "#8b91a0" },
      ]
    : (agent?.peers ?? []).map((peer) => ({
        name: peer.name,
        accent: agents.find((a) => a.id === peer.id || a.name === peer.name)?.accent,
      }));
  const blocks = conversations[activeAgentId] ?? [];
  const [draft, setDraft] = useState("");
  const [acCursor, setAcCursor] = useState(0);
  const [folderMenu, setFolderMenu] = useState(false);
  /** Files chosen for the next message, not yet sent. */
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  /** Why the last attempt to attach did not fully work. */
  const [attachError, setAttachError] = useState<string | null>(null);
  /** Whether files are being dragged over the composer right now. */
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the view is following the tail of the conversation.
   *
   * Scrolling on new blocks alone is not enough: a reply arrives as one block
   * whose text keeps growing, and the activity line and tool calls appear
   * underneath it. None of that changes the block COUNT, so the window sat
   * still while the answer wrote itself just out of sight — the agent looked
   * idle when it was working.
   *
   * Following is a mode the user controls by scrolling. Scroll up to read
   * something and the view stops chasing; return to the bottom and it resumes.
   * Yanking someone back mid-read would be worse than not scrolling at all.
   */
  const following = useRef(true);

  useEffect(() => {
    const thread = threadRef.current;
    const inner = innerRef.current;
    if (!thread || !inner) return;

    const toBottom = (): void => {
      // Assigning scrollTop rather than scrollIntoView: this scrolls exactly
      // one container, and stays smooth under rapid streaming updates.
      thread.scrollTop = thread.scrollHeight;
    };

    // Any change in rendered height — a delta, a tool call, a card expanding.
    const observer = new ResizeObserver(() => {
      if (following.current) toBottom();
    });
    observer.observe(inner);
    toBottom();
    return () => observer.disconnect();
  }, [activeAgentId]);

  // Switching conversations always lands at the newest message.
  useEffect(() => {
    following.current = true;
  }, [activeAgentId]);

  useEffect(() => {
    void loadAgentInfo(activeAgentId);
  }, [activeAgentId, loadAgentInfo]);

  const busy = activity[activeAgentId] ?? null;
  const model = models[activeAgentId];
  // A turn in flight, which is a stronger fact than an activity label: the
  // label goes quiet between steps, but the session is still not accepting.
  /**
   * A room is busy while ANY member is still working.
   *
   * Flight is tracked per member (`<roomId>::<agentId>`), so asking about the
   * room id alone always says "idle" — and the stop button never appears while
   * four agents are mid-hand-off, which is exactly when it is wanted.
   */
  const roomFlightKeys = (room?.memberIds ?? []).map((id) => `${room?.id}::${id}`);
  const busyMembers = roomFlightKeys.filter((k) => inflight[k]);
  const running = room ? busyMembers.length > 0 : Boolean(inflight[activeAgentId]);
  const waiting = room
    ? roomFlightKeys.reduce((n, k) => n + (roomQueue[k]?.length ?? 0), 0)
    : (queued[activeAgentId]?.length ?? 0);


  /**
   * What the caret is sitting in, not what the message ends with.
   *
   * With a textarea those were the same thing. In a contenteditable the caret
   * can be anywhere — including before an existing chip — so reading the end of
   * the serialized text would open the menu for a word the user is not typing.
   */
  const [caretTrigger, setCaretTrigger] = useState<{ char: string; term: string } | null>(null);
  const triggerChar = caretTrigger?.char ?? null;
  const triggerTerm = caretTrigger?.term ?? "";

  const suggestions: Suggestion[] = (() => {
    if (!triggerChar) return [];
    const match = (t: string): boolean => !triggerTerm || t.toLowerCase().includes(triggerTerm);

    const info = details[activeAgentId];

    if (triggerChar === "/") {
      // What the agent can DO — its real skills, as it reports them.
      const fromSkills: Suggestion[] = (info?.skills ?? [])
        .filter((k) => match(k.name))
        .map((k) => ({ id: `skill:${k.name}`, title: k.name, detail: k.description, type: "Skill" }));
      const actions: Suggestion[] = [
        { id: "act:settings", title: "Chat Settings", detail: "Current chat", type: "Action" },
        { id: "act:channels", title: "Settings: Channels", detail: "Current agent", type: "Action" },
        { id: "act:plugins", title: "Plugins", detail: "Marketplace", type: "Action" },
      ].filter((a) => match(a.title)) as Suggestion[];
      return [...fromSkills, ...actions].slice(0, 8);
    }

    /**
     * Agents first, because @ is for addressing someone.
     *
     * These are the peers the CONTROL PLANE says this agent may call, not a
     * list the agent asserts about itself — so an edge revoked in the admin
     * stops being suggested here, and tagging someone it cannot reach is not
     * offered in the first place.
     */
    // In a room the people you can address are the members — plus everyone at
    // once. Outside a room they are the peers this agent may CALL, from the
    // control plane. Same gesture, two different sets, because tagging someone
    // who is not here does nothing and tagging someone unreachable is worse.
    const fromPeers: Suggestion[] = room
      ? [
          ...(match("everyone")
            ? [
                {
                  id: "agent:everyone",
                  title: "everyone",
                  detail: "Everyone in this group",
                  type: "Agent" as const,
                },
              ]
            : []),
          ...roomMembers
            .filter((m) => match(m.name))
            .map((m) => ({
              id: `agent:${m.id}`,
              title: m.name,
              detail: m.title,
              type: "Agent" as const,
              accent: m.accent,
            })),
        ]
      : (agent?.peers ?? [])
          .filter((peer) => match(peer.name))
          .map((peer) => ({
            id: `agent:${peer.id}`,
            title: peer.name,
            detail: peer.purpose,
            type: "Agent" as const,
            accent: agents.find((a) => a.id === peer.id || a.name === peer.name)?.accent,
          }));

    // What the agent can REACH — its real connections, tools, and schedules.
    const fromRoutines: Suggestion[] = (info?.schedules ?? [])
      .filter((r) => match(r.name))
      .map((r) => ({ id: `routine:${r.name}`, title: r.name, detail: r.cron, type: "Routine" }));
    const fromConnections: Suggestion[] = (info?.connections ?? [])
      .filter((c) => match(c.name))
      .map((c) => ({
        id: `conn:${c.name}`,
        title: c.name,
        detail: c.description,
        type: "Plugin",
      }));
    const fromTools: Suggestion[] = (info?.tools ?? [])
      .filter((t) => match(t.name))
      .map((t) => ({ id: `tool:${t.name}`, title: t.name, detail: t.description, type: "Plugin" }));
    return [...fromPeers, ...fromRoutines, ...fromConnections, ...fromTools].slice(0, 8);
  })();

  const applySuggestion = (s: Suggestion): void => {
    const el = inputRef.current;
    if (!el) return;

    if (s.type === "Action") {
      composerDom.removeTrigger(el);
      setDraft(composerDom.serialize(el));
      setCaretTrigger(null);
      if (s.id === "act:plugins") setPluginsOpen(true);
      else if (s.id === "act:channels") setPanel("channels");
      else setPanel("settings");
      return;
    }

    // An agent becomes a chip; everything else stays text, because a skill or a
    // tool is not someone you are addressing.
    if (s.type === "Agent") {
      composerDom.replaceTriggerWithChip(el, { name: s.title, accent: s.accent });
    } else {
      composerDom.replaceTriggerWithText(el, `${triggerChar ?? ""}${s.title} `);
    }
    setDraft(composerDom.serialize(el));
    setCaretTrigger(null);
    setAcCursor(0);
    el.focus();
  };

  if (!agent && !room) return <div className="main" />;

  /**
   * Attaching a file is the user handing something over deliberately.
   *
   * @remarks
   * Distinct from the agent reaching into the filesystem, which is what local
   * access governs and asks about separately. That distinction is the whole
   * reason the bytes travel with the message instead of a path: what is shared
   * is this file, chosen at this moment, and nothing else on the disk.
   */
  const attach = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    const { accepted, rejected } = await readFiles(files, pending);
    if (accepted.length > 0) setPending((current) => [...current, ...accepted]);
    // Refusals replace rather than accumulate: the second attempt's problem is
    // the one being solved, and a stack of stale complaints obscures it.
    setAttachError(rejected.length > 0 ? rejected.join(" ") : null);
  };

  const submit = (): void => {
    const text = draft.trim();
    // A file with no words is still a message — dragging a document in and
    // pressing enter means "look at this", and refusing it as empty is wrong.
    if (!text && pending.length === 0) return;
    if (room) {
      // Rooms fan one message out to several agents; attachments are not
      // carried there yet, so say so rather than dropping them silently.
      if (pending.length > 0) {
        setAttachError("Files can be attached in a direct conversation, not in a group yet.");
        return;
      }
      sendToRoom(room.id, text);
    } else if (agent) {
      send(agent.id, text, false, pending.length > 0 ? pending : undefined);
    }
    setDraft("");
    setPending([]);
    setAttachError(null);
    if (inputRef.current) composerDom.clear(inputRef.current);
  };

  return (
    <div className="main" style={{ position: "relative" }}>
      <ExchangeView />
      <div className="topbar">
        {room ? (
          <>
            <span className="stack">
              {roomMembers.map((m) => (
                <Avatar key={m.id} name={m.name} accent={m.accent} size={22} />
              ))}
            </span>
            <span className="topbar__title">
              {room.name ?? roomMembers.map((m) => m.name).join(", ")}
            </span>
            {/* Who answers when you tag nobody. The default is the first
                member, which is how a team works — you talk to whoever runs
                it, and they bring the others in. */}
            <select
              className="policy"
              value={room.policy ?? "lead"}
              title="Who replies when you do not tag anyone"
              onChange={(e) => setRoomPolicy(room.id, e.target.value as "all" | "lead" | "silent")}
            >
              <option value="lead">{roomMembers[0]?.name ?? "Lead"} answers</option>
              <option value="all">Everyone answers</option>
              <option value="silent">Only who I tag</option>
            </select>
          </>
        ) : (
          <>
            <Avatar name={agent!.name} accent={agent!.accent} size={22} />
            <span className="topbar__title">{agent!.name}</span>
          </>
        )}
        <div className="topbar__spacer" />
        {workspaces[activeAgentId] ? (
          <div className="workspace-wrap">
            <button
              className="workspace"
              title={workspaces[activeAgentId]}
              onClick={() => setFolderMenu((v) => !v)}
            >
              <Icon name="folder" size={13} />
              {workspaces[activeAgentId]!.split("/").pop()}
            </button>
            {folderMenu ? (
              <div className="menu workspace-menu">
                <button
                  className="menu__item"
                  onClick={() => {
                    setFolderMenu(false);
                    void chooseWorkspace(activeAgentId);
                  }}
                >
                  <Icon name="folder" /> Change folder…
                </button>
                <button
                  className="menu__item"
                  onClick={() => {
                    setFolderMenu(false);
                    setWorkspace(activeAgentId, null);
                  }}
                >
                  <Icon name="close" /> Clear working folder
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <button
            className="workspace workspace--empty"
            title="Set a default working folder on this machine (optional)"
            onClick={() => void chooseWorkspace(activeAgentId)}
          >
            <Icon name="folder" size={13} />
            Folder
          </button>
        )}
        <button
          className={`topbar__btn${panel !== "none" ? " topbar__btn--on" : ""}`}
          title="Agent panel"
          onClick={() => setPanel(panel === "none" ? "overview" : "none")}
        >
          <Icon name="monitor" />
        </button>
      </div>

      <div
        className="thread"
        ref={threadRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // A small tolerance: sub-pixel layout and the last delta both leave
          // you a few pixels short of the true bottom.
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        <div className="thread__inner" ref={innerRef}>
          {blocks.map((b, i) => {
            const when = whenLabel(b.at, i > 0 ? blocks[i - 1].at : undefined);
            const marker = when ? (
              <div className="thread__when" key={`w${b.id}`}>
                {when}
              </div>
            ) : null;
            const body = ((): ReactNode => {
            if (b.kind === "peer-activity")
              return (
                <PeerActivity key={b.id} events={b.events} agentId={activeAgentId} blockId={b.id} />
              );
            if (b.kind === "connection") return <ConnectionCard key={b.id} block={b} />;
            if (b.kind === "authorization") return <AuthorizationCard key={b.id} block={b} />;
            if (b.kind === "question")
              return (
                <QuestionCard
                  key={b.id}
                  block={b}
                  onAnswer={(answer) => answerQuestion(activeAgentId, b.id, answer)}
                />
              );
              // In a room, every agent turn says who is speaking. Without it a
              // run of replies from three agents is one anonymous wall.
              // Who said it, above what they said, with their avatar beside the
              // bubble. In a room this is not decoration: two grey bubbles in a
              // row are unreadable when three agents can produce them.
              return b.speaker ? (
                <div key={b.id} className="said">
                  <div className="said__who">{b.speaker.name}</div>
                  <div className="said__row">
                    <Avatar name={b.speaker.name} accent={b.speaker.accent} size={22} />
                    <div className="bubble bubble--agent">
                      <Markdown text={b.text} />
                    </div>
                  </div>
                </div>
              ) : (
                <div key={b.id} className={`bubble bubble--${b.role}`}>
                  {b.role === "agent" ? (
                    <Markdown text={b.text} />
                  ) : (
                    <RichText text={b.text} mentions={mentionable} />
                  )}
                </div>
              );
            })();

            // A marker and its block travel together, so the label always sits
            // directly above the message that opened the sitting.
            return marker ? (
              <Fragment key={b.id}>
                {marker}
                {body}
              </Fragment>
            ) : (
              body
            );
          })}
          {blocks.length === 0 ? (
            <div className="empty">
              {room
                ? `No messages yet. Say something to ${roomMembers.map((m) => m.name).join(" and ")}.`
                : `No messages yet. Say hello to ${agent?.name}.`}
            </div>
          ) : null}
          {busy ? (
            <div className="activity">
              <Spinner />
              <span className="activity__label">{busy}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="composer">
        <LocalAskCard />
        {suggestions.length > 0 ? (
          <div className="composer__ac">
            <Autocomplete
              items={suggestions}
              cursor={acCursor}
              onPick={applySuggestion}
              onHover={setAcCursor}
            />
          </div>
        ) : null}
        {pending.length > 0 ? (
          <div className="composer__files">
            {pending.map((file) => (
              <span key={file.id} className="chip-file" title={`${file.name} · ${file.mediaType}`}>
                <Icon name="paperclip" size={11} />
                <span className="chip-file__name">{file.name}</span>
                <span className="chip-file__size">{formatSize(file.size)}</span>
                <button
                  className="chip-file__x"
                  title="Remove"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => setPending((c) => c.filter((f) => f.id !== file.id))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        {attachError ? <div className="composer__attach-error">{attachError}</div> : null}
        <div
          className={`composer__inner${dragging ? " composer__inner--drop" : ""}`}
          onDragOver={(e) => {
            // Only for actual files: a drag of selected text inside the
            // composer must keep behaving like text.
            if (!Array.from(e.dataTransfer.types).includes("Files")) return;
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            // Fires when crossing onto a child element too, which would flicker
            // the highlight off while the pointer is still over the composer.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragging(false);
          }}
          onDrop={(e) => {
            if (!Array.from(e.dataTransfer.types).includes("Files")) return;
            e.preventDefault();
            setDragging(false);
            void attach(Array.from(e.dataTransfer.files));
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              void attach(Array.from(e.target.files ?? []));
              // Cleared so choosing the same file twice in a row still fires a
              // change event.
              e.target.value = "";
            }}
          />
          <button
            className="icon-btn"
            title="Attach a file"
            aria-label="Attach a file"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="plus" />
          </button>
          <div
            ref={inputRef}
            className="composer__input"
            contentEditable
            role="textbox"
            aria-multiline="true"
            suppressContentEditableWarning
            data-placeholder={room ? "Message the group" : `Message ${agent?.name}`}
            onInput={() => {
              const el = inputRef.current;
              if (!el) return;
              setDraft(composerDom.serialize(el));
              setCaretTrigger(composerDom.triggerBeforeCaret(el));
            }}
            onKeyUp={() => {
              const el = inputRef.current;
              if (el) setCaretTrigger(composerDom.triggerBeforeCaret(el));
            }}
            onMouseUp={() => {
              const el = inputRef.current;
              if (el) setCaretTrigger(composerDom.triggerBeforeCaret(el));
            }}
            onPaste={(e) => {
              // A pasted screenshot is the fastest way anyone attaches
              // anything, and it arrives as a clipboard file rather than text.
              const files = filesFromClipboard(e.clipboardData);
              if (files.length > 0) {
                e.preventDefault();
                void attach(files);
                return;
              }
              // Plain text only. Pasted markup would bring styles, and worse,
              // spans that serialize into the message as invisible junk.
              e.preventDefault();
              const text = e.clipboardData.getData("text/plain");
              document.execCommand("insertText", false, text);
            }}
            onKeyDown={(e) => {
              if (suggestions.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setAcCursor((c) => Math.min(c + 1, suggestions.length - 1));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setAcCursor((c) => Math.max(c - 1, 0));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  const picked = suggestions[acCursor];
                  if (picked) {
                    e.preventDefault();
                    applySuggestion(picked);
                    return;
                  }
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  const el = inputRef.current;
                  if (el) {
                    composerDom.removeTrigger(el);
                    setDraft(composerDom.serialize(el));
                  }
                  setCaretTrigger(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            className={`icon-btn${running || draft.trim() ? " icon-btn--filled" : ""}`}
            title={running ? "Stop" : draft.trim() ? "Send" : "Dictate"}
            onClick={() => {
              // While a turn runs, this is a stop button. A user watching a turn
              // that has gone nowhere for two minutes needs a way out that does
              // not involve quitting the app.
              if (running) {
                if (room) stopRoom(room.id);
                else stopTurn(activeAgentId);
              }
              else if (draft.trim()) submit();
            }}
          >
            {running ? (
              <Icon name="stop" />
            ) : (
              <Icon name={draft.trim() ? "arrowUp" : "mic"} />
            )}
          </button>
        </div>
        {model || busy ? (
          <div className="composer__meta">
            {model ? (
              <span className="composer__model" title={`Model this agent runs on: ${model}`}>
                {model}
              </span>
            ) : null}
            {busy ? <span className="composer__status">{busy}…</span> : null}
            {waiting ? (
              <span className="composer__status" title="Sent in order once this turn settles">
                {waiting} queued
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
