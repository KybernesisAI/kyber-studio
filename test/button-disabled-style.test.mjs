import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

/**
 * How a disabled `.btn` looks, measured through the real stylesheet (KYB-598).
 *
 * `styles.css` sets `button { color: inherit; cursor: pointer; }` for every
 * button. That hides the user agent's own disabled look, so until a `.btn`
 * rule put one back, a disabled `.btn` was identical to a live one: same
 * colour, same fill, same hand cursor. The `button` rule has to stay: without
 * `color: inherit` button text falls back to black, 1.47:1 on the dark theme.
 *
 * jsdom applies the cascade (selectors and specificity) for `cursor` and
 * `opacity`, so the first test reads computed values from real markup rather
 * than looking for a rule by name. It does not resolve `var()` colours or the
 * `background` shorthand, so contrast is computed from the stylesheet's own
 * colour tokens instead.
 */

const CSS = readFileSync(new URL("../src/renderer/src/styles.css", import.meta.url), "utf8");

// One button pair per place the renderer puts a `.btn` that can be disabled,
// plus the variants it combines with. A rule scoped to one of these would
// pass in that container and fail in the others.
const PLACES = [
  { name: "bare", wrap: "", cls: "btn" },
  { name: "primary", wrap: "", cls: "btn btn--primary" },
  { name: "small", wrap: "", cls: "btn btn--small" },
  { name: "new-room footer", wrap: "newroom__foot", cls: "btn btn--primary" },
  { name: "server row", wrap: "pl__row", cls: "btn" },
  { name: "account actions", wrap: "cd__acct", cls: "btn" },
  { name: "sign-in actions", wrap: "signin__actions", cls: "btn" },
  { name: "damaged-config block", wrap: "empty", cls: "btn btn--primary" },
  { name: "card actions", wrap: "kcard__actions", cls: "btn btn--primary" },
  { name: "dialog row", wrap: "stack-row", cls: "btn" },
];

function render() {
  const body = PLACES.map(
    ({ wrap, cls }, i) =>
      `<div class="${wrap}"><button id="live${i}" class="${cls}">Live</button>` +
      `<button id="off${i}" class="${cls}" disabled>Off</button></div>`,
  ).join("");
  const dom = new JSDOM(`<!doctype html><html><head><style>${CSS}</style></head><body><div class="modal">${body}</div></body></html>`);
  return dom.window;
}

/** Every style rule in the sheet, including those inside `@media`, with the condition. */
function styleRules(window) {
  const out = [];
  const walk = (rules, media) => {
    for (const r of rules) {
      if (r.selectorText !== undefined) out.push({ rule: r, media });
      else if (r.cssRules) walk(r.cssRules, r.media ? r.media.mediaText : media);
    }
  };
  walk(window.document.styleSheets[0].cssRules, null);
  return out;
}

test("a disabled .btn is dimmed and has no hand cursor, wherever the app puts one", () => {
  const w = render();
  PLACES.forEach(({ name }, i) => {
    const live = w.getComputedStyle(w.document.getElementById(`live${i}`));
    const off = w.getComputedStyle(w.document.getElementById(`off${i}`));
    // The live twin is the control: if it stopped reading as a pointer at
    // full opacity, the assertions below would prove nothing.
    assert.equal(live.cursor, "pointer", `${name}: a live .btn lost its hand cursor`);
    assert.equal(Number(live.opacity), 1, `${name}: a live .btn is dimmed`);
    assert.notEqual(off.cursor, "pointer", `${name}: a disabled .btn still shows a hand cursor`);
    assert.ok(
      Number(off.opacity) < Number(live.opacity),
      `${name}: a disabled .btn (opacity ${off.opacity}) looks the same as a live one (${live.opacity})`,
    );
  });
});

test("one shared rule styles a disabled .btn, not one per container", () => {
  const w = render();
  const disabledBtn = styleRules(w)
    .flatMap(({ rule }) => rule.selectorText.split(",").map((s) => s.trim()))
    .filter((s) => /\.btn\b/.test(s) && /(:disabled|\[disabled\])/.test(s));
  const scoped = disabledBtn.filter((s) => !/^\.btn(:disabled|\[disabled\])$/.test(s));
  assert.deepEqual(scoped, [], "a disabled .btn is styled only inside a particular container");
  assert.ok(disabledBtn.length >= 1, "no rule styles a disabled .btn at all");
});

test("the button rule keeps color: inherit, so live button text stays --ink", () => {
  // Deleting this rule is the obvious fix and the wrong one: measured in
  // Chromium, live button text then falls back to black, 1.47:1 on dark.
  const w = render();
  const rule = styleRules(w).find(({ rule, media }) => !media && rule.selectorText.trim() === "button");
  assert.ok(rule, "the base button rule is gone");
  assert.equal(rule.rule.style.getPropertyValue("color"), "inherit", "the button rule no longer inherits colour");
});

// ── contrast of the primary button, which the damaged-config way out uses ────

function tokens(window, media) {
  const out = {};
  for (const { rule, media: m } of styleRules(window)) {
    if (rule.selectorText.trim() !== ":root" || (m !== null && m !== media)) continue;
    for (let i = 0; i < rule.style.length; i++) {
      const p = rule.style[i];
      if (p.startsWith("--")) out[p] = rule.style.getPropertyValue(p).trim();
    }
  }
  return out;
}

function resolve(value, vars) {
  let v = value.trim();
  for (let n = 0; n < 10 && v.startsWith("var("); n++) v = vars[v.slice(4, -1).trim()].trim();
  return v;
}

function rgba(colour) {
  const hex = colour.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const fn = colour.match(/^rgba?\(([^)]+)\)$/i);
  assert.ok(fn, `cannot read the colour ${colour}`);
  const p = fn[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const luminance = (c) =>
  c
    .slice(0, 3)
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("the primary button's label has at least 4.5:1 against its fill, in both themes", () => {
  const w = render();
  const primary = styleRules(w).find(({ rule, media }) => !media && rule.selectorText.trim() === ".btn--primary");
  assert.ok(primary, "the .btn--primary rule is gone");
  const fill = primary.rule.style.getPropertyValue("background") || primary.rule.style.getPropertyValue("background-color");

  // Inside the damaged-config block, whose own colour is the tertiary grey
  // that made the old label unreadable: the primary colour must win there.
  const inEmpty = w.document.getElementById(`live${PLACES.findIndex((p) => p.wrap === "empty")}`);
  const label = w.getComputedStyle(inEmpty).color;

  for (const [theme, media] of [["light", null], ["dark", "(prefers-color-scheme: dark)"]]) {
    const vars = { ...tokens(w, null), ...(media ? tokens(w, media) : {}) };
    const surface = rgba(resolve("var(--surface)", vars));
    const bg = over(rgba(resolve(fill, vars)), surface);
    const fg = over(rgba(resolve(label, vars)), bg);
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `${theme}: the primary button's label is ${ratio.toFixed(2)}:1 against its fill`);
  }
});
