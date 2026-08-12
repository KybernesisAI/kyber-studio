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
  const { plugins, pluginsOpen, setPluginsOpen, togglePlugin } = useStore();
  const [tab, setTab] = useState<"marketplace" | "yours">("marketplace");
  const [q, setQ] = useState("");

  if (!pluginsOpen) return null;

  const query = q.trim().toLowerCase();
  const pool = tab === "yours" ? plugins.filter((p) => p.added) : plugins;
  const filtered = pool.filter(
    (p) => !query || p.name.toLowerCase().includes(query) || p.description.toLowerCase().includes(query),
  );

  const categories = [...new Set(filtered.map((p) => p.category))];

  return (
    <div className="scrim" onClick={() => setPluginsOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">Plugins</span>
          <button className="topbar__btn" onClick={() => setPluginsOpen(false)}>
            <Icon name="close" />
          </button>
        </div>

        <div className="modal__tabs">
          <button
            className={`tab${tab === "marketplace" ? " tab--on" : ""}`}
            onClick={() => setTab("marketplace")}
          >
            Marketplace
          </button>
          <button className={`tab${tab === "yours" ? " tab--on" : ""}`} onClick={() => setTab("yours")}>
            Yours
          </button>
          <div style={{ flex: 1 }} />
          <button className="topbar__btn" title="Filter">
            <Icon name="filter" />
          </button>
          <label className="search" style={{ width: 240 }}>
            <Icon name="search" size={14} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search plugins"
              spellCheck={false}
            />
          </label>
        </div>

        <div className="modal__body">
          {filtered.length === 0 ? (
            <div className="empty">
              {tab === "yours" ? "No plugins added yet." : `Nothing matches “${q}”.`}
            </div>
          ) : (
            categories.map((cat) => (
              <div key={cat}>
                <div className="group-label">{cat}</div>
                <div className="plugin-grid">
                  {filtered
                    .filter((p) => p.category === cat)
                    .map((p) => (
                      <div className="plugin-row" key={p.id}>
                        <span className="conn__icon" style={{ width: 34, height: 34, fontSize: 17 }}>
                          {p.icon}
                        </span>
                        <div className="plugin-row__body">
                          <div className="plugin-row__name">{p.name}</div>
                          <div className="plugin-row__desc">{p.description}</div>
                        </div>
                        {p.added ? (
                          <button className="plugin-row__added" onClick={() => togglePlugin(p.id)}>
                            <Icon name="check" size={13} /> Added
                          </button>
                        ) : (
                          <button className="btn" onClick={() => togglePlugin(p.id)}>
                            Add
                          </button>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
