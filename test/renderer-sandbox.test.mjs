import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import config from "../electron.vite.config.ts";
import {
  esmStatements,
  inspectPreload,
  requiredSpecifiers,
  unresolvableSpecifiers,
  withoutComments,
} from "../scripts/lib/preload-shape.mjs";

/**
 * The renderer runs in Chromium's sandbox, and this is what keeps it there.
 *
 * KYB-569: both BrowserWindows were built with `webPreferences.sandbox: false`.
 * There is no global `--no-sandbox` in this app and never was, which is why
 * weeks of grepping for one found nothing — Electron implements that ONE flag
 * by spawning the renderer `--no-sandbox --no-zygote`. A process-table sweep on
 * an Ubuntu 26.04 .deb install found the renderer in the HOST user namespace
 * with NoNewPrivs 0 and Seccomp 0, while the zygote beside it was correctly
 * confined in its own. The kernel and the AppArmor profile were never the
 * problem.
 *
 * The guarantee has been written down twice before and survived only as a
 * sentence, so it is asserted here instead. The assertions are deliberately
 * about the things that are LOAD-BEARING and not obvious:
 *
 * - `sandbox: false` must not come back. It is one word and it reads like a
 *   workaround for a preload that will not load, which is exactly what somebody
 *   debugging this will think they have.
 * - the preload must be `.cjs`. A sandboxed preload has no ESM context, and
 *   `"type": "module"` makes a `.js` file ESM.
 * - the preload must be BUNDLED, which is the half that gets missed. A
 *   sandboxed preload's `require` reaches `electron` and some polyfilled
 *   builtins and nothing else, so `externalizeDepsPlugin` on the preload build
 *   leaves a bare `require("@electron-toolkit/preload")` that throws at load.
 *   CommonJS alone is not enough, and a config that is CommonJS and externalised
 *   looks perfectly reasonable.
 *
 * Every one of these fails SILENTLY: the context bridge never attaches,
 * `window.studio` is undefined, and the app looks signed out rather than
 * broken. That is why this is a test and not a comment.
 *
 * Sources are read as TEXT with comments stripped first. Stripping is not
 * fastidiousness — src/main/index.ts explains this change at length and says
 * the words `sandbox: false` three times while doing it, so a naive grep would
 * be failed by the documentation of the very rule it enforces.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "src/main");

/** Every .ts under src/main, so a third window added later is covered by default. */
function sourcesUnder(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourcesUnder(at));
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(at);
  }
  return found;
}

const mainSources = sourcesUnder(MAIN).map((file) => ({
  file: file.slice(ROOT.length + 1),
  code: withoutComments(readFileSync(file, "utf8")),
}));

/** file:line for every line matching a pattern, so a failure names the place. */
function sitesOf(pattern) {
  const sites = [];
  for (const { file, code } of mainSources) {
    code.split("\n").forEach((line, index) => {
      if (pattern.test(line)) sites.push(`${file}:${index + 1}  ${line.trim()}`);
    });
  }
  return sites;
}

// ── the source tree ────────────────────────────────────────────────────

test("no window in src/main disables the renderer sandbox", () => {
  // Property order and spacing are free; the value is not. `sandbox: true` is
  // not accepted as an alternative and is not what the fix did — sandboxed is
  // the default, and an explicit true is an invitation to flip it back.
  assert.deepEqual(sitesOf(/\bsandbox\s*:\s*false\b/), []);
});

test("the sandbox assertion is looking at windows that exist", () => {
  // Without this, deleting src/main or renaming the directory turns the test
  // above into a test that scans nothing and passes. Two windows are known:
  // the main window and the voice orb.
  const windows = sitesOf(/\bwebPreferences\s*:/);
  assert.ok(
    windows.length >= 2,
    `expected at least the 2 known BrowserWindows, found ${windows.length}:\n${windows.join("\n")}`,
  );
});

test("every preload in src/main is the .cjs bundle", () => {
  // A sandboxed renderer cannot load an ESM preload, and with "type": "module"
  // a .js preload IS ESM. The path is checked rather than the build output
  // because this is the half a person edits.
  const assignments = [];
  for (const { file, code } of mainSources) {
    for (const match of code.matchAll(/\bpreload\s*:\s*([^\n]*)/g)) {
      const literals = [...match[1].matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]);
      assignments.push({ file, expression: match[1].trim(), literals });
    }
  }

  assert.ok(
    assignments.length >= 2,
    `expected a preload for each known window, found ${assignments.length}`,
  );

  for (const { file, expression, literals } of assignments) {
    const path = literals.at(-1);
    assert.ok(path, `could not read a preload path out of ${file}: ${expression}`);
    assert.ok(
      path.endsWith(".cjs"),
      `${file} loads a preload that is not the CommonJS bundle: ${path}\n` +
        `  A sandboxed renderer cannot load an ESM preload, and this package is "type": "module".`,
    );
  }
});

// ── the build that produces it ─────────────────────────────────────────

test("the preload build emits CommonJS, at a .cjs filename", () => {
  // Read from the config object rather than its text: the question is what the
  // build DOES, and a comment mentioning cjs must not be able to satisfy it.
  assert.equal(typeof config, "object", "electron.vite.config.ts no longer exports a plain object");
  const output = config.preload?.build?.rollupOptions?.output;
  assert.equal(output?.format, "cjs", "the preload build must emit CommonJS");
  assert.match(
    String(output?.entryFileNames),
    /\.cjs$/,
    'the preload entry must be named .cjs — a .js file is ESM under "type": "module"',
  );
});

test("only electron is left external to the preload", () => {
  // THE TRAP. A sandboxed preload's require resolves electron and a few
  // polyfilled builtins; anything else left external is a bare require that
  // throws at load, and the app then looks signed out. Verified empirically:
  // building with externalizeDepsPlugin on the preload and launching the app
  // gives "Error: module not found: @electron-toolkit/preload".
  const external = config.preload?.build?.rollupOptions?.external;
  assert.deepEqual(
    Array.isArray(external) ? [...external].sort() : external,
    ["electron"],
    "everything but electron must be bundled into the preload",
  );
});

test("externalizeDepsPlugin is not applied to the preload", () => {
  const named = (plugins) => (plugins ?? []).flat(Infinity).map((p) => p?.name ?? "").join(",");

  assert.ok(
    !/externalize/i.test(named(config.preload?.plugins)),
    "externalizeDepsPlugin on the preload leaves @electron-toolkit/preload as a bare require",
  );

  // The non-vacuous half: main SHOULD have it, so a change that stopped this
  // test being able to see plugins at all cannot pass as a clean bill of health.
  assert.ok(
    /externalize/i.test(named(config.main?.plugins)),
    "main no longer externalises its dependencies — if that was deliberate, this " +
      "test can no longer tell whether the preload check above is looking at anything",
  );
});

// ── reading a preload's shape, which is what verify-package.mjs does ───

test("comments cannot satisfy or break a rule about code", () => {
  assert.equal(withoutComments("const a = 1; // sandbox: false\n").includes("sandbox"), false);
  assert.equal(withoutComments("/* preload: 'index.mjs' */ const a = 1;").includes("mjs"), false);
  // A string is not a comment, and a URL in one must survive intact.
  assert.match(withoutComments('const u = "https://x/y"; // gone'), /https:\/\/x\/y/);
  // Line numbers must not move, or a guard names the wrong line.
  assert.equal(withoutComments("a\n/* two\nlines */\nb").split("\n").length, 4);
});

test("a bare package require is found, and a bundled preload has none", () => {
  assert.deepEqual(requiredSpecifiers('require("electron"); require("@electron-toolkit/preload")'), [
    "electron",
    "@electron-toolkit/preload",
  ]);
  // electron is provided by the runtime; builtins are polyfilled; a package is not.
  assert.deepEqual(unresolvableSpecifiers(["electron", "node:path", "events", "./local"]), []);
  assert.deepEqual(unresolvableSpecifiers(["@electron-toolkit/preload", "zod"]), [
    "@electron-toolkit/preload",
    "zod",
  ]);
});

test("a top-level import is found, and a dynamic one is not", () => {
  assert.deepEqual(esmStatements('import { x } from "y";'), ['import { x } from "y"']);
  assert.deepEqual(esmStatements('import "./side-effect";'), ['import "./side-effect"']);
  assert.deepEqual(esmStatements("export default x;"), ["export default"]);
  // await import(...) is legal in CommonJS and must not be reported, or the
  // check fails a preload that is perfectly loadable.
  assert.deepEqual(esmStatements('const m = await import("y");'), []);
  assert.deepEqual(esmStatements('log("import x from \\"y\\"");'), []);
});

test("the two shapes a preload can be wrong in are both reported", () => {
  const good = 'const electron = require("electron");\nmodule.exports = {};\n';
  assert.deepEqual(inspectPreload(good), { usesRequire: true, unresolvable: [], esm: [] });

  const esm = 'import { contextBridge } from "electron";\n';
  assert.deepEqual(inspectPreload(esm).esm, ['import { contextBridge } from "electron"']);
  assert.equal(inspectPreload(esm).usesRequire, false);

  const externalised = 'const p = require("@electron-toolkit/preload");\n';
  assert.deepEqual(inspectPreload(externalised).unresolvable, ["@electron-toolkit/preload"]);
});

test("the emitted preload is one a sandboxed renderer could load", (t) => {
  // The real artefact, when there is one. `npm test` runs BEFORE the build in
  // the `build` script, so on a clean checkout there is nothing here yet and
  // this skips; scripts/verify-package.mjs makes the same assertions against a
  // PACKAGED app, where they cannot be skipped.
  const emitted = join(ROOT, "out/preload/index.cjs");
  if (!existsSync(emitted)) {
    t.skip("no out/preload/index.cjs — run `npx electron-vite build` to exercise this");
    return;
  }

  assert.ok(
    !existsSync(join(ROOT, "out/preload/index.mjs")),
    "out/preload/index.mjs is still there — a stale build, or the preload emits both",
  );

  const { usesRequire, unresolvable, esm } = inspectPreload(readFileSync(emitted, "utf8"));
  assert.ok(usesRequire, `${emitted} contains no require( — rebuild if this is stale`);
  assert.deepEqual(esm, [], "the emitted preload has top-level ESM statements");
  assert.deepEqual(unresolvable, [], "the emitted preload requires a package that is not bundled");
});
