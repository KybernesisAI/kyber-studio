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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const APP = process.argv[2] ?? "dist/mac-arm64/KYBER Studio.app";
const asar = join(APP, "Contents/Resources/app.asar");
const binary = join(APP, "Contents/MacOS/KYBER Studio");

if (!existsSync(asar)) {
  console.error(`No packaged app at ${APP}. Run electron-builder first.`);
  process.exit(1);
}

// ── 1. Does the module graph close? ────────────────────────────────────
const extracted = "/tmp/kyber-studio-verify";
execFileSync("npx", ["asar", "extract", asar, extracted], { stdio: "ignore" });

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

console.log("\nPackage verified: it can load what it imports.\n");
