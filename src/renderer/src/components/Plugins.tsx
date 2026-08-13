import { type ReactNode, useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { Spinner } from "./Spinner";
import { Icon } from "./primitives";

/** Stable colour per item, so the same plugin always looks the same. */
function tint(name: string): string {
  const palette = ["#2ec4a6", "#4f9cf0", "#7c6cf0", "#f0883e", "#e0609a", "#3fb950"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length]!;
}

/**
 * The connector library: services a person can sign in to, one click each.
 *
 * Two facts belong on every card and are easy to leave off. WHO it acts as —
 * your account or the company's — because a user-scoped connection cannot fire
 * from a schedule, and finding that out when a briefing does not arrive is the
 * wrong time. And whether an ADMIN has to approve it, because "one click" is
 * false for Slack, Notion, and Workspace, and someone should learn that before
 * they start rather than at the end of a redirect chain.
 */
function AppsTab({ agent, query }: { agent: string; query: string }): ReactNode {
  const [state, setState] = useState<{
    configured: boolean;
    connectors: {
      slug: string;
      name: string;
      description?: string;
      provider: string;
      scope: string;
      needsAdmin: boolean;
      mark?: string;
      logo?: string;
      connected: boolean;
    }[];
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    const next = await window.studio?.connectors(agent);
    if (next) setState(next);
  };

  useEffect(() => {
    void refresh();
    // Sign-in finishes in a browser tab, so nothing tells this window when it
    // worked. A slow poll while the screen is open is the honest way to notice.
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [agent]);

  if (!state) return <div className="empty">Loading the library…</div>;
  if (!state.configured) {
    return <div className="empty">Connectors are not configured on this control plane yet.</div>;
  }

  const term = query.trim().toLowerCase();
  const shown = state.connectors.filter(
    (c) => !term || c.name.toLowerCase().includes(term) || c.slug.includes(term),
  );
  if (!shown.length) return <div className="empty">Nothing matches “{query}”.</div>;

  const act = async (slug: string, connected: boolean, shared: boolean): Promise<void> => {
    setBusy(slug);
    setError(null);
    try {
      const res = connected
        ? await window.studio!.disconnectService({ agent, slug, shared })
        : await window.studio!.connectService({ agent, slug });
      if (!res.ok) setError(res.error ?? "That did not work.");
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {error ? <div className="modal__banner modal__banner--error">{error}</div> : null}
      <div className="pl__group">Apps</div>
      <div className="pl__grid">
        {shown.map((c) => (
          <div className="pl__row" key={c.slug}>
            {c.logo ? (
              // The real mark, on white: these are drawn for light backgrounds and
              // several of them vanish on a dark tile.
              <span className="pl__icon pl__icon--logo">
                <img src={c.logo} alt="" />
              </span>
            ) : (
              <span className="pl__icon" style={{ background: tint(c.name) }}>
                {c.mark ?? c.name.slice(0, 1)}
              </span>
            )}
            <div className="pl__body">
              <div className="pl__name">{c.name}</div>
              <div className="pl__desc">{c.description}</div>
              <div className="pl__meta">
                {c.scope === "app" ? "Connects for the company" : "Connects as you"}
                {c.needsAdmin ? " · an admin must approve" : ""}
              </div>
            </div>
            {busy === c.slug ? (
              <span className="pl__added">
                <Spinner /> Working
              </span>
            ) : c.connected ? (
              <button className="btn" onClick={() => void act(c.slug, true, c.scope === "app")}>
                Disconnect
              </button>
            ) : (
              <button className="btn btn--primary" onClick={() => void act(c.slug, false, false)}>
                Connect
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function Tile({ name }: { name: string }): ReactNode {
  return (
    <span className="pl__icon" style={{ background: tint(name) }}>
      {name.replace(/^Kybernesis /, "").charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * The plugin marketplace.
 *
 * Marketplace lists what can be added to this agent, from the Kybernesis
 * registry. Yours lists what it already has, read from the agent itself. Add
 * genuinely installs — files, dependencies, rebuild, restart — so the button
 * means what it says.
 *
 * Authorization is the control-plane grant you already hold — the same one that
 * lets you talk to this agent. There is no separate key to obtain or paste.
 *
 * Where it cannot install, it says why rather than disabling silently: an agent
 * on a read-only serverless bundle has no working copy to modify.
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
  } = useStore();
  const [tab, setTab] = useState<"apps" | "marketplace" | "yours">("apps");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (pluginsOpen) void loadCatalog(activeAgentId);
  }, [pluginsOpen, activeAgentId, loadCatalog]);

  if (!pluginsOpen) return null;

  const info = details[activeAgentId];
  const agent = agents.find((a) => a.id === activeAgentId);
  const cat = catalog[activeAgentId];
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
            className={`tab${tab === "apps" ? " tab--on" : ""}`}
            onClick={() => setTab("apps")}
          >
            Apps
          </button>
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

        {manageError ? (
          <div className="modal__banner modal__banner--error">{manageError}</div>
        ) : cat && !cat.writable ? (
          <div className="modal__banner">{cat.reason}</div>
        ) : null}

        <div className="modal__body">
          {tab === "apps" ? (
            <AppsTab agent={activeAgentId} query={q} />
          ) : tab === "marketplace" ? (
            !cat ? (
              <div className="empty">
                Loading the catalog…
              </div>
            ) : marketplace.length === 0 ? (
              <div className="empty">Nothing matches “{q}”.</div>
            ) : (
              <>
                <div className="pl__group">Kybernesis registry</div>
                <div className="pl__grid">
                  {marketplace.map((item) => {
                    const added = isInstalled(item);
                    const busy = installing === item.name;
                    return (
                      <div className="pl__row" key={item.name}>
                        <Tile name={item.title ?? item.name} />
                        <div className="pl__body">
                          <div className="pl__name">{(item.title ?? item.name).replace(/^Kybernesis /, "")}</div>
                          <div className="pl__desc">{item.description}</div>
                        </div>
                        {added ? (
                          <span className="pl__added">
                            <Icon name="check" size={13} /> Added
                          </span>
                        ) : busy ? (
                          <span className="pl__added">
                            <Spinner /> Installing
                          </span>
                        ) : (
                          <button
                            className="btn"
                            disabled={!cat.writable || Boolean(installing)}
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
                  <div className="pl__group">
                    {group} · {items.length}
                  </div>
                  <div className="pl__grid">
                    {items.map((i) => (
                      <div className="pl__row" key={i.key}>
                        <Tile name={i.title} />
                        <div className="pl__body">
                          <div className="pl__name">{i.title}</div>
                          <div className="pl__desc">{i.detail ?? ""}</div>
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
