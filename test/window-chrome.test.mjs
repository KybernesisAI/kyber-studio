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
 * "the risk is not wrong branches but missing ones".
 *
 * COMMENTS ARE STRIPPED FIRST. The block above the options in index.ts names
 * `hiddenInset` in prose, so a scan that did not strip comments would be
 * satisfied by the prose while the real option sat unguarded one line below —
 * the trap test/renderer-sandbox.test.mjs documents for KYB-569, met here by
 * reusing the same stripper rather than writing a second one.
 *
 * THIS FILE HAS BEEN WRONG TWICE, IN THE SAME WAY BOTH TIMES, and the shape of
 * the mistake is the most useful thing in it. Each revision pinned one anchor
 * and left the anchor above it free:
 *
 *   Round 1 — the region started at the first `platform.isMacOS` in the file
 *   and ended at the first `{}` after it. A dock-badge line above
 *   createWindow() stretched it across the file; all six tests passed with the
 *   defect live.
 *
 *   Round 2 — `platform.isMacOS` was pinned to exactly one, but `windowOptions()`
 *   still took the FIRST `new BrowserWindow(` and nothing said it was the only
 *   one. A second window declared above createWindow(), carrying its own darwin
 *   guard, re-pointed the whole suite while the main window's options went
 *   unconditional: 7 passed, 0 failed, defect live. Separately `GUARD`'s lazy
 *   consequent — advertised as fixing round 1's budget problem — swallowed a
 *   NON-EMPTY else-branch and latched onto a later `cond ? {...} : {})`, so the
 *   test named "else-branch is empty" passed with `vibrancy` and
 *   `visualEffectState` set off darwin.
 *
 * Both were found by building the counter-example, not by reading. So the rule
 * this file now follows is: NEVER LOCATE ANYTHING BY "THE FIRST ONE". Every
 * anchor is asserted unique, and every span is brace-matched from a known
 * start rather than searched for by its end.
 *
 *   1. Exactly one `new BrowserWindow(` per file, and the options literal is
 *      brace-matched from it. Test 1 also checks the literal ends where the
 *      CALL ends — an unbalanced `{` inside a string silently widened the
 *      region past the call with everything still green.
 *   2. Exactly one `platform.isMacOS`, inside that literal.
 *   3. The guard's consequent is BRACE-MATCHED from the `{` after the `?`, so
 *      it cannot run past its own else-branch, and the else is then required to
 *      be exactly `{}` in the text immediately following.
 *   4. `titleBarStyle` and `trafficLightPosition` are counted over the WHOLE
 *      FILE, not the literal, and the single occurrence must fall inside the
 *      consequent. Counting within the literal let a copy live outside it —
 *      including as a `const` spread in from above.
 *
 * What this still CANNOT see: it reads text, so a computed guard defeats it.
 * `...(someFlag ? { titleBarStyle } : {})` passes as long as the identifier is
 * `platform.isMacOS`, and a guard resolving to `true` everywhere would too.
 * Closing that needs a parser and an evaluator, and it is not closed here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => resolve(join(here, "..", "src", ...p));

const mainSource = withoutComments(readFileSync(src("main", "index.ts"), "utf8"));
const voiceSource = withoutComments(readFileSync(src("main", "voice.ts"), "utf8"));

/** Brace-match a `{ ... }` starting at `from`. Returns the index after its `}`. */
function matchBraces(text, from) {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** The single `new BrowserWindow({ ... })` options literal in a file. Rule 1. */
function windowOptions(source) {
  const calls = [...source.matchAll(/new BrowserWindow\(/g)];
  if (calls.length !== 1) return { calls: calls.length };
  const open = source.indexOf("{", calls[0].index);
  if (open === -1) return { calls: 1 };
  const end = matchBraces(source, open);
  if (end === -1) return { calls: 1 };
  return { calls: 1, start: open, end, text: source.slice(open, end) };
}

/** The darwin guard, anchored and brace-matched rather than searched for. Rule 3. */
function darwinGuard(opts) {
  const head = /\bplatform\s*\.\s*isMacOS\s*\?\s*\(?\s*/.exec(opts.text);
  if (!head) return null;

  const open = head.index + head[0].length;
  if (opts.text[open] !== "{") return null;

  const close = matchBraces(opts.text, open);
  if (close === -1) return null;

  // The else-branch, taken from the text immediately after the consequent's
  // closing brace. It cannot be some later spread's `: {}` — there is no search.
  const emptyElse = /^\s*(?:as\s+const\s*)?\)?\s*:\s*\(?\s*\{\s*\}\s*(?:as\s+const\s*)?\)?\s*\)/.test(
    opts.text.slice(close),
  );

  return {
    consequent: opts.text.slice(open, close),
    emptyElse,
    from: opts.start + open,
    to: opts.start + close,
  };
}

const opts = windowOptions(mainSource);
const orb = windowOptions(voiceSource);

test("there is exactly one BrowserWindow in index.ts, and its literal closes with the call", () => {
  assert.equal(opts.calls, 1, "expected exactly one `new BrowserWindow(` in src/main/index.ts");
  assert.ok(opts.text, "could not brace-match the options literal");
  assert.match(opts.text, /\bwebPreferences\b/, "literal found but implausibly small");
  // An unbalanced `{` inside a string widened the literal past the end of the
  // call with every test still green. If the literal does not end where the
  // call ends, the brace matcher has been fooled and nothing below is scoped.
  assert.match(mainSource.slice(opts.end), /^\s*\)/, "the literal does not end where the call does");
});

test("there is exactly one darwin check, and it is in the window options", () => {
  const all = [...mainSource.matchAll(/\bplatform\s*\.\s*isMacOS\b/g)];
  assert.equal(all.length, 1, "expected exactly one platform.isMacOS in src/main/index.ts");

  const at = all[0].index;
  assert.ok(at > opts.start && at < opts.end, "the darwin check is outside the window options");

  // The shared helper, not a hand-rolled isMac(): @electron-toolkit/utils is
  // already a dependency and already imported here, and a second spelling of
  // the same question is how two answers to it start to disagree.
  assert.match(
    mainSource,
    /import\s*\{[^}]*\bplatform\b[^}]*\}\s*from\s*["']@electron-toolkit\/utils["']/,
  );
});

test("the darwin check is a ternary whose else-branch is empty", () => {
  const guard = darwinGuard(opts);
  assert.ok(guard, "no `platform.isMacOS ? { ... } : ...` in the window options");
  assert.ok(guard.emptyElse, "the darwin check's else-branch is not exactly `{}`");
  // The only assertion here that catches a `frame` key whose value is not
  // `false`; test 6 rejects `frame: false` by value.
  assert.doesNotMatch(guard.consequent, /\bframe\b/, "the darwin branch sets `frame`");
});

for (const option of ["titleBarStyle", "trafficLightPosition"]) {
  test(`${option} appears once in the file, and only inside the darwin check`, () => {
    const guard = darwinGuard(opts);
    assert.ok(guard);

    // Counted over the WHOLE FILE. Counting inside the literal let a second
    // copy live outside it — as a bare property in another window, or as a
    // `const` declared above and spread in.
    const all = [...mainSource.matchAll(new RegExp(`\\b${option}\\b`, "g"))];
    assert.equal(all.length, 1, `expected exactly one ${option} in src/main/index.ts`);

    const at = all[0].index;
    assert.ok(at > guard.from && at < guard.to, `${option} is outside the darwin check`);
  });
}

test("the main window is not frameless, anywhere in its options", () => {
  // Settled decision 2: native frame, no custom titlebar. The renderer draws no
  // window controls, so a frameless main window would leave no way to close it.
  assert.doesNotMatch(opts.text, /\bframe\s*:\s*false\b/);
  assert.doesNotMatch(opts.text, /\btitleBarOverlay\b/);
});

test("the voice orb stays frameless — it is not a window with chrome", () => {
  // KYB-579 is explicitly not about the orb: 240px, transparent, always on top.
  // Scoped to the orb's own literal for the same reason as everything above —
  // an unscoped scan of voice.ts would let a second window satisfy this on the
  // orb's behalf.
  assert.equal(orb.calls, 1, "expected exactly one `new BrowserWindow(` in src/main/voice.ts");
  assert.ok(orb.text, "could not brace-match the orb's options literal");
  assert.match(orb.text, /\bframe\s*:\s*false\b/);
  assert.match(orb.text, /\btransparent\s*:\s*true\b/);
});
