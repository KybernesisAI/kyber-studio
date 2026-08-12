import { type ReactNode, useState } from "react";
import { useStore } from "@/lib/store";
import { Icon } from "./primitives";

/**
 * The plugin marketplace.
 *
 * A customer adds capabilities to their agent here — this is the reason Studio
 * is a console and not just a chat window. "Yours" is the honest counterpart to
 * a marketplace: what is actually installed on this agent right now, so nobody
 * has to infer their own configuration from a list of everything available.
 */
export function Plugins(): ReactNode {
  const { details, activeAgentId, agents, pluginsOpen, setPluginsOpen } = useStore();
  const [q, setQ] = useState("");
  if (!pluginsOpen) return null;

  const info = details[activeAgentId];
  const agent = agents.find((a) => a.id === activeAgentId);
  const query = q.trim().toLowerCase();
  const match = (t: string): boolean => !query || t.toLowerCase().includes(query);

  const connections = (info?.connections ?? []).filter((c) => match(c.name));
  const skills = (info?.skills ?? []).filter((s) => match(s.name));
  const tools = (info?.tools ?? []).filter((t) => match(t.name));
  const nothing = connections.length + skills.length + tools.length === 0;

  const group = (
    label: string,
    items: { key: string; title: string; detail?: string }[],
  ): ReactNode =>
    items.length === 0 ? null : (
      <div key={label}>
        <div className="group-label">
          {label} · {items.length}
        </div>
        <div className="plugin-grid">
          {items.map((i) => (
            <div className="plugin-row" key={i.key}>
              <span className="conn__icon" style={{ width: 30, height: 30, fontSize: 14 }}>
                <Icon name="plug" size={14} />
              </span>
              <div className="plugin-row__body">
                <div className="plugin-row__name">{i.title}</div>
                <div className="plugin-row__desc">{i.detail ?? ""}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );

  return (
    <div className="scrim" onClick={() => setPluginsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">{agent?.name ?? "Agent"} capabilities</span>
          <button className="topbar__btn" onClick={() => setPluginsOpen(false)}>
            <Icon name="close" />
          </button>
        </div>

        <div className="modal__tabs">
          <span className="muted" style={{ flex: 1 }}>
            What this agent can reach, as it reports itself
          </span>
          <label className="search" style={{ width: 240 }}>
            <Icon name="search" size={14} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search capabilities"
              spellCheck={false}
            />
          </label>
        </div>

        <div className="modal__body">
          {!info ? (
            <div className="empty">Loading from the agent…</div>
          ) : nothing ? (
            <div className="empty">
              {query ? `Nothing matches "${q}".` : "This agent reports no connections, skills, or authored tools."}
            </div>
          ) : (
            <>
              {group(
                "Connections",
                connections.map((c) => ({ key: c.name, title: c.name, detail: c.description })),
              )}
              {group("Skills", skills.map((s) => ({ key: s.name, title: s.name, detail: s.description })))}
              {group("Tools", tools.map((t) => ({ key: t.name, title: t.name, detail: t.description })))}
            </>
          )}

          <div className="muted" style={{ marginTop: 22, padding: "0 6px" }}>
            Adding a capability happens in the agent&apos;s own repository — `eve add` and a
            deploy. There is no install-from-here yet, so this window reports rather than pretends.
          </div>
        </div>
      </div>
    </div>
  );
}
