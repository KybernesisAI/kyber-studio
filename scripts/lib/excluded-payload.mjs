/**
 * Did the build actually drop what it was told to drop?
 *
 * @remarks
 * `build.<platform>.files` can name an exclusion that never fires — a glob with
 * a typo, a path that moved upstream, a filename whose case changed between
 * releases — and electron-builder says nothing when a negation matches zero
 * files. So the configuration cannot tell you an exclusion worked. Only the
 * packaged tree can, and until something reads the tree the exclusion is a
 * claim rather than a fact. That gap is what left the previous packaging fix
 * unproven.
 *
 * This is the half of that check which needs no packaged app: given the paths a
 * walk found and the rules a layout declares, it says which rules were
 * violated and what to print. The walking lives in `verify-package.mjs`, the
 * same split as `native-arch.mjs` and `preload-shape.mjs` — so the half that
 * decides can be reached without building an artefact.
 */

/**
 * Paths arrive from `path.relative`, which yields backslashes on Windows — and
 * this check RUNS on Windows, because that is where the Windows package is
 * built. A rule written with forward slashes would match nothing there.
 *
 * That failure mode is the dangerous one: it does not error, it reports a tick
 * for a tree it never examined. A check that cannot fail is worse than no
 * check, so both sides are normalised rather than trusting the host separator.
 */
const forward = (path) => path.replace(/\\/g, "/");

/**
 * Matching is CASE-INSENSITIVE, and the reason is the opposite of the obvious
 * one — worth stating because the first version of this file got it backwards.
 *
 * The electron-builder globs meant to remove these files ARE case-sensitive.
 * That is the hazard, not the safeguard: an upstream release shipping
 * `DirectML.DLL` stops matching `!…/DirectML.dll`, so the file is packaged. A
 * case-sensitive check here would then miss it too — glob and check would agree
 * and both be wrong, which is the silent regression this exists to catch.
 *
 * So the check deliberately does NOT mirror the glob. It asks the question the
 * glob cannot: is any DirectML payload present, under any casing? There is no
 * casing of these names that belongs in the package, so insensitivity costs no
 * precision.
 */
function violates(path, rule) {
  const subject = forward(path);
  if (rule.kind === "file") {
    const base = subject.slice(subject.lastIndexOf("/") + 1);
    return base.toLowerCase() === rule.value.toLowerCase();
  }
  const tree = forward(rule.value).replace(/\/+$/, "").toLowerCase();
  const lowered = subject.toLowerCase();
  return lowered === tree || lowered.startsWith(`${tree}/`);
}

/**
 * Which declared exclusions are present in the tree after all.
 *
 * @remarks
 * One entry per VIOLATED rule, each carrying the paths that violated it, so a
 * report can say "this exclusion did not fire, and here is what it left behind"
 * rather than listing loose paths a reader has to attribute to a cause.
 *
 * A rule that matches nothing is not reported: it worked. Rules are returned in
 * the order they were declared, so the output order is the layout's order and
 * not the filesystem's.
 */
export function excludedPayloadIn(paths, rules) {
  const violations = [];
  for (const rule of rules) {
    const matched = paths.filter((path) => violates(path, rule));
    if (matched.length > 0) violations.push({ rule, paths: matched });
  }
  return violations;
}

/**
 * The verdict and its wording, as a pure function of the inputs.
 *
 * @remarks
 * Three outcomes, and they must not print the same line:
 *
 * - **No rules declared.** Not a pass. Nothing was verified, and saying "no
 *   excluded payload present" would be a false assurance about a tree nobody
 *   looked at. `checked` is 0 and the wording says so — and when the manifest
 *   does exclude paths that this layout has not modelled, it says how many,
 *   because "none were checked" reads very differently next to a 7.
 * - **Rules declared, none violated.** A real measurement: every exclusion
 *   fired.
 * - **Rules violated.** The failure names the key a reader can edit, because
 *   the remediation is a glob and not a code change.
 *
 * `ok` is false only for the third. A layout with nothing to check does not
 * fail a build — it just must not claim to have checked it.
 */
export function excludedPayloadVerdict(paths, rules, { filesKey, layoutLabel, declaredCount = 0 }) {
  const violations = excludedPayloadIn(paths, rules);

  if (rules.length === 0) {
    return {
      ok: true,
      checked: 0,
      violations,
      lines:
        declaredCount === 0
          ? [
              `· no exclusions are declared for the ${layoutLabel}, so none were checked`,
              `  Nothing here says the build dropped anything. If ${filesKey} excludes paths,`,
              `  declare them on this layout so that claim gets tested against the tree.`,
            ]
          : [
              `· ${declaredCount} path(s) excluded by ${filesKey} are not modelled on the`,
              `  ${layoutLabel} layout, so none were checked. Nothing here says the build`,
              `  dropped them — model them on the layout to have that claim tested.`,
            ],
    };
  }

  if (violations.length === 0) {
    const plural = rules.length === 1 ? "exclusion" : "exclusions";
    return {
      ok: true,
      checked: rules.length,
      violations,
      lines: [`✓ all ${rules.length} declared ${plural} are absent from the package`],
    };
  }

  const lines = [
    ``,
    `✗ the package contains payload that ${filesKey} was supposed to exclude.`,
    ``,
    `  An exclusion that matches nothing is silent in electron-builder's output, so`,
    `  this is what a glob that stopped matching looks like from the outside:`,
    ``,
  ];
  for (const { rule, paths: hits } of violations) {
    lines.push(`  ${rule.kind === "file" ? "filename" : "tree"}  ${rule.value}`);
    lines.push(`      why it should be absent: ${rule.why}`);
    for (const hit of hits) lines.push(`      present as  ${hit}`);
    lines.push(``);
  }
  lines.push(`  Fix the pattern in ${filesKey}, not this check. Patterns there are`);
  lines.push(`  case-sensitive and this check is not, so a file whose case changed upstream`);
  lines.push(`  is reported here and needs its own entry there.`);
  lines.push(``);
  lines.push(`  If you ADD a pattern rather than correcting one, add a rule to the layout`);
  lines.push(`  too, or the count guard will stop the next run asking for it.`);
  lines.push(``);
  return { ok: false, checked: rules.length, violations, lines };
}
