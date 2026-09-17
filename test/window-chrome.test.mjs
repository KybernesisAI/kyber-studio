import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { withoutComments } from "../scripts/lib/preload-shape.mjs";

/**
 * The window's macOS-only chrome options stay behind a darwin check.
 *
 * KYB-579. `titleBarStyle: "hiddenInset"` hides the titlebar and floats the
 * traffic lights over the content; `trafficLightPosition` places them. Neither
 * exists off darwin, so Electron silently ignores both on Linux and Windows.
 *
 * That is why this guard is worth having and also why it is easy to get wrong:
 * passing them everywhere produces NO visible defect on any platform. There is
 * nothing to notice, which is exactly the shape KYB-500 was opened to find —
 * "the risk is not wrong branches but missing ones". A silent assumption does
 * not announce itself when someone deletes the branch again.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not incidental. The block above the
 * options in index.ts names `hiddenInset` in prose. A naive text scan would be
 * satisfied by that prose while the real option sat unguarded one line below —
 * the precise trap test/renderer-sandbox.test.mjs documents for KYB-569, met
 * here by reusing the same comment stripper rather than writing a second one.
 *
 * EVERYTHING IS SCOPED TO THE BrowserWindow LITERAL, by brace matching, and the
 * first revision of this file was not — which review caught with a worked
 * counter-example rather than a worry. It anchored on the first
 * `platform.isMacOS` in the file and the first `{}` after it. Add one plausible
 * macOS line above createWindow() — `if (platform.isMacOS) app.dock?.setBadge()`
 * — and the "region" stretched across the whole intervening file, so an
 * unguarded `titleBarStyle` back in the window options counted as inside it.
 * All six tests passed with the KYB-579 defect live. A guard that cannot see the
 * regression it was written for is worse than none, because it is reported as
 * coverage.
 *
 * Hence three rules here, and they are the substance of this file:
 *
 *   1. Find the `new BrowserWindow({ ... })` literal by matching braces, and
 *      look ONLY inside it. Nothing elsewhere in the file can widen the window
 *      or satisfy an assertion.
 *   2. Require EXACTLY ONE `platform.isMacOS` in the whole source. The moment a
 *      second appears — likely, in a cross-platform epic — this fails loudly and
 *      whoever adds it re-reads this file, rather than silently moving the
 *      anchor.
 *   3. Take the guard's else-branch from the ternary itself, not from a
 *      character budget. The previous `[\s\S]{0,400}?` could skip the guard's
 *      own else and latch onto a later `: {})` belonging to a different spread;
 *      review demonstrated it with a `platform.isLinux` icon spread, which is a
 *      plausible next commit in an AppImage/.deb lane.
 *
 * What this still CANNOT see, stated rather than left to be discovered: it reads
 * text, so a computed guard defeats it. `...(someFlag ? { titleBarStyle } : {})`
 * passes as long as the identifier is `platform.isMacOS`; a guard that resolves
 * to `true` everywhere at runtime would too. Closing that needs a parser and an
 * evaluator, and it is not closed here.
 *
 * The brace matcher is brace-counting, not parsing: a `{` inside a string or a
 * template literal within the options would confuse it. There is none today, and
 * the first test in this file fails loudly if the literal stops closing where
 * these tests expect.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => resolve(join(here, "..", "src", ...p));

const mainSource = withoutComments(readFileSync(src("main", "index.ts"), "utf8"));
const voiceSource = withoutComments(readFileSync(src("main", "voice.ts"), "utf8"));

/**
 * The `new BrowserWindow({ ... })` options literal, by brace matching.
 * Everything in this file is scoped to what this returns. Rule 1.
 */
function windowOptions(source) {
  const call = source.indexOf("new BrowserWindow(");
  if (call === -1) return null;
  const open = source.indexOf("{", call);
  if (open === -1) return null;

  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return { start: open, end: i + 1, text: source.slice(open, i + 1) };
    }
  }
  return null;
}

/**
 * The darwin guard, with its true-branch captured and its else-branch required
 * to be empty — both taken from the ternary itself rather than from a character
 * budget. Rules 2 and 3.
 */
const GUARD =
  /\bplatform\s*\.\s*isMacOS\s*\?\s*\(?\s*\{(?<consequent>[\s\S]*?)\}\s*(?:as\s+const\s*)?\)?\s*:\s*\{\s*\}\s*\)/;

const opts = windowOptions(mainSource);

test("the BrowserWindow options literal can be located at all", () => {
  // Every other test here is scoped to this. If it could not be found, the rest
  // would assert against an empty string and pass.
  assert.ok(opts, "could not brace-match the new BrowserWindow({ ... }) literal");
  assert.match(opts.text, /\bwebPreferences\b/, "literal found but implausibly small");
});

test("there is exactly one darwin check, and it is in the window options", () => {
  // Rule 2. Not a style preference: the assertions below locate the guard by
  // this occurrence, so a second one would move the anchor without failing
  // anything. If you are adding a legitimate second `platform.isMacOS`, give
  // the guard its own anchor first.
  const all = [...mainSource.matchAll(/\bplatform\s*\.\s*isMacOS\b/g)];
  assert.equal(all.length, 1, "expected exactly one platform.isMacOS in src/main/index.ts");

  const at = all[0].index;
  assert.ok(at > opts.start && at < opts.end, "the darwin check is outside the window options");

  // And it is the shared helper, not a hand-rolled isMac(). @electron-toolkit/utils
  // is already a dependency and already imported here; a second spelling of the
  // same question is how two answers to it start to disagree.
  assert.match(
    mainSource,
    /import\s*\{[^}]*\bplatform\b[^}]*\}\s*from\s*["']@electron-toolkit\/utils["']/,
  );
});

test("the darwin check is a ternary whose else-branch is empty", () => {
  // Rule 3. The else-branch comes from this match, so it cannot be satisfied by
  // a `: {}` belonging to some later spread — a platform.isLinux icon, say.
  // Linux and Windows take the desktop's own frame: KYB-500 settled decision 2.
  const guard = GUARD.exec(opts.text);
  assert.ok(guard, "no `platform.isMacOS ? { ... } : {}` ternary in the window options");
  assert.doesNotMatch(guard.groups.consequent, /\bframe\b/, "the darwin branch sets `frame`");
});

test("titleBarStyle appears once, and only inside the darwin check", () => {
  const guard = GUARD.exec(opts.text);
  assert.ok(guard);

  const all = [...opts.text.matchAll(/\btitleBarStyle\b/g)];
  assert.equal(all.length, 1, "expected exactly one titleBarStyle in the window options");
  assert.match(guard.groups.consequent, /\btitleBarStyle\b/, "titleBarStyle is outside the guard");
});

test("trafficLightPosition appears once, and only inside the darwin check", () => {
  const guard = GUARD.exec(opts.text);
  assert.ok(guard);

  const all = [...opts.text.matchAll(/\btrafficLightPosition\b/g)];
  assert.equal(all.length, 1, "expected exactly one trafficLightPosition in the window options");
  assert.match(
    guard.groups.consequent,
    /\btrafficLightPosition\b/,
    "trafficLightPosition is outside the guard",
  );
});

test("the main window is not frameless, anywhere in its options", () => {
  // Settled decision 2: native frame, no custom titlebar. The renderer draws no
  // window controls, so a frameless main window would leave no way to close it.
  //
  // The WHOLE literal, not a prefix of it. The first revision stopped at the
  // first `webPreferences` — which is the LAST option in this file, so anything
  // appended after it was invisible, including the one thing this test names.
  assert.doesNotMatch(opts.text, /\bframe\s*:\s*false\b/);
  assert.doesNotMatch(opts.text, /\btitleBarOverlay\b/);
});

test("the voice orb stays frameless — it is not a window with chrome", () => {
  // KYB-579 is explicitly not about the orb: 240px, transparent, always on top,
  // no shadow, not resizable. If a later change to the main window's chrome is
  // applied here too, this is what says it was a mistake rather than a tidy-up.
  assert.match(voiceSource, /\bframe\s*:\s*false\b/);
  assert.match(voiceSource, /\btransparent\s*:\s*true\b/);
});
