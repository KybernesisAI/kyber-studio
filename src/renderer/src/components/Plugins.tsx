import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { Spinner } from "./Spinner";
import { Icon } from "./primitives";

/**
 * The plugin marketplace.
 *
 * Marketplace lists what can be added to this agent, from the Kybernesis
 * registry. Yours lists what it already has, read from the agent itself. Add
 * genuinely installs — files, dependencies, rebuild, restart — so the button
 * means what it says.
 *
 * Where it cannot install, it says why rather than disabling silently: an agent
 * on a read-only serverless bundle has no working copy to modify, and an agent
 * with no management key has not been given permission to be changed from here.
 */
export function Plugins(): ReactNode {
  const {
    details,
    activeAgentId,
    agents,
    pluginsOpen,
    setPluginsOpen,
    catalog,
    loadCatalog,
    install,
    installing,
    manageError,
    manageSecrets,
    setPanel,
  } = useStore();
  const [tab, setTab] = useState<"marketplace" | "yours">("marketplace");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (pluginsOpen) void loadCatalog(activeAgentId);
  }, [pluginsOpen, activeAgentId, loadCatalog]);

  if (!pluginsOpen) return null;

  const info = details[activeAgentId];
  const agent = agents.find((a) => a.id === activeAgentId);
  const cat = catalog[activeAgentId];
  const hasKey = Boolean(manageSecrets[activeAgentId]);
  const query = q.trim().toLowerCase();
  const match = (t: string): boolean => !query || t.toLowerCase().includes(query);

  const isInstalled = (item: { name: string; dependencies?: string[] }): boolean => {
    const deps = item.dependencies ?? [`@kybernesis/${item.name}`];
    return deps.some((d) => (cat?.installed ?? []).includes(d));
  };

  const marketplace = (cat?.items ?? []).filter(
    (i) => match(i.title ?? i.name) || match(i.description ?? ""),
  );

  const yours = [
    ...(info?.connections ?? []).map((c) => ({
      key: `c:${c.name}`,
      title: c.name,
      detail: c.description,
      group: "Connections",
    })),
    ...(info?.skills ?? []).map((s) => ({
      key: `s:${s.name}`,
      title: s.name,
      detail: s.description,
      group: "Skills",
    })),
    ...(info?.tools ?? []).map((t) => ({
      key: `t:${t.name}`,
      title: t.name,
      detail: t.description,
      group: "Tools",
    })),
  ].filter((i) => match(i.title));

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

        {manageError ? (
          <div className="modal__banner modal__banner--error">{manageError}</div>
        ) : !hasKey ? (
          <div className="modal__banner">
            Installing needs {agent?.name ?? "this agent"}&apos;s management key.{" "}
            <button
              className="linkish"
              onClick={() => {
                setPluginsOpen(false);
                setPanel("settings");
              }}
            >
              Add it in Settings
            </button>
          </div>
        ) : cat && !cat.writable ? (
          <div className="modal__banner">{cat.reason}</div>
        ) : null}

        <div className="modal__body">
          {tab === "marketplace" ? (
            !cat ? (
              <div className="empty">
                {hasKey ? "Loading the catalog…" : "Add a management key to browse."}
              </div>
            ) : marketplace.length === 0 ? (
              <div className="empty">Nothing matches “{q}”.</div>
            ) : (
              <>
                <div className="group-label">Kybernesis registry</div>
                <div className="plugin-grid">
                  {marketplace.map((item) => {
                    const added = isInstalled(item);
                    const busy = installing === item.name;
                    return (
                      <div className="plugin-row" key={item.name}>
                        <span className="conn__icon" style={{ width: 34, height: 34 }}>
                          <Icon name="plug" size={16} />
                        </span>
                        <div className="plugin-row__body">
                          <div className="plugin-row__name">{item.title ?? item.name}</div>
                          <div className="plugin-row__desc">{item.description}</div>
                        </div>
                        {added ? (
                          <span className="plugin-row__added">
                            <Icon name="check" size={13} /> Added
                          </span>
                        ) : busy ? (
                          <span className="plugin-row__added">
                            <Spinner /> Installing
                          </span>
                        ) : (
                          <button
                            className="btn"
                            disabled={!hasKey || !cat.writable || Boolean(installing)}
                            onClick={() => void install(activeAgentId, item.name)}
                          >
                            Add
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )
          ) : !info ? (
            <div className="empty">Loading from the agent…</div>
          ) : yours.length === 0 ? (
            <div className="empty">This agent reports no connections, skills, or authored tools.</div>
          ) : (
            ["Connections", "Skills", "Tools"].map((group) => {
              const items = yours.filter((i) => i.group === group);
              if (items.length === 0) return null;
              return (
                <div key={group}>
                  <div className="group-label">
                    {group} · {items.length}
                  </div>
                  <div className="plugin-grid">
                    {items.map((i) => (
                      <div className="plugin-row" key={i.key}>
                        <span className="conn__icon" style={{ width: 34, height: 34 }}>
                          <Icon name="plug" size={16} />
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
            })
          )}
        </div>
      </div>
    </div>
  );
}
