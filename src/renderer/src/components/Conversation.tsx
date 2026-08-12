import { type ReactNode, useEffect, useRef, useState } from "react";
import type { Block, PeerEvent } from "@shared/types";
import { peerSummaryLabel, summarizePeerEvents } from "@shared/types";
import { useStore } from "@/lib/store";
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
function PeerActivity({ events }: { events: PeerEvent[] }): ReactNode {
  const [open, setOpen] = useState(false);
  const summary = summarizePeerEvents(events);
  if (!summary) return null;

  const peers =
    summary.kind === "single" ? [summary.peer] : summary.peers;

  return (
    <div className="peer">
      <button className="peer__summary" onClick={() => setOpen(!open)}>
        <span className={`peer__chev${open ? " peer__chev--open" : ""}`}>
          <Icon name="chevronRight" size={13} />
        </span>
        <span className="peer__stack">
          {peers.slice(0, 3).map((p) => (
            <Avatar key={p.id} name={p.name} accent={p.accent} size={17} />
          ))}
        </span>
        {peerSummaryLabel(summary)}
      </button>

      {open ? (
        <div className="peer__events">
          {events.map((e) => (
            <div className="peer__event" key={e.id}>
              <Avatar name={e.peer.name} accent={e.peer.accent} size={20} />
              <div className="peer__event-body">
                <div className="peer__event-head">
                  <span className="peer__event-name">{e.peer.name}</span>
                  <span className="peer__event-dir">
                    {e.direction === "inbound" ? "replied" : "asked"} · {timeLabel(e.at)}
                  </span>
                </div>
                <div className="peer__event-text">{e.text}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
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
  const blocks = conversations[activeAgentId] ?? [];
  const [draft, setDraft] = useState("");
  const [acCursor, setAcCursor] = useState(0);
  const [folderMenu, setFolderMenu] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [blocks.length, activeAgentId]);

  useEffect(() => {
    void loadAgentInfo(activeAgentId);
  }, [activeAgentId, loadAgentInfo]);

  const busy = activity[activeAgentId] ?? null;
  const model = models[activeAgentId];
  // A turn in flight, which is a stronger fact than an activity label: the
  // label goes quiet between steps, but the session is still not accepting.
  const running = Boolean(inflight[activeAgentId]);
  const waiting = queued[activeAgentId]?.length ?? 0;


  // A trigger only counts at the start of a word, so an email address does not
  // open the connector menu halfway through typing it.
  const trigger = /(?:^|\s)([/@])([\w-]*)$/.exec(draft);
  const triggerChar = trigger?.[1] ?? null;
  const triggerTerm = (trigger?.[2] ?? "").toLowerCase();

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
    return [...fromRoutines, ...fromConnections, ...fromTools].slice(0, 8);
  })();

  const applySuggestion = (s: Suggestion): void => {
    if (s.type === "Action") {
      setDraft(draft.replace(/(?:^|\s)[/@][\w-]*$/, "").trimEnd());
      if (s.id === "act:plugins") setPluginsOpen(true);
      else if (s.id === "act:channels") setPanel("channels");
      else setPanel("settings");
      return;
    }
    const token = `${triggerChar ?? ""}${s.title} `;
    setDraft(draft.replace(/([/@])[\w-]*$/, "") .replace(/([/@])$/, "") + token);
    setAcCursor(0);
  };

  if (!agent) return <div className="main" />;

  const submit = (): void => {
    const text = draft.trim();
    if (!text) return;
    send(agent.id, text);
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  return (
    <div className="main">
      <div className="topbar">
        <Avatar name={agent.name} accent={agent.accent} size={22} />
        <span className="topbar__title">{agent.name}</span>
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

      <div className="thread">
        <div className="thread__inner">
          {blocks.map((b) => {
            if (b.kind === "peer-activity") return <PeerActivity key={b.id} events={b.events} />;
            if (b.kind === "connection") return <ConnectionCard key={b.id} block={b} />;
            if (b.kind === "question")
              return (
                <QuestionCard
                  key={b.id}
                  block={b}
                  onAnswer={(answer) => answerQuestion(activeAgentId, b.id, answer)}
                />
              );
            return (
              <div key={b.id} className={`bubble bubble--${b.role}`}>
                {b.role === "agent" ? <Markdown text={b.text} /> : <RichText text={b.text} />}
              </div>
            );
          })}
          {blocks.length === 0 ? (
            <div className="empty">No messages yet. Say hello to {agent.name}.</div>
          ) : null}
          {busy ? (
            <div className="activity">
              <Spinner />
              <span className="activity__label">{busy}</span>
            </div>
          ) : null}
          <div ref={endRef} />
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
        <div className="composer__inner">
          <button className="icon-btn" title="Attach">
            <Icon name="plus" />
          </button>
          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            placeholder={`Message ${agent.name}`}
            onChange={(e) => {
              setDraft(e.target.value);
              const el = e.target;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
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
                  setDraft(draft.replace(/([/@])[\w-]*$/, ""));
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
              if (running) stopTurn(activeAgentId);
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
