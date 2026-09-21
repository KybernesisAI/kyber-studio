/**
 * Which desktop this window is running on.
 *
 * @remarks
 * The renderer carries no platform signal from the main process — there is no
 * member on the `studio` bridge for it, deliberately (KYB-579 weighed adding
 * one and decided against). It does not need one. The packaged app loads this
 * window from a `file://` origin, which Chromium treats as a secure context, so
 * `navigator.userAgentData` is present and answers.
 *
 * Both halves here are pure and take their input as an argument, which is the
 * whole reason this file exists rather than a couple of inline checks: a module
 * that reads `navigator` at the top level cannot be reached by `node --test`,
 * and this repo has been bitten repeatedly by logic that no test could get at.
 * The single line of glue at the bottom is the only part not covered.
 *
 * What this is NOT for: deciding what a keystroke does. Gate DISPLAY on this,
 * never input. If the detection is ever wrong, the cost should be a label that
 * names the wrong key, not a shortcut that does nothing — so the handlers
 * accept either modifier and only the hints branch.
 */

/** The shape of the two places a browser will tell you its platform. */
interface PlatformSource {
  userAgentData?: { platform?: unknown };
  platform?: unknown;
}

/**
 * Read a platform string out of a navigator-like object.
 *
 * `userAgentData.platform` first because `navigator.platform` is deprecated and
 * frozen-in-place on some engines. Falls back rather than assuming, and answers
 * `""` when neither exists — Node has a `navigator` with `platform` but no
 * `userAgentData`, so both branches are live in the test runner.
 */
export function detectPlatform(source: unknown): string {
  if (typeof source !== "object" || source === null) return "";
  const nav = source as PlatformSource;
  const fromData = nav.userAgentData?.platform;
  if (typeof fromData === "string" && fromData.trim() !== "") return fromData;
  return typeof nav.platform === "string" ? nav.platform : "";
}

/**
 * macOS, from either spelling.
 *
 * `userAgentData.platform` says `"macOS"`; the older `navigator.platform` says
 * `"MacIntel"`. Anchored at the start and case-insensitive so both land and
 * neither `"Linux x86_64"` nor `"Win32"` does.
 */
export function isMacPlatform(platform: string): boolean {
  return /^mac/i.test(platform.trim());
}

/** The modifier this keyboard actually has, for hints shown to the user. */
export function modifierFor(isMac: boolean): "⌘" | "Ctrl" {
  return isMac ? "⌘" : "Ctrl";
}

/**
 * A keyboard hint, spelled the way this platform spells it.
 *
 * Here rather than inline in the component so the branch is reachable from a
 * test. A hint that silently stops branching is the failure this ticket is
 * about, and a branch no test can see is how it survived.
 */
export function chordLabel(isMac: boolean, key: string): string {
  return isMac ? `⌘${key}` : `Ctrl ${key}`;
}

export const IS_MAC = isMacPlatform(detectPlatform(globalThis.navigator));

export const MODIFIER = modifierFor(IS_MAC);
