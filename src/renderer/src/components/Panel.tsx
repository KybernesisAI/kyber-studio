import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  DEFAULT_SPEC,
  FREQUENCIES,
  type ScheduleSpec,
  WEEKDAYS,
  describeCron,
  timeOptions,
  toCron,
} from "@/lib/schedule";
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

        <div style={{ marginTop: 20, display: "flex", gap: 8 }}>
          <button className="btn" style={{ flex: 1 }} onClick={() => setPluginsOpen(true)}>
            Plugins
          </button>
          <button className="btn" style={{ flex: 1 }} onClick={() => setPanel("settings")}>
            Settings
          </button>
        </div>
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
  const { agents, activeAgentId, patchAgent, setPanel, details, models, resetConversation, sessions } =
    useStore();
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

        <LocalAccess agent={info?.name ?? agent.name} url={agent.url} />

        <div className="card stack-row">
          <div style={{ flex: 1 }}>
            <div>Start a fresh conversation</div>
            <div className="muted">
              {sessions[activeAgentId]
                ? "Retires the agent's current session. Use this if replies stopped arriving — an agent that restarted mid-turn leaves a session that can never finish."
                : "No session yet; the next message starts one."}
            </div>
          </div>
          <button
            className="btn"
            disabled={!sessions[activeAgentId]}
            onClick={() => resetConversation(activeAgentId)}
          >
            Reset
          </button>
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
