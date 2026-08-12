import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import { Avatar, Icon } from "./primitives";

/**
 * The command palette.
 *
 * One search field over everything the app knows — agents, routines, plugins,
 * settings, actions — because a customer should never have to remember which
 * panel a thing lives in. Filter tabs narrow the same result set rather than
 * changing what search means.
 */

export type PaletteScope =
  | "All"
  | "Messages"
  | "Agents"
  | "Groups"
  | "Files"
  | "Links"
  | "Routines"
  | "Actions";

const SCOPES: PaletteScope[] = [
  "All",
  "Messages",
  "Agents",
  "Groups",
  "Files",
  "Links",
  "Routines",
  "Actions",
];

interface Item {
  id: string;
  title: string;
  subtitle?: string;
  scope: Exclude<PaletteScope, "All">;
  icon?: ReactNode;
  run(): void;
}

export function Palette(): ReactNode {
  const {
    agents,
    routines,
    conversations,
    paletteOpen,
    setPaletteOpen,
    select,
    openRoutine,
    setPanel,
    setPluginsOpen,
  } = useStore();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<PaletteScope>("All");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (paletteOpen) {
      setQ("");
      setScope("All");
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [paletteOpen]);

  const items = useMemo((): Item[] => {
    const out: Item[] = [];

    for (const a of agents.filter((x) => !x.hidden)) {
      out.push({
        id: `agent:${a.id}`,
        title: a.name,
        subtitle: a.title ?? a.description,
        scope: "Agents",
        icon: <Avatar name={a.name} accent={a.accent} size={30} />,
        run: () => select(a.id),
      });
    }

    // Message hits carry the agent name as their subtitle — a matching line with
    // no attribution is not findable again once the palette closes.
    for (const [agentId, blocks] of Object.entries(conversations)) {
      const agent = agents.find((a) => a.id === agentId);
      if (!agent) continue;
      for (const b of blocks) {
        if (b.kind !== "text") continue;
        out.push({
          id: `msg:${b.id}`,
          title: b.text.length > 90 ? `${b.text.slice(0, 90)}…` : b.text,
          subtitle: agent.name,
          scope: "Messages",
          icon: <Avatar name={agent.name} accent={agent.accent} size={30} />,
          run: () => select(agentId),
        });
      }
    }

    for (const r of routines) {
      const agent = agents.find((a) => a.id === r.agentId);
      out.push({
        id: `routine:${r.id}`,
        title: r.name,
        subtitle: `${r.schedules[0] ?? "No schedule"}${agent ? ` · ${agent.name}` : ""}`,
        scope: "Routines",
        icon: <Icon name="clock" />,
        run: () => {
          if (agent) select(agent.id);
          openRoutine(r.id);
        },
      });
    }

    const action = (title: string, subtitle: string, run: () => void, icon = "gear"): Item => ({
      id: `action:${title}`,
      title,
      subtitle,
      scope: "Actions",
      icon: <Icon name={icon} />,
      run,
    });
    out.push(action("Chat Settings", "Current chat", () => setPanel("settings")));
    out.push(action("Settings: Channels", "Current agent", () => setPanel("channels")));
    out.push(action("Plugins", "Marketplace", () => setPluginsOpen(true), "plug"));
    out.push(action("Agent panel", "Show or hide", () => setPanel("overview"), "monitor"));

    return out;
  }, [agents, routines, conversations, select, openRoutine, setPanel, setPluginsOpen]);

  const query = q.trim().toLowerCase();
  const results = items
    .filter((i) => scope === "All" || i.scope === scope)
    .filter(
      (i) => !query || i.title.toLowerCase().includes(query) || (i.subtitle ?? "").toLowerCase().includes(query),
    )
    .slice(0, 40);

  useEffect(() => setCursor(0), [q, scope]);

  if (!paletteOpen) return null;

  const runAt = (index: number): void => {
    const item = results[index];
    if (!item) return;
    item.run();
    setPaletteOpen(false);
  };

  return (
    <div className="scrim scrim--top" onClick={() => setPaletteOpen(false)}>
      <div
        className="palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") setPaletteOpen(false);
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setCursor((c) => Math.min(c + 1, results.length - 1));
          }
          if (e.key === "ArrowUp") {
            e.preventDefault();
            setCursor((c) => Math.max(c - 1, 0));
          }
          if (e.key === "Enter") {
            e.preventDefault();
            runAt(cursor);
          }
          if (e.metaKey && /^[1-9]$/.test(e.key)) {
            e.preventDefault();
            runAt(Number(e.key) - 1);
          }
        }}
      >
        <div className="palette__search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search"
            spellCheck={false}
          />
        </div>

        <div className="palette__scopes">
          {SCOPES.map((s) => (
            <button
              key={s}
              className={`tab${scope === s ? " tab--on" : ""}`}
              onClick={() => setScope(s)}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="palette__results">
          {results.length === 0 ? (
            <div className="empty">Nothing matches “{q}”.</div>
          ) : (
            results.map((item, i) => (
              <button
                key={item.id}
                className={`palette__row${i === cursor ? " palette__row--on" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => runAt(i)}
              >
                <span className="palette__icon">{item.icon}</span>
                <span className="palette__body">
                  <span className="palette__title">{item.title}</span>
                  {item.subtitle ? <span className="palette__sub">{item.subtitle}</span> : null}
                </span>
                {i < 9 ? <span className="kbd">⌘ {i + 1}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
