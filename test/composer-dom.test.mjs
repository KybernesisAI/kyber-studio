import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The serializer, which decides what actually gets SENT.
 *
 * A chip that serializes wrong is the worst kind of bug here: the composer
 * looks right, the message looks right, and the agent receives something else.
 *
 * Runs against a minimal DOM rather than a browser — enough of Node/Element for
 * the walk, since that is all `serialize` uses.
 */

const TEXT = 3;
const ELEMENT = 1;

function text(value) {
  return { nodeType: TEXT, textContent: value, childNodes: [] };
}

function el(tag, { mention, children = [] } = {}) {
  return {
    nodeType: ELEMENT,
    tagName: tag.toUpperCase(),
    dataset: mention ? { mention } : {},
    childNodes: children,
    __isElement: true,
  };
}

/** The serializer from composerDom.ts, with the instanceof check made portable. */
function serialize(root) {
  let out = "";
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === TEXT) {
        out += child.textContent ?? "";
        continue;
      }
      if (!child.__isElement) continue;
      if (child.dataset.mention) {
        out += `@${child.dataset.mention}`;
        continue;
      }
      if (child.tagName === "BR") {
        out += "\n";
        continue;
      }
      if (child.tagName === "DIV" || child.tagName === "P") {
        if (out && !out.endsWith("\n")) out += "\n";
        walk(child);
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return out;
}

test("a chip becomes the @name the agent expects", () => {
  const root = el("div", {
    children: [
      text("ask "),
      el("span", { mention: "sid", children: [el("span"), text("sid")] }),
      text(" what he knows about me"),
    ],
  });
  // Critically NOT "ask sidsid what..." — the chip's visible text must not be
  // serialized alongside its data-mention.
  assert.equal(serialize(root), "ask @sid what he knows about me");
});

test("the chip's own contents never leak into the message", () => {
  const root = el("div", {
    children: [el("span", { mention: "Chief of Staff", children: [text("Chief of Staff")] })],
  });
  assert.equal(serialize(root), "@Chief of Staff");
});

test("line breaks survive", () => {
  const root = el("div", { children: [text("one"), el("br"), text("two")] });
  assert.equal(serialize(root), "one\ntwo");
});

test("a pasted block becomes its own line, without doubling separators", () => {
  const root = el("div", {
    children: [text("first"), el("div", { children: [text("second")] })],
  });
  assert.equal(serialize(root), "first\nsecond");
});

test("an empty composer is an empty string, not whitespace", () => {
  assert.equal(serialize(el("div")), "");
});

test("two chips in one message both come through", () => {
  const root = el("div", {
    children: [
      el("span", { mention: "sid", children: [text("sid")] }),
      text(" and "),
      el("span", { mention: "eve-gtm", children: [text("eve-gtm")] }),
      text(" both"),
    ],
  });
  assert.equal(serialize(root), "@sid and @eve-gtm both");
});
