import MarkdownIt from "markdown-it";
import { type ReactNode, useMemo, useState } from "react";
import { Icon } from "./primitives";

/**
 * Agent replies as formatted text.
 *
 * markdown-it parses; this file draws its tokens as React elements. It never
 * produces an HTML string, and raw HTML in a reply is not parsed at all, so an
 * agent cannot put markup into the window by writing it.
 *
 * The hand-rolled renderer this replaces covered fences, headings, bullets,
 * bold and links. Agents also send numbered lists that restart at one, tables
 * that arrived as rows of pipes, quotes and task lists, and every one of those
 * read as broken punctuation.
 *
 * Code blocks keep their copy button. An unterminated fence still renders as
 * code: a streaming reply is unterminated for most of its life, and markdown-it
 * runs an open fence to the end of the text, which is the behaviour wanted.
 */

const md = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

type Token = ReturnType<MarkdownIt["parse"]>[number];
interface TokenNode {
  token: Token;
  children: TokenNode[];
  /** Set on a list item that opens with `[ ]` or `[x]`. */
  task?: "open" | "done";
}

/** markdown-it's flat open/close stream as a tree. */
function tree(tokens: Token[]): TokenNode[] {
  const root: TokenNode[] = [];
  const stack: TokenNode[][] = [root];
  for (const token of tokens) {
    const level = stack[stack.length - 1]!;
    if (token.nesting === 1) {
      const node: TokenNode = { token, children: [] };
      level.push(node);
      stack.push(node.children);
    } else if (token.nesting === -1) {
      if (stack.length > 1) stack.pop();
    } else {
      level.push({ token, children: [] });
    }
  }
  return root;
}

/** Only addresses a browser should open. markdown-it already refuses javascript: and friends. */
function safeHref(href: string | null): string | undefined {
  if (!href) return undefined;
  return /^(https?:|mailto:)/i.test(href) ? href : undefined;
}

function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <div className="code__bar">
        <span className="code__lang">{lang || "text"}</span>
        <button
          className="code__copy"
          onClick={() => {
            void navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={12} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code__body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function inline(nodes: TokenNode[]): ReactNode[] {
  return nodes.map((node, i) => {
    const t = node.token;
    switch (t.type) {
      case "text":
        return t.content;
      case "code_inline":
        return <code key={i}>{t.content}</code>;
      case "softbreak":
      case "hardbreak":
        return <br key={i} />;
      case "strong_open":
        return <strong key={i}>{inline(node.children)}</strong>;
      case "em_open":
        return <em key={i}>{inline(node.children)}</em>;
      case "s_open":
        return <s key={i}>{inline(node.children)}</s>;
      case "link_open": {
        const href = safeHref(t.attrGet("href"));
        return href ? (
          <a key={i} href={href} target="_blank" rel="noreferrer">
            {inline(node.children)}
          </a>
        ) : (
          <span key={i}>{inline(node.children)}</span>
        );
      }
      case "image": {
        // Remote images cannot load in this window (its CSP allows none), so
        // an image is offered as the link it is rather than drawn as a blank.
        const href = safeHref(t.attrGet("src"));
        const alt = t.content || "Image";
        return href ? (
          <a key={i} href={href} target="_blank" rel="noreferrer">
            {alt}
          </a>
        ) : (
          alt
        );
      }
      default:
        return t.content ? t.content : null;
    }
  });
}

/** The inline content of a block, parsed into a tree once. */
function inlineOf(node: TokenNode): ReactNode[] {
  const children = node.token.children ?? [];
  return inline(tree(children));
}

/**
 * Task-list items: `[ ]` or `[x]` opening a list item, which markdown-it leaves
 * as text. Marked once per parse, and the marker is cut from the text there,
 * never during a render (a render can run twice).
 */
function markTasks(nodes: TokenNode[]): TokenNode[] {
  for (const node of nodes) {
    if (node.token.type === "list_item_open") {
      const content = node.children[0]?.children[0];
      const first = content?.token.type === "inline" ? content.token.children?.[0] : undefined;
      const m = first?.type === "text" ? /^\[( |x|X)\]\s+/.exec(first.content) : null;
      if (first && m) {
        first.content = first.content.slice(m[0].length);
        node.task = m[1] === " " ? "open" : "done";
      }
    }
    markTasks(node.children);
  }
  return nodes;
}

function blocks(nodes: TokenNode[]): ReactNode[] {
  return nodes.map((node, i) => {
    const t = node.token;
    switch (t.type) {
      case "paragraph_open":
        // A tight list's paragraphs are hidden: the item IS the line.
        return t.hidden ? (
          <span key={i}>{blocks(node.children)}</span>
        ) : (
          <p key={i} className="md-p">
            {blocks(node.children)}
          </p>
        );
      case "inline":
        return <span key={i}>{inlineOf(node)}</span>;
      case "heading_open": {
        const level = Math.min(4, Number(t.tag.slice(1)) || 1);
        return (
          <div key={i} className={`md-h md-h${level}`} role="heading" aria-level={level}>
            {blocks(node.children)}
          </div>
        );
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const items = node.children.filter((c) => c.token.type === "list_item_open");
        const body = items.map((item, n) => {
          const task = item.task;
          return (
            <li key={n} className={task ? `md-task md-task--${task}` : undefined}>
              {task ? <span className="md-task__box" aria-hidden>{task === "done" ? "✓" : ""}</span> : null}
              {blocks(item.children)}
            </li>
          );
        });
        if (t.type === "ordered_list_open") {
          const start = Number(t.attrGet("start") ?? 1);
          return (
            <ol key={i} className="md-ol" start={Number.isFinite(start) ? start : 1}>
              {body}
            </ol>
          );
        }
        return (
          <ul key={i} className={`md-ul${items.some((item) => item.task) ? " md-ul--tasks" : ""}`}>
            {body}
          </ul>
        );
      }
      case "blockquote_open":
        return (
          <blockquote key={i} className="md-quote">
            {blocks(node.children)}
          </blockquote>
        );
      case "fence":
      case "code_block": {
        const lang = t.info.trim().split(/\s+/)[0] || undefined;
        return <CodeBlock key={i} code={t.content.replace(/\n$/, "")} lang={lang} />;
      }
      case "hr":
        return <hr key={i} className="md-hr" />;
      case "table_open":
        return (
          <div key={i} className="md-table">
            <table>{blocks(node.children)}</table>
          </div>
        );
      case "thead_open":
        return <thead key={i}>{blocks(node.children)}</thead>;
      case "tbody_open":
        return <tbody key={i}>{blocks(node.children)}</tbody>;
      case "tr_open":
        return <tr key={i}>{blocks(node.children)}</tr>;
      case "th_open":
      case "td_open": {
        const align = /text-align:(left|right|center)/.exec(t.attrGet("style") ?? "")?.[1] as
          | "left"
          | "right"
          | "center"
          | undefined;
        const Cell = t.type === "th_open" ? "th" : "td";
        return (
          <Cell key={i} style={align ? { textAlign: align } : undefined}>
            {blocks(node.children)}
          </Cell>
        );
      }
      default:
        return node.children.length ? <span key={i}>{blocks(node.children)}</span> : null;
    }
  });
}

export function Markdown({ text }: { text: string }): ReactNode {
  // A block saved by a newer Studio can reach an older reader with no text; draw nothing rather than crash the window.
  const nodes = useMemo(() => markTasks(tree(md.parse(typeof text === "string" ? text : "", {}))), [text]);
  return <div className="md">{blocks(nodes)}</div>;
}
