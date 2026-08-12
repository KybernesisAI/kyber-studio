import type { ReactNode } from "react";
import { useStore } from "@/lib/store";
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
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  onClick?: () => void;
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
  return onClick ? (
    <button className="routine-row" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="routine-row">{body}</div>
  );
}

/** Distinguishes "not asked yet" from "the agent has none". */
function Empty({ loaded, none }: { loaded: boolean; none: string }): ReactNode {
  return <div className="muted" style={{ padding: "2px 8px 6px" }}>{loaded ? none : "Loading…"}</div>;
}

function Overview(): ReactNode {
  const { agents, activeAgentId, details, models, setPanel, openRoutine } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  const info = details[activeAgentId];
  const loaded = Boolean(info);
  if (!agent) return null;

  const schedules = info?.schedules ?? [];
  const connections = info?.connections ?? [];
  const channels = info?.channels ?? [];
  const skills = info?.skills ?? [];
  const subagents = info?.subagents ?? [];
  const authored = (info?.tools ?? []).filter((t) => t.origin !== "framework");

  return (
    <>
      <Head title={agent.name} onClose={() => setPanel("none")} />
      <div className="panel__body">
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

        <Section title="Routines" count={loaded ? schedules.length : undefined}>
          {schedules.length === 0 ? (
            <Empty loaded={loaded} none="This agent runs nothing on a schedule." />
          ) : (
            schedules.map((s) => (
              <Row
                key={s.name}
                icon={<Icon name="clock" size={14} />}
                title={s.name}
                detail={`${s.cron ?? "no cron"}${s.hasRun ? "" : " · never run"}`}
                onClick={() => openRoutine(s.name)}
              />
            ))
          )}
        </Section>

        <Section title="Connections" count={loaded ? connections.length : undefined}>
          {connections.length === 0 ? (
            <Empty loaded={loaded} none="No external systems connected." />
          ) : (
            connections.map((c) => (
              <Row
                key={c.connectionName}
                icon={<Icon name="plug" size={14} />}
                title={c.connectionName}
                detail={c.description}
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

        {subagents.length > 0 ? (
          <Section title="Subagents" count={subagents.length}>
            {subagents.map((s) => (
              <Row
                key={s.name}
                icon={<Icon name="package" size={14} />}
                title={s.name}
                detail={
                  s.description ??
                  `${s.summary?.tools ?? 0} tools · ${s.summary?.skills ?? 0} skills`
                }
              />
            ))}
          </Section>
        ) : null}

        <Section title="Skills" count={loaded ? skills.length : undefined}>
          {skills.length === 0 ? (
            <Empty loaded={loaded} none="No skills installed." />
          ) : (
            skills.map((s) => (
              <Row key={s.name} icon={<Icon name="package" size={14} />} title={s.name} detail={s.description} />
            ))
          )}
        </Section>

        <Section title="Tools" count={loaded ? authored.length : undefined}>
          {authored.length === 0 ? (
            <Empty loaded={loaded} none="No authored tools." />
          ) : (
            authored.map((t) => (
              <Row key={t.name} icon={<Icon name="gear" size={14} />} title={t.name} detail={t.description} />
            ))
          )}
        </Section>

        <div style={{ marginTop: 20 }}>
          <button className="btn" style={{ width: "100%" }} onClick={() => setPanel("settings")}>
            Agent settings
          </button>
        </div>
      </div>
    </>
  );
}

/** A schedule, as the agent reports it. Read-only — eve exposes no way to edit. */
function RoutineView(): ReactNode {
  const { details, activeAgentId, activeRoutineId, setPanel } = useStore();
  const schedule = (details[activeAgentId]?.schedules ?? []).find((s) => s.name === activeRoutineId);
  if (!schedule) return null;

  return (
    <>
      <Head title="Routine" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div className="field">
          <div className="field__label">Name</div>
          <div className="card">{schedule.name}</div>
        </div>
        <div className="field">
          <div className="field__label">When it runs</div>
          <div className="card" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
            {schedule.cron ?? "—"}
          </div>
        </div>
        {schedule.markdown ? (
          <div className="field">
            <div className="field__label">Instruction</div>
            <div className="card" style={{ whiteSpace: "pre-wrap" }}>{schedule.markdown}</div>
          </div>
        ) : null}
        <div className="field">
          <div className="field__label">Status</div>
          <div className="card">{schedule.hasRun ? "Has run before" : "Has never run"}</div>
        </div>
        <div className="muted">
          Read-only. Schedules are defined in the agent's own repository — eve exposes them here but
          offers no way to change them from a client.
        </div>
      </div>
    </>
  );
}

function Settings(): ReactNode {
  const { agents, activeAgentId, patchAgent, setPanel, details, models } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  const info = details[activeAgentId];
  if (!agent) return null;

  return (
    <>
      <Head title="Settings" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div style={{ display: "grid", placeItems: "center", padding: "6px 0 20px" }}>
          <Avatar name={agent.name} accent={agent.accent} size={62} />
        </div>

        <div className="field">
          <div className="field__label">Display name (this app only)</div>
          <input
            className="input"
            value={agent.name}
            onChange={(e) => patchAgent(agent.id, { name: e.target.value })}
          />
        </div>

        <div className="card stack-row">
          <div style={{ flex: 1 }}>
            <div>Notifications</div>
            <div className="muted">Not wired up yet</div>
          </div>
          <Toggle
            on={agent.notifications ?? false}
            onChange={(on) => patchAgent(agent.id, { notifications: on })}
          />
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
  if (panel === "none") return null;
  return (
    <aside className="panel">
      {panel === "overview" ? <Overview /> : null}
      {panel === "routine" ? <RoutineView /> : null}
      {panel === "settings" || panel === "channels" ? <Settings /> : null}
    </aside>
  );
}
