import {
  cardTitle,
  isKnownCard,
  money,
  routineSchedule,
  type ApprovalData,
  type ArtifactData,
  type Card,
  type CardAction,
  type ChartData,
  type KnownCard,
  type StatTile,
} from "@kybernesis/cards";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { formatSize } from "../lib/attachments";
import { Markdown } from "./Markdown";
import { Icon } from "./primitives";
import { Spinner } from "./Spinner";

/**
 * Cards in a reply: what a tool handed back, drawn instead of described.
 *
 * Every card shares one frame (a title, where the data came from, the body,
 * at most a few buttons), so a new type is only a new body. A card is data,
 * never markup; the only thing here that runs anything is an artifact, which
 * runs in a sandboxed frame that cannot reach the agent or the network.
 *
 * Ink and greys only. Green and red appear where they mean good and bad: a
 * change, a check, a diff line. Nothing else is coloured.
 */

export interface CardContext {
  /** The agent's base URL, for pictures and artifacts on its own origin. */
  agentUrl?: string;
  /** A `say` action: sent as the person's next message, only when pressed. */
  onSay(text: string): void;
  onOpenArtifact(artifactId: string, title?: string, version?: number): void;
}

const isHttp = (url: string): boolean => /^https?:\/\//i.test(url);

function openUrl(url: string, ctx: CardContext): void {
  // A path is on the agent's own address.
  const target = isHttp(url) ? url : ctx.agentUrl ? new URL(url, ctx.agentUrl).toString() : null;
  if (target) void window.studio?.openExternal(target);
}

function Actions({ actions, ctx }: { actions?: CardAction[]; ctx: CardContext }): ReactNode {
  if (!actions?.length) return null;
  return (
    <div className="kcard__actions">
      {actions.map((a, i) => (
        <button
          key={i}
          className={`btn${a.primary ? " btn--primary" : ""}`}
          onClick={() => {
            if (a.artifact) ctx.onOpenArtifact(a.artifact);
            else if (a.url) openUrl(a.url, ctx);
            else if (a.say) ctx.onSay(a.say);
          }}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}

function toneClass(tone?: string): string {
  return tone === "good" ? " is-good" : tone === "bad" ? " is-bad" : "";
}

function Tiles({ tiles }: { tiles: StatTile[] }): ReactNode {
  return (
    <div className="kstats">
      {tiles.map((t, i) => (
        <div key={i} className="kstats__tile">
          <div className="klabel">{t.label}</div>
          <div className="kstats__value">{t.value}</div>
          {t.change ? <div className={`kstats__change${toneClass(t.tone)}`}>{t.change}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** "30" and "emails" → "30 emails"; "%" and "k" stay attached. */
export function withUnit(value: string, unit?: string): string {
  if (!unit) return value;
  return /^[A-Za-z]/.test(unit) ? `${value} ${unit}` : `${value}${unit}`;
}

/** A line, area or bar chart as SVG, with the values under the pointer. */
function Chart({ data }: { data: ChartData }): ReactNode {
  const W = 600;
  const H = 160;
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const n = data.x.length;
  const all = data.series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all, lo + 1);
  const y = (v: number): number => H - 6 - ((v - lo) / (hi - lo)) * (H - 12);
  const x = (i: number): number => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
  const fmt = (v: number): string => withUnit(v.toLocaleString(), data.unit);
  const bars = data.kind === "bar";
  // Where point i sits across the plot, as a share of its width: bars sit in the middle of their slot.
  const across = (i: number): number => (bars ? (i + 0.5) / Math.max(1, n) : x(i) / W);

  const marks = data.series.map((s, si) => {
    if (data.kind === "bar") {
      const group = W / Math.max(1, n);
      const width = (group * 0.7) / data.series.length;
      return s.values.map((v, i) => (
        <rect
          key={`${si}-${i}`}
          className={`kchart__bar kchart__s${si}`}
          x={i * group + group * 0.15 + si * width}
          y={Math.min(y(v), y(0))}
          width={Math.max(1, width - 1)}
          height={Math.abs(y(0) - y(v))}
        />
      ));
    }
    const points = s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
    return (
      <g key={si}>
        {data.kind === "area" && si === 0 ? (
          <polygon className={`kchart__area kchart__s${si}`} points={`${x(0)},${y(lo)} ${points} ${x(s.values.length - 1)},${y(lo)}`} />
        ) : null}
        <polyline className={`kchart__line kchart__s${si}`} points={points} vectorEffect="non-scaling-stroke" />
      </g>
    );
  });

  const label = (i: number): string => data.x[i] ?? "";
  // Every label while they fit (a week of days); otherwise the ends and the middle.
  const ticks = n <= (bars ? 12 : 8) ? [...Array(n).keys()] : [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <div className="kchart">
      {data.series.length > 1 ? (
        <div className="kchart__legend">
          {data.series.map((s, si) => (
            <span key={si} className="kchart__key">
              <span className={`kchart__swatch kchart__s${si}`} />
              {s.name}
            </span>
          ))}
        </div>
      ) : null}
      <div className="kchart__plot">
        <div className="kchart__y">
          <span>{fmt(hi)}</span>
          <span>{fmt(lo)}</span>
        </div>
        <div className="kchart__frame">
          <svg
            ref={ref}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="kchart__svg"
            onMouseMove={(e) => {
              const box = ref.current?.getBoundingClientRect();
              if (!box || n === 0) return;
              const share = (e.clientX - box.left) / box.width;
              const at = bars ? Math.floor(share * n) : Math.round(share * (n - 1));
              setHover(Math.max(0, Math.min(n - 1, at)));
            }}
            onMouseLeave={() => setHover(null)}
          >
            <line className="kchart__base" x1={0} x2={W} y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
            {marks}
            {hover !== null ? (
              <line className="kchart__rule" x1={across(hover) * W} x2={across(hover) * W} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
            ) : null}
          </svg>
          {hover !== null ? (
            <div className="kchart__tip" style={{ left: `${across(hover) * 100}%` }}>
              <div className="klabel">{label(hover)}</div>
              {data.series.map((s, si) => (
                <div key={si}>
                  {data.series.length > 1 ? `${s.name} ` : ""}
                  <strong>{fmt(s.values[hover] ?? 0)}</strong>
                </div>
              ))}
            </div>
          ) : null}
          <div className={bars ? "kchart__x kchart__x--slots" : "kchart__x"} style={bars ? { gridTemplateColumns: `repeat(${n}, 1fr)` } : undefined}>
            {bars
              ? data.x.map((_, i) => <span key={i}>{ticks.includes(i) ? label(i) : ""}</span>)
              : ticks.map((i) => <span key={i}>{label(i)}</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A picture on the agent, fetched with the person's token. */
function AgentImage({ src, alt, agentUrl }: { src: string; alt: string; agentUrl?: string }): ReactNode {
  const [state, setState] = useState<{ dataUrl?: string; error?: string } | null>(null);
  const [big, setBig] = useState(false);
  useEffect(() => {
    let live = true;
    if (src.startsWith("data:image/")) {
      setState({ dataUrl: src });
      return;
    }
    if (!agentUrl) {
      setState({ error: "No agent address to fetch this from." });
      return;
    }
    setState(null);
    void window.studio?.agentImage({ url: agentUrl, src }).then((r) => {
      if (live) setState(r.ok ? { dataUrl: r.dataUrl } : { error: r.error });
    });
    return () => {
      live = false;
    };
  }, [src, agentUrl]);

  if (!state) return <div className="kshot__wait"><Spinner /></div>;
  if (!state.dataUrl) {
    return (
      <div className="kshot__missing">
        {state.error}
        {isHttp(src) ? (
          <button className="btn" onClick={() => void window.studio?.openExternal(src)}>
            Open in browser
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <img
      className={`kshot__img${big ? " kshot__img--big" : ""}`}
      src={state.dataUrl}
      alt={alt}
      onClick={() => setBig((b) => !b)}
      title={big ? "Smaller" : "Larger"}
    />
  );
}

/**
 * An artifact drawn in the conversation: its content in a sandboxed frame
 * (`allow-scripts` without `allow-same-origin`, so it has no origin of its own
 * and cannot reach the agent, the app, or the network), or markdown through
 * the same renderer as replies.
 */
export function ArtifactFrame({
  agentUrl,
  artifactId,
  version,
  className,
}: {
  agentUrl?: string;
  artifactId: string;
  version?: number;
  className?: string;
}): ReactNode {
  const [state, setState] = useState<{ content?: string; format?: string; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    setState(null);
    if (!agentUrl) {
      setState({ error: "No agent address to fetch this from." });
      return;
    }
    void window.studio?.agentArtifact({ url: agentUrl, artifactId, version }).then((r) => {
      if (live) setState(r.ok ? { content: r.content, format: r.format } : { error: r.error });
    });
    return () => {
      live = false;
    };
  }, [agentUrl, artifactId, version]);

  if (!state) return <div className={`kartifact__wait ${className ?? ""}`}><Spinner /></div>;
  if (state.error) return <div className={`kartifact__missing ${className ?? ""}`}>{state.error}</div>;
  if (state.format === "markdown") {
    return (
      <div className={`kartifact__doc ${className ?? ""}`}>
        <Markdown text={state.content ?? ""} />
      </div>
    );
  }
  return (
    <iframe
      className={`kartifact__frame ${className ?? ""}`}
      sandbox="allow-scripts"
      srcDoc={withPolicy(state.content ?? "")}
      title="Artifact"
      referrerPolicy="no-referrer"
    />
  );
}

/**
 * The frame's own content policy, first in the document: inline code and data
 * only, no network. The sandbox already gives it no origin; this also stops it
 * loading a script or an image from anywhere.
 */
function withPolicy(html: string): string {
  const csp =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:";
  return `<meta http-equiv="Content-Security-Policy" content="${csp}">${html}`;
}

export function dateLabel(iso?: string): string | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return undefined;
  return new Date(at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function ArtifactBody({ data, title, ctx }: { data: ArtifactData; title?: string; ctx: CardContext }): ReactNode {
  const meta = [
    data.format === "markdown" ? "Document" : "Page",
    data.version ? `v${data.version}` : undefined,
    dateLabel(data.updatedAt) ? `updated ${dateLabel(data.updatedAt)}` : undefined,
  ].filter(Boolean);
  return (
    <>
      {data.display === "inline" ? (
        <ArtifactFrame agentUrl={ctx.agentUrl} artifactId={data.artifactId} version={data.version} className="kartifact--inline" />
      ) : (
        // A document shows its top as a preview; the whole thing opens on a click.
        <button
          className="kartifact__preview"
          aria-label={`Open ${title ?? "artifact"}`}
          onClick={() => ctx.onOpenArtifact(data.artifactId, title, data.version)}
        >
          <ArtifactFrame agentUrl={ctx.agentUrl} artifactId={data.artifactId} version={data.version} className="kartifact--preview" />
        </button>
      )}
      <div className="kartifact__row">
        <span className="kartifact__meta">{meta.join(" · ")}</span>
      </div>
      {/* Open is always there, even when the card has its own actions. */}
      <div className="kcard__actions">
        <button className="btn btn--primary" onClick={() => ctx.onOpenArtifact(data.artifactId, title, data.version)}>
          Open
        </button>
      </div>
    </>
  );
}

/** An event's time as a person reads it: "Thu 29 Oct, 2:00 PM – 3:00 PM". A date alone stays a date. */
export function whenLabel(when?: string, until?: string): string | undefined {
  if (!when) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const at = Date.parse(when);
  if (Number.isNaN(at)) return until ? `${when} – ${until}` : when;
  if (dateOnly.test(when)) {
    return new Date(`${when}T00:00:00`).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  }
  const start = new Date(at);
  const head = start.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const end = until ? Date.parse(until) : NaN;
  if (Number.isNaN(end)) return head;
  const sameDay = new Date(end).toDateString() === start.toDateString();
  const tail = new Date(end).toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  return `${head} – ${tail}`;
}

/**
 * What an approval would do, as the thing itself: the email with its
 * recipients and body, the event with its time and people. Read-only; the
 * buttons belong to the question that holds it.
 */
export function ApprovalBody({ data }: { data: ApprovalData }): ReactNode {
  const rows: [string, string][] = [];
  if (data.kind === "email") {
    if (data.to?.length) rows.push(["To", data.to.join(", ")]);
    if (data.cc?.length) rows.push(["Cc", data.cc.join(", ")]);
    if (data.subject) rows.push(["Subject", data.subject]);
  } else if (data.kind === "event") {
    if (data.subject) rows.push(["Event", data.subject]);
    const when = whenLabel(data.when, data.until);
    if (when) rows.push(["When", when]);
    if (data.where) rows.push(["Where", data.where]);
    if (data.people?.length) rows.push(["With", data.people.join(", ")]);
  } else if (data.kind === "message") {
    if (data.channel) rows.push(["In", data.channel]);
    if (data.to?.length) rows.push(["To", data.to.join(", ")]);
  }
  for (const f of data.fields ?? []) rows.push([f.label, f.value]);
  return (
    <div className="kapproval">
      {rows.length ? (
        <dl className="kapproval__rows">
          {rows.map(([label, value], i) => (
            <div key={i} className="kapproval__row">
              <dt className="klabel">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {data.body ? <div className="kapproval__body">{data.body}</div> : null}
    </div>
  );
}

function CheckGlyph({ state }: { state: string }): ReactNode {
  if (state === "passed" || state === "done") return <span className="kglyph is-good">✓</span>;
  if (state === "failed") return <span className="kglyph is-bad">✗</span>;
  if (state === "running") return <span className="kglyph">…</span>;
  if (state === "skipped") return <span className="kglyph">–</span>;
  return <span className="kglyph">○</span>;
}

function Body({ card, ctx }: { card: KnownCard; ctx: CardContext }): ReactNode {
  switch (card.card) {
    case "stats":
      return <Tiles tiles={card.data.tiles} />;
    case "chart":
      return <Chart data={card.data} />;
    case "table": {
      const d = card.data;
      const cell = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "number" ? v.toLocaleString() : String(v));
      return (
        <div className="ktable">
          <table>
            <thead>
              <tr>
                {d.columns.map((c) => (
                  <th key={c.key} style={c.align === "right" ? { textAlign: "right" } : undefined}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r, i) => (
                <tr key={i}>
                  {d.columns.map((c) => (
                    <td key={c.key} style={c.align === "right" || typeof r[c.key] === "number" ? { textAlign: "right" } : undefined}>
                      {cell(r[c.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {d.total && d.total > d.rows.length ? (
            <div className="ktable__more">
              Showing {d.rows.length.toLocaleString()} of {d.total.toLocaleString()} rows
            </div>
          ) : null}
        </div>
      );
    }
    case "checklist":
      return (
        <ul className="kcheck">
          {card.data.items.map((item, i) => (
            <li key={i} className={`kcheck__item kcheck__item--${item.state}`}>
              <CheckGlyph state={item.state} />
              <span>
                {item.text}
                {item.detail ? <span className="kcheck__detail"> {item.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      );
    case "brief": {
      const d = card.data;
      return (
        <div className="kbrief">
          <div className="kbrief__head">
            <span className="kbrief__initial">{(d.initial ?? d.name.slice(0, 1)).toUpperCase()}</span>
            <div>
              <div className="kbrief__name">{d.name}</div>
              {d.subtitle ? <div className="kbrief__sub">{d.subtitle}</div> : null}
            </div>
          </div>
          {d.points?.length ? (
            <ul className="kbrief__points">
              {d.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          ) : null}
          {d.facts?.length ? (
            <dl className="kbrief__facts">
              {d.facts.map((f, i) => (
                <div key={i}>
                  <dt className="klabel">{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {d.tiles?.length ? <Tiles tiles={d.tiles} /> : null}
        </div>
      );
    }
    case "link": {
      const d = card.data;
      return (
        <button className="klink" onClick={() => openUrl(d.url, ctx)}>
          {d.description ? <div className="klink__desc">{d.description}</div> : null}
          <div className="klink__url">{d.site ?? d.url}</div>
        </button>
      );
    }
    case "screenshot": {
      const d = card.data;
      return (
        <div className="kshot">
          <AgentImage src={d.image} alt={d.caption ?? "Screenshot"} agentUrl={ctx.agentUrl} />
          {d.caption || d.site ? (
            <div className="kshot__caption">
              {d.caption}
              {d.site ? <span className="kshot__site">{d.site}</span> : null}
            </div>
          ) : null}
        </div>
      );
    }
    case "file": {
      const d = card.data;
      return (
        <div className="kfile">
          <Icon name="package" size={18} />
          <div className="kfile__name">
            {d.name}
            {d.size ? <span className="kfile__size">{formatSize(d.size)}</span> : null}
          </div>
          {isHttp(d.url) ? (
            <button className="btn" onClick={() => void window.studio?.openRemoteFile({ url: d.url, suggestedName: d.name })}>
              Open
            </button>
          ) : null}
        </div>
      );
    }
    case "artifact":
      return <ArtifactBody data={card.data} title={card.title} ctx={ctx} />;
    case "pull-request": {
      const d = card.data;
      return (
        <div className="kpr">
          {d.summary ? <div className="kpr__summary">{d.summary}</div> : null}
          {d.additions !== undefined || d.deletions !== undefined ? (
            <div className="kpr__delta">
              <span className="is-good">+{d.additions ?? 0}</span> <span className="is-bad">−{d.deletions ?? 0}</span>
            </div>
          ) : null}
          {d.checks?.length ? (
            <ul className="kcheck">
              {d.checks.map((c, i) => (
                <li key={i} className="kcheck__item">
                  <CheckGlyph state={c.state} />
                  <span>
                    {c.name}
                    {c.detail ? <span className="kcheck__detail"> {c.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {d.diff ? (
            <div className="kdiff">
              <div className="kdiff__file">{d.diff.file}</div>
              {d.diff.lines.map((line, i) => (
                <div key={i} className={`kdiff__line${line.startsWith("+") ? " is-good" : line.startsWith("-") ? " is-bad" : ""}`}>
                  {line}
                </div>
              ))}
            </div>
          ) : null}
          {d.reviewer ? <div className="kpr__meta">Review: {d.reviewer}</div> : null}
          <div className="kcard__actions">
            <button className="btn" onClick={() => openUrl(d.url, ctx)}>
              View pull request
            </button>
            {d.preview ? (
              <button className="btn" onClick={() => openUrl(d.preview!, ctx)}>
                Preview
              </button>
            ) : null}
          </div>
        </div>
      );
    }
    case "receipt": {
      const d = card.data;
      return (
        <div className="kreceipt">
          <div className="kreceipt__amount">{money(d.amount, d.currency)}</div>
          {d.orderId ? <div className="kreceipt__meta">Order {d.orderId}</div> : null}
          {d.note ? <div className="kreceipt__note">{d.note}</div> : null}
          {d.file && isHttp(d.file.url) ? (
            <button className="btn" onClick={() => void window.studio?.openRemoteFile({ url: d.file!.url, suggestedName: d.file!.name })}>
              {d.file.name}
            </button>
          ) : null}
        </div>
      );
    }
    case "remembered":
      return <div className="kremember">{card.data.fact}</div>;
    case "approval":
      return <ApprovalBody data={card.data} />;
    case "form":
      // A form is answered where it was asked; shown anywhere else, it lists what it asks.
      return (
        <ol className="kform__list">
          {card.data.fields.map((f) => (
            <li key={f.id}>{f.label}</li>
          ))}
        </ol>
      );
    case "routine": {
      const d = card.data;
      return (
        <div className="kroutine">
          <div>{routineSchedule(d)}</div>
          {d.nextRun ? <div className="kroutine__meta">Next run {dateLabel(d.nextRun)}</div> : null}
          {d.posts?.length ? <div className="kroutine__meta">Posts to {d.posts.join(", ")}</div> : null}
        </div>
      );
    }
  }
}

const SOURCE_DEFAULTS: Partial<Record<string, string>> = {
  remembered: "Memory",
  artifact: "Artifact",
  screenshot: "Computer",
  receipt: "Payments",
  "pull-request": "GitHub",
  routine: "Routine",
  form: "Question",
};

export function CardView({ card, ctx }: { card: Card; ctx: CardContext }): ReactNode {
  const title = cardTitle(card);
  const source = card.source ?? SOURCE_DEFAULTS[card.card];
  const known = isKnownCard(card);
  const compact = card.card === "remembered";
  return (
    <div className={`kcard kcard--${known ? card.card : "unknown"}${compact ? " kcard--compact" : ""}`}>
      {title || source ? (
        <div className="kcard__head">
          {title ? <span className="kcard__title">{title}</span> : <span className="kcard__title" />}
          {source ? <span className="klabel kcard__source">{source}</span> : null}
        </div>
      ) : null}
      {known ? <Body card={card} ctx={ctx} /> : <div className="kcard__text">{card.text}</div>}
      <Actions actions={card.card === "artifact" ? card.actions?.filter((a) => !a.artifact) : card.actions} ctx={ctx} />
    </div>
  );
}

/** Several cards, in the order they arrived. */
export function CardStack({ cards, ctx }: { cards: Card[]; ctx: CardContext }): ReactNode {
  if (cards.length === 0) return null;
  return (
    <div className="kcards">
      {cards.map((card, i) => (
        <CardView key={card.id ?? i} card={card} ctx={ctx} />
      ))}
    </div>
  );
}
