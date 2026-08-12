import type { ReactNode } from "react";
import { useStore } from "@/lib/store";
import { Avatar, Icon, Toggle, timeLabel } from "./primitives";

/**
 * The agent panel: everything about THIS agent that is not the conversation.
 *
 * Overview is the landing view — what the agent is doing right now, what it
 * runs on a schedule, what it is connected to, and where it can be reached.
 * Each of those drills into a real editor, because a customer living in this
 * app must never be told to open a terminal to connect Gmail or add Slack.
 */

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

function Overview(): ReactNode {
  const {
    agents,
    activeAgentId,
    routines,
    channels,
    connections,
    setPanel,
    openRoutine,
    addRoutine,
    setPluginsOpen,
  } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;
  const mine = routines.filter((r) => r.agentId === agent.id);
  const activeChannels = channels.filter((c) => c.configured);

  return (
    <>
      <Head title={agent.name} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div className="screen-preview">Idle</div>
        <div className="panel__caption">{agent.name}&apos;s screen</div>

        <div className="panel__section-head">
          <span className="panel__section-title">Routines</span>
          <button className="topbar__btn" title="New routine" onClick={() => addRoutine(agent.id)}>
            <Icon name="plus" />
          </button>
        </div>
        {mine.length === 0 ? (
          <div className="muted" style={{ padding: "2px 8px 12px" }}>
            Recurring tasks this agent runs on a schedule.
          </div>
        ) : (
          mine.map((r) => (
            <button className="routine-row" key={r.id} onClick={() => openRoutine(r.id)}>
              <span className="routine-row__dot">
                <Icon name="clock" size={14} />
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div className="routine-row__name">{r.name}</div>
                <div className="routine-row__when">
                  {r.schedules[0] ?? "No schedule"}
                  {r.active ? "" : " · paused"}
                </div>
              </span>
            </button>
          ))
        )}

        <div className="panel__section-head" style={{ marginTop: 22 }}>
          <span className="panel__section-title">Connections</span>
          <button className="topbar__btn" title="Add a connection" onClick={() => setPluginsOpen(true)}>
            <Icon name="plus" />
          </button>
        </div>
        {connections.map((c) => (
          <button className="routine-row" key={c.id} onClick={() => setPluginsOpen(true)}>
            <span className="conn__icon" style={{ width: 26, height: 26, fontSize: 14 }}>
              {c.icon}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div className="routine-row__name">{c.name}</div>
              <div className="routine-row__when">
                {c.accounts.filter((a) => a.connected).length} of {c.accounts.length} accounts
                {c.toolCount ? ` · ${c.toolCount} tools` : ""}
              </div>
            </span>
          </button>
        ))}

        <div className="panel__section-head" style={{ marginTop: 22 }}>
          <span className="panel__section-title">Channels</span>
          <button className="topbar__btn" title="Add a channel" onClick={() => setPanel("channels")}>
            <Icon name="plus" />
          </button>
        </div>
        {activeChannels.map((c) => (
          <button className="routine-row" key={c.id} onClick={() => setPanel("channels")}>
            <span className="conn__icon" style={{ width: 26, height: 26, fontSize: 14 }}>
              {c.icon}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div className="routine-row__name">{c.label}</div>
              <div className="routine-row__when">{c.detail ?? "Connected"}</div>
            </span>
          </button>
        ))}

        <div style={{ marginTop: 22 }}>
          <button className="btn" style={{ width: "100%" }} onClick={() => setPanel("settings")}>
            Agent settings
          </button>
        </div>
      </div>
    </>
  );
}

function RoutineEditor(): ReactNode {
  const { routines, activeRoutineId, patchRoutine, deleteRoutine, setPanel } = useStore();
  const routine = routines.find((r) => r.id === activeRoutineId);
  if (!routine) return null;

  return (
    <>
      <Head title="Routine" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div className="stack-row" style={{ marginBottom: 18 }}>
          <Toggle on={routine.active} onChange={(on) => patchRoutine(routine.id, { active: on })} />
          <span style={{ flex: 1 }}>{routine.active ? "Active" : "Paused"}</span>
          <button className="btn" onClick={() => deleteRoutine(routine.id)}>
            Delete
          </button>
          <button className="btn btn--primary">Test run</button>
        </div>

        <div className="field">
          <div className="field__label">Name</div>
          <input
            className="input"
            value={routine.name}
            onChange={(e) => patchRoutine(routine.id, { name: e.target.value })}
          />
        </div>

        <div className="field">
          <div className="field__label">Instruction</div>
          <textarea
            className="textarea"
            style={{ minHeight: 150 }}
            value={routine.instruction}
            placeholder="What should this agent do, and what should it leave alone?"
            onChange={(e) => patchRoutine(routine.id, { instruction: e.target.value })}
          />
        </div>

        <div className="field">
          <div className="field__label">When to run</div>
          <div className="card">
            {routine.schedules.map((s) => (
              <div className="stack-row" key={s} style={{ marginBottom: 8 }}>
                <Icon name="clock" size={14} />
                <span>{s}</span>
              </div>
            ))}
            <button className="stack-row muted" style={{ gap: 7 }}>
              <Icon name="plus" size={13} /> Add another
            </button>
          </div>
        </div>

        <div className="field">
          <div className="field__label">Run history</div>
          {routine.runHistory.length === 0 ? (
            <div className="muted">Not run yet.</div>
          ) : (
            routine.runHistory.map((h) => (
              <div className="stack-row" key={h.at} style={{ padding: "5px 0" }}>
                <span style={{ flex: 1 }}>{timeLabel(h.at)}</span>
                <span style={{ color: h.ok ? "var(--accent-deep)" : "var(--danger)" }}>
                  <Icon name={h.ok ? "check" : "close"} size={13} />
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function Settings(): ReactNode {
  const { agents, activeAgentId, patchAgent, setPanel } = useStore();
  const agent = agents.find((a) => a.id === activeAgentId);
  if (!agent) return null;

  return (
    <>
      <Head title="Settings" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div style={{ display: "grid", placeItems: "center", padding: "6px 0 20px" }}>
          <Avatar name={agent.name} accent={agent.accent} size={62} />
        </div>

        <div className="field">
          <div className="field__label">Name</div>
          <input
            className="input"
            value={agent.name}
            onChange={(e) => patchAgent(agent.id, { name: e.target.value })}
          />
        </div>

        <div className="field">
          <div className="field__label">Title</div>
          <input
            className="input"
            value={agent.title ?? ""}
            placeholder="Describe what your agent does"
            onChange={(e) => patchAgent(agent.id, { title: e.target.value })}
          />
        </div>

        <div className="field">
          <div className="field__label">Description</div>
          <textarea
            className="textarea"
            value={agent.description ?? ""}
            onChange={(e) => patchAgent(agent.id, { description: e.target.value })}
          />
        </div>

        <div className="card stack-row">
          <div style={{ flex: 1 }}>
            <div>Notifications</div>
            <div className="muted">Get notified when this agent finishes or needs input</div>
          </div>
          <Toggle
            on={agent.notifications ?? false}
            onChange={(on) => patchAgent(agent.id, { notifications: on })}
          />
        </div>

        <div className="field" style={{ marginTop: 18 }}>
          <div className="field__label">Deployment</div>
          <div className="card">
            <div className="stack-row" style={{ marginBottom: 6 }}>
              <span style={{ flex: 1 }} className="muted">
                Host
              </span>
              <span style={{ fontSize: 12.5 }}>{new URL(agent.url).host}</span>
            </div>
            <div className="stack-row">
              <span style={{ flex: 1 }} className="muted">
                Status
              </span>
              <span style={{ fontSize: 12.5 }}>{agent.status ?? "unknown"}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function Channels(): ReactNode {
  const { channels, toggleChannel, setPanel } = useStore();
  return (
    <>
      <Head title="Channels" onBack={() => setPanel("overview")} onClose={() => setPanel("none")} />
      <div className="panel__body">
        <div className="muted" style={{ marginBottom: 14 }}>
          Where this agent can be reached, besides Studio. Adding one here configures it on the
          agent&apos;s own deployment.
        </div>
        {channels.map((c) => (
          <div className="routine-row" key={c.id}>
            <span className="conn__icon" style={{ width: 30, height: 30, fontSize: 15 }}>
              {c.icon}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div className="routine-row__name">{c.label}</div>
              <div className="routine-row__when">{c.detail ?? c.description}</div>
            </span>
            <button className="btn" onClick={() => toggleChannel(c.id)}>
              {c.configured ? "Manage" : "Add"}
            </button>
          </div>
        ))}
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
      {panel === "routine" ? <RoutineEditor /> : null}
      {panel === "settings" ? <Settings /> : null}
      {panel === "channels" ? <Channels /> : null}
    </aside>
  );
}
