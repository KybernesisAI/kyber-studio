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
  //
  // WHY THE LIST MUST BE EXHAUSTIVE. After the fix there is no `sandbox` key in
  // either webPreferences at all — and that absence is precisely the state in
  // which Electron DERIVES the answer rather than reading it. Electron 34.5.8,
  // shell/browser/web_contents_preferences.cc:280-286:
  //
  //     bool WebContentsPreferences::IsSandboxed() const {
  //       if (sandbox_) return *sandbox_;
  //       bool sandbox_disabled_by_default =
  //           node_integration_ || node_integration_in_worker_;
  //       return !sandbox_disabled_by_default;
  //     }
  //
  // `sandbox_` is a std::optional, cleared to nullopt (:119) and assigned only
  // when the key is actually present (:175-177). So with no key, a node
  // integration flag is the entire input. AppendCommandLineSwitches then takes
  // the else branch and appends kNoSandbox and kNoZygote (:318-325), which is
  // the unconfined renderer KYB-569 found in the host user namespace.
  //
  // Read that derivation carefully, because it is narrower than it looks:
  // nodeIntegration and nodeIntegrationInWorker feed IsSandboxed() directly.
  // nodeIntegrationInSubFrames does NOT — it gates `can_sandbox_frame` for
  // cross-origin SUBFRAMES (:318). It stays on this list on its own merits: it
  // unsandboxes those subframes, and src/main/index.ts names it as the reason
  // `sandbox: false` came across from KBDE in the first place.
  //
  // nodeIntegrationInWorker is the third spelling, and it was missed when this
  // test was written — review round 3 found it, against Electron's source. The
  // word boundary is why: `\bnodeIntegration\s*:\s*true\b` does not match
  // `nodeIntegrationInWorker: true`, because \b fails on the following letter.
  // A fixture of the fixed main window with that one line added passed all
  // three original assertions.
  //
  // WHAT THIS CANNOT SEE, written down because a known limit is worth more than
  // a discovered one. It is a TEXT scan, so it only ever catches a literal.
  // Both of these disable the sandbox and both return [] here:
  //
  //     sandbox: !app.isPackaged,
  //     nodeIntegration: isDev ? true : false
  //
  // A computed value is out of reach without a parser. That is accepted: the
  // scan cannot invent a violation, only miss one.
  //
  // `app.commandLine.appendSwitch("no-sandbox")` is a further route and an
  // app-wide one rather than per-window. It is greppable, so it is checked
  // below — but only because it is greppable, and the computed-value hole above
  // applies to it just the same.
  const disallowed = [
    ["sandbox: false", /\bsandbox\s*:\s*false\b/],
    ["nodeIntegration: true", /\bnodeIntegration\s*:\s*true\b/],
    ["nodeIntegrationInSubFrames: true", /\bnodeIntegrationInSubFrames\s*:\s*true\b/],
    ["nodeIntegrationInWorker: true", /\bnodeIntegrationInWorker\s*:\s*true\b/],
    ['appendSwitch("no-sandbox")', /\bappendSwitch\s*\(\s*["'`](?:--)?no-sandbox\b/],
  ];

  for (const [property, pattern] of disallowed) {
    const sites = sitesOf(pattern);
    assert.deepEqual(
      sites,
      [],
      `${property} takes the renderer out of the Chromium sandbox:\n${sites.join("\n")}`,
    );
  }
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

  // Every literal on the line is judged, not the last one: `literals.at(-1)`
  // was positional, and `preload: join(__dirname, "../preload/index.mjs"),
  // title: "x.cjs"` satisfies a positional check while loading ESM.
  for (const { file, expression, literals } of assignments) {
    assert.ok(literals.length > 0, `could not read a preload path out of ${file}: ${expression}`);

    const esmLooking = literals.filter((literal) => /\.m?js$/.test(literal));
    assert.deepEqual(
      esmLooking,
      [],
      `${file} names a preload file that is not the CommonJS bundle: ${esmLooking.join(", ")}\n` +
        `  A sandboxed renderer cannot load an ESM preload, and this package is "type": "module".`,
    );

    assert.ok(
      literals.some((literal) => literal.endsWith(".cjs")),
      `${file} has a preload: with no .cjs path on it: ${expression}`,
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

  // The plugin is not the only spelling. electron-vite 5 deprecates
  // externalizeDepsPlugin in favour of a `build.externalizeDeps` option, so
  // `preload: { build: { externalizeDeps: true, … } }` reopens this exact trap
  // somewhere the plugin check above cannot see it.
  assert.ok(
    !config.preload?.build?.externalizeDeps,
    "build.externalizeDeps on the preload leaves @electron-toolkit/preload a bare require",
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
  // A regex literal containing `//` is not a comment. Outside a string a
  // backslash escapes what follows, so each `\/` is consumed as a pair and the
  // slashes never become adjacent — the rest of the line survives.
  const afterRegex = withoutComments('const re = /^https?:\\/\\//; const mode = "keep";');
  assert.match(afterRegex, /mode/);
  assert.match(afterRegex, /keep/);
});

test("a bare package require is found, and a bundled preload has none", () => {
  assert.deepEqual(requiredSpecifiers('require("electron"); require("@electron-toolkit/preload")'), [
    "electron",
    "@electron-toolkit/preload",
  ]);
  // electron comes from the runtime, and Electron polyfills three builtins for a
  // sandboxed preload — events, timers, url — in both spellings. Paths are
  // somebody else's problem.
  assert.deepEqual(
    unresolvableSpecifiers(["electron", "events", "timers", "url", "./local", "/abs/x"]),
    [],
  );
  assert.deepEqual(unresolvableSpecifiers(["node:events", "node:timers", "node:url"]), []);

  // The electron subpaths resolve too, and only source says so: Electron's
  // docs/tutorial/sandbox.md lists `electron` alone, while
  // lib/sandboxed_renderer/init.ts binds all three to the same module object.
  // electron-vite's preload preset externalises /^electron\/.+/, so one of
  // these reaching the bundle as a bare require is a real path, not a theory.
  assert.deepEqual(unresolvableSpecifiers(["electron/common", "electron/renderer"]), []);

  // And the two that look like they belong and do not. `process` is a GLOBAL
  // passed into the preload wrapper, not a module — require("process") throws.
  // init.ts registers `timers` and `node:timers`, not the promises subpath.
  // Pinned so that neither is added back on the strength of looking familiar.
  assert.deepEqual(unresolvableSpecifiers(["process", "node:timers/promises"]), [
    "process",
    "node:timers/promises",
  ]);

  // Every OTHER builtin is as absent as a package from node_modules, which is
  // why this cannot be an isBuiltin check: electron-vite's preload preset
  // externalises all of them and mergeConfig concatenates, so `node:path` in the
  // preload reaches the bundle as a bare require and fails silently at load.
  assert.deepEqual(unresolvableSpecifiers(["node:fs", "fs", "path", "child_process"]), [
    "node:fs",
    "fs",
    "path",
    "child_process",
  ]);
  assert.deepEqual(unresolvableSpecifiers(["electron", "node:path", "events", "./local"]), [
    "node:path",
  ]);
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
