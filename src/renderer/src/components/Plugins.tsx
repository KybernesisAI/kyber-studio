import { type ReactNode, useEffect, useState } from "react";
import type { LocalMcpServer } from "@shared/ipc";
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

/**
 * MCP servers, remote and local, on one screen.
 *
 * They were on separate tabs because they are implemented differently — one is
 * a URL the agent calls, the other a process on this machine reached through
 * the relay. That is our problem, not the user's. Someone adding an MCP server
 * knows they have either a URL or a command, and asking them to first work out
 * which tab that implies is asking them to understand our architecture before
 * they can paste a line from a README.
 */
function McpTab({ agent, query }: { agent: string; query: string }): ReactNode {
  const [local, setLocal] = useState<LocalMcpServer[] | null>(null);
  const [remote, setRemote] = useState<{ slug: string; name: string; description?: string }[]>([]);
  const [mode, setMode] = useState<"none" | "remote" | "local">("none");

  const refresh = async (): Promise<void> => {
    const servers = await window.studio?.mcpServers();
    if (servers) setLocal(servers);
    const cards = await window.studio?.connectors(agent);
    setRemote(
      (cards?.connectors ?? [])
        .filter((c) => c.provider === "mcp-direct" && c.connected)
        .map((c) => ({ slug: c.slug, name: c.name, description: c.description })),
    );
  };

  useEffect(() => {
    void refresh();
  }, [agent]);

  if (!local) return <div className="empty">Loading…</div>;

  const save = async (next: LocalMcpServer[]): Promise<void> => {
    setLocal(await window.studio!.saveMcpServers(next));
  };

  const term = query.trim().toLowerCase();
  const matches = (name: string): boolean => !term || name.toLowerCase().includes(term);
  const shownLocal = local.filter((s) => matches(s.name));
  const shownRemote = remote.filter((s) => matches(s.name));

  return (
    <>
      {shownRemote.length ? (
        <>
          <div className="pl__group">Remote servers</div>
          <div className="pl__grid">
            {shownRemote.map((s) => (
              <div className="pl__row" key={s.slug}>
                <span className="pl__icon" style={{ background: tint(s.name) }}>
                  {s.name.slice(0, 1)}
                </span>
                <div className="pl__body">
                  <div className="pl__name">{s.name}</div>
                  <div className="pl__desc">{s.description}</div>
                  <div className="pl__meta">Your agents call this directly</div>
                </div>
                <button
                  className="btn"
                  onClick={async () => {
                    await window.studio!.disconnectService({ agent, slug: s.slug });
                    await refresh();
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="pl__group" style={{ marginTop: shownRemote.length ? 18 : 0 }}>
        On this computer
      </div>
      {shownLocal.length ? (
        <div className="pl__grid">
          {shownLocal.map((s) => (
            <div className="pl__row" key={s.id}>
              <span className="pl__icon" style={{ background: tint(s.name) }}>
                {s.name.slice(0, 1)}
              </span>
              <div className="pl__body">
                <div className="pl__name">{s.name}</div>
                <div className="pl__desc">
                  {s.command} {s.args.join(" ")}
                </div>
                <div className="pl__meta">
                  {s.enabled ? "Runs here, never exposed" : "Off"}
                </div>
              </div>
              <button
                className="btn"
                onClick={() =>
                  void save(local.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)))
                }
              >
                {s.enabled ? "Turn off" : "Turn on"}
              </button>
              <button
                className="btn"
                title="Remove"
                onClick={() => void save(local.filter((x) => x.id !== s.id))}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty" style={{ paddingBottom: 8 }}>
          Nothing running here yet — a server on this machine is reachable by your
          agents without being exposed to anyone else.
        </div>
      )}

      {mode === "remote" ? (
        <AddRemoteServer agent={agent} onDone={() => { setMode("none"); void refresh(); }} />
      ) : mode === "local" ? (
        <AddLocalServer
          onAdd={async (server) => {
            await save([...local, server]);
            setMode("none");
          }}
          onCancel={() => setMode("none")}
        />
      ) : (
        <div className="ask__options" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => setMode("remote")}>
            <Icon name="plus" size={13} /> Add by URL
          </button>
          <button className="btn" onClick={() => setMode("local")}>
            <Icon name="plus" size={13} /> Add one on this computer
          </button>
        </div>
      )}
    </>
  );
}

/** The local half: a command this machine runs. */
function AddLocalServer({
  onAdd,
  onCancel,
}: {
  onAdd(server: LocalMcpServer): Promise<void>;
  onCancel(): void;
}): ReactNode {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");

  const submit = async (): Promise<void> => {
    const trimmed = command.trim();
    if (!trimmed || !name.trim()) return;
    // Split on whitespace: `npx -y @plaud-ai/mcp@latest` is what a README gives
    // you, and it is what people will paste.
    const [bin, ...args] = trimmed.split(/\s+/);
    await onAdd({
      id: name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name: name.trim(),
      command: bin!,
      args,
      enabled: true,
    });
  };

  return (
    <div className="card" style={{ marginTop: 14 }}>
      <div className="field">
        <div className="field__label">Name</div>
        <input
          className="input"
          value={name}
          placeholder="Plaud"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field" style={{ marginBottom: 8 }}>
        <div className="field__label">Command</div>
        <input
          className="input"
          value={command}
          spellCheck={false}
          placeholder="npx -y @plaud-ai/mcp@latest"
          onChange={(e) => setCommand(e.target.value)}
        />
      </div>
      <div className="ask__options">
        <button className="btn btn--primary" onClick={() => void submit()}>
          Add
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Adding a remote MCP server by URL.
 *
 * The half of the library no broker can cover: the server a company built last
 * week, a vendor whose endpoint is three days old, anything internal. Two
 * fields, because there are only two — nobody registered an OAuth app on their
 * behalf, so a token is the honest ask.
 *
 * Unlike everything else in this app, this one does take a secret from the
 * user. That is not the pattern we removed: there is no broker who could have
 * done it for them, and the alternative is not supporting custom servers at
 * all. It goes straight to their control plane and is never shown again.
 */
function AddRemoteServer({
  agent,
  onDone,
}: {
  agent: string;
  onDone(): void;
}): ReactNode {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [shared, setShared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.studio!.addCustomConnector({
        agent,
        name: name.trim(),
        url: url.trim(),
        token: token.trim() || undefined,
        shared,
      });
      if (!res.ok) {
        setError(res.error ?? "That did not work.");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="field">
        <div className="field__label">Name</div>
        <input
          className="input"
          value={name}
          placeholder="Arcana"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <div className="field__label">Remote MCP server URL</div>
        <input
          className="input"
          value={url}
          spellCheck={false}
          placeholder="https://mcp.example.com/mcp"
          onChange={(e) => setUrl(e.target.value)}
        />
      </div>
      <div className="field">
        <div className="field__label">Access token (optional)</div>
        <input
          className="input"
          type="password"
          value={token}
          spellCheck={false}
          placeholder="Leave blank if the server needs no token"
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <label className="row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
        <span className="muted">
          Everyone here uses this one connection — required if a routine should use it
        </span>
      </label>
      {error ? (
        <div className="muted" style={{ color: "var(--danger)", marginTop: 8 }}>
          {error}
        </div>
      ) : null}
      <div className="ask__options" style={{ marginTop: 12 }}>
        <button className="btn btn--primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Adding…" : "Add"}
        </button>
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
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
  const [tab, setTab] = useState<"apps" | "local" | "marketplace" | "yours">("apps");
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
            className={`tab${tab === "local" ? " tab--on" : ""}`}
            onClick={() => setTab("local")}
          >
            MCP servers
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
          ) : tab === "local" ? (
            <McpTab agent={activeAgentId} query={q} />
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
