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
 *
 * One failure is not a missing module at all, and section 2 is the only part of
 * this file that reads a byte of a native binary: a `.node` that is PRESENT and
 * built for the wrong CPU. The per-platform packages are chosen by whichever
 * machine ran `npm install`, so a bundle can be complete, resolvable, and still
 * fail at dlopen on the first machine that is not the one that built it.
 */
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
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

/**
 * One positional argument — the app — plus an optional `--arch=<x64|arm64|…>`.
 *
 * The flag is the escape hatch for section 2, which works out what architecture
 * the bundle is SUPPOSED to be from the path electron-builder wrote. A path that
 * electron-builder did not name (a mounted volume, an artefact somebody renamed,
 * an unzipped download) carries no arch, and the one answer that must never be
 * substituted there is the verifying host's own. So it is stated, not guessed.
 *
 * `--arch=arm64` and `--arch arm64` both work; anything else is a positional.
 */
const args = process.argv.slice(2);
const positional = [];
let archArgument = null;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg.startsWith("--arch=")) archArgument = arg.slice("--arch=".length);
  else if (arg === "--arch") {
    // Undefined when it is the last argument, which is caught below rather than
    // read as "no flag given" — a typo must not quietly become an inference.
    archArgument = args[i + 1] ?? "";
    i += 1;
  } else positional.push(arg);
}

const APP = positional[0] ?? defaultPath;

if (!APP) {
  console.error(`No default app path for platform "${process.platform}". Pass one:`);
  console.error(`  node scripts/verify-package.mjs <path to packaged app> [--arch=<arch>]\n`);
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

// ── 2. Is every native binary built for the arch being shipped? ────────
/**
 * Every other check in this file catches a MISSING package. None of them
 * catches a present-but-wrong-architecture one, and before this section nothing
 * here read a single byte of a `.node`.
 *
 * That gap has two open doors today, both of which produce a bundle that is
 * structurally perfect and internally inconsistent:
 *
 * - `@img/sharp-linux-x64` and `@img/sharp-linux-arm64` are per-platform
 *   optional dependencies, resolved by whatever machine ran `npm install`. An
 *   install host that disagrees with the build target is all it takes.
 * - `build.linux.files` keeps exactly one
 *   `onnxruntime-node/bin/napi-v6/linux/<arch>` directory and excludes the rest.
 *   That the kept one matches the target is, until this section, an assumption.
 *
 * The two runtime checks below look like they would cover this, and do not:
 * they can only run when the verifying machine can execute the artefact. Verify
 * an arm64 tree from an x64 runner and they either cannot run at all or run
 * under emulation, where a mixed bundle behaves unpredictably. Reading a header
 * costs nothing, runs anywhere, needs no execution, and names the file.
 *
 * It runs BEFORE those checks for exactly that reason. When a `.node` is the
 * wrong CPU, "wrong architecture in <file>" is the diagnosis; the loader error
 * the next sections would produce instead is a symptom several layers
 * downstream, and on a cross-arch runner it never even gets that far.
 */

/**
 * The machine identifiers, per executable format, for the arches
 * electron-builder can name. ELF `e_machine` (2 bytes at 0x12) and Mach-O
 * `cputype` (4 bytes at 0x04); Mach-O sets bit 24 (0x01000000) for the 64-bit
 * variant of a CPU family, which is why arm64 is 0x0100000C and 32-bit arm is
 * 0x0000000C.
 */
const ELF_MACHINES = new Map([
  [0x03, "ia32"],
  [0x28, "armv7l"],
  [0x3e, "x64"],
  [0xb7, "arm64"],
]);
const MACHO_CPUTYPES = new Map([
  [0x00000007, "ia32"],
  [0x0000000c, "armv7l"],
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

/** electron-builder, Node, ELF and Mach-O all spell the same arches differently. */
function normaliseArch(name) {
  return (
    {
      x64: "x64",
      x86_64: "x64",
      amd64: "x64",
      arm64: "arm64",
      aarch64: "arm64",
      arm: "armv7l",
      armv7l: "armv7l",
      ia32: "ia32",
      x86: "ia32",
      universal: "universal",
    }[String(name).trim().toLowerCase()] ?? null
  );
}

/**
 * What architecture is this artefact FOR?
 *
 * Deliberately NOT process.arch. The verifying machine is not necessarily the
 * target — that is the entire premise of the check — and taking the host's word
 * for it would reintroduce the blind spot this section exists to remove: on an
 * x64 runner, an all-x64 bundle destined for arm64 would pass.
 *
 * electron-builder names its output directory `<platform>[-<arch>][-unpacked]`:
 * `dist/mac-arm64/KYBER Studio.app`, `dist/linux-arm64-unpacked`,
 * `dist/win-unpacked`. Segments are searched from the end so that an absolute
 * path through a directory called `linux-x64` upstream cannot outvote the real
 * output directory.
 *
 * THE INFERENCE WORTH STATING: electron-builder OMITS the arch segment for its
 * default arch, x64. So a plain `dist/linux-unpacked`, `dist/win-unpacked` or
 * `dist/mac` means x64 — it does not mean "unknown". That is a convention rather
 * than a measurement, and it is the one line here that could go stale: if
 * electron-builder ever changes that default, this function is where it is
 * wrong, and `--arch=` is the way past it in the meantime.
 */
function archFromPath(app) {
  for (const segment of resolve(app).split(sep).reverse()) {
    const named = segment.endsWith("-unpacked") ? segment.slice(0, -"-unpacked".length) : segment;
    const match = /^(?:mac|darwin|linux|win|windows)(?:-(.+))?$/.exec(named);
    if (!match) continue;
    // A segment that names a platform but an arch we have no machine table for
    // (say linux-riscv64) must fail loudly, not fall through to a later segment
    // and certainly not to the host: return null and let the caller say so.
    return match[1] ? normaliseArch(match[1]) : "x64";
  }
  return null;
}

let EXPECTED;
let ARCH_SOURCE;

if (archArgument !== null) {
  EXPECTED = normaliseArch(archArgument);
  ARCH_SOURCE = `--arch=${archArgument}`;
  if (!EXPECTED) {
    console.error(`\n✗ --arch=${archArgument || "<nothing>"} is not an architecture this script knows.`);
    console.error(`\n  Known: x64 (x86_64, amd64), arm64 (aarch64), armv7l, ia32, universal.`);
    console.error(`  Add it to normaliseArch and to the ELF/Mach-O tables above if it is real.\n`);
    process.exit(1);
  }
} else {
  EXPECTED = archFromPath(APP);
  ARCH_SOURCE = `the app path (${APP})`;
  if (!EXPECTED) {
    // Loudly, and never a fallback to process.arch: an unverifiable expectation
    // is a check that cannot be trusted, and a wrong one is worse than none.
    console.error(`\n✗ cannot tell which architecture this build is for, from its path:`);
    console.error(`\n  ${resolve(APP)}`);
    console.error(`\n  Expected an electron-builder output directory in the path —`);
    console.error(`  <platform>[-<arch>][-unpacked], e.g. dist/mac-arm64, dist/linux-arm64-unpacked,`);
    console.error(`  or dist/linux-unpacked (no arch segment means x64, electron-builder's default).`);
    console.error(`\n  This is NOT defaulted to the verifying machine's own architecture (${process.arch})`);
    console.error(`  on purpose: that assumption is the failure this check exists to catch.`);
    console.error(`  Say which arch it is instead:\n`);
    console.error(`    node scripts/verify-package.mjs "${APP}" --arch=<x64|arm64|…>\n`);
    process.exit(1);
  }
}

/**
 * A universal macOS app is the one target that is not a single architecture:
 * @electron/universal keeps an x64 slice and an arm64 slice side by side, so a
 * THIN .node of either arch is correct in one. The per-file check degrades to
 * "one of the two" there rather than pretending to a precision it does not have.
 */
const ACCEPTABLE = EXPECTED === "universal" ? new Set(["x64", "arm64"]) : new Set([EXPECTED]);
/** "x64", or "x64 or arm64" for a universal build — "expected universal" is not an architecture. */
const EXPECTED_LABEL = [...ACCEPTABLE].join(" or ");

/**
 * Read the architecture out of a file's own header.
 *
 * No new dependency, and deliberately not `file(1)`: it is not guaranteed to be
 * installed on a runner, and a check that silently does not run is worse than no
 * check. Returns null for anything that is not an object file we recognise —
 * a `.node` that is not ELF or Mach-O is a different bug and must not be
 * reported as an architecture mismatch.
 */
function archesOf(file) {
  // Never read the whole file: a bundled .node can be hundreds of megabytes.
  // 4 KiB covers an ELF header (0x34/0x40 bytes) and a fat header with a longer
  // arch list than any real binary carries.
  const buffer = Buffer.alloc(4096);
  const fd = openSync(file, "r");
  let read;
  try {
    read = readSync(fd, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(fd);
  }
  if (read < 8) return null;

  const asBE = buffer.readUInt32BE(0);
  const asLE = buffer.readUInt32LE(0);

  // ELF — Linux. \x7fELF, then EI_DATA at byte 5 says how the rest is written.
  // Honouring it rather than assuming little-endian costs one branch; assuming
  // would read e_machine byte-swapped on the first big-endian target and report
  // a confident wrong answer, which is this file's least acceptable failure.
  if (asBE === 0x7f454c46) {
    if (read < 0x14) return null;
    const machine = buffer[5] === 2 ? buffer.readUInt16BE(0x12) : buffer.readUInt16LE(0x12);
    // A machine we have no name for is still a measurement, so it is reported
    // as one ("found ELF machine 0x2b") rather than skipped: the file IS an
    // object file, and it is provably not the arch we are shipping.
    return { arches: [ELF_MACHINES.get(machine) ?? `ELF machine 0x${machine.toString(16)}`] };
  }

  // Mach-O, thin — macOS. MH_MAGIC_64 0xFEEDFACF (and the 32-bit 0xFEEDFACE),
  // either byte order; cputype is the next 4 bytes, read the same way round as
  // the magic that identified the file.
  if (asLE === 0xfeedfacf || asLE === 0xfeedface || asBE === 0xfeedfacf || asBE === 0xfeedface) {
    const bigEndian = asBE === 0xfeedfacf || asBE === 0xfeedface;
    const cputype = bigEndian ? buffer.readUInt32BE(4) : buffer.readUInt32LE(4);
    return { arches: [MACHO_CPUTYPES.get(cputype) ?? `Mach-O cputype 0x${cputype.toString(16)}`] };
  }

  // Mach-O, universal/fat — a legitimate shape for a macOS build, and one that
  // must PASS when it contains the expected arch. Always big-endian on disk:
  // magic, nfat_arch, then nfat_arch entries whose first field is the cputype.
  if (asBE === 0xcafebabe || asBE === 0xcafebabf) {
    const wide = asBE === 0xcafebabf; // fat_arch_64: 64-bit offset and size
    const stride = wide ? 32 : 20;
    const count = buffer.readUInt32BE(4);
    // 0xCAFEBABE is also the Java class-file magic, and a class file puts its
    // version where nfat_arch goes. A bound is the whole difference between
    // reading arch entries and reading "Java 8" as 52 architectures.
    if (count < 1 || count > 64 || read < 8 + count * stride) return null;
    const arches = [];
    for (let i = 0; i < count; i += 1) {
      const cputype = buffer.readUInt32BE(8 + i * stride);
      arches.push(MACHO_CPUTYPES.get(cputype) ?? `Mach-O cputype 0x${cputype.toString(16)}`);
    }
    return { arches };
  }

  return null;
}

/**
 * Every `*.node` under a root, depth-first.
 *
 * Symlinks are not followed: a link can leave the tree entirely (Homebrew, a
 * pnpm store) and a cycle would hang the walk. `shown` is what gets printed —
 * the asar side lives in a temp directory whose path means nothing to whoever
 * reads the failure, so paths are reported as they sit in the shipped app.
 */
function nodeFilesIn(root, shownAs) {
  const found = [];
  if (!existsSync(root)) return found;
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const at = join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.isFile() && entry.name.endsWith(".node")) {
        found.push({ file: at, shown: join(shownAs, relative(root, at)) });
      }
    }
  })(root);
  return found;
}

/**
 * BOTH trees, because they hold different copies of the same binaries.
 * `build.asarUnpack` lifts the `@img` packages out of the archive, and the copy
 * OUTSIDE it is the one dlopen actually gets — so checking only inside app.asar
 * would carefully check the copies that nothing loads.
 *
 * The unpacked directory is not per-layout knowledge: electron-builder always
 * writes it beside the archive with a `.unpacked` suffix, on every platform.
 * Deriving it keeps the promise LAYOUTS makes above — Windows is one more entry
 * and nothing else — instead of a third field repeating the same string thrice.
 */
const UNPACKED = `${asar}.unpacked`;
const unpackedNatives = nodeFilesIn(UNPACKED, `${found.layout.asar}.unpacked`);

/**
 * Measured, not assumed: `asar extract` materialises unpacked entries by
 * copying them back out of that same `.unpacked` directory, because their bytes
 * were never in the archive to begin with. So every file asarUnpack lifted out
 * shows up in both walks — the same bytes under two names, which would double
 * the count and print every mismatch twice. Keep the unpacked path: it is the
 * copy dlopen is actually handed. A `.node` that is genuinely IN the archive has
 * no counterpart here and is still checked, under its app.asar path.
 */
const natives = [
  ...nodeFilesIn(extracted, found.layout.asar).filter(
    ({ file }) => !existsSync(join(UNPACKED, relative(extracted, file))),
  ),
  ...unpackedNatives,
];

const wrongArch = [];
let checked = 0;
let unrecognised = 0;

for (const native of natives) {
  let header;
  try {
    header = archesOf(native.file);
  } catch (error) {
    // An unreadable .node inside a bundle we are about to ship is not something
    // to shrug at, but it is not a mismatch either — so it gets its own words.
    console.error(`\n✗ could not read the header of a bundled native binary:\n  ${native.shown}`);
    console.error(`  ${error.message}\n`);
    process.exit(1);
  }
  if (!header) {
    unrecognised += 1;
    continue;
  }
  checked += 1;
  if (!header.arches.some((arch) => ACCEPTABLE.has(arch))) {
    wrongArch.push({ ...native, arches: header.arches });
  }
}

if (wrongArch.length > 0) {
  const plural = wrongArch.length === 1 ? "binary is" : "binaries are";
  console.error(`\n✗ ${wrongArch.length} bundled native ${plural} built for the wrong architecture:\n`);
  for (const { shown, arches } of wrongArch) {
    console.error(`  ${shown}`);
    console.error(`      found ${arches.join(" + ")}, expected ${EXPECTED_LABEL}`);
  }
  console.error(`\n  A bundle like this installs, starts, and then dies at dlopen on a user's`);
  console.error(`  machine rather than on this runner. The two ways it happens:`);
  console.error(`\n  - @img/sharp-* and onnxruntime-node ship per-platform binaries, picked by`);
  console.error(`    whichever machine ran npm install. Install on the target architecture, or`);
  console.error(`    pass --cpu/--os to npm install, and package again.`);
  console.error(`\n  - build.linux.files keeps exactly one`);
  console.error(`    onnxruntime-node/bin/napi-v6/linux/<arch> directory and excludes the others.`);
  console.error(`    If the kept one is not ${EXPECTED_LABEL}, those globs are what to fix.`);
  console.error(`\n  "Expected ${EXPECTED_LABEL}" came from ${ARCH_SOURCE}. If THAT is what is wrong,`);
  console.error(`  say which arch the build is for: --arch=<x64|arm64|…>\n`);
  process.exit(1);
}

// Zero is not a failure here, and not this section's call to make: a bundle
// with no native binaries at all is what sections 1 and 4 are for. Say what was
// seen rather than printing a reassuring "all of nothing is correct".
if (checked === 0) {
  console.log(`✓ no bundled .node files to check for architecture (expected ${EXPECTED_LABEL})`);
} else {
  const skipped = unrecognised > 0 ? `, ${unrecognised} skipped: not an ELF or Mach-O object` : "";
  console.log(`✓ all bundled .node files are ${EXPECTED_LABEL} (${checked} checked${skipped})`);
}

// ── 3. Can the app's runtime import the paths that matter? ─────────────
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

// ── 4. Does dictation actually run inside the package? ─────────────────
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
