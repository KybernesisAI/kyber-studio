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
 * What this CANNOT see, stated rather than left to be discovered: it reads
 * text, so a computed guard defeats it. `...(someFlag ? { titleBarStyle } : {})`
 * passes as long as the identifier is `platform.isMacOS`; a guard that resolves
 * to `true` everywhere at runtime would too. Closing that needs a parser and an
 * evaluator, and it is not closed here.
 */

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => resolve(join(here, "..", "src", ...p));

const mainSource = withoutComments(readFileSync(src("main", "index.ts"), "utf8"));
const voiceSource = withoutComments(readFileSync(src("main", "voice.ts"), "utf8"));

/** The one darwin guard the options must sit inside, and its closing brace. */
function macOnlyRegion(source) {
  const start = source.search(/\bplatform\s*\.\s*isMacOS\b/);
  if (start === -1) return null;
  const end = source.indexOf("{}", start);
  return end === -1 ? null : { start, end };
}

test("the window is built with a darwin check, by the shared platform helper", () => {
  // Not a hand-rolled isMac(). @electron-toolkit/utils is already a dependency
  // and already imported in this file; a second spelling of the same question
  // is how two answers to it start to disagree.
  assert.match(mainSource, /\bplatform\s*\.\s*isMacOS\b/);
  assert.match(
    mainSource,
    /import\s*\{[^}]*\bplatform\b[^}]*\}\s*from\s*["']@electron-toolkit\/utils["']/,
  );
});

test("titleBarStyle appears once, and only inside the darwin check", () => {
  const occurrences = [...mainSource.matchAll(/\btitleBarStyle\b/g)];
  assert.equal(occurrences.length, 1, "expected exactly one titleBarStyle");

  const region = macOnlyRegion(mainSource);
  assert.ok(region, "no platform.isMacOS region found");

  const at = occurrences[0].index;
  assert.ok(at > region.start, "titleBarStyle is set before the darwin check");
  assert.ok(at < region.end, "titleBarStyle is set outside the darwin check");
});

test("trafficLightPosition appears once, and only inside the darwin check", () => {
  const occurrences = [...mainSource.matchAll(/\btrafficLightPosition\b/g)];
  assert.equal(occurrences.length, 1, "expected exactly one trafficLightPosition");

  const region = macOnlyRegion(mainSource);
  assert.ok(region, "no platform.isMacOS region found");

  const at = occurrences[0].index;
  assert.ok(at > region.start, "trafficLightPosition is set before the darwin check");
  assert.ok(at < region.end, "trafficLightPosition is set outside the darwin check");
});

test("the non-darwin branch adds no chrome options at all", () => {
  // The whole point is that Linux and Windows take the desktop's own frame.
  // An else-branch quietly growing a `frame: false` or a titleBarOverlay would
  // reintroduce custom chrome, which KYB-500 settled decision 2 rules out.
  assert.match(mainSource, /\bplatform\s*\.\s*isMacOS[\s\S]{0,400}?:\s*\{\s*\}\s*\)/);
});

test("the main window is not frameless on any platform", () => {
  // Settled decision 2: native frame, no custom titlebar. The renderer draws no
  // window controls, so a frameless main window would leave no way to close it.
  const region = macOnlyRegion(mainSource);
  const beforeWebPreferences = mainSource.slice(0, mainSource.indexOf("webPreferences"));
  assert.ok(region, "no platform.isMacOS region found");
  assert.doesNotMatch(beforeWebPreferences, /\bframe\s*:\s*false\b/);
});

test("the voice orb stays frameless — it is not a window with chrome", () => {
  // KYB-579 is explicitly not about the orb: 240px, transparent, always on top,
  // no shadow, not resizable. If a later change to the main window's chrome is
  // applied here too, this is what says it was a mistake rather than a tidy-up.
  assert.match(voiceSource, /\bframe\s*:\s*false\b/);
  assert.match(voiceSource, /\btransparent\s*:\s*true\b/);
});
