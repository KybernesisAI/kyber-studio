import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  filesFromClipboard,
  formatSize,
  readFiles,
  type PendingAttachment,
} from "../lib/attachments";
import type { Block, PeerEvent } from "@shared/types";
import { peerSummaryLabel, summarizePeerEvents } from "@shared/types";
import { isRetired, useStore } from "@/lib/store";
import { GoneNotice } from "./GoneNotice";
import * as composerDom from "@/lib/composerDom";
import { Autocomplete, type Suggestion } from "./Autocomplete";
import { LocalAskCard } from "./LocalAsk";
import { Markdown } from "./Markdown";
import { record, type Recorder } from "../lib/dictation";
import { DeliveredFiles } from "./DeliveredFiles";
import { ApprovalAskCard, FormAskCard, SpendRequestCard, VaultAskCard } from "./Asks";
import { approvalPrompt, parseSpendRequestAsk, parseVaultItemAsk } from "@shared/asks";
import { deliveredFiles } from "../../../shared/deliveredFiles";
import { Spinner } from "./Spinner";
import { Avatar, Icon, RichText, timeLabel } from "./primitives";
import { approvalCard, isKnownCard, parseCardPrompt } from "@kybernesis/cards";
import { placeCards } from "../lib/placeCards";
import { ArtifactFrame, CardStack, CardView, type CardContext } from "./Cards";
import { WorkSteps } from "./Work";
import { reportLabel } from "@shared/thread";

/**
 * An artifact, over the conversation, opened from its card.
 *
 * Fetched fresh on open, so an older card shows the latest version unless it
 * named one. Closed with the button or Escape, back to where you were.
 */
function ArtifactView(): ReactNode {
  const artifact = useStore((s) => s.artifact);
  const closeArtifact = useStore((s) => s.closeArtifact);
  const agents = useStore((s) => s.agents);
  useEffect(() => {
    if (!artifact) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeArtifact();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [artifact, closeArtifact]);
  if (!artifact) return null;
  const agent = agents.find((a) => a.id === artifact.agentId);
  return (
    <div className="artifact-view">
      <div className="artifact-view__head">
        <span className="artifact-view__title">{artifact.title ?? "Artifact"}</span>
        {agent ? <span className="klabel">{agent.name}</span> : null}
        <button className="btn" onClick={closeArtifact}>
          Close
        </button>
      </div>
      <ArtifactFrame agentUrl={agent?.url} artifactId={artifact.artifactId} version={artifact.version} className="artifact-view__body" />
    </div>
  );
}

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
  ctx,
}: {
  block: Extract<Block, { kind: "question" }>;
  onAnswer(answer: { optionId?: string; text?: string; label?: string }): void;
  ctx: CardContext;
}): ReactNode {
  const [text, setText] = useState("");
  const vault = parseVaultItemAsk(block.prompt);
  const spend = parseSpendRequestAsk(block.prompt);
  const carded = vault || spend ? null : parseCardPrompt(block.prompt);
  const approval = carded ? null : approvalPrompt(block.prompt);
  // What the transcript shows once answered: the sentence, not the marker line.
  const shownPrompt = vault ? `Needed ${vault.ask.kind === "login" ? "a login" : vault.ask.kind === "card" ? "a card" : `an ${vault.ask.kind}`}${vault.ask.site ? ` for ${vault.ask.site}` : ""}` : spend ? `Purchase approval · ${spend.ask.merchant ?? spend.ask.merchant_url ?? ""}` : carded ? carded.text : approval ? approval.title : block.prompt;

  const approvalCardOf = block.approval && !carded && !vault && !spend ? approvalCard(block.approval.tool, block.approval.input, block.requestId) : null;
  if (approvalCardOf && isKnownCard(approvalCardOf) && approvalCardOf.card === "approval") return <ApprovalAskCard block={block} card={approvalCardOf} onAnswer={onAnswer} />;
  if (carded && isKnownCard(carded.card) && carded.card.card === "form") return <FormAskCard block={block} card={carded.card} text={carded.text} onAnswer={onAnswer} />;
  if (spend) return <SpendRequestCard block={block} ask={spend.ask} text={spend.text} onAnswer={onAnswer} />;

  if (block.answered) {
    return (
      <div className="ask ask--done">
        <div className="ask__title" style={{ fontWeight: 500 }}>{shownPrompt}</div>
        <div className="ask__answered">
          <Icon name="check" size={13} /> {block.answered}
        </div>
      </div>
    );
  }

  if (vault) return <VaultAskCard block={block} ask={vault.ask} text={vault.text} onAnswer={onAnswer} />;

  return (
    <div className="ask">
      {carded ? <CardView card={carded.card} ctx={ctx} /> : null}
      <div className="ask__title" style={{ marginBottom: 10 }}>{carded ? carded.text : approval ? approval.title : block.prompt}</div>
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
      <div className="kcard kcard--signin is-done">
        <div className="kcard__head">
          <span className="kcard__title">{block.name}</span>
          <span className={`kpill${good ? " is-good" : ""}`}>{good ? "Connected" : "Not connected"}</span>
        </div>
        {!good ? <div className="muted">{block.outcome}</div> : null}
      </div>
    );
  }

  return (
    <div className="kcard kcard--signin">
      <div className="kcard__head">
        <span className="kcard__title">Sign in to {block.name}</span>
        <span className="klabel kcard__source">Sign-in</span>
      </div>
      <div className="kcard__text">{block.instructions ?? block.description ?? "The agent needs access before it can continue."}</div>
      <div className="kcard__actions" style={{ alignItems: "center" }}>
        <button
          className="btn btn--primary"
          disabled={!block.url}
          onClick={() => block.url && void window.studio?.openExternal(block.url)}
        >
          Open sign-in
        </button>
        {block.userCode ? <span className="ksignin__code">{block.userCode}</span> : null}
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
  const sessions = useStore((s) => s.sessions);
  const threadIndex = useStore((s) => s.threadIndex);
  const startConversation = useStore((s) => s.startConversation);
  const openThread = useStore((s) => s.openThread);
  const threads = useStore((s) => s.threads);
  const openOrb = (): void => {
    if (!agent?.url) return;
    void window.studio.toggleOrb({
      agentId: agent.id,
      agentUrl: agent.url,
      agentName: agent.name,
      sessionId: sessions[activeAgentId],
      voice: agent.voice ?? "marin",
    });
  };
  const [voiceCapable, setVoiceCapable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setVoiceCapable(false);
    const url = agent?.url;
    if (url) {
      void window.studio.voiceManifest(url).then((m) => {
        if (!cancelled) setVoiceCapable(Boolean(m?.enabled));
      });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgentId, agent?.url]);
  const sendToRoom = useStore((s) => s.sendToRoom);
  const stopRoom = useStore((s) => s.stopRoom);
  const roomQueue = useStore((s) => s.roomQueue);
  const setRoomPolicy = useStore((s) => s.setRoomPolicy);
  const room = rooms.find((r) => r.id === activeAgentId);
  // The open thread is one the agent reports ended or failed (KYB-649).
  const held = agent ? sessions[agent.id] : undefined;
  const retired = !room && Boolean(agent && held && isRetired(threadIndex[agent.id]?.[held]));
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
  const placed = useMemo(() => placeCards(blocks), [blocks]);
  const openArtifact = useStore((s) => s.openArtifact);
  const runRoutine = useStore((s) => s.runRoutine);
  /** Cards act for the agent that made them: in a room, the member who answered. */
  const cardContext = (speakerId?: string): CardContext => {
    const owner = agents.find((a) => a.id === (speakerId ?? activeAgentId)) ?? agent ?? roomMembers[0];
    return {
      agentUrl: owner?.url,
      onSay: (text) => (room ? sendToRoom(room.id, text) : send(activeAgentId, text)),
      onRunRoutine: (routine, say) => {
        if (owner) runRoutine(owner.id, routine, say);
      },
      onOpenArtifact: (artifactId, title, version) => {
        if (owner) openArtifact(owner.id, artifactId, title, version);
      },
    };
  };
  // The newest work block, while the agent is on it, is the one whose steps are live.
  const lastWork = [...blocks].reverse().find((b) => b.kind === "work");
  const lastWorkId = lastWork?.id;
  // A running step already says what is happening; the activity line would say it twice.
  const stepRunning =
    blocks[blocks.length - 1]?.kind === "work" &&
    lastWork?.kind === "work" &&
    lastWork.steps.some((step) => step.status === "running");
  // KYB-643: right after signing in, the account's threads are still being
  // read. An empty chat may be about to receive one, so "No messages yet"
  // would be a guess, and usually a wrong one. Not conditioned on the chat
  // having no thread: adoption names the thread first and replays its history
  // after, and the directory gate stays shut until that replay has landed.
  const directoryLoading = useStore((s) => s.directoryLoading);
  const loadingMessages = !room && directoryLoading;
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
  /** The live recorder while the user holds the mic; null when not recording. */
  const recorderRef = useRef<Recorder | null>(null);
  /** "idle" | "recording" | "transcribing" — what the mic control is doing. */
  const [voice, setVoice] = useState<"idle" | "recording" | "transcribing">("idle");
  /** Input level while recording, so a muted microphone is visible as one. */
  const [level, setLevel] = useState(0);
  const [voiceError, setVoiceError] = useState<string | null>(null);
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

  // Landing on an agent means you are about to talk to it: the composer takes
  // the caret without a click. After paint, so the switch has rendered the
  // input this effect is focusing.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) composerDom.focusAtEnd(el);
    });
    return () => window.cancelAnimationFrame(id);
  }, [activeAgentId]);

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
        { id: "act:channels", title: "Channels", detail: "Current agent", type: "Action" },
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
      else if (s.id === "act:channels") setPanel("overview");
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

  /**
   * Click to start, click again to stop and transcribe.
   *
   * The microphone opens only between those two clicks; it is not listening
   * before the first or after the second. Holding a button down for the length
   * of a sentence is fine for a two-word command and tiring for anything real,
   * and it makes the button impossible to use while reading something else on
   * screen — which is most of what dictation is for.
   */
  const startDictation = async (): Promise<void> => {
    if (voice !== "idle") return;
    setVoiceError(null);
    try {
      const recorder = await record();
      recorderRef.current = recorder;
      setVoice("recording");
      const tick = (): void => {
        if (recorderRef.current !== recorder) return;
        setLevel(recorder.level());
        requestAnimationFrame(tick);
      };
      tick();
    } catch {
      // Refused permission, or no input device. Either way the honest answer is
      // that the microphone is unavailable, not that dictation is broken.
      setVoiceError("No microphone available. Check the system permission for KYBER Studio.");
      setVoice("idle");
    }
  };

  const finishDictation = async (): Promise<void> => {
    const recorder = recorderRef.current;
    if (!recorder || voice !== "recording") return;
    recorderRef.current = null;
    setVoice("transcribing");
    setLevel(0);
    const samples = await recorder.stop();
    if (samples.length === 0) {
      setVoice("idle");
      return;
    }
    const result = await window.studio.transcribe(samples);
    setVoice("idle");
    if (result.error) {
      setVoiceError(result.error);
      return;
    }
    const el = inputRef.current;
    if (!el || !result.text) return;
    // Inserted at the caret rather than replacing the draft: dictation is
    // another way to type, so it must compose with what is already written.
    el.focus();
    document.execCommand("insertText", false, (draft.trim() ? " " : "") + result.text);
    setDraft(composerDom.serialize(el));
  };

  const cancelDictation = (): void => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    setLevel(0);
    setVoice("idle");
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
      <ArtifactView />
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
            <Avatar name={agent!.name} accent={agent!.accent} src={agent!.avatar} size={22} />
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
          <Icon name="sidePanel" />
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
            if (b.kind === "work") {
              const cards = placed.atWork.get(b.id);
              return (
                <div key={b.id} className="turn-work">
                  <WorkSteps steps={b.steps} live={running && b.id === lastWorkId} />
                  {cards ? <CardStack cards={cards} ctx={cardContext(b.speakerId)} /> : null}
                </div>
              );
            }
            if (b.kind === "authorization") return <AuthorizationCard key={b.id} block={b} />;
            // What a routine or heads-up produced. It ran in the background and
            // nobody typed its instruction, so only its answer is here, labelled.
            if (b.kind === "report")
              return (
                <div key={b.id} className="report">
                  <div className="report__head">
                    <span className="klabel">{reportLabel(b.routine)}</span>
                  </div>
                  {b.text ? <Markdown text={b.text} /> : null}
                  {b.cards?.length ? <CardStack cards={b.cards} ctx={cardContext()} /> : null}
                </div>
              );
            if (b.kind === "gone")
              return (
                <GoneNotice
                  key={b.id}
                  agentName={agent?.name ?? "the agent"}
                  oneThread={Boolean(agent && threads[agent.id])}
                  showAction={i === blocks.length - 1 && Boolean(agent) && !inflight[activeAgentId]}
                  onNewConversation={() => agent && startConversation(agent.id)}
                  onBackToThread={() => agent && void openThread(agent.id)}
                />
              );
            if (b.kind === "divider")
              return (
                <div key={b.id} className="thread-divider" role="separator">
                  <span>{b.label}</span>
                </div>
              );
            if (b.kind === "question")
              return (
                <QuestionCard
                  key={b.id}
                  block={b}
                  ctx={cardContext()}
                  onAnswer={(answer) => answerQuestion(activeAgentId, b.id, answer)}
                />
              );
            // A kind this version does not know (saved by a newer Studio sharing
            // this data folder) has no text to draw: skip it, never crash on it.
            if (typeof b.text !== "string") return null;
            if (b.role === "user") {
              return (
                <div key={b.id} className="bubble bubble--user">
                  <RichText text={b.text} mentions={mentionable} />
                </div>
              );
            }
            // The agent's reply is the page, not a bubble: full width, with the
            // cards its tools returned underneath. A bubble around a table or a
            // chart is a box inside a box.
            const cards = placed.under.get(b.id);
            const reply = (
              <div className="reply">
                <Markdown text={b.text} />
                {/* Under the words, never instead of them: the sentence
                    explaining what the file is stays exactly as written. */}
                <DeliveredFiles files={deliveredFiles(b.text)} />
                {cards ? <CardStack cards={cards} ctx={cardContext(b.speaker?.id)} /> : null}
              </div>
            );
            // In a room, every reply says who is speaking. Without it a run of
            // replies from three agents is one anonymous wall.
            return b.speaker ? (
              <div key={b.id} className="said">
                <div className="said__who">
                  <Avatar name={b.speaker.name} accent={b.speaker.accent} size={18} />
                  {b.speaker.name}
                </div>
                {reply}
              </div>
            ) : (
              <Fragment key={b.id}>{reply}</Fragment>
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
          {blocks.length === 0 && loadingMessages ? (
            <div className="empty" role="status">
              <Spinner />
              <span> Loading messages…</span>
            </div>
          ) : blocks.length === 0 ? (
            <div className="empty">
              {room
                ? `No messages yet. Say something to ${roomMembers.map((m) => m.name).join(" and ")}.`
                : `No messages yet. Say hello to ${agent?.name}.`}
            </div>
          ) : null}
          {busy && !stepRunning ? (
            <div className="activity">
              <Spinner />
              <span className="activity__label">{busy}</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className={`composer${retired ? " composer--retired" : ""}`}>
        {/* Outside the switch below, always mounted: the permission card is for
            EVERY agent, and unmounting it while a retired thread is open would
            leave asks with no listener, denied unseen when they time out. */}
        <LocalAskCard />
        {/* A thread the agent reports ended or failed opens to READ (KYB-649):
            it cannot be continued, so the composer is not offered at all. */}
        {retired && agent ? (
          <div className="card stack-row" role="status">
            <span style={{ flex: 1 }} className="muted">
              This conversation has ended. You can read it, but it cannot be continued.
            </span>
            <button className="btn btn--primary" onClick={() => startConversation(agent.id)}>
              New conversation
            </button>
          </div>
        ) : (
        <>
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
        {voiceError ? <div className="composer__attach-error">{voiceError}</div> : null}
        {voice === "recording" ? (
          <div className="composer__voice">
            <span className="composer__voice-dot" />
            <span>Listening — click again to transcribe, Esc to discard</span>
            {/* The level is what tells someone the microphone is actually
                hearing them. Without it a muted input looks like silence. */}
            <span className="composer__voice-level">
              <span style={{ width: `${Math.min(100, Math.round(level * 140))}%` }} />
            </span>
          </div>
        ) : null}
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
              // The banner promises Esc discards the recording, so Esc must
              // mean that before anything else claims the key.
              if (e.key === "Escape" && voice === "recording") {
                e.preventDefault();
                cancelDictation();
                return;
              }
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
              // Recording: this click ends it and transcribes.
              else if (voice === "recording") void finishDictation();
              else if (draft.trim() || pending.length > 0) submit();
              // Empty composer and idle: this click starts recording.
              else if (voice === "idle") void startDictation();
            }}
          >
            {running ? (
              <Icon name="stop" />
            ) : voice === "transcribing" ? (
              <Spinner />
            ) : voice === "recording" ? (
              // A square, not a microphone: mid-recording the button's job is
              // to stop, and showing a mic there invites a second start.
              <Icon name="stop" />
            ) : (
              <Icon name={draft.trim() || pending.length > 0 ? "arrowUp" : "mic"} />
            )}
          </button>
          {voiceCapable ? (
          <button
            className="icon-btn"
            type="button"
            title={`Talk to ${agent?.name ?? "agent"} by voice`}
            disabled={!agent?.url}
            onClick={openOrb}
            style={{ alignSelf: "center", marginRight: 7, transform: "translateY(-1px)" }}
          >
            <span
              aria-hidden
              style={{
                display: "block",
                width: 30,
                height: 30,
                borderRadius: "50%",
                background:
                  "conic-gradient(from 0deg, oklch(75% 0.15 350), oklch(80% 0.12 200), oklch(78% 0.14 280), oklch(75% 0.15 350))",
                boxShadow: "0 0 4px rgba(147, 51, 234, 0.4)",
              }}
            />
          </button>
          ) : null}
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
        </>
        )}
      </div>
    </div>
  );
}
