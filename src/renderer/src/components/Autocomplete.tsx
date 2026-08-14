import type { ReactNode } from "react";
import { Avatar, Icon } from "./primitives";

/**
 * The composer's `/` and `@` menus.
 *
 * `/` is what the agent can DO — its skills, plus app actions. `@` is what the
 * agent can REACH — connected plugins and its own routines. Keeping the two
 * triggers meaningfully different matters: one menu holding both verbs and
 * nouns makes the user read every row to find the one they meant.
 *
 * Each row carries an explicit type label, because "add-connector" reads as a
 * command and "Gmail" reads as a noun, and only the label tells you which will
 * happen when you press Enter.
 */

export interface Suggestion {
  id: string;
  title: string;
  detail?: string;
  /** Shown right-aligned: Agent · Skill · Action · Plugin · Routine. */
  type: "Agent" | "Skill" | "Action" | "Plugin" | "Routine";
  /** Agents carry their own colour so the row looks like the agent it names. */
  accent?: string;
  icon?: string;
}

export function Autocomplete({
  items,
  cursor,
  onPick,
  onHover,
}: {
  items: Suggestion[];
  cursor: number;
  onPick(item: Suggestion): void;
  onHover(index: number): void;
}): ReactNode {
  if (items.length === 0) return null;

  const glyph = (s: Suggestion): ReactNode => {
    // An agent row should look like the agent, not like a generic entry — same
    // avatar and colour as its row in the sidebar.
    if (s.type === "Agent") return <Avatar name={s.title} accent={s.accent ?? "#7c6cf0"} size={16} />;
    if (s.icon) return <span style={{ fontSize: 15 }}>{s.icon}</span>;
    if (s.type === "Skill") return <Icon name="package" size={15} />;
    if (s.type === "Routine") return <Icon name="clock" size={15} />;
    return <span style={{ fontSize: 13, color: "var(--ink-tertiary)" }}>⌘</span>;
  };

  return (
    <div className="ac">
      {items.map((s, i) => (
        <button
          key={s.id}
          className={`ac__row${i === cursor ? " ac__row--on" : ""}`}
          onMouseEnter={() => onHover(i)}
          onMouseDown={(e) => {
            // mousedown, not click: the composer must not lose focus first.
            e.preventDefault();
            onPick(s);
          }}
        >
          <span className="ac__icon">{glyph(s)}</span>
          <span className="ac__title">{s.title}</span>
          {s.detail ? <span className="ac__detail">{s.detail}</span> : null}
          <span className="ac__type">{s.type}</span>
        </button>
      ))}
    </div>
  );
}
