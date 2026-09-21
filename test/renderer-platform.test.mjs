import { test } from "node:test";
import assert from "node:assert/strict";

import {
  IS_MAC,
  MODIFIER,
  chordLabel,
  detectPlatform,
  isMacPlatform,
  modifierFor,
} from "../src/renderer/src/lib/platform.ts";

/**
 * What these tests exist to catch.
 *
 * KYB-583: the palette advertised ⌘1…⌘9 on every platform and acted on
 * `metaKey` alone, so on Linux and Windows it named a key the keyboard does not
 * have and the feature it named did nothing.
 *
 * The fix turns on one question — is this a Mac — asked of a string the browser
 * hands over. Both spellings are real and they disagree: `userAgentData`
 * answers "macOS", the older `navigator.platform` answers "MacIntel". A check
 * that handles one and not the other is exactly the kind of half-right branch
 * this epic keeps finding, so both are pinned here by their actual values.
 *
 * Deliberately NOT covered: the last two lines of the module, which call
 * `detectPlatform(globalThis.navigator)` and pass the answer on. Reading a real
 * navigator needs a real browser; every decision either side of that read is a
 * pure function taking its input as an argument, which is why they are shaped
 * that way.
 */

test("both real spellings of macOS are recognised", () => {
  // navigator.userAgentData.platform, Chromium
  assert.equal(isMacPlatform("macOS"), true);
  // navigator.platform, the older API — still what Node reports
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("MacPPC"), true);
});

test("the platforms this lane exists for are not mistaken for macOS", () => {
  for (const p of ["Linux", "Linux x86_64", "Linux aarch64", "Windows", "Win32", "Chrome OS"]) {
    assert.equal(isMacPlatform(p), false, `${p} should not read as macOS`);
  }
});

test("an absent or unreadable platform is not macOS", () => {
  // What detectPlatform returns when there is no navigator at all. The default
  // has to be the non-Mac branch: it is the one whose hints name keys that
  // exist on every keyboard.
  assert.equal(isMacPlatform(""), false);
  assert.equal(isMacPlatform("   "), false);
});

test("surrounding whitespace does not change the answer", () => {
  assert.equal(isMacPlatform("  macOS  "), true);
});

test("userAgentData is preferred, and navigator.platform is the fallback", () => {
  assert.equal(detectPlatform({ userAgentData: { platform: "macOS" }, platform: "Linux" }), "macOS");
  assert.equal(detectPlatform({ platform: "MacIntel" }), "MacIntel");
  // Node has navigator.platform and no userAgentData, so this branch is live in
  // this very test run rather than hypothetical.
  assert.equal(detectPlatform({ userAgentData: {}, platform: "Linux x86_64" }), "Linux x86_64");
  assert.equal(detectPlatform({ userAgentData: { platform: "   " }, platform: "Win32" }), "Win32");
});

test("a source that cannot answer yields an empty string rather than throwing", () => {
  assert.equal(detectPlatform(undefined), "");
  assert.equal(detectPlatform(null), "");
  assert.equal(detectPlatform({}), "");
  assert.equal(detectPlatform("Linux"), "");
  assert.equal(detectPlatform({ platform: 42 }), "");
});

test("the hint names the key the keyboard has", () => {
  assert.equal(modifierFor(true), "⌘");
  assert.equal(modifierFor(false), "Ctrl");
});

test("a keyboard hint names a key the keyboard has", () => {
  // The macOS spellings are pinned to what ships today, because this lane must
  // not change what a Mac user sees.
  assert.equal(chordLabel(true, "K"), "⌘K");
  assert.equal(chordLabel(true, "1"), "⌘1");
  // Off macOS, a spelled-out modifier and a space — "CtrlK" is not a chord
  // anyone writes.
  assert.equal(chordLabel(false, "K"), "Ctrl K");
  assert.equal(chordLabel(false, "1"), "Ctrl 1");
});

test("the exported pair agrees with the exported predicate", () => {
  // A shape check, not a platform check: asserting IS_MAC's VALUE would pin
  // this suite to the machine it runs on and fail on a Mac.
  assert.equal(typeof IS_MAC, "boolean");
  assert.equal(MODIFIER, modifierFor(IS_MAC));
});
