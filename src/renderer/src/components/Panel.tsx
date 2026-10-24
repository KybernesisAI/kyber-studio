import type { ReactNode } from "react";
import { ComputerCard } from "./Computer";
import { VaultView } from "./Vault";
import { isImage, toAvatarDataUrl } from "../lib/avatarImage";
import { useEffect, useState, useRef } from "react";
import {
  DEFAULT_SPEC,
  FREQUENCIES,
  type ScheduleSpec,
  WEEKDAYS,
  describeCron,
  timeOptions,
  toCron,
} from "@/lib/schedule";
import { isRetired, threadFilterFor, useStore, type AgentSession, type PanelView, type ThreadFilter } from "@/lib/store";
import type { ArtifactSummary } from "@shared/artifacts";
import type { LocalAction, LocalPermission } from "@shared/ipc";
import { Avatar, Icon, Toggle } from "./primitives";

/**
 * The agent panel: everything about THIS agent that is not the conversation.
 *
 * Every section here is read from the agent's own /eve/v1/info — its real
 * schedules, connections, channels, skills, tools, and subagents. Nothing is
 * seeded. Where the agent reports nothing, the panel says so; where we have not
 * asked yet, it says that instead. Those are different states and showing one
 * as the other is how a console starts lying to its operator.
 *
 * Editing is deliberately absent: eve exposes this information read-only, and a
 * Save button with nowhere to POST would be worse than no button.
 */

/**
 * Never throws.
 *
 * `new URL()` rejects anything that is not an absolute URL, and a control-plane
 * record can legitimately hold a bare host or a daemon endpoint. A panel must
 * not be able to take the whole renderer down because an agent was registered
 * with an odd URL — showing the raw value is a fine answer; a white window is
 * not.
 */
function hostOf(url?: string): string {
  if (!url) return "—";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Head({
  title,
  onBack,
  onClose,
}: {
  title: string;
  onBack?: () => void;
  onClose(): void;
}): ReactNode {
  return (
    <div className="panel__head">
      {onBack ? (
        <button className="topbar__btn" onClick={onBack} style={{ WebkitAppRegion: "no-drag" } as never}>
          <Icon name="chevronLeft" />
        </button>
      ) : (
        <span style={{ width: 28 }} />
      )}
      <span className="panel__title">{title}</span>
      <button className="topbar__btn" onClick={onClose} style={{ WebkitAppRegion: "no-drag" } as never}>
        <Icon name="close" />
      </button>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}): ReactNode {
  return (
    <>
      <div className="panel__section-head" style={{ marginTop: 20 }}>
        <span className="panel__section-title">{title}</span>
        {count != null ? <span className="muted">{count}</span> : null}
      </div>
      {children}
    </>
  );
}

function Row({
  icon,
  title,
  detail,
  onClick,
  active,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  onClick?: () => void;
  active?: boolean;
}): ReactNode {
  const body = (
    <>
      <span className="routine-row__dot">{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <div className="routine-row__name">{title}</div>
        {detail ? <div className="routine-row__when">{detail}</div> : null}
      </span>
    </>
  );
  const cls = `routine-row${active ? " routine-row--active" : ""}`;
  return onClick ? (
    <button className={cls} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

const SURFACE_LABEL: Record<string, string> = { chat: "Chat", routines: "Routines", imessage: "iMessage", buzz: "Buzz", api: "API" };

function whenShort(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return "";
  const diff = Date.now() - t;
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The compact entry in the drawer: the routines feed (one tap, it is the thing
 * people look for most) and a door to the full list. The list itself lives in
 * its own drawer so the overview stays an overview.
 */
function ConversationsEntry(): ReactNode {
  const { activeAgentId, sessions, agentSessions, threadIndex, routinesSessions, openSession, loadSessions, setPanel, prefs } = useStore();
  const filter = threadFilterFor(prefs, activeAgentId);
  const list = asKnown(heldUnder(agentSessions[activeAgentId], filter), threadIndex[activeAgentId], filter);
  const current = sessions[activeAgentId];
  const routinesId = routinesSessions[activeAgentId];
  useEffect(() => {
    void loadSessions(activeAgentId);
  }, [activeAgentId, loadSessions]);
  const routines = list?.find((s) => s.id === routinesId || s.surface === "routines");
  const archived = new Set(prefs[activeAgentId]?.archived ?? []);
  const others = (list ?? []).filter((s) => s.id !== routines?.id && !archived.has(s.id));
  return (
    <Section title="Conversations">
      {routines ? (
        <Row
          icon={<Icon name="clock" size={14} />}
          title="Routines feed"
          detail={`${routines.routine ? `Last: ${routines.routine} · ` : ""}${whenShort(routines.updatedAt)}`}
          active={current === routines.id}
          onClick={() => {
            void openSession(activeAgentId, routines.id);
            setPanel("none");
          }}
        />
      ) : null}
      <Row
        icon={<Icon name="chevronRight" size={14} />}
        title="Show conversations"
        detail={
          list
            ? `${others.length} ${filter === "active" ? "active " : ""}thread${others.length === 1 ? "" : "s"} across this app, your phone and iMessage`
            : "Loading…"
        }
        onClick={() => setPanel("conversations")}
      />
    </Section>
  );
}

/**
 * The door to the Artifacts drawer, under Conversations. It asks the agent
 * nothing until opened: the list is per person and fetched fresh there.
 */
function ArtifactsEntry(): ReactNode {
  const setPanel = useStore((s) => s.setPanel);
  return (
    <Section title="Artifacts">
      <Row
        icon={<Icon name="page" size={14} />}
        title="Show artifacts"
        detail="Pages and documents this agent made for you"
        onClick={() => setPanel("artifacts")}
      />
    </Section>
  );
}

/**
 * Every artifact this agent made for the signed-in person, newest first.
 *
 * The agent answers only with that person's own (and, for someone who manages
 * it, what its routines made), so this drawer shows exactly what its routes
 * return. Opening one uses the same viewer as a card in the conversation, at
 * its latest version.
 */
function ArtifactsView(): ReactNode {
  const { activeAgentId, agents, setPanel, openArtifact } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  const [state, setState] = useState<{ list?: ArtifactSummary[]; error?: string } | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setState(null);
    if (!agent?.url) {
      setState({ error: "This agent has no address yet." });
      return;
    }
    void window.studio?.agentArtifacts({ url: agent.url }).then((r) => {
      if (live) setState(r.ok ? { list: r.artifacts ?? [] } : { error: r.error });
    });
    return () => {
      live = false;
    };
  }, [agent?.url, round]);

  return (
    <>
      <Head title="Artifacts" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div className="panel__section-head">
          <span className="panel__section-title">Made for you</span>
          {state?.list ? <span className="muted" style={{ marginRight: 8 }}>{state.list.length}</span> : null}
          <button className="btn btn--small" disabled={!state} onClick={() => setRound((n) => n + 1)}>
            Refresh
          </button>
        </div>
        {!state ? <Empty loaded={false} none="" /> : null}
        {state?.error ? <div className="muted" style={{ padding: "2px 8px 6px" }}>{state.error}</div> : null}
        {state?.list && state.list.length === 0 ? (
          <Empty loaded none="Nothing yet. Ask for a report, a dashboard or a plan, and it lands here." />
        ) : null}
        {state?.list?.map((a) => (
          <Row
            key={a.id}
            icon={<Icon name="page" size={14} />}
            title={a.title}
            detail={[a.format === "markdown" ? "Document" : "Page", a.version > 1 ? `v${a.version}` : null, whenShort(a.updatedAt)]
              .filter(Boolean)
              .join(" · ")}
            onClick={() => {
              // The page opens over the conversation, which is under the drawer.
              openArtifact(activeAgentId, a.id, a.title);
              setPanel("none");
            }}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Every conversation this agent has had — this app's, the phone's, iMessage,
 * Buzz — in its own drawer. The chat shows one at a time; this is how you get
 * to the others, which until now sat on the agent's disk with no door.
 */
function ConversationsView(): ReactNode {
  const {
    agents,
    activeAgentId,
    sessions,
    agentSessions,
    threadIndex,
    routinesSessions,
    openSession,
    startConversation,
    loadSessions,
    inflight,
    setPanel,
    prefs,
    setThreadFilter,
    archiveThread,
    unarchiveThread,
  } = useStore();
  const filter = threadFilterFor(prefs, activeAgentId);
  const list = asKnown(heldUnder(agentSessions[activeAgentId], filter), threadIndex[activeAgentId], filter);
  const current = sessions[activeAgentId];
  const routinesId = routinesSessions[activeAgentId];
  const [showArchived, setShowArchived] = useState(false);
  // The thread an End confirmation was opened for, described as it was then.
  const [ending, setEnding] = useState<EndTarget | null>(null);
  useEffect(() => {
    void loadSessions(activeAgentId);
    setShowArchived(false);
    setEnding(null);
  }, [activeAgentId, loadSessions]);
  const archivedIds = prefs[activeAgentId]?.archived ?? [];
  const archived = new Set(archivedIds);
  // Archived is the person's choice, held here; ended is the agent's report.
  // Archiving hides a thread whatever its status, and ending never archives.
  const others = (list ?? []).filter((s) => s.id !== routinesId && s.surface !== "routines" && !archived.has(s.id));
  const known = threadIndex[activeAgentId] ?? {};
  const toggleArchived = (): void => {
    // The archived list must name threads the current filter does not fetch —
    // an ended thread under Active — so it asks for all of them once.
    if (!showArchived) void loadSessions(activeAgentId, "all");
    setShowArchived(!showArchived);
  };
  const askEnd = (s: AgentSession): void => {
    const agentName = agents.find((a) => a.id === activeAgentId)?.name ?? "this agent";
    setEnding({
      agentId: activeAgentId,
      sessionId: s.id,
      agentName,
      thread: describeThread(useStore.getState(), activeAgentId, s.id),
    });
  };
  const busy = Boolean(inflight[activeAgentId]);
  // The drawer lies over the conversation, so it gets out of the way of the
  // thread just picked rather than stepping back to the overview on top of it.
  const pick = (id: string) => {
    void openSession(activeAgentId, id);
    setPanel("none");
  };
  return (
    <>
      <Head title="Conversations" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <Row
          icon={<Icon name="plus" size={14} />}
          title="New conversation"
          detail={busy ? "Wait for the current turn to finish" : "Leaves this thread where it is; the next message starts a fresh one."}
          onClick={
            busy
              ? undefined
              : () => {
                  startConversation(activeAgentId);
                  setPanel("none");
                }
          }
        />
        <div className="panel__section-head" style={{ marginTop: 16 }}>
          <span className="panel__section-title">Threads</span>
          {list ? <span className="muted" style={{ marginRight: 8 }}>{others.length}</span> : null}
          <div className="thread-filter" role="group" aria-label="Which threads to show">
            {THREAD_FILTERS.map(([value, label]) => (
              <button
                key={value}
                className={`tab${filter === value ? " tab--on" : ""}`}
                aria-pressed={filter === value}
                onClick={() => setThreadFilter(activeAgentId, value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {list === undefined ? <Empty loaded={false} none="" /> : null}
        {list && others.length === 0 && filter === "all" ? <Empty loaded none="No conversations yet." /> : null}
        {list && others.length === 0 && filter === "active" ? (
          <>
            <Empty loaded none="No active conversations. Finished ones are under All." />
            <button className="btn" style={{ width: "100%", marginTop: 4 }} onClick={() => setThreadFilter(activeAgentId, "all")}>
              Show all conversations
            </button>
          </>
        ) : null}
        {others.map((s) =>
          ending?.sessionId === s.id && ending.agentId === activeAgentId ? (
            <EndConversationConfirm key={s.id} target={ending} onDone={() => setEnding(null)} />
          ) : (
            <ThreadRow
              key={s.id}
              thread={s}
              active={current === s.id}
              onPick={() => pick(s.id)}
              actions={
                <>
                  {s.status === "alive" ? (
                    <button className="btn btn--small" onClick={() => askEnd(s)} aria-label={`End ${s.title}`}>
                      End…
                    </button>
                  ) : null}
                  <button className="btn btn--small" onClick={() => archiveThread(activeAgentId, s.id)} aria-label={`Archive ${s.title}`}>
                    Archive
                  </button>
                </>
              }
            />
          ),
        )}

        <div className="panel__section-head" style={{ marginTop: 16 }}>
          <span className="panel__section-title">Archived</span>
          <span className="muted" style={{ marginRight: 8 }}>{archivedIds.length}</span>
          <button className="btn btn--small" onClick={toggleArchived} aria-pressed={showArchived}>
            {showArchived ? "Hide archived" : "Show archived"}
          </button>
        </div>
        {showArchived && archivedIds.length === 0 ? <Empty loaded none="Nothing archived. Archiving hides a thread here and leaves it untouched on the agent." /> : null}
        {showArchived
          ? archivedIds.map((id) => {
              const s: AgentSession = known[id] ?? {
                id,
                title: "A conversation not listed by the agent right now",
                surface: "chat",
                trigger: "",
                status: "alive",
                createdAt: "",
                updatedAt: "",
              };
              return (
                <ThreadRow
                  key={id}
                  thread={s}
                  unknown={!known[id]}
                  active={current === id}
                  onPick={() => pick(id)}
                  actions={
                    <button className="btn btn--small" onClick={() => unarchiveThread(activeAgentId, id)} aria-label={`Unarchive ${s.title}`}>
                      Unarchive
                    </button>
                  }
                />
              );
            })
          : null}
      </div>
    </>
  );
}

const THREAD_FILTERS: ReadonlyArray<readonly [ThreadFilter, string]> = [
  ["active", "Active"],
  ["all", "All"],
];

/**
 * The held list, if it was fetched under the filter now chosen. Otherwise
 * undefined, which reads as "Loading…" until the new request answers: a list
 * fetched as All must not be shown under Active (KYB-646).
 */
function heldUnder<T>(held: { filter: ThreadFilter; sessions: T[] } | undefined, filter: ThreadFilter): T[] | undefined {
  return held?.filter === filter ? held.sessions : undefined;
}

/**
 * A listing as this client knows it (KYB-649, AC9). A thread ended from here
 * stays ended even when the agent's list has not caught up yet — retirement
 * is terminal — and the Active list drops it. Without this an End stayed
 * invisible, and End… stayed offered, until the next refresh found the agent
 * current.
 */
function asKnown(
  list: AgentSession[] | undefined,
  known: Record<string, AgentSession> | undefined,
  filter: ThreadFilter,
): AgentSession[] | undefined {
  if (!list) return list;
  const out = list.map((s) => {
    const k = known?.[s.id];
    return isRetired(k) && !isRetired(s) ? { ...s, status: k!.status } : s;
  });
  return filter === "active" ? out.filter((s) => !isRetired(s)) : out;
}

/** Distinguishes "not asked yet" from "the agent has none". */
function Empty({ loaded, none }: { loaded: boolean; none: string }): ReactNode {
  return <div className="muted" style={{ padding: "2px 8px 6px" }}>{loaded ? none : "Loading…"}</div>;
}

/** One thread in the drawer: pick it to read it, with its own actions beside it. */
function ThreadRow({
  thread: s,
  active,
  unknown,
  onPick,
  actions,
}: {
  thread: AgentSession;
  active: boolean;
  unknown?: boolean;
  onPick: () => void;
  actions: ReactNode;
}): ReactNode {
  // A retired thread says so on its row, and never as an error: most of an
  // owner's history was ended by a routine upgrade, not by anything they did.
  const detail = unknown
    ? "Not in the agent's current list"
    : `${SURFACE_LABEL[s.surface] ?? s.surface}${s.channel ? ` · ${s.channel}` : ""} · ${whenShort(s.updatedAt)}${s.status === "alive" ? "" : " · ended"}`;
  return (
    <div className="thread-row" style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Row icon={<Icon name="monitor" size={14} />} title={s.title} detail={detail} active={active} onClick={onPick} />
      </div>
      {actions}
    </div>
  );
}

/** A confirmation's target: the thread, described once, when it opened. */
type EndTarget = { agentId: string; sessionId: string; agentName: string; thread: ReturnType<typeof describeThread> };

/**
 * What the End confirmation says about a thread: its title (or its last
 * message), when it was last active, and whether the agent still lists it as
 * alive. A thread the agent has not listed yet is treated as alive, so the
 * cross-surface warning is shown rather than silently left out.
 */
export function describeThread(
  state: Pick<ReturnType<typeof useStore.getState>, "agentSessions" | "threadIndex" | "conversations" | "sessions">,
  agentId: string,
  sessionId: string,
): { name: string; lastActive: string; alive: boolean } {
  const listed =
    state.threadIndex[agentId]?.[sessionId] ?? state.agentSessions[agentId]?.sessions.find((s) => s.id === sessionId);
  // Only the transcript on screen belongs to this thread; another one's would misname it.
  const blocks = state.sessions[agentId] === sessionId ? (state.conversations[agentId] ?? []) : [];
  const last = [...blocks]
    .reverse()
    .find((b) => b.kind === "text" && typeof (b as { text?: unknown }).text === "string" && (b as { text: string }).text.trim()) as
    | { text: string; at?: number }
    | undefined;
  const fromTranscript = last ? (last.text.length > 80 ? `${last.text.slice(0, 80)}…` : last.text) : "This conversation";
  if (listed) {
    return { name: listed.title?.trim() || fromTranscript, lastActive: whenShort(listed.updatedAt), alive: listed.status === "alive" };
  }
  const lastActive = last?.at ? whenShort(new Date(last.at).toISOString()) : "";
  return { name: fromTranscript, lastActive, alive: true };
}

/** Fixed until the agent reports which surface a thread belongs to (KYB-645). */
export const END_CROSS_SURFACE_LINE = "If this conversation is also open in Buzz, iMessage or on your phone, it ends there too.";

/**
 * Confirm ending ONE named conversation. It ends `target.sessionId` — the
 * thread shown when this opened — and nothing else. Never says "delete": the
 * conversation stays stored and readable on the agent.
 */
function EndConversationConfirm({
  target,
  onDone,
}: {
  target: EndTarget;
  onDone: () => void;
}): ReactNode {
  const endConversation = useStore((s) => s.endConversation);
  // Described when the confirmation OPENED and never again: if the chat moves
  // to another thread meanwhile, this must still name the one it will end.
  const { thread } = target;
  return (
    <div className="card" role="alertdialog" aria-label="End this conversation?">
      <div style={{ marginBottom: 6 }}>End this conversation with {target.agentName}?</div>
      <div style={{ marginBottom: 6 }}>
        <strong>{thread.name}</strong>
        {thread.lastActive ? <span className="muted"> · last active {thread.lastActive}</span> : null}
      </div>
      <div className="muted" style={{ marginBottom: 6 }}>
        It stays stored and you can still read it, but it cannot be continued, and the agent loses its working memory of it.
      </div>
      {thread.alive ? (
        <div className="muted" style={{ marginBottom: 10 }}>
          {END_CROSS_SURFACE_LINE}
        </div>
      ) : null}
      <div className="stack-row">
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <div style={{ flex: 1 }} />
        <button
          className="btn btn--primary"
          onClick={() => {
            endConversation(target.agentId, target.sessionId);
            onDone();
          }}
        >
          End conversation
        </button>
      </div>
    </div>
  );
}

/** Create a routine that is actually written into the agent's repository. */
function NewRoutine(): ReactNode {
  const { activeAgentId, createSchedule, manageError } = useStore();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [spec, setSpec] = useState<ScheduleSpec>(DEFAULT_SPEC);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button className="btn" style={{ width: "100%", marginBottom: 8 }} onClick={() => setOpen(true)}>
        New routine
      </button>
    );
  }

  const cron = toCron(spec);
  const set = (patch: Partial<ScheduleSpec>): void => setSpec({ ...spec, ...patch });
  const needsTime = ["daily", "weekdays", "weekly", "monthly"].includes(spec.frequency);

  const submit = async (): Promise<void> => {
    if (!name.trim() || !instruction.trim() || !cron) return;
    setBusy(true);
    const ok = await createSchedule(activeAgentId, {
      name: name.trim(),
      cron,
      instruction: instruction.trim(),
    });
    setBusy(false);
    if (ok) {
      setOpen(false);
      setName("");
      setInstruction("");
    }
  };

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="field" style={{ marginBottom: 10 }}>
        <div className="field__label">Name</div>
        <input
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Morning digest"
        />
      </div>

      <div className="field" style={{ marginBottom: 10 }}>
        <div className="field__label">What should it do each time it runs?</div>
        <textarea
          className="textarea"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Skim my inbox and calendar and send me one short update."
        />
      </div>

      <div className="field" style={{ marginBottom: 8 }}>
        <div className="field__label">When to run</div>
        <div className="sched">
          <select
            className="input sched__freq"
            value={spec.frequency}
            onChange={(e) => set({ frequency: e.target.value as ScheduleSpec["frequency"] })}
          >
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>

          {spec.frequency === "hourly" ? (
            <select
              className="input"
              value={spec.minute}
              onChange={(e) => set({ minute: Number(e.target.value) })}
            >
              {[0, 15, 30, 45].map((m) => (
                <option key={m} value={m}>
                  at :{String(m).padStart(2, "0")}
                </option>
              ))}
            </select>
          ) : null}

          {spec.frequency === "weekly" ? (
            <select
              className="input"
              value={spec.weekday}
              onChange={(e) => set({ weekday: Number(e.target.value) })}
            >
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          ) : null}

          {spec.frequency === "monthly" ? (
            <select
              className="input"
              value={spec.day}
              onChange={(e) => set({ day: Number(e.target.value) })}
            >
              {/* 28 days, so the routine exists in February too. */}
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  day {d}
                </option>
              ))}
            </select>
          ) : null}

          {needsTime ? (
            <select
              className="input"
              value={`${spec.hour}:${spec.minute}`}
              onChange={(e) => {
                const [h, m] = e.target.value.split(":");
                set({ hour: Number(h), minute: Number(m) });
              }}
            >
              {timeOptions().map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          ) : null}

          {spec.frequency === "interval" ? (
            <select
              className="input"
              value={spec.everyMinutes}
              onChange={(e) => set({ everyMinutes: Number(e.target.value) })}
            >
              {[5, 10, 15, 30, 60, 120, 240, 360, 720].map((m) => (
                <option key={m} value={m}>
                  every {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
                </option>
              ))}
            </select>
          ) : null}

          {spec.frequency === "custom" ? (
            <input
              className="input"
              value={spec.cron}
              onChange={(e) => set({ cron: e.target.value })}
              placeholder="0 9 * * 1-5"
              style={{ fontFamily: "var(--font-mono)" }}
            />
          ) : null}
        </div>

        {/* Show what was built, in words and in cron. The sentence is what the
            user is agreeing to; the expression is what lands in their repo, and
            hiding it would make a reviewed file a surprise. */}
        <div className="muted" style={{ marginTop: 7 }}>
          {describeCron(cron)} <span style={{ fontFamily: "var(--font-mono)" }}>· {cron}</span>
        </div>
      </div>

      {manageError ? (
        <div className="muted" style={{ color: "var(--danger)", marginBottom: 8 }}>{manageError}</div>
      ) : null}

      <div className="stack-row">
        <button className="btn" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
          {busy ? "Writing…" : "Create"}
        </button>
      </div>
      <div className="muted" style={{ marginTop: 8 }}>
        Writes agent/schedules/&lt;name&gt;.ts in the agent&apos;s repo, rebuilds, and restarts it.
      </div>
    </div>
  );
}

function Overview(): ReactNode {
  const { agents, activeAgentId, details, models, setPanel, openRoutine, setPluginsOpen } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  const info = details[activeAgentId];
  const loaded = Boolean(info);
  if (!agent) return null;

  const schedules = info?.schedules ?? [];
  const channels = info?.channels ?? [];
  const subagents = info?.subagents ?? [];
  // From the control plane, not from the agent's own /info: an agent listing
  // its own permissions would be the agent grading its own homework.
  const peers = agent.peers ?? [];

  return (
    <>
      <Head title={agent.name} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
          <button className="btn" style={{ flex: 1 }} onClick={() => setPluginsOpen(true)}>
            Plugins
          </button>
          <button className="btn" style={{ flex: 1 }} onClick={() => setPanel("settings")}>
            Settings
          </button>
        </div>
        <div className="card" style={{ marginBottom: 4 }}>
          <div className="stack-row" style={{ marginBottom: 6 }}>
            <span style={{ flex: 1 }} className="muted">Host</span>
            <span style={{ fontSize: 12.5 }}>{hostOf(agent.url)}</span>
          </div>
          <div className="stack-row">
            <span style={{ flex: 1 }} className="muted">Model</span>
            <span style={{ fontSize: 12.5, fontFamily: "var(--font-mono)" }}>
              {models[activeAgentId] ?? "—"}
            </span>
          </div>
        </div>

        <ComputerCard />

        <ConversationsEntry />

        <ArtifactsEntry />

        <Section title="Routines" count={loaded ? schedules.length : undefined}>
          <NewRoutine />
          {schedules.length === 0 ? (
            <Empty loaded={loaded} none="This agent runs nothing on a schedule." />
          ) : (
            schedules.map((s) => (
              <Row
                key={s.name}
                icon={<Icon name="clock" size={14} />}
                title={s.name}
                detail={`${describeCron(s.cron)}${s.hasRun ? "" : " · never run"}`}
                onClick={() => openRoutine(s.name)}
              />
            ))
          )}
        </Section>

        <Section title="Channels" count={loaded ? channels.length : undefined}>
          {channels.length === 0 ? (
            <Empty loaded={loaded} none="Reachable only through this app." />
          ) : (
            channels.map((c) => (
              <Row
                key={c.name + (c.urlPath ?? "")}
                icon={<Icon name="monitor" size={14} />}
                title={c.name}
                detail={c.urlPath}
              />
            ))
          )}
        </Section>

        {/*
          Who this agent may call, straight from the control plane.

          Read-only on purpose. Granting an edge is a governance decision and it
          belongs in the admin, next to who may talk to the agent at all — a
          desktop app that could quietly widen an agent's reach would make the
          admin a place you consult rather than the place that decides. Showing
          it here still matters: when a delegation fails, the first question is
          whether the edge exists, and the answer should not require a browser.
        */}
        {peers.length > 0 ? (
          <Section title="Peers" count={peers.length}>
            {peers.map((p) => {
              const known = agents.find((a) => a.id === p.id || a.name === p.name);
              return (
                <Row
                  key={p.id}
                  icon={<Avatar name={p.name} accent={known?.accent ?? "#7c6cf0"} size={16} />}
                  title={p.name}
                  detail={p.purpose ?? "granted"}
                />
              );
            })}
          </Section>
        ) : null}

        {subagents.length > 0 ? (
          <Section title="Subagents" count={subagents.length}>
            {subagents.map((s) => (
              <Row
                key={s.name}
                icon={<Icon name="package" size={14} />}
                title={s.name}
                detail={s.description}
              />
            ))}
          </Section>
        ) : null}
      </div>
    </>
  );
}

/** A routine, with what it does and a way to stop it. */
function RoutineView(): ReactNode {
  const { details, activeAgentId, activeRoutineId, setPanel, deleteSchedule, manageError } =
    useStore();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const schedule = (details[activeAgentId]?.schedules ?? []).find((s) => s.name === activeRoutineId);
  if (!schedule) return null;

  const remove = async (): Promise<void> => {
    setBusy(true);
    const ok = await deleteSchedule(activeAgentId, schedule.name);
    setBusy(false);
    if (ok) setPanel("overview");
  };

  return (
    <>
      <Head title="Routine" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div className="field">
          <div className="field__label">Name</div>
          <div className="card">{schedule.name}</div>
        </div>

        <div className="field">
          <div className="field__label">What it does</div>
          <div className="card" style={{ whiteSpace: "pre-wrap" }}>
            {schedule.markdown?.trim() ? (
              schedule.markdown
            ) : (
              // Distinguish 'no instruction' from 'eve did not report one'.
              // Schedules authored as source may keep their prompt in a form the
              // info route does not surface, and saying nothing at all reads as
              // an empty routine.
              <span className="muted">
                The agent does not report an instruction for this routine. It is defined in{" "}
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  agent/schedules/{schedule.name}.ts
                </span>
                .
              </span>
            )}
          </div>
        </div>

        <div className="field">
          <div className="field__label">When it runs</div>
          <div className="card">
            {describeCron(schedule.cron)}
            <div className="muted" style={{ fontFamily: "var(--font-mono)", marginTop: 4 }}>
              {schedule.cron ?? "—"}
            </div>
          </div>
        </div>

        <div className="field">
          <div className="field__label">Status</div>
          <div className="card">{schedule.hasRun ? "Has run before" : "Has never run"}</div>
        </div>

        {manageError ? (
          <div className="muted" style={{ color: "var(--danger)", marginBottom: 10 }}>{manageError}</div>
        ) : null}

        {confirming ? (
          <div className="card">
            <div style={{ marginBottom: 10 }}>
              Remove this routine? The file is kept as{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {schedule.name}.ts.disabled
              </span>{" "}
              so it can be restored.
            </div>
            <div className="stack-row">
              <button className="btn" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </button>
              <div style={{ flex: 1 }} />
              <button className="btn btn--primary" onClick={() => void remove()} disabled={busy}>
                {busy ? "Removing…" : "Remove routine"}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn" style={{ width: "100%" }} onClick={() => setConfirming(true)}>
            Remove routine
          </button>
        )}

        <div className="muted" style={{ marginTop: 12 }}>
          Editing happens where the routine lives — ask the agent to change it, or edit{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>agent/schedules/{schedule.name}.ts</span>{" "}
          in its repository.
        </div>
      </div>
    </>
  );
}

/**
 * The standing answers already given to permission cards, and a way to change them.
 *
 * "Always allow" and "Never" are written to disk the moment they are chosen on
 * a card. The enforcement side has always been able to read and rewrite them;
 * only this screen was missing, so a person who clicked "always" once could
 * never see that they had, let alone take it back. These are per-computer, not
 * per-agent: the permission is about what may happen HERE.
 */
const LOCAL_ACTIONS: { action: LocalAction; label: string; detail: string }[] = [
  { action: "run-command", label: "Run commands", detail: "Shell commands in the working folder." },
  { action: "read-file", label: "Read files", detail: "Read a file from the working folder." },
  { action: "write-file", label: "Write files", detail: "Create or change a file there." },
  { action: "list-directory", label: "List folders", detail: "See what a folder contains." },
  { action: "local-mcp", label: "Use local services", detail: "Call an MCP server running on this computer." },
];

/**
 * What the permissions card says when a save is refused. Not the error itself,
 * which names the user's profile path and an IPC channel (KYB-641); that goes
 * to the log.
 */
export const PERMISSION_SAVE_FAILED_MESSAGE = "Couldn’t save that setting. Please try again.";

/** Exported so a test can mount it and drive a refused save (KYB-621). */
export function LocalPermissions(): ReactNode {
  const [perms, setPerms] = useState<Record<LocalAction, LocalPermission> | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.studio?.localPermissions().then((p) => live && setPerms(p));
    return () => {
      live = false;
    };
  }, []);

  const set = async (action: LocalAction, value: LocalPermission): Promise<void> => {
    // A save can fail (KYB-621: on Windows, whenever another process holds the
    // file). Unhandled, the select silently snapped back; say so instead, in
    // words a person can act on, and log the detail (KYB-641).
    try {
      const next = await window.studio?.setLocalPermission({ action, value });
      setSaveError(null);
      if (next) setPerms(next);
    } catch (error) {
      console.error(
        `[permissions] could not save ${action}: ${error instanceof Error ? error.message : String(error)}`,
      );
      setSaveError(PERMISSION_SAVE_FAILED_MESSAGE);
    }
  };

  if (!perms) return null;
  const standing = LOCAL_ACTIONS.filter((a) => perms[a.action] !== "ask").length;

  return (
    <div className="card">
      <div className="stack-row">
        <div style={{ flex: 1 }}>
          <div>What agents may do on this computer</div>
          <div className="muted">
            {standing === 0
              ? "Every one of these asks first. Answering “always” or “never” on a card is remembered here."
              : `${standing} of these no longer ask. Set one back to “Ask” to be prompted again.`}
          </div>
          {saveError ? <div className="muted" role="alert">{saveError}</div> : null}
        </div>
      </div>
      {LOCAL_ACTIONS.map((a) => (
        <div key={a.action} className="stack-row" style={{ marginTop: 10 }}>
          <div style={{ flex: 1 }}>
            <div>{a.label}</div>
            <div className="muted">{a.detail}</div>
          </div>
          <select
            className="input"
            style={{ maxWidth: 110 }}
            value={perms[a.action]}
            onChange={(e) => void set(a.action, e.target.value as LocalPermission)}
          >
            <option value="ask">Ask</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </div>
      ))}
    </div>
  );
}

/**
 * One switch for "this agent may work on this computer".
 *
 * Everything underneath it — minting the agent's credential, installing it,
 * recording the standing permission — happens between the control plane, this
 * app, and the agent. None of it is a step for the person, and the credential
 * is never shown, because a setup that asks someone to carry a secret between
 * two screens is a setup that will be done wrong or not at all.
 */
function LocalAccess({ agent, url }: { agent: string; url?: string }): ReactNode {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void window.studio?.localAccess(agent).then((v) => live && setOn(v));
    return () => {
      live = false;
    };
  }, [agent]);

  const toggle = async (next: boolean): Promise<void> => {
    if (!url) return;
    setBusy(true);
    setError(null);
    try {
      if (next) {
        const res = await window.studio!.provisionLocal({ url, agent });
        if (!res.ok) {
          setError(res.error ?? "Could not connect it to this computer.");
          return;
        }
        setOn(true);
      } else {
        await window.studio!.revokeLocal(agent);
        setOn(false);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack-row">
      <div style={{ flex: 1 }}>
        <div>Work on this computer</div>
        <div className="muted">
          {error
            ? error
            : busy
              ? "Setting it up…"
              : on
                ? "Allowed on this Mac. It stays allowed until you turn this off."
                : "Let this agent read and change files here, and run commands."}
        </div>
      </div>
      <Toggle on={on === true} onChange={(v) => void toggle(v)} />
    </div>
  );
}

function Settings(): ReactNode {
  const { agents, activeAgentId, patchAgent, setPanel, details, models, sessions } =
    useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  const info = details[activeAgentId];
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  // The thread the confirmation names, captured when it OPENS. Ending reads
  // this, never `sessions[…]` at the moment of confirming: adoption can change
  // the selected thread while the confirmation is open (KYB-649).
  const [ending, setEnding] = useState<EndTarget | null>(null);
  // Settings is not keyed by agent: a confirmation left open across an agent
  // switch would sit under the other agent's settings. It closes instead.
  useEffect(() => {
    setEnding((e) => (e && e.agentId !== activeAgentId ? null : e));
  }, [activeAgentId]);
  if (!agent) return null;

  return (
    <>
      <Head title="Settings" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div className="agent-portrait">
          <Avatar name={agent.name} accent={agent.accent} src={agent.avatar} size={62} />
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              // Cleared immediately so choosing the same file twice still fires.
              e.target.value = "";
              if (!file) return;
              if (!isImage(file)) {
                setAvatarError("That file is not an image.");
                return;
              }
              try {
                const dataUrl = await toAvatarDataUrl(file);
                patchAgent(agent.id, { avatar: dataUrl });
                setAvatarError(null);
              } catch (error) {
                setAvatarError((error as Error).message);
              }
            }}
          />
          <div className="agent-portrait__actions">
            <button className="btn btn--small" onClick={() => avatarInputRef.current?.click()}>
              {agent.avatar ? "Change picture" : "Upload picture"}
            </button>
            {agent.avatar ? (
              <button
                className="btn btn--small"
                // Back to the lettered mark rather than to nothing: an agent
                // always has an avatar, and this only chooses which kind.
                onClick={() => patchAgent(agent.id, { avatar: undefined })}
              >
                Remove
              </button>
            ) : null}
          </div>
          {avatarError ? <div className="agent-portrait__error">{avatarError}</div> : null}
        </div>

        <div className="field">
          <div className="field__label">Display name</div>
          <input
            className="input"
            value={agent.name}
            onChange={(e) => patchAgent(agent.id, { name: e.target.value })}
          />
        </div>

        <LocalAccess agent={info?.name ?? agent.name} url={agent.url} />

        <LocalPermissions />

        <div className="card stack-row">
          <div style={{ flex: 1 }}>
            <div>Vault</div>
            <div className="muted">
              This agent's own logins, cards and addresses, kept apart from every other agent's. It types them into pages on its computer without ever seeing them.
            </div>
          </div>
          <button className="btn" onClick={() => setPanel("vault")}>
            Open
          </button>
        </div>

        {ending && ending.agentId === activeAgentId ? (
          <EndConversationConfirm target={ending} onDone={() => setEnding(null)} />
        ) : (
          <div className="card stack-row">
            <div style={{ flex: 1 }}>
              <div>Current conversation</div>
              <div className="muted">
                {sessions[activeAgentId]
                  ? "Use this if replies stopped arriving — an agent that restarted mid-turn leaves a conversation that can never finish. You will be asked to confirm."
                  : "No conversation yet; the next message starts one."}
              </div>
            </div>
            <button
              className="btn"
              disabled={!sessions[activeAgentId]}
              onClick={() => {
                const sessionId = sessions[activeAgentId];
                if (!sessionId) return;
                setEnding({
                  agentId: activeAgentId,
                  sessionId,
                  agentName: agent.name,
                  thread: describeThread(useStore.getState(), activeAgentId, sessionId),
                });
              }}
            >
              End this conversation
            </button>
          </div>
        )}

        <div className="card stack-row">
          <div style={{ flex: 1 }}>
            <div>Notifications</div>
            <div className="muted">When it needs your answer, or finishes while you are elsewhere.</div>
          </div>
          <Toggle
            on={agent.notifications ?? false}
            onChange={(on) => patchAgent(agent.id, { notifications: on })}
          />
        </div>

        <div className="card stack-row">
          <div style={{ flex: 1 }}>
            <div>Voice</div>
            <div className="muted">The spoken voice for this agent's floating voice orb.</div>
          </div>
          <select
            className="input"
            style={{ maxWidth: 220 }}
            value={agent.voice ?? "marin"}
            onChange={(e) => patchAgent(agent.id, { voice: e.target.value })}
          >
            {/* Every voice the Live API accepts, in OpenAI's order of preference;
                marin and cedar are the two it recommends for quality. There is no
                endpoint that reports them, so this list is held here and on the phone. */}
            {["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"].map((v) => (
              <option key={v} value={v}>
                {v === "marin" || v === "cedar" ? `${v} — recommended` : v}
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ marginTop: 18 }}>
          <div className="field__label">Reported by the agent</div>
          <div className="card">
            <div className="stack-row" style={{ marginBottom: 6 }}>
              <span style={{ flex: 1 }} className="muted">Name</span>
              <span style={{ fontSize: 12.5 }}>{info?.name ?? "—"}</span>
            </div>
            <div className="stack-row" style={{ marginBottom: 6 }}>
              <span style={{ flex: 1 }} className="muted">Model</span>
              <span style={{ fontSize: 12.5, fontFamily: "var(--font-mono)" }}>
                {models[activeAgentId] ?? "—"}
              </span>
            </div>
            <div className="stack-row">
              <span style={{ flex: 1 }} className="muted">Host</span>
              <span style={{ fontSize: 12.5 }}>{hostOf(agent.url)}</span>
            </div>
          </div>
        </div>

        <div className="muted" style={{ marginTop: 14 }}>
          An agent&apos;s identity, instructions, and capabilities live in its own repository. This
          panel reports them; it does not change them.
        </div>
      </div>
    </>
  );
}

export function Panel(): ReactNode {
  const panel = useStore((s) => s.panel);
  const setPanel = useStore((s) => s.setPanel);
  /**
   * The view being shown, which lags the store while the drawer closes.
   *
   * A component that unmounts cannot animate: the moment `panel` becomes
   * "none" the element is gone, and any exit animation is attached to
   * something that no longer exists. So the last real view is held for the
   * length of the animation, and only then released.
   */
  const [shown, setShown] = useState<PanelView>(panel);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (panel !== "none") {
      setClosing(false);
      setShown(panel);
      return;
    }
    if (shown === "none") return;
    setClosing(true);
    const timer = setTimeout(() => {
      setClosing(false);
      setShown("none");
    }, 150);
    return () => clearTimeout(timer);
  }, [panel, shown]);

  // Escape closes the drawer, as it closes every other thing laid over the
  // conversation. Anything above the drawer (a modal, the palette, the
  // computer) has the key first, so it is left alone while one is open.
  useEffect(() => {
    if (panel === "none") return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (useStore.getState().paletteOpen) return;
      if (document.querySelector(".scrim, .computer-view")) return;
      setPanel("none");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, setPanel]);

  if (shown === "none") return null;
  return (
    <>
      <div className={`panel-scrim${closing ? " panel-scrim--closing" : ""}`} onClick={() => setPanel("none")} />
      <aside className={`panel${closing ? " panel--closing" : ""}`}>
        {/* Gated on `shown`, not `panel`: `panel` is already "none" while the
            drawer animates out, so gating on it blanked the contents instantly
            and slid an empty box off screen — defeating the very hold above. */}
        {shown === "overview" ? <Overview /> : null}
        {shown === "routine" ? <RoutineView /> : null}
        {shown === "settings" ? <Settings /> : null}
        {shown === "vault" ? <VaultView /> : null}
        {shown === "conversations" ? <ConversationsView /> : null}
        {shown === "artifacts" ? <ArtifactsView /> : null}
      </aside>
    </>
  );
}
