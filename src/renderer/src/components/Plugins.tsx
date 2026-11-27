import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CredentialStoreAnswer, LocalMcpServer, SaveMcpServersOptions } from "@shared/ipc";
import { useStore } from "@/lib/store";
import { looksSealed } from "@shared/sealed";
import {
  type McpPanelState,
  initialMcpPanelState,
  loadMcpPanel,
  panelView,
  saveMcpPanel,
} from "@/lib/mcpPanel";
import { Spinner } from "./Spinner";
import { Icon } from "./primitives";

/**
 * What an MCP row says when a bridge call throws instead of answering. The
 * thrown text is Electron's IPC wrapping, which names a channel and an
 * exception class, so it goes to the log and not on screen (KYB-641, KYB-688).
 */
const ROW_FAILED_MESSAGE = "That didn’t work. Please try again.";

/**
 * The key an MCP row's state is held under: its spinner, its sign-in wait and
 * its last result. A remote slug is `mcp-` plus the name put through the same
 * rule that makes a local id from a name, so a remote "Linear" and a local
 * "MCP Linear" are both `mcp-linear`. With bare keys, checking one spun and
 * overwrote the other (KYB-689).
 */
const remoteRow = (slug: string): string => `remote:${slug}`;
const localRow = (id: string): string => `local:${id}`;

/** A set with `key` added, or taken out, for a state update. */
function withKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set(set).add(key);
}
function withoutKey(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(set);
  next.delete(key);
  return next;
}

/** How long a sign-in in the browser is waited on before the row gives up. */
const SIGN_IN_WAIT_MS = 180_000;

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
      accounts?: { id: string; label: string | null; status: string }[];
    }[];
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** The connector whose accounts are open, if any. */
  const [open, setOpen] = useState<string | null>(null);
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

  // An open connector takes over this pane. Seeing accounts, naming a new one
  // and removing the right one are three actions with state of their own, and
  // squeezing them beside a description is what broke the library's layout.
  const opened = open ? shown.find((c) => c.slug === open) : null;
  if (opened) {
    return (
      <ConnectorDetail
        agent={agent}
        connector={opened}
        onBack={() => setOpen(null)}
        onChanged={refresh}
      />
    );
  }

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
              // One button, one screen. Managing accounts — seeing them, naming
              // a new one, removing the right one — does not fit on a row, and
              // squeezing it there is what broke the library's layout.
              <button className="btn" onClick={() => setOpen(c.slug)}>
                Manage{c.accounts && c.accounts.length > 1 ? ` (${c.accounts.length})` : ""}
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
 * One service, and every account behind it.
 *
 * This exists because a card could only say "connected" — a boolean that
 * cannot describe two mailboxes, and cannot say which of them failed. With
 * only that to look at, the way to find out what an agent could actually
 * reach was to ASK THE AGENT, which is a question the app should be able to
 * answer about itself.
 *
 * A screen rather than a row: seeing accounts, naming a new one, and removing
 * the right one are three actions with state, and squeezing them beside a
 * description is what broke the library's layout.
 */
function ConnectorDetail({
  agent,
  connector,
  onBack,
  onChanged,
}: {
  agent: string;
  connector: {
    slug: string;
    name: string;
    description?: string;
    scope: string;
    needsAdmin: boolean;
    accounts?: { id: string; label: string | null; status: string }[];
  };
  onBack: () => void;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accounts = connector.accounts ?? [];

  const run = async (what: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(what);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "That did not work.");
      await onChanged();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="cd">
      <button className="cd__back" onClick={onBack}>
        <Icon name="chevronLeft" size={14} /> All apps
      </button>

      <div className="cd__head">
        <div className="cd__title">{connector.name}</div>
        <div className="cd__desc">{connector.description}</div>
        <div className="pl__meta">
          {connector.scope === "app" ? "Connects for the company" : "Connects as you"}
          {connector.needsAdmin ? " · an admin must approve" : ""}
        </div>
      </div>

      <div className="pl__group">Connected accounts</div>
      {accounts.length === 0 ? (
        <div className="empty">Nothing connected yet.</div>
      ) : (
        <div className="cd__list">
          {accounts.map((a) => (
            <div className="cd__acct" key={a.id}>
              <div className="cd__acctName">{a.label ?? connector.name}</div>
              {/*
                * Status is shown per account, always. A connection that failed
                * at the provider — an admin policy, a denied consent — looks
                * exactly like a working one from outside, and the person who
                * added it deserves to see which is which without interrogating
                * the agent.
                */}
              <div className={`cd__status cd__status--${a.status}`}>{a.status}</div>
              <div className="cd__acctActions">
                {a.status !== "active" ? (
                  <button
                    className="btn"
                    disabled={busy !== null}
                    onClick={() =>
                      void run(a.id, () =>
                        window.studio!.connectService({ agent, slug: connector.slug, label: a.label ?? undefined }),
                      )
                    }
                  >
                    Re-authorize
                  </button>
                ) : null}
                <button
                  className="btn"
                  disabled={busy !== null}
                  onClick={() =>
                    void run(a.id, () =>
                      window.studio!.disconnectService({
                        agent,
                        slug: connector.slug,
                        shared: connector.scope === "app",
                        account: a.id,
                      }),
                    )
                  }
                >
                  {busy === a.id ? "Working…" : "Remove"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="pl__group">Add an account</div>
      <div className="cd__add">
        <input
          className="input"
          value={label}
          placeholder={accounts.length ? "work, personal, an address…" : "a name for this account"}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && label.trim()) {
              void run("add", () =>
                window.studio!.connectService({ agent, slug: connector.slug, label: label.trim() }),
              ).then(() => setLabel(""));
            }
          }}
        />
        <button
          className="btn btn--primary"
          disabled={!label.trim() || busy !== null}
          onClick={() =>
            void run("add", () =>
              window.studio!.connectService({ agent, slug: connector.slug, label: label.trim() }),
            ).then(() => setLabel(""))
          }
        >
          {busy === "add" ? "Opening…" : "Connect"}
        </button>
      </div>
      <div className="pl__meta cd__hint">
        Sign-in opens in your browser. Name it first — two accounts of one service produce the same
        tools, and the name is how the agent is told which to act as.
      </div>

      {error ? <div className="modal__banner modal__banner--error">{error}</div> : null}
    </div>
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
  /**
   * ONE piece of state, applied whole.
   *
   * It was three — `local`, `unreadable`, `saveError` — and each answer set
   * them one at a time. Review round 4 showed what that cost: deleting either
   * of the two `unreadable` setters was a free mutation, green across the whole
   * suite, and it turned a config the app cannot read into "Nothing running
   * here yet" on the load path and into a silently-failing Remove on the save
   * path. The decision now lives in `mcpPanel.ts`, where a test can call it;
   * this component applies what that returns and has no half to drop.
   *
   * Round 6 moved the ASKING there as well: `setPanel` is handed to
   * `loadMcpPanel` and `saveMcpPanel` and is not invoked in this file. That
   * killed round 5's mutation — `if (answer)` narrowed to `if (answer?.ok)`
   * discarded a damaged config's `{ ok: false }`, left `servers` null and
   * restored the permanent `Loading…` with the whole suite green — because the
   * equivalent edit now has to be written inside `loadMcpPanel`, where
   * `test/mcp-panel-state.test.mjs` drives it.
   *
   * **WITHDRAWN 25 Sep.** This comment used to go on to say that there was
   * therefore "no site at which a condition could stand in front of an answer
   * and drop it". That was false, and round 6 found two of them in this very
   * file — the CALLS, at the end of `refresh()` and inside `save()`. Both
   * `if (window.studio) await loadMcpPanel(...)` and `if (!unreadable) await
   * saveMcpPanel(...)` typechecked under both tsconfigs, built, and left the
   * suite green at 304/304. Moving the decision one level further would only
   * move the call site again. What holds those two now is
   * `test/mcp-panel-dom.test.mjs`, which mounts this component, presses the
   * recovery button and reads what is on screen.
   */
  const [panel, setPanel] = useState<McpPanelState>(initialMcpPanelState);
  const { servers: local, unreadable, saveError, loadError, heldKeys } = panel;
  const [remote, setRemote] = useState<
    {
      slug: string;
      name: string;
      description?: string;
      authMode?: string;
      awaitingSignIn?: boolean;
      present?: boolean;
      scope: string;
      url?: string;
      connected: boolean;
    }[]
  >([]);
  const [mode, setMode] = useState<"none" | "remote" | "local">("none");
  /** The card the remote form is changing, when it is not adding a new one. */
  const [editing, setEditing] = useState<{ name: string; url: string; shared: boolean } | null>(null);
  /** The local server the local form is changing, when it is not adding one (KYB-591). */
  // The entry Edit was pressed on, and which of the entries sharing its id it
  // is: lists stored before KYB-591 can hold two servers with one id, and an
  // edit must replace the one that was opened, not both (KYB-591).
  const [editingLocal, setEditingLocal] = useState<{ server: LocalMcpServer; nth: number } | null>(null);
  /**
   * The rows whose call is running, by `remoteRow` / `localRow` key. A set, not
   * one value: with one value, checking a second row took the first row's
   * spinner away, and the first answer cleared the second's (KYB-689).
   */
  const [checking, setChecking] = useState<ReadonlySet<string>>(() => new Set());
  const [menu, setMenu] = useState<string | null>(null);
  /**
   * Sign-ins happening in the browser, which this window cannot see, by
   * `remoteRow` key. A set for the same reason: a second Connect used to
   * replace the first, and the first approval then went unnoticed.
   */
  const [awaiting, setAwaiting] = useState<ReadonlySet<string>>(() => new Set());
  /** Each sign-in's own give-up timer, so a later Connect does not move it. */
  const giveUps = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [result, setResult] = useState<
    Record<string, { ok: boolean; tools?: string[]; error?: string; signInUrl?: string }>
  >({});

  const refresh = async (): Promise<void> => {
    // No branch here, and putting one back is exactly what round 6 did:
    // `if (window.studio)` in front of this line skipped the load whenever the
    // preload script had not run, left `servers` null and brought the permanent
    // `Loading…` back, with the whole suite green.
    // `test/mcp-panel-dom.test.mjs` mounts the panel with no bridge at all and
    // fails on it. `loadMcpPanel` itself folds the answer, the ABSENCE of an
    // answer and a rejection each into a stated state, and
    // `test/mcp-panel-state.test.mjs` drives all three; handling only the happy
    // one is what left `local` null on a damaged config, and null is what
    // renders `Loading…` for ever.
    await loadMcpPanel(window.studio, setPanel);
    const cards = await window.studio?.connectors(agent);
    setRemote(
      (cards?.connectors ?? [])
        // What THIS agent has, whatever state it is in.
        //
        // Listing every definition in the org put a server added to one agent
        // under all of them. Listing only connected ones hid a server waiting
        // to be signed in. Listing connected-or-waiting hid the case between
        // them — added, with an authorization already held — and a card that
        // vanishes on Add reads as the button being broken.
        .filter((c) => c.provider === "mcp-direct" && c.present !== false && (c.present || c.connected || c.awaitingSignIn))
        .map((c) => ({
          slug: c.slug,
          name: c.name,
          description: c.description,
          authMode: c.authMode,
          awaitingSignIn: c.awaitingSignIn,
          present: c.present,
          scope: c.scope,
          url: c.url,
          connected: c.connected,
        })),
    );
  };

  const startChecking = (key: string): void => setChecking((c) => withKey(c, key));
  const stopChecking = (key: string): void => setChecking((c) => withoutKey(c, key));

  const stopAwaiting = (key: string): void => {
    clearTimeout(giveUps.current.get(key));
    giveUps.current.delete(key);
    setAwaiting((a) => withoutKey(a, key));
  };
  const startAwaiting = (key: string): void => {
    clearTimeout(giveUps.current.get(key));
    giveUps.current.set(
      key,
      setTimeout(() => stopAwaiting(key), SIGN_IN_WAIT_MS),
    );
    setAwaiting((a) => withKey(a, key));
  };

  /**
   * Notice an approval that happened somewhere else.
   *
   * The browser has no way to tell this window that a person pressed Approve,
   * so the window has to look. Two triggers, because either alone leaves a
   * case stranded: coming back to the app covers the ordinary path, and a poll
   * covers approving on a phone or on a second monitor without ever switching
   * back. Both stop once nothing is waited on. Each wait gives up a few
   * minutes after its own Connect (`startAwaiting`) rather than running for
   * the life of the app. One poll looks for every row waited on.
   */
  const waitedOn = [...awaiting].sort().join("\n");
  useEffect(() => {
    if (!waitedOn) return;
    const keys = waitedOn.split("\n");
    let cancelled = false;
    const look = async (): Promise<void> => {
      const cards = await window.studio?.connectors(agent);
      const approved = keys.filter((key) =>
        (cards?.connectors ?? []).some((c) => remoteRow(c.slug) === key && c.connected),
      );
      if (!cancelled && approved.length) {
        for (const key of approved) stopAwaiting(key);
        await refresh();
      }
    };
    const timer = setInterval(() => void look(), 2_000);
    const onFocus = (): void => void look();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [waitedOn, agent]);

  // The give-up timers outlive any one wait, so they are cleared on close.
  useEffect(() => {
    const timers = giveUps.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [agent]);

  const term = query.trim().toLowerCase();
  const matches = (name: string): boolean => !term || name.toLowerCase().includes(term);
  // `?? []` and not a null check: the only state in which `servers` is null is
  // the one `panelView` calls `loading`, and that returns two lines below
  // before any of this is rendered.
  const servers = local ?? [];
  const shownLocal = servers.filter((s) => matches(s.name));
  const shownRemote = remote.filter((s) => matches(s.name));

  // What the local half shows, decided in `mcpPanel.ts` and switched on here.
  // The decision used to be a chain of ternaries in the JSX below, which no
  // test reached until round 7 added `test/mcp-panel-dom.test.mjs`.
  //
  // `shownLocal` is an argument and not a detail. Passing `servers` here
  // instead silently disables the search box for local servers, which round 6
  // found green; the DOM harness types into the box and reads what is left.
  const view = panelView(panel, shownLocal);

  if (view.kind === "loading") return <div className="empty">Loading…</div>;

  // Tested from the control plane, which is where the agent calls from — a
  // server your laptop can reach and the cloud cannot is an ordinary situation.
  const checkRemote = async (slug: string): Promise<void> => {
    const key = remoteRow(slug);
    startChecking(key);
    try {
      const outcome = await window.studio!.testRemoteMcp(slug);
      setResult((r) => ({ ...r, [key]: outcome }));
    } catch (error) {
      rowFailed(key, "check", error);
    } finally {
      stopChecking(key);
    }
  };

  /**
   * Put a bridge call that THREW on its row, rather than letting it escape.
   *
   * Every handler below starts the spinner, awaits the bridge and stops it. With
   * nothing around the await, a rejection skipped the clear, so the spinner
   * turned for good, and the rejection went unhandled (KYB-688). The main
   * process answers ordinary failures as `{ ok: false, error }`; a throw is the
   * IPC call itself failing, which a person cannot act on, so the screen gets
   * a plain sentence and the detail goes to the log (as `saveMcpPanel` does,
   * KYB-641).
   */
  const rowFailed = (key: string, action: string, error: unknown): void => {
    console.error(`[plugins] ${action} failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    setResult((r) => ({ ...r, [key]: { ok: false, error: ROW_FAILED_MESSAGE } }));
  };

  // Remote and local rows share one `menu` state. A remote slug is prefixed so
  // it can never equal a local server's id and open both menus at once.
  const remoteMenu = (slug: string): string => `remote:${slug}`;

  const save = async (
    next: LocalMcpServer[],
    options?: SaveMcpServersOptions,
  ): Promise<void> => {
    await saveMcpPanel(window.studio, setPanel, next, options);
  };

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
                  <div className="pl__meta">
                    {result[remoteRow(s.slug)]
                      ? result[remoteRow(s.slug)]!.ok
                        ? `Answering · ${result[remoteRow(s.slug)]!.tools?.length ?? 0} tools`
                        : result[remoteRow(s.slug)]!.error
                      : awaiting.has(remoteRow(s.slug))
                        ? "Waiting for you to approve it…"
                        : s.authMode === "oauth" && !s.connected
                          ? "Signs you in — connect to use it"
                        : s.scope === "app"
                          ? "Your agents call this directly"
                        : // A scheduled run has no person, so the control plane
                          // answers it with the shared connectors only. A card
                          // added for one person is invisible to routines, and
                          // the agent reports the server as unavailable rather
                          // than as unshared (KYB-547).
                          "Yours only — routines can't use it until it is shared"}
                  </div>
                </div>
                {/* One primary action and the ⋯ menu, as on local rows. Four
                    controls side by side left a half-width card about 40px for
                    the server's name, and cut "Linear" to "Line…" (KYB-687). */}
                {checking.has(remoteRow(s.slug)) || awaiting.has(remoteRow(s.slug)) ? (
                  <span className="pl__added">
                    <Spinner />
                  </span>
                ) : s.connected ? (
                  // Say it. A connection that worked and shows only a
                  // diagnostic button reads as unfinished — the person did
                  // everything asked of them and the interface never agreed.
                  <span className="pl__added">
                    <Icon name="check" size={13} /> Connected
                  </span>
                ) : s.authMode === "oauth" ? (
                  // A server that signs people in has one obvious next step, and
                  // it is not a diagnostic. Offering Check here reports the
                  // missing sign-in as though the server were broken.
                  <button
                    className="btn btn--primary"
                    onClick={async () => {
                      startChecking(remoteRow(s.slug));
                      let outcome: { ok: boolean; error?: string };
                      try {
                        outcome = await window.studio!.startMcpSignIn({
                          slug: s.slug,
                          agent,
                          shared: s.scope === "app",
                        });
                      } catch (error) {
                        rowFailed(remoteRow(s.slug), "sign-in", error);
                        return;
                      } finally {
                        stopChecking(remoteRow(s.slug));
                      }
                      if (!outcome.ok) {
                        setResult((r) => ({ ...r, [remoteRow(s.slug)]: { ok: false, error: outcome.error } }));
                        return;
                      }
                      // The browser has it now, and approving happens out
                      // there. Watch for it rather than claiming success on the
                      // strength of having opened a tab.
                      startAwaiting(remoteRow(s.slug));
                    }}
                  >
                    Connect
                  </button>
                ) : (
                  <button className="btn" onClick={() => void checkRemote(s.slug)}>
                    Check
                  </button>
                )}

                <button
                  className="icon-btn"
                  title="More"
                  onClick={() => setMenu(menu === remoteMenu(s.slug) ? null : remoteMenu(s.slug))}
                >
                  <Icon name="more" size={15} />
                </button>

                {menu === remoteMenu(s.slug) ? (
                  <div className="pl__menu">
                    {/* Only when connected: otherwise Check, or Connect, is
                        already the primary action on the row. Not while this
                        row is checking: a second press ran a second call
                        beside the first, and the first to finish cleared the
                        spinner while the other still ran (KYB-688). */}
                    {s.connected && !checking.has(remoteRow(s.slug)) ? (
                      <button
                        title="Ask the server whether it answers"
                        onClick={() => {
                          setMenu(null);
                          void checkRemote(s.slug);
                        }}
                      >
                        Check again
                      </button>
                    ) : null}
                    {s.url ? (
                      <button
                        title={
                          s.scope === "app"
                            ? "Change this server's address, or replace its token"
                            : "Share this server with everyone, so routines can use it"
                        }
                        onClick={() => {
                          setMenu(null);
                          setEditing({ name: s.name, url: s.url!, shared: s.scope === "app" });
                          setMode("remote");
                        }}
                      >
                        {s.scope === "app" ? "Change" : "Share"}
                      </button>
                    ) : null}
                    <button
                      className="danger"
                      onClick={async () => {
                        setMenu(null);
                        // Read the answer. It used to be thrown away, so a
                        // refused Remove left the row exactly as it was with
                        // nothing on screen saying no (KYB-688). The row stays
                        // and says why, as a failed check does.
                        let outcome: { ok: boolean; error?: string };
                        try {
                          outcome = await window.studio!.disconnectService({ agent, slug: s.slug });
                        } catch (error) {
                          rowFailed(remoteRow(s.slug), "remove", error);
                          return;
                        }
                        if (!outcome.ok) {
                          setResult((r) => ({
                            ...r,
                            [remoteRow(s.slug)]: { ok: false, error: outcome.error ?? ROW_FAILED_MESSAGE },
                          }));
                          return;
                        }
                        await refresh();
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="pl__group" style={{ marginTop: shownRemote.length ? 18 : 0 }}>
        On this computer
      </div>
      {saveError ? (
        <div className="pl__meta" style={{ marginBottom: 8 }}>
          That didn’t save: {saveError}
        </div>
      ) : null}
      {loadError ? (
        <div className="pl__meta" style={{ marginBottom: 8 }}>
          Couldn’t read your servers: {loadError}
        </div>
      ) : null}
      {/* One switch over a decision already made, rather than a chain of
          conditions. `panelView` picked the kind; every arm below only renders
          it, so deleting an arm is visible as a kind nothing handles rather
          than as a silently different screen. */}
      {view.kind === "unreadable" ? (
        // Distinct from `Loading…` and distinct from “you have none”, because the
        // user’s response is distinct: we cannot tell what is configured, and
        // the only thing this panel can honestly offer is the way out.
        // Quarantine renames the damaged file aside — the bytes survive — and
        // writes an empty list, which is what makes the panel usable again.
        <div className="empty" style={{ paddingBottom: 8 }}>
          Your list of servers on this computer is damaged and can’t be read, so
          nothing here can be changed.
          <div className="pl__desc" style={{ marginTop: 6 }}>{view.path}</div>
          <div className="ask__options" style={{ marginTop: 10 }}>
            <button
              className="btn btn--primary"
              onClick={() => void save([], { onUnreadableConfig: "quarantine" })}
            >
              Move it aside and start again
            </button>
          </div>
        </div>
      ) : view.kind === "list" ? (
        <div className="pl__grid">
          {view.servers.map((s) => (
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
                  {!s.enabled
                    ? "Off"
                    : result[localRow(s.id)]?.ok
                      ? result[localRow(s.id)]!.tools?.length
                        ? `Connected · ${result[localRow(s.id)]!.tools!.length} tools`
                        : "Connected"
                      : result[localRow(s.id)]?.error
                        ? result[localRow(s.id)]!.error
                        : "Runs here, never exposed"}
                </div>
                {/* Its own line, not the status slot above (KYB-695). That slot
                    is a precedence chain, Off, then the last result, then the
                    default, so a notice in it vanished on a row turned off or
                    showing a result: the rows a person is most likely looking
                    at. Names only; values never leave the main process. */}
                {heldKeys[s.id]?.length ? (
                  <div className="pl__held">
                    Kept until Studio restarts, not saved: {heldKeys[s.id]!.join(", ")}
                  </div>
                ) : null}
              </div>

              {/* One primary action, decided by state: sign in, or confirm it
                  works. Everything else lives in the menu, because four buttons
                  on a half-width card leaves no room for the name of the thing
                  they act on. */}
              {checking.has(localRow(s.id)) ? (
                <span className="pl__added">
                  <Spinner />
                </span>
              ) : result[localRow(s.id)]?.ok ? (
                <span className="pl__added">
                  <Icon name="check" size={13} /> Ready
                </span>
              ) : (
                <button
                  className="btn btn--primary"
                  onClick={async () => {
                    startChecking(localRow(s.id));
                    try {
                      const outcome = await window.studio!.connectMcpServer(s.id);
                      if (outcome.signInUrl) void window.studio!.openExternal(outcome.signInUrl);
                      const verified = outcome.ok ? await window.studio!.testMcpServer(s.id) : null;
                      setResult((r) => ({
                        ...r,
                        [localRow(s.id)]: verified ?? { ok: outcome.ok, error: outcome.message },
                      }));
                    } catch (error) {
                      rowFailed(localRow(s.id), "connect", error);
                    } finally {
                      stopChecking(localRow(s.id));
                    }
                  }}
                >
                  Connect
                </button>
              )}

              <button
                className="icon-btn"
                title="More"
                onClick={() => setMenu(menu === s.id ? null : s.id)}
              >
                <Icon name="more" size={15} />
              </button>

              {menu === s.id ? (
                <div className="pl__menu">
                  {/* Not while this row is checking, as on remote rows (KYB-688). */}
                  {!checking.has(localRow(s.id)) ? (
                    <button
                      onClick={async () => {
                        setMenu(null);
                        startChecking(localRow(s.id));
                        try {
                          const outcome = await window.studio!.testMcpServer(s.id);
                          setResult((r) => ({ ...r, [localRow(s.id)]: outcome }));
                        } catch (error) {
                          rowFailed(localRow(s.id), "check", error);
                        } finally {
                          stopChecking(localRow(s.id));
                        }
                      }}
                    >
                      Check again
                    </button>
                  ) : null}
                  <button
                    onClick={() => {
                      setMenu(null);
                      setEditingLocal({
                        server: s,
                        // Counted in the whole list, not the rows shown: the
                        // search box can hide one of two entries sharing an id.
                        nth: servers.slice(0, servers.indexOf(s)).filter((x) => x.id === s.id).length,
                      });
                      setMode("local");
                    }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => {
                      setMenu(null);
                      void save(
                        servers.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x)),
                      );
                    }}
                  >
                    {s.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button
                    className="danger"
                    onClick={() => {
                      setMenu(null);
                      void save(servers.filter((x) => x.id !== s.id));
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : null}
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
        <AddRemoteServer
          agent={agent}
          initial={editing ?? undefined}
          onDone={() => { setMode("none"); setEditing(null); void refresh(); }}
        />
      ) : mode === "local" && view.kind !== "unreadable" ? (
        // The SAME condition as the button that opens this, and not only that
        // button: `disabled` guards opening the form, so a form already open
        // when the config goes unreadable went on taking a name, a command and
        // a set of secrets, and then had the write refused. Closing it here
        // drops the user back to the disabled button, which says why.
        <AddLocalServer
          key={editingLocal ? `${editingLocal.server.id}#${editingLocal.nth}` : "new"}
          initial={editingLocal?.server}
          takenIds={servers.map((s) => s.id)}
          onAdd={async (server) => {
            if (editingLocal) {
              await save(applyEdit(servers, editingLocal, server));
              // The save stopped the server if it was running, so its last
              // answer no longer describes it: offer Connect, not an old Ready.
              setResult((r) => {
                const { [localRow(server.id)]: _stale, ...rest } = r;
                return rest;
              });
            } else {
              await save([...servers, server]);
            }
            setEditingLocal(null);
            setMode("none");
          }}
          onCancel={() => {
            setEditingLocal(null);
            setMode("none");
          }}
        />
      ) : (
        <div className="ask__options" style={{ marginTop: 14 }}>
          <button className="btn" onClick={() => setMode("remote")}>
            <Icon name="plus" size={13} /> Add by URL
          </button>
          {/*
            Dead over a damaged config: `saveServers` refuses by default, so the
            form would take a name, a command and — worst — a set of secrets,
            and then decline to write any of it. Adding by URL is untouched,
            because a remote server has nothing to do with this file.
          */}
          <button
            className="btn"
            disabled={!!unreadable}
            title={
              unreadable
                ? "Move the damaged list aside first — nothing here can be written until then"
                : undefined
            }
            onClick={() => {
              setEditingLocal(null);
              setMode("local");
            }}
          >
            <Icon name="plus" size={13} /> Add one on this computer
          </button>
        </div>
      )}
    </>
  );
}

/**
 * The list with one edit applied (KYB-591).
 *
 * Replaces exactly the entry that was opened: the `nth` of those with its id,
 * counted in the list as it is NOW. And it lays only what the form shows (name,
 * command line, env) over that entry as it is now, not as it was when the form
 * opened, so a Turn off made while the form was open survives, and so does
 * anything stored that the form does not show (`cwd`, `enabled`). If the entry
 * has gone in the meantime, nothing is put back.
 */
function applyEdit(
  servers: readonly LocalMcpServer[],
  target: { server: LocalMcpServer; nth: number },
  edited: LocalMcpServer,
): LocalMcpServer[] {
  let seen = -1;
  return servers.map((x) => {
    if (x.id !== target.server.id) return x;
    seen += 1;
    if (seen !== target.nth) return x;
    const { env: _previous, ...rest } = x;
    return {
      ...rest,
      name: edited.name,
      command: edited.command,
      args: edited.args,
      ...(edited.env ? { env: edited.env } : {}),
    };
  });
}

/** The id a name gives, as it always has: lower case, other runs to `-`. */
function idFromName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/**
 * An id no stored server has (KYB-591). Ids are frozen once a server exists,
 * because consent is kept under `mcp:<id>`, so a rename keeps its id and a
 * later server can arrive with a name that gives the same one. Two servers
 * with one id used to be stored side by side, and calls went to the first.
 */
function freeId(base: string, taken: readonly string[]): string {
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

/**
 * The characters taken off both ends of a key and a value in the box: what
 * `trim` takes (`\s` is the same set, U+FEFF included), and the zero-width
 * characters a copy from a web page or a chat can carry with it (KYB-699).
 * Characters inside a key or a value are left alone.
 */
const EDGE = /^[\s\u200B\u200C\u200D\u2060\uFEFF]$/;

/** `text` without the {@link EDGE} characters at either end. */
function trimEdges(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && EDGE.test(text[start]!)) start += 1;
  while (end > start && EDGE.test(text[end - 1]!)) end -= 1;
  return text.slice(start, end);
}

/**
 * A value without one pair of matching quotes around it (KYB-699): `"x"` and
 * `'x'` give `x`, as they do in a `.env` file. Anything else is kept as typed,
 * so `"abc`, `abc"` and `"abc'` stay as they are, and `"a"b"` gives `a"b`.
 * Nothing inside is interpreted: `"a\nb"` gives a, backslash, n, b.
 */
function withoutQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value[value.length - 1] === first) return value.slice(1, -1);
  return value;
}

/**
 * `KEY=value` per line, the format every README prints. The key and the value
 * are trimmed, then one pair of quotes around the value is taken off, and the
 * value is not trimmed again, so `KEY=" x "` keeps its spaces (KYB-699).
 *
 * The map has no prototype, so a typed key named `__proto__` is held as a key
 * like any other rather than being taken as the object's prototype and lost.
 * It reaches the main process because the env crosses as `[key, value]`
 * pairs, encoded in `mcpPanel.ts` and decoded on the other side (KYB-700).
 * As an object it would not: Electron's context bridge omits an own
 * `__proto__` from every object it copies, whatever its value, and gives the
 * copy `Object.prototype` (measured on Electron 34.5.8). A key that is an
 * array element is never an object key, so it crosses intact.
 */
function parseEnvLines(text: string): Record<string, string> {
  const environment: Record<string, string> = Object.create(null);
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = trimEdges(line.slice(0, at));
    const value = withoutQuotes(trimEdges(line.slice(at + 1)));
    if (key) environment[key] = value;
  }
  return environment;
}

/**
 * Why a stored value could not be shown, in words a person can act on.
 *
 * `store-unavailable` is not here. Its words describe the store, and those are
 * the main process's to write (KYB-696): it is the one that can tell Linux's
 * `basic_text` from a locked keyring. See {@link revealFailedMessage}.
 */
const REVEAL_FAILED: Record<"needs-re-entry" | "not-found", string> = {
  "needs-re-entry": "It can’t be opened on this computer. Type a new value, or remove it.",
  "not-found": "Can’t show it right now. The stored value is kept unless you type a new one or remove it.",
};

type RevealFailure = "store-unavailable" | keyof typeof REVEAL_FAILED;

/**
 * The message under a value the eye could not open.
 *
 * `store-unavailable` takes its description and remedy from the availability
 * answer and adds none of its own (KYB-696). Only a sealed value fails that
 * way, and once the answer says the store is unavailable a server with a
 * sealed value is locked and offers no eye, so in practice this shows before
 * the answer has arrived, as "Can’t show it." alone: the renderer has no words
 * for the store until the main process sends them. It is worked out when the
 * row renders, not when the eye failed, so the answer's words appear once it
 * is in. It does not say to type a new value (KYB-695): for a server with a
 * sealed value that does nothing.
 */
function revealFailedMessage(reason: RevealFailure, description: string, remedy: string): string {
  if (reason !== "store-unavailable") return REVEAL_FAILED[reason];
  return description ? `Can’t show it. ${description} ${remedy}` : "Can’t show it.";
}

/**
 * The availability answer, if it has the one shape the main process sends.
 * Anything else is treated as no answer, which leaves the form as it always
 * was; the main process holds the line whatever the form shows. The caller
 * says so on the console, as it does for a failed call.
 */
function readCredentialStoreAnswer(reply: unknown): CredentialStoreAnswer | null {
  if (typeof reply !== "object" || reply === null) return null;
  const { available, description, remedy } = reply as Partial<Record<keyof CredentialStoreAnswer, unknown>>;
  if (typeof available !== "boolean" || typeof description !== "string" || typeof remedy !== "string") return null;
  return { available, description, remedy };
}

/**
 * One stored environment value in the edit form.
 *
 * `sealed` is the string the value arrived as, and it is what goes back when
 * nobody changed the value: re-sending it is what keeps it byte for byte. The
 * field starts EMPTY, with dots as a placeholder, because a mask held as the
 * value would be written back as the new secret on the first save (KYB-291).
 * `revealed` is the plaintext the eye fetched, so a revealed value that was
 * not changed still goes back sealed. `edited` is set only when the person
 * changes the field, never by the eye, so a stored value that is itself empty
 * reveals as an empty field without the note an emptied field shows (KYB-693).
 */
interface StoredEnv {
  key: string;
  sealed: string;
  typed: string;
  revealed?: string;
  shown: boolean;
  failed?: RevealFailure;
  edited?: boolean;
}

/**
 * Whether Save sends the value typed in a stored key's row rather than the
 * stored one: blank, or the same as what the eye showed, means keep. Save and
 * the note under the box both ask this, so they cannot disagree (KYB-697).
 */
function sendsTyped(e: StoredEnv): boolean {
  return Boolean(e.typed) && e.typed !== e.revealed;
}

/**
 * The note for something left empty that Save will not send as empty. On a
 * stored key's row once the person has emptied its field (KYB-693): a blank
 * field keeps the stored value on Save, and an empty field with the dots back
 * reads as cleared, so the row says what will happen. Under the box for new
 * values for a `KEY=` line Save ignores (KYB-697), where the row may instead
 * send a value typed in its field.
 *
 * One sentence with an optional trailing clause, not several written
 * separately: the clause about × is left off where × is not offered (KYB-695),
 * and the rest must not drift. Two outcomes is the limit. A third or fourth
 * makes this a wording table, and that belongs with `credentialStoreWording`,
 * not on this helper.
 */
function emptiedFieldNote(removable: boolean, outcome: "stored" | "typed"): string {
  const kept = outcome === "typed" ? "the value typed above is used" : "the stored value is kept";
  return `Left empty, ${kept}.${removable ? " × removes it." : ""}`;
}

/**
 * The local half: a command this machine runs. Adds one, or with `initial`
 * changes one in place (KYB-591), keeping its id, its working folder and
 * anything else stored on it that this form does not show.
 */
function AddLocalServer({
  initial,
  takenIds,
  onAdd,
  onCancel,
}: {
  initial?: LocalMcpServer;
  takenIds: readonly string[];
  onAdd(server: LocalMcpServer): Promise<void>;
  onCancel(): void;
}): ReactNode {
  const initialLine = initial ? [initial.command, ...initial.args].join(" ") : "";
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initialLine);
  const [env, setEnv] = useState("");
  const [stored, setStored] = useState<StoredEnv[]>(() =>
    Object.entries(initial?.env ?? {}).map(([key, sealed]) => ({ key, sealed, typed: "", shown: false })),
  );

  /**
   * Whether the OS credential store can protect a secret, asked once when the
   * form opens (KYB-695), with the main process's words for the case when it
   * cannot (KYB-696). `null` until the answer arrives, and then the form is
   * as it always was: an answer of `true`, a missing bridge or a failed call
   * all leave it so, and the main process holds the line whatever the form
   * shows. Asked here and not when the panel lists servers, because the first
   * ask can raise the keyring's unlock prompt.
   */
  const [answer, setAnswer] = useState<CredentialStoreAnswer | null>(null);
  const available = answer?.available ?? null;
  useEffect(() => {
    let open = true;
    void (async () => {
      try {
        // A bridge without the call (an older preload, or a test) is no answer
        // and says nothing. A call that answers in another shape is a fault
        // between main and renderer, and is logged like a failed call. The
        // reply itself is not printed: what it carries is unknown.
        if (typeof window.studio?.credentialStoreAvailable !== "function") return;
        const reply = readCredentialStoreAnswer(await window.studio.credentialStoreAvailable());
        if (!reply) {
          console.error("[plugins] the credential store answer was not in the expected shape, so it was ignored");
          return;
        }
        if (open) setAnswer(reply);
      } catch (error) {
        console.error(
          `[plugins] could not ask whether the credential store is available: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    return () => {
      open = false;
    };
  }, []);

  /**
   * A sealed value on disk, judged from the values as stored with the same
   * `looksSealed` the main process uses: a value typed as `kyb:v1:my key` is
   * plain text, not ciphertext.
   */
  const sealedOnDisk = Object.values(initial?.env ?? {}).some((value) => looksSealed(value));
  /**
   * The store is unavailable and this server has a sealed value: it cannot
   * start until the store is available, so no env change is offered. Name and
   * command still save.
   */
  const locked = available === false && sealedOnDisk;
  /** The store is unavailable and nothing is sealed: values work until Studio restarts. */
  const warn = available === false && !sealedOnDisk;
  /**
   * The keys the box for new values has a line for, parsed as Save parses it.
   * A line with a value replaces the stored value. An empty line for a stored
   * key is ignored and gets its own note under the box (KYB-697). Any line
   * still hides the row's note that the stored value is kept (KYB-693), so the
   * two notes never stack.
   */
  const boxKeys = parseEnvLines(env);
  /**
   * The box's `KEY=` lines Save ignores (KYB-697): an empty value for a key
   * still on the form as a stored key, which keeps whatever its row sends. An
   * empty value is what a half-finished paste looks like, and sending it would
   * destroy a stored secret. Checked against `stored` now, not `initial.env`:
   * a key removed with × is not on the form, so `KEY=` after × still sets an
   * empty value on purpose, as it does for a new key. The same in the warning
   * state, where × is not offered. Save and the notes under the box both read
   * this list.
   */
  const ignoredBoxKeys = Object.keys(boxKeys).filter(
    (key) => boxKeys[key] === "" && stored.some((e) => e.key === key),
  );
  /** The main process's words for the state and its remedy; `""` until it says. */
  const description = answer?.description ?? "";
  const remedy = answer?.remedy ?? "";

  /**
   * Any env change made before the availability answer arrived goes when the
   * form locks (KYB-695). Until then the fields are offered, and without this a
   * value typed or a key removed with × stayed in state, `submit` sent it, the
   * main process refused it, and the form closed as if it had worked. Rebuilt
   * from `initial`, as the initialiser builds it, the locked save sends exactly
   * the stored env.
   */
  useEffect(() => {
    if (!locked) return;
    setStored(
      Object.entries(initial?.env ?? {}).map(([key, sealed]) => ({ key, sealed, typed: "", shown: false })),
    );
    setEnv("");
  }, [locked]);

  /**
   * A stored key removed with × before the answer comes back when it puts the
   * form in the warning state (KYB-696). × is not offered there, because the
   * main process writes the stored env back unchanged while the store is
   * unavailable, so the removal would be undone in silence under a warning
   * about what is and is not kept. Rebuilt from `initial` as the locked state
   * is, except that what was typed is kept: the main process holds a typed
   * value for a server with no sealed value, so it is not a change refused.
   */
  useEffect(() => {
    if (!warn) return;
    setStored((all) =>
      Object.entries(initial?.env ?? {}).map(
        ([key, sealed]) => all.find((e) => e.key === key) ?? { key, sealed, typed: "", shown: false },
      ),
    );
  }, [warn]);

  const change = (key: string, next: Partial<StoredEnv>): void =>
    setStored((all) => all.map((e) => (e.key === key ? { ...e, ...next } : e)));

  /** The eye. Opens this one value on first press; after that it only shows or hides. */
  const reveal = async (entry: StoredEnv): Promise<void> => {
    if (entry.shown) return change(entry.key, { shown: false });
    if (entry.revealed !== undefined) return change(entry.key, { shown: true });
    let outcome: Awaited<ReturnType<NonNullable<typeof window.studio>["revealMcpEnv"]>>;
    try {
      outcome = await window.studio!.revealMcpEnv(initial!.id, entry.key);
    } catch (error) {
      console.error(`[plugins] reveal failed for ${initial!.id}: ${error instanceof Error ? error.message : String(error)}`);
      return change(entry.key, { failed: "not-found" });
    }
    if (!outcome.ok) return change(entry.key, { failed: outcome.reason });
    setStored((all) =>
      all.map((e) =>
        e.key === entry.key
          ? { ...e, revealed: outcome.value, typed: e.typed || outcome.value, shown: true, failed: undefined }
          : e,
      ),
    );
  };

  const submit = async (): Promise<void> => {
    const trimmed = command.trim();
    if (!trimmed || !name.trim()) return;
    // An unchanged command line keeps its stored parts exactly, so an argument
    // with a space in it (possible by hand-editing the file) is not split.
    // Otherwise split on whitespace: `npx -y @plaud-ai/mcp@latest` is what a
    // README gives you, and it is what people will paste.
    const [bin, ...args] =
      initial && command === initialLine ? [initial.command, ...initial.args] : trimmed.split(/\s+/);

    // Stored values go back sealed unless a new value was typed: blank, or the
    // same as what the eye showed, means keep. Lines below add keys, and a line
    // with a value wins over a stored key of the same name. An empty line for a
    // key still on the form is ignored, and the key keeps what its row sends
    // (KYB-697); for any other key it sets an empty value. A row's field is
    // sent exactly as typed: only the box takes quotes off (KYB-699). No
    // prototype, so a `__proto__` key is held in this map like any other,
    // where on a plain object the `__proto__` setter would swallow it. A stored
    // one is here because the form received it, decoded from pairs, and a
    // typed one because `parseEnvLines` keeps it. Both reach the main process
    // because the env crosses the context bridge as pairs (see
    // `parseEnvLines`).
    const environment: Record<string, string> = Object.create(null);
    for (const e of stored) {
      environment[e.key] = sendsTyped(e) ? e.typed : e.sealed;
    }
    for (const [key, value] of Object.entries(boxKeys)) {
      if (!ignoredBoxKeys.includes(key)) environment[key] = value;
    }

    // An edit sends only what the form shows; the panel lays it over the stored
    // entry as it is at save time (`applyEdit`), which keeps `cwd` and the rest.
    await onAdd({
      id: initial ? initial.id : freeId(idFromName(name), takenIds),
      name: name.trim(),
      command: bin!,
      args,
      ...(Object.keys(environment).length ? { env: environment } : {}),
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
      <div className="field" style={{ marginBottom: 8 }}>
        <div className="field__label">Environment (optional)</div>
        {/* The description and remedy are the main process's (KYB-696): it can
            tell Linux's `basic_text`, where there is nothing to unlock, from a
            locked keyring. Only the consequence is written here. */}
        {warn ? (
          <div className="pl__notice" role="note">
            {`${description} Values typed here won’t be saved. Studio will use them until it restarts. ${remedy}`}
          </div>
        ) : null}
        {locked ? (
          <div className="pl__notice" role="note">
            {`${description} Environment values can’t be changed now. ${remedy}`}
          </div>
        ) : null}
        {locked
          ? // Names only: no field, no eye, no ×, and no box for new lines.
            stored.map((e) => (
              <div className="pl__env" key={e.key} style={{ marginBottom: 6 }}>
                <code>{e.key}</code>
              </div>
            ))
          : stored.map((e) => (
          <div className="pl__env" key={e.key} style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <code style={{ flex: "0 0 auto" }}>{e.key}</code>
              <input
                className="input"
                aria-label={e.key}
                type={e.shown ? "text" : "password"}
                value={e.typed}
                spellCheck={false}
                autoComplete="off"
                placeholder="••••••••"
                onChange={(ev) => change(e.key, { typed: ev.target.value, edited: true })}
                style={{ flex: "1 1 auto", minWidth: 0 }}
              />
              <button
                className="icon-btn"
                title={e.shown ? "Hide" : "Show"}
                onClick={() => void reveal(e)}
              >
                <Icon name={e.shown ? "eyeOff" : "eye"} size={14} />
              </button>
              {/* Not while the store is unavailable: a removal then writes the
                  stored env back as it was, so × would do nothing (KYB-695). */}
              {warn ? null : (
                <button
                  className="icon-btn"
                  title={`Remove ${e.key}`}
                  onClick={() => setStored((all) => all.filter((x) => x.key !== e.key))}
                >
                  <Icon name="close" size={13} />
                </button>
              )}
            </div>
            {e.failed ? (
              <div className="muted" style={{ marginTop: 2 }}>
                {revealFailedMessage(e.failed, description, remedy)}
              </div>
            ) : null}
            {/* An edit that left the field empty, not an empty field: a
                stored value that is itself empty reveals as one (KYB-693).
                Not while the box has a line for the key, which either
                replaces the stored value or has its own note under the box
                (KYB-697), and not under the not-found message, which
                already says the value is kept. */}
            {e.edited && e.typed === "" && !Object.hasOwn(boxKeys, e.key) && e.failed !== "not-found" ? (
              <div className="muted" style={{ marginTop: 2 }}>
                {emptiedFieldNote(!warn, "stored")}
              </div>
            ) : null}
          </div>
        ))}
        {locked ? null : (
          <>
            <textarea
              className="input"
              rows={2}
              value={env}
              spellCheck={false}
              placeholder={"API_KEY=…\nDATABASE_URL=…"}
              onChange={(e) => setEnv(e.target.value)}
            />
            {/* One note per `KEY=` line Save ignores, saying what it sends
                instead (KYB-697). Outside every row, under the box the line
                was typed in. */}
            {ignoredBoxKeys.map((key) => {
              const entry = stored.find((e) => e.key === key);
              const outcome = entry && sendsTyped(entry) ? "typed" : "stored";
              return (
                <div className="muted" data-box-note={key} key={key} style={{ marginTop: 4 }}>
                  {`${key}: ${emptiedFieldNote(!warn, outcome)}`}
                </div>
              );
            })}
            <div className="muted" style={{ marginTop: 4 }}>
              {stored.length
                ? "Leave a stored value blank to keep it. Add new ones below, one per line."
                : "One per line. Servers that want a key read it from here rather than from the command, where it would sit in plain sight in the list."}
            </div>
          </>
        )}
      </div>
      <div className="ask__options">
        <button className="btn btn--primary" onClick={() => void submit()}>
          {initial ? "Save" : "Add"}
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
 * week, a vendor whose endpoint is three days old, anything internal.
 *
 * The token field is the last resort rather than the ask. A server that does
 * OAuth is detected when it is added — it answers with a pointer to its own
 * authorization server — and then this offers a browser sign-in instead, the
 * same as every other connection in this app. Only servers with no such flow
 * need a pasted secret, which then goes straight to the control plane and is
 * never shown again.
 */
function AddRemoteServer({
  agent,
  onDone,
  initial,
}: {
  agent: string;
  onDone(): void;
  /**
   * An existing card being changed rather than a new server being added.
   *
   * Adding by the same name updates the server in place, so sharing one is the
   * add form with its answers already filled in. The token is the exception:
   * the control plane never hands a stored secret back, so a bearer server
   * asks for it again. Saying that is better than a disabled field nobody can
   * explain.
   */
  initial?: { name: string; url: string; shared: boolean };
}): ReactNode {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [token, setToken] = useState("");
  const [shared, setShared] = useState(initial?.shared ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the server asked for OAuth: added, but not yet connected. */
  const [signIn, setSignIn] = useState<{ slug: string } | null>(null);

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
      // A server that signs people in is not finished being added. Closing the
      // form here would leave it looking added and behaving disconnected.
      if (res.needsSignIn && res.slug) {
        setSignIn({ slug: res.slug });
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const connect = async (): Promise<void> => {
    if (!signIn) return;
    setBusy(true);
    setError(null);
    try {
      const res = await window.studio!.startMcpSignIn({ slug: signIn.slug, agent, shared });
      if (!res.ok) {
        setError(res.error ?? "Could not start the sign-in.");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  if (signIn) {
    return (
      <div className="card" style={{ marginTop: 12 }}>
        <p style={{ marginTop: 0 }}>
          <strong>{name.trim()}</strong> signs you in itself. Approve it in your browser and it
          connects for you — {shared ? "for everyone here" : "for you"}, on this agent.
        </p>
        {error ? <div className="error">{error}</div> : null}
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn--primary" disabled={busy} onClick={() => void connect()}>
            {busy ? "Opening…" : "Connect"}
          </button>
          <button className="btn" disabled={busy} onClick={onDone}>
            Later
          </button>
        </div>
      </div>
    );
  }

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
        <div className="field__label">{initial ? "Access token" : "Access token (optional)"}</div>
        <input
          className="input"
          type="password"
          value={token}
          spellCheck={false}
          placeholder={
            initial
              // A shared connection keeps its own copy of the secret, and the
              // control plane never hands a stored one back. Blank here leaves
              // the shared card with no credential, and the agent then reports
              // the server as unavailable rather than as missing its token.
              ? "Paste it again — a shared connection stores its own copy"
              : "Leave blank if the server needs no token"
          }
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

  // An item IS its own package. Its dependency list may also name packages it
  // builds on (vault and payments both need computer), and having one of those
  // does not mean the item is installed — every agent with a computer looked
  // like it had a Link wallet.
  const isInstalled = (item: { name: string; dependencies?: string[] }): boolean => {
    const installed = cat?.installed ?? [];
    const own = `@kybernesis/${item.name}`;
    const deps = item.dependencies ?? [own];
    if (deps.includes(own)) return installed.includes(own);
    return deps.every((d) => installed.includes(d));
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
