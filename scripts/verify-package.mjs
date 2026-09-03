#!/usr/bin/env node
/**
 * Prove a packaged build can actually load what it imports.
 *
 * @remarks
 * Two releases shipped that could not start. Both were caught by a user rather
 * than by us, and both would have been caught in ten seconds here.
 *
 * The reason they got through is worth stating, because "test the build" is not
 * the lesson — we did test the build:
 *
 * - **0.4.0** was inspected, not run. Signature, notarization, the model file
 *   in the right place: all verified, none of which loads a module.
 * - **0.4.1** was run, and it started perfectly. The import that fails is not
 *   on the startup path — it happens the first time somebody sends a message.
 *   Launching the app proved only that launching the app works.
 *
 * So this checks the thing that actually breaks: whether every dependency and
 * required peer in the bundle can be resolved, and whether the specific module
 * that failed before can be imported by the app's own runtime, from inside the
 * archive it will ship in.
 *
 * The failure being guarded against is structural, not incidental. A package
 * manager installs peer dependencies at the top level, where they work in
 * development; the packager builds its bundle from THIS package's declared
 * dependencies. Anything the framework needs but this app never declared is
 * present all through development and absent in the .dmg.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// ── 0. Where is the app, and what shape is it? ─────────────────────────
/**
 * The only place layout knowledge lives. electron-builder emits a bundle on
 * macOS and a plain directory on Linux; every path below is derived from an
 * entry here, so adding Windows later is one more entry and nothing else.
 *
 * Linux arches other than x64 land in `dist/linux-<arch>-unpacked` with the
 * same internal shape, so they need no entry — CI passes the path explicitly
 * and the shape matches.
 */
const LAYOUTS = [
  {
    label: "macOS bundle",
    platform: "darwin",
    defaultPath: "dist/mac-arm64/KYBER Studio.app",
    asar: "Contents/Resources/app.asar",
    binary: "Contents/MacOS/KYBER Studio",
  },
  {
    label: "Linux unpacked directory",
    platform: "linux",
    defaultPath: "dist/linux-unpacked",
    asar: "resources/app.asar",
    binary: "kyber-studio",
  },
];

/** The archive is the marker: it is the one file both layouts must contain. */
function layoutFor(app) {
  for (const layout of LAYOUTS) {
    const asar = join(app, layout.asar);
    if (existsSync(asar)) return { layout, asar, binary: join(app, layout.binary) };
  }
  return null;
}

const defaultPath = LAYOUTS.find((l) => l.platform === process.platform)?.defaultPath;
const APP = process.argv[2] ?? defaultPath;

if (!APP) {
  console.error(`No default app path for platform "${process.platform}". Pass one:`);
  console.error(`  node scripts/verify-package.mjs <path to packaged app>\n`);
  process.exit(1);
}

const found = layoutFor(APP);
if (!found) {
  // Naming both candidates turns "it is missing" into "you built the other
  // platform" or "you typo'd the arch", which is the actual question.
  const width = Math.max(...LAYOUTS.map((l) => l.label.length));
  console.error(`\nNo packaged app at ${APP}. Looked for both known layouts:\n`);
  for (const layout of LAYOUTS) {
    console.error(`  ${layout.label.padEnd(width)}  ${join(APP, layout.asar)}`);
  }
  console.error(`\nRun electron-builder first, or pass the path to the build you mean.\n`);
  process.exit(1);
}

const { asar, binary } = found;

// A bundle with an archive but no executable is a half-written build; say which
// half, rather than failing later inside a spawn with errno -2.
if (!existsSync(binary)) {
  console.error(`\nFound ${found.layout.label} at ${APP}, but its executable is missing:`);
  console.error(`  ${binary}\n`);
  process.exit(1);
}

// ── 1. Does the module graph close? ────────────────────────────────────
/**
 * `npx asar` was the obvious spelling and the wrong one: when the local binary
 * is absent, npx silently falls back to fetching the deprecated legacy `asar`
 * package from the registry. A silent behaviour change, inside the one script
 * whose entire job is catching silent breakage. The local binary is resolved
 * from the repo root — derived from this file's own URL, because the cwd of a
 * CI step is not something we get to assume.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ASAR_BIN = join(REPO_ROOT, "node_modules/.bin/asar");

if (!existsSync(ASAR_BIN)) {
  console.error(`\nNo asar binary at ${ASAR_BIN}.`);
  console.error(`\n@electron/asar reaches us transitively (via @electron/universal) and is hoisted,`);
  console.error(`so a dependency-tree change can remove it without touching this package.json.`);
  console.error(`Reinstall, or declare @electron/asar as a devDependency and re-run.\n`);
  process.exit(1);
}

// A fixed /tmp path collides the moment two arches — or two platforms — verify
// on the same machine, and the loser silently inspects the winner's tree.
const extracted = mkdtempSync(join(tmpdir(), "kyber-studio-verify-"));
process.on("exit", () => {
  try {
    rmSync(extracted, { recursive: true, force: true });
  } catch {
    // A leftover temp dir is not a failed verification. Never fail the run here.
  }
});

execFileSync(ASAR_BIN, ["extract", asar, extracted], { stdio: "ignore" });

/** Node's own resolution: look in node_modules here, then in every parent. */
function resolvable(fromDir, name) {
  let dir = fromDir;
  while (dir.startsWith(extracted)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return true;
    dir = dirname(dir);
  }
  return false;
}

const packages = [];
(function scan(dir, depth) {
  if (depth > 6) return;
  const modules = join(dir, "node_modules");
  if (!existsSync(modules)) return;
  for (const entry of readdirSync(modules)) {
    const names = entry.startsWith("@")
      ? readdirSync(join(modules, entry)).map((s) => `${entry}/${s}`)
      : [entry];
    for (const name of names) {
      const at = join(modules, name);
      if (existsSync(join(at, "package.json"))) {
        packages.push(at);
        scan(at, depth + 1);
      }
    }
  }
})(extracted, 0);

const missing = new Set();
for (const at of packages) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const check = (dep, kind) => {
    // electron is provided by the runtime itself, and @types/* is compile-time.
    if (dep === "electron" || dep.startsWith("@types/")) return;
    if (!resolvable(at, dep)) missing.add(`${dep}  ← ${kind} of ${manifest.name}`);
  };
  for (const dep of Object.keys(manifest.dependencies ?? {})) check(dep, "dependency");
  for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[peer]?.optional) continue;
    check(peer, "REQUIRED peer");
  }
}

if (missing.size > 0) {
  console.error(`\n${packages.length} packages bundled, and these cannot be resolved at runtime:\n`);
  for (const line of [...missing].sort()) console.error(`  ${line}`);
  console.error(`\nAdd them to this app's own dependencies. They are present in development because`);
  console.error(`the package manager hoists peers; the packager only bundles what this app declares.\n`);
  process.exit(1);
}
console.log(`✓ module graph closes (${packages.length} packages)`);

// ── 2. Can the app's runtime import the paths that matter? ─────────────
/**
 * Modules chosen because they are NOT on the startup path. A build that boots
 * and then dies on first use is the exact failure this file exists for.
 */
const ENTRY_POINTS = [
  "node_modules/eve/dist/src/shared/tool-schema.js",
  "node_modules/eve/dist/src/client/index.js",
];

for (const entry of ENTRY_POINTS) {
  // resolve, not join: the app path may be absolute (a mounted volume), and
  // joining it onto the working directory produces a path that exists nowhere
  // — which reads as a broken build rather than a broken check.
  const target = resolve(asar, entry);
  try {
    execFileSync(binary, ["--input-type=module", "-e", `await import(${JSON.stringify(target)});`], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "pipe",
    });
    console.log(`✓ ${entry.split("/").slice(-2).join("/")} imports`);
  } catch (error) {
    const detail = String(error.stderr ?? error.message).split("\n").find((l) => l.includes("Error")) ?? "";
    console.error(`\n✗ ${entry} could not be imported by the packaged app:\n  ${detail.trim()}\n`);
    process.exit(1);
  }
}

// ── 3. Does dictation actually run inside the package? ─────────────────
/**
 * Everything above proves modules resolve. This proves the one that has to do
 * real work does it: @huggingface/transformers pulls in onnxruntime-node, whose
 * native binaries are the sort of thing electron-builder's `files` globs drop
 * without comment, and a `.node` inside app.asar only loads because Electron's
 * fs shim redirects it to app.asar.unpacked. Nothing short of running the
 * pipeline through the packaged binary tests that chain.
 *
 * It also sits exactly where this file's remit says to look: dictation happens
 * the first time somebody speaks, not at startup, so a launch test never
 * reaches it.
 */
const RESOURCES = dirname(asar);
const MODEL_ROOT = resolve(RESOURCES, "models");
const CHECKPOINT = "Xenova/whisper-base.en";

if (!existsSync(join(MODEL_ROOT, CHECKPOINT))) {
  console.error(`\n✗ no speech model in the package: ${join(MODEL_ROOT, CHECKPOINT)}\n`);
  console.error(`  The app sets env.allowRemoteModels = false deliberately, so a missing`);
  console.error(`  checkpoint is not a slow first run — it is dictation that never works.`);
  console.error(`  Check build.extraResources maps resources/models → models.\n`);
  process.exit(1);
}

/**
 * Read the entry out of the manifest instead of naming a dist file: the bundle
 * layout of transformers is theirs to change on a minor, and a hardcoded
 * filename would turn that into a verification failure on a build that is fine.
 *
 * Condition order is what Electron's main process asks for — it is node, and it
 * is importing — so "require" and "browser" branches are deliberately not
 * followed even when they are listed first.
 */
function esmEntryOf(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

  // Collect every candidate in preference order rather than stopping at the
  // first string: an exports array is a fallback list, and taking its head
  // without checking disk would reject a package the runtime loads happily.
  const collect = (value, into) => {
    if (typeof value === "string") into.push(value);
    else if (Array.isArray(value)) for (const item of value) collect(item, into);
    else if (value && typeof value === "object") {
      for (const condition of ["node", "import", "module", "default"]) {
        if (condition in value) collect(value[condition], into);
      }
    }
    return into;
  };

  const candidates = [];
  if (manifest.exports !== undefined) {
    const exp = manifest.exports;
    const subpaths =
      exp && typeof exp === "object" && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith("."));
    const root = subpaths ? exp["."] : exp;
    if (root !== undefined) collect(root, candidates);
  }
  for (const field of ["module", "main"]) {
    if (typeof manifest[field] === "string") candidates.push(manifest[field]);
  }

  for (const candidate of candidates) {
    // Extensionless and directory entries are legal in the older fields; a
    // package that only has those should still be verifiable.
    const base = resolve(pkgDir, candidate);
    for (const file of [base, `${base}.mjs`, `${base}.js`, join(base, "index.mjs"), join(base, "index.js")]) {
      if (existsSync(file) && statSync(file).isFile()) return relative(pkgDir, file);
    }
  }

  throw new Error(
    `could not resolve an entry file from its manifest.\n  Tried: ${candidates.join(", ") || "nothing — no exports/module/main"}`,
  );
}

const TRANSFORMERS = "node_modules/@huggingface/transformers";

// Checked before reading the manifest so that "the packager dropped it" reads as
// that, and not as an ENOENT on a temp path nobody recognises.
if (!existsSync(join(extracted, TRANSFORMERS, "package.json"))) {
  console.error(`\n✗ @huggingface/transformers is not in the bundle at all (${TRANSFORMERS}).`);
  console.error(`\n  It is a declared runtime dependency, so this is electron-builder's files`);
  console.error(`  globs excluding it — dictation is absent from this build, not merely broken.\n`);
  process.exit(1);
}

let transformersEntry;
try {
  transformersEntry = esmEntryOf(join(extracted, TRANSFORMERS));
} catch (error) {
  console.error(`\n✗ @huggingface/transformers ${error.message}\n`);
  process.exit(1);
}

// Same trick as ENTRY_POINTS: the path the packaged runtime will use is the
// extracted-tree path, re-rooted at the archive it actually ships in.
const transformersInAsar = resolve(asar, TRANSFORMERS, transformersEntry);

/**
 * Deliberately no `language` or `task`: whisper-base.en is an English-only
 * checkpoint and refuses either, so passing them here would test a call the app
 * never makes. Everything else mirrors src/main/dictation.ts.
 *
 * The assertion is that this loads and runs without throwing. It is NOT that
 * any particular words come back — the input is a quiet tone, and Whisper
 * answers silence with an empty string or a "[BLANK_AUDIO]"-style label
 * depending on version. Both are passes. Do not "fix" this by matching text.
 */
const probe = `
const { env, pipeline } = await import(${JSON.stringify(transformersInAsar)});
env.allowRemoteModels = false;
env.localModelPath = ${JSON.stringify(MODEL_ROOT)};
const transcribe = await pipeline("automatic-speech-recognition", ${JSON.stringify(CHECKPOINT)}, { dtype: "q8" });
const samples = new Float32Array(16000); // one second, mono, 16 kHz — dictation.ts's shape
for (let i = 0; i < samples.length; i += 1) samples[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * 0.01;
const output = await transcribe(samples, { chunk_length_s: 30, stride_length_s: 5 });
console.log("DICTATION_RAN " + JSON.stringify(output?.text ?? ""));
`;

try {
  const stdout = execFileSync(binary, ["--input-type=module", "-e", probe], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "pipe",
    encoding: "utf8",
    // Weights come off a cold runner disk and q8 loading is not quick; this
    // bound exists to stop a hung child, not to police performance.
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const transcript = stdout.split("\n").find((l) => l.startsWith("DICTATION_RAN"))?.slice("DICTATION_RAN ".length) ?? '""';
  console.log(`✓ dictation pipeline loads and runs (${CHECKPOINT}, q8) → ${transcript.trim()}`);
} catch (error) {
  const stderr = String(error.stderr ?? "");
  const lines = stderr.split("\n").filter((l) => l.trim());
  // Node echoes the offending source line before the message, and that echo
  // usually contains the word "Error" too — so prefer a line that BEGINS like a
  // thrown error, or the headline is the code rather than what it said.
  const detail =
    lines.find((l) => /^[A-Za-z]*Error\b/.test(l.trim())) ??
    lines.find((l) => l.includes("Error")) ??
    lines.at(-1) ??
    error.message;
  console.error(`\n✗ the dictation pipeline could not run inside the packaged app:\n  ${detail.trim()}\n`);
  if (error.signal === "SIGTERM") {
    console.error(`  (killed on timeout — the model never finished loading)\n`);
  }
  // ONNX failures name the missing binding several lines below the first
  // "Error", so the tail earns its space here in a way it does not above.
  const tail = lines.slice(-12);
  if (tail.length > 1) {
    console.error(`  last lines of stderr:`);
    for (const line of tail) console.error(`    ${line}`);
    console.error("");
  }
  process.exit(1);
}

console.log("\nPackage verified: it can load what it imports, and run what it loads.\n");
