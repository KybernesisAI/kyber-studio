import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";

/**
 * How a `.btn` looks when disabled and when hovered, measured through the real
 * stylesheet (KYB-598).
 *
 * `styles.css` sets `button { color: inherit; cursor: pointer; }` for every
 * button. That hides the user agent's own disabled look, so until a `.btn`
 * rule put one back, a disabled `.btn` was identical to a live one: same
 * colour, same fill, same hand cursor. The `button` rule has to stay: without
 * `color: inherit` button text falls back to black, 1.47:1 on the dark theme.
 *
 * And `.btn:hover` is more specific than `.btn--primary`, so a hovered primary
 * button used to swap its solid fill for the faint hover tint while keeping
 * its inverse label: 1.14:1 in light, 1.35:1 in dark, measured in Chromium
 * with the hover's 0.87 opacity applied.
 *
 * jsdom applies the cascade (selectors, specificity, order), so these tests
 * read computed values from real markup rather than looking for a rule by
 * name. Two adjustments to the stylesheet text make that possible, and
 * neither changes which rule wins:
 *
 *  - `:hover` becomes the class `.is-hover`. Both weigh one class in
 *    specificity, and a test can put a class on an element where it cannot
 *    put the pointer.
 *  - `background:` becomes `background-color:`. jsdom drops the shorthand when
 *    its value is a `var()`; every `.btn` fill is a single colour, so the
 *    longhand carries the same value.
 *
 * jsdom does not resolve `var()`, so colours come back as token names and
 * contrast is computed from the stylesheet's own token values.
 */

const SOURCE = readFileSync(new URL("../src/renderer/src/styles.css", import.meta.url), "utf8");
const CSS = SOURCE.replace(/:hover\b/g, ".is-hover").replace(/\bbackground:/g, "background-color:");

// One place per container the renderer puts a `.btn` in, with the variant it
// uses there. A rule scoped to one of these would pass there and fail in the
// others.
const PLACES = [
  { name: "bare", wrap: "", cls: "btn" },
  { name: "primary", wrap: "", cls: "btn btn--primary" },
  { name: "small", wrap: "", cls: "btn btn--small" },
  { name: "new-room footer", wrap: "newroom__foot", cls: "btn btn--primary" },
  { name: "server row", wrap: "pl__row", cls: "btn" },
  { name: "server row, Connect", wrap: "pl__row", cls: "btn btn--primary" },
  { name: "sign-in card, Connect", wrap: "card", cls: "btn btn--primary" },
  { name: "account actions", wrap: "cd__acct", cls: "btn" },
  { name: "sign-in actions", wrap: "signin__actions", cls: "btn" },
  { name: "damaged-config block", wrap: "empty", cls: "btn btn--primary" },
  { name: "card actions", wrap: "kcard__actions", cls: "btn btn--primary" },
  { name: "dialog row", wrap: "stack-row", cls: "btn" },
];

// The class that stands in for `:hover` (see above).
const HOVER = "is-hover";

// Each place gets the same button three ways: live, hovered and disabled.
function render() {
  const body = PLACES.map(
    ({ wrap, cls }, i) =>
      `<div class="${wrap}">` +
      `<button id="live${i}" class="${cls}">Live</button>` +
      `<button id="hover${i}" class="${cls} ${HOVER}">Hovered</button>` +
      `<button id="off${i}" class="${cls}" disabled>Off</button>` +
      `</div>`,
  ).join("");
  const dom = new JSDOM(
    `<!doctype html><html><head><style>${CSS}</style></head><body><div class="modal">${body}</div></body></html>`,
  );
  return dom.window;
}

const style = (w, id) => w.getComputedStyle(w.document.getElementById(id));

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
    const live = style(w, `live${i}`);
    const off = style(w, `off${i}`);
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
  // `.btn` as a whole class name: `-` is a word boundary, so a plain `\b`
  // would also count `.btn--primary` and `.btn--small`.
  const disabledBtn = styleRules(w)
    .flatMap(({ rule }) => rule.selectorText.split(",").map((s) => s.trim()))
    .filter((s) => /\.btn(?![\w-])/.test(s) && /(:disabled|\[disabled\])/.test(s));
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

// ── contrast of the primary button, at rest and hovered ─────────────────────

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
  for (let n = 0; n < 10 && v.startsWith("var("); n++) {
    const name = v.slice(4, -1).trim();
    assert.ok(name in vars, `the token ${name} is not defined`);
    v = vars[name].trim();
  }
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

/**
 * Label against fill as drawn on screen: the fill over the modal surface, the
 * label over the fill, then both faded by the element's opacity over the
 * surface, which is what `.btn--primary:hover`'s 0.87 does.
 */
function onScreenContrast(computed, vars) {
  const surface = rgba(resolve("var(--surface)", vars));
  const fill = over(rgba(resolve(computed.backgroundColor, vars)), surface);
  const label = over(rgba(resolve(computed.color, vars)), fill);
  const opacity = Number(computed.opacity);
  const faded = (c) => over([c[0], c[1], c[2], opacity], surface);
  return contrast(faded(label), faded(fill));
}

test("a primary button's label has at least 4.5:1 against its fill, at rest and hovered, in both themes", () => {
  const w = render();
  const primaries = PLACES.map((p, i) => ({ ...p, i })).filter((p) => p.cls.includes("btn--primary"));
  // The damaged-config block is the case this exists for: its own colour is
  // the tertiary grey that made the old recovery label unreadable.
  assert.ok(primaries.some((p) => p.wrap === "empty"), "the damaged-config block is not among the places measured");

  for (const [theme, media] of [["light", null], ["dark", "(prefers-color-scheme: dark)"]]) {
    const vars = { ...tokens(w, null), ...(media ? tokens(w, media) : {}) };
    for (const { name, i } of primaries) {
      for (const state of ["live", "hover"]) {
        const ratio = onScreenContrast(style(w, `${state}${i}`), vars);
        assert.ok(
          ratio >= 4.5,
          `${theme}, ${name}, ${state === "hover" ? "hovered" : "at rest"}: the primary label is ${ratio.toFixed(2)}:1 against its fill`,
        );
      }
    }
  }
});

test("every component spells the primary class the way the stylesheet does", () => {
  // Two Connect buttons in Plugins.tsx were `btn btn-primary`, one dash. The
  // stylesheet defines no such class, so both rendered as a plain `.btn` and
  // nothing failed. This reads source text rather than rendering, because
  // the second of them is only on screen part-way through adding a server.
  assert.ok(!/\.btn-primary\b/.test(SOURCE), "the stylesheet now defines .btn-primary; this test's premise has changed");
  const dir = new URL("../src/renderer/src/", import.meta.url);
  const misspelt = [];
  for (const entry of readdirSync(dir, { recursive: true })) {
    const file = String(entry);
    if (!file.endsWith(".tsx")) continue;
    readFileSync(new URL(file, dir), "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(/\bbtn[-_]+primary\b/g)) {
          if (m[0] !== "btn--primary") misspelt.push(`${file}:${i + 1}: ${m[0]}`);
        }
      });
  }
  assert.deepEqual(misspelt, [], `primary class misspelt, so the button renders plain:\n${misspelt.join("\n")}`);
});
