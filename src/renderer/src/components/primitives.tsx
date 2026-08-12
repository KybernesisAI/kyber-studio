import type { ReactNode } from "react";

/** Inline SVG so the app has no icon dependency and no network fetch. */
export function Icon({ name, size = 16 }: { name: string; size?: number }): ReactNode {
  const paths: Record<string, ReactNode> = {
    search: <><circle cx="7" cy="7" r="5" /><path d="M11 11l4 4" /></>,
    plus: <path d="M8 3v10M3 8h10" />,
    chevronRight: <path d="M6 3l5 5-5 5" />,
    chevronLeft: <path d="M10 3L5 8l5 5" />,
    close: <path d="M4 4l8 8M12 4l-8 8" />,
    monitor: <><rect x="2" y="3" width="12" height="9" rx="1.5" /><path d="M6 14h4" /></>,
    plug: <><path d="M6 2v4M10 2v4" /><path d="M4 6h8v3a4 4 0 01-8 0z" /><path d="M8 13v2" /></>,
    gear: <><circle cx="8" cy="8" r="2.4" /><path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" /></>,
    clock: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
    pin: <><path d="M6 2h4l-.7 4L12 8.5H4L6.7 6z" /><path d="M8 8.5V14" /></>,
    folderPlus: <><path d="M2 4.5h4l1.2 1.5H14v6.5H2z" /><path d="M8 8v3M6.5 9.5h3" /></>,
    bell: <><path d="M4.5 6.5a3.5 3.5 0 017 0c0 3 1 4 1 4h-9s1-1 1-4z" /><path d="M6.8 13a1.4 1.4 0 002.4 0" /></>,
    pencil: <><path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" /></>,
    copy: <><rect x="5" y="5" width="8" height="8" rx="1.5" /><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" /></>,
    eyeOff: <><path d="M2 8s2.4-4 6-4c1 0 1.9.3 2.7.8M14 8s-2.4 4-6 4c-1 0-1.9-.3-2.7-.8" /><path d="M2 2l12 12" /></>,
    trash: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2h5.8l.6-8.2" /></>,
    mic: <><rect x="6" y="2" width="4" height="7" rx="2" /><path d="M4 8a4 4 0 008 0M8 12v2" /></>,
    check: <path d="M3 8.5l3.5 3.5L13 5" />,
    filter: <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />,
    download: <><path d="M8 2.5v7M5 7l3 3 3-3" /><path d="M3 12.5h10" /></>,
    arrowUp: <><path d="M8 13V4M4 8l4-4 4 4" /></>,
    folder: <><path d="M2 4.5h4l1.2 1.5H14v6.5H2z" /></>,
    alert: <><path d="M8 2.6l6 10.8H2z" /><path d="M8 6.6v3.2M8 11.6v.01" /></>,
    package: <><path d="M8 1.8l5.5 3v6.4L8 14.2 2.5 11.2V4.8z" /><path d="M2.5 4.8L8 7.9l5.5-3.1M8 7.9v6.3" /></>,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? null}
    </svg>
  );
}

/**
 * Generated agent mark. Agents are identified by color and initial rather than
 * an uploaded image, so a fresh deployment looks intentional with no setup.
 */
export function Avatar({
  name,
  accent,
  size = 34,
}: {
  name: string;
  accent: string;
  size?: number;
}): ReactNode {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, background: accent, fontSize: size * 0.42 }}
      title={name}
    >
      {initial}
    </div>
  );
}

export function Toggle({ on, onChange }: { on: boolean; onChange(next: boolean): void }): ReactNode {
  return (
    <button
      className={`toggle${on ? " toggle--on" : ""}`}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="toggle__knob" />
    </button>
  );
}

/** Minimal inline markdown: `code` and bare URLs. Deliberately not a parser. */
export function RichText({ text }: { text: string }): ReactNode {
  const parts = text.split(/(`[^`]+`|https?:\/\/\S+)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
          return <code key={i}>{part.slice(1, -1)}</code>;
        }
        if (/^https?:\/\//.test(part)) {
          return (
            <a key={i} href={part} target="_blank" rel="noreferrer">
              {part}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function timeLabel(at: number): string {
  const d = new Date(at);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const days = Math.floor((today.getTime() - at) / 86_400_000);
  if (days < 7) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
}
