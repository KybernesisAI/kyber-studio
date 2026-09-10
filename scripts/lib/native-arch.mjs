/**
 * Reading (platform, arch) out of a native binary, and out of a build path.
 *
 * @remarks
 * This is the measuring half of `verify-package.mjs` section 2, and it lives in
 * its own file for ONE reason: so that it can be tested without a packaged app.
 *
 * `verify-package.mjs` is a script, not a module — it runs top to bottom, needs
 * a real bundle to point at, and calls `process.exit`. Importing it from a test
 * runs it. So the functions that decide what a `.node` IS could not be exercised
 * at all except by building an artefact, which is why every proof KYB-544 had
 * lived in a temporary CI workflow and died with it (KYB-551).
 *
 * Nothing here changed in the move. These are the same functions, byte for byte,
 * with the same comments; the split is structural. If you are changing behaviour,
 * `test/native-arch.test.mjs` is where you find out what you broke, and a test
 * that disagrees with the code is a finding to raise rather than an assertion to
 * edit.
 *
 * Nothing here touches the network or the environment, but nothing here is
 * quite pure either. `identify` reads the first 4 KiB of the file it is handed
 * and nothing more. `archFromPath` calls `resolve`, so a RELATIVE argument is
 * interpreted against process.cwd() — the script only ever passes it a path it
 * has already derived, and the tests' relative inputs always match a segment
 * before cwd could matter, but the dependency is real and this file's whole
 * value is that its comments are exact.
 */
import { closeSync, openSync, readSync } from "node:fs";
import { resolve, sep } from "node:path";

/**
 * The machine identifiers, per executable format, for the arches
 * electron-builder can name. ELF `e_machine` (2 bytes at 0x12), Mach-O
 * `cputype` (4 bytes at 0x04), PE `Machine` (2 bytes at the start of the COFF
 * header); Mach-O sets bit 24 (0x01000000) for the 64-bit variant of a CPU
 * family, which is why arm64 is 0x0100000C and 32-bit arm is 0x0000000C.
 */
export const ELF_MACHINES = new Map([
  [0x03, "ia32"],
  [0x28, "armv7l"],
  [0x3e, "x64"],
  [0xb7, "arm64"],
]);
export const MACHO_CPUTYPES = new Map([
  [0x00000007, "ia32"],
  [0x0000000c, "armv7l"],
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);
export const PE_MACHINES = new Map([
  [0x014c, "ia32"],
  [0x01c4, "armv7l"], // IMAGE_FILE_MACHINE_ARMNT. The older ARM (0x1c0, Windows CE
                      // and Phone 7) is left out deliberately: it degrades to the
                      // named measurement "PE machine 0x1c0", which is the right
                      // treatment for payload we do not ship.
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);

/** electron-builder, Node, ELF, Mach-O and PE all spell the same arches differently. */
export function normaliseArch(name) {
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
 * Only the ARCH is taken from the path. The target PLATFORM is never taken from
 * it: that is `found.layout.platform`, measured from the shape of the tree — a
 * `Contents/Resources/app.asar` is a macOS bundle and a `resources/app.asar` is
 * not — because a measurement beats a naming convention.
 *
 * Be precise about what that does and does not guarantee. The regex below still
 * READS a platform token, as the gate that locates the arch segment; it just
 * never becomes the target platform. A path whose token disagrees with the
 * measured layout — `dist/linux-arm64-unpacked` pointed at a `.app` — is not
 * detected here, and the arch is taken from it anyway. That costs nothing in
 * normal use and it is not an invariant anyone should lean on.
 *
 * electron-builder names its output directory `<platform>[-<arch>][-unpacked]`:
 * `dist/mac-arm64/KYBER Studio.app`, `dist/linux-arm64-unpacked`,
 * `dist/linux-unpacked`, and `dist/win-unpacked` — which this parses on the same
 * "classified, not supported" footing as the PE branch: there is no Windows
 * target, and a path we can read the arch out of is not a build we verify.
 * Segments are searched from the end so that an absolute
 * path through a directory called `linux-x64` upstream cannot outvote the real
 * output directory.
 *
 * THE INFERENCE WORTH STATING: electron-builder OMITS the arch segment for its
 * default arch. So a plain `dist/linux-unpacked` or `dist/mac` means x64 — it
 * does not mean "unknown". That is a convention rather than a measurement, and
 * it is the one line here that could go stale. The default it depends on is
 * LOCAL, not an upstream constant: builder-util omits the suffix when the arch
 * equals `build.<platform>.defaultArch`, which resolves to x64 only while that
 * key is unset, as it is in this package.json today. Set it, and an arm64 bundle
 * lands in `dist/mac` and is checked against x64 — a loud wrong failure rather
 * than a silent pass, and `--arch=` is the way past it.
 */
export function archFromPath(app) {
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

/**
 * Read the platform and architecture out of a file's own header.
 *
 * The FORMAT is the platform: ELF is linux, Mach-O is darwin, PE is win32. That
 * is a measurement of the bytes, which is the whole point — a `.node` under a
 * directory called `linux/arm64` is only evidence of what somebody named it.
 *
 * No new dependency, and deliberately not `file(1)`: it is not guaranteed to be
 * installed on a runner, and a check that silently does not run is worse than no
 * check. Returns null for anything that is not an object file we recognise —
 * a `.node` that is not ELF, Mach-O or PE is a different bug and must not be
 * reported as an architecture mismatch.
 */
export function identify(file) {
  // Never read the whole file: a bundled .node can be hundreds of megabytes.
  // 4 KiB covers an ELF header (0x34/0x40 bytes), a PE header at any e_lfanew a
  // real linker emits, and a fat header with a longer arch list than any real
  // binary carries.
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
    return { platform: "linux", format: "ELF", arches: [ELF_MACHINES.get(machine) ?? `ELF machine 0x${machine.toString(16)}`] };
  }

  // Mach-O, thin — macOS. MH_MAGIC_64 0xFEEDFACF (and the 32-bit 0xFEEDFACE),
  // either byte order; cputype is the next 4 bytes, read the same way round as
  // the magic that identified the file.
  if (asLE === 0xfeedfacf || asLE === 0xfeedface || asBE === 0xfeedfacf || asBE === 0xfeedface) {
    const bigEndian = asBE === 0xfeedfacf || asBE === 0xfeedface;
    const cputype = bigEndian ? buffer.readUInt32BE(4) : buffer.readUInt32LE(4);
    return { platform: "darwin", format: "Mach-O", arches: [MACHO_CPUTYPES.get(cputype) ?? `Mach-O cputype 0x${cputype.toString(16)}`] };
  }

  // Mach-O, universal/fat — a legitimate shape for a macOS build, and one that
  // must PASS when it contains the expected arch. Always big-endian on disk:
  // magic, nfat_arch, then nfat_arch entries whose first field is the cputype.
  if (asBE === 0xcafebabe || asBE === 0xcafebabf) {
    const wide = asBE === 0xcafebabf; // fat_arch_64: 64-bit offset and size
    const stride = wide ? 32 : 20;
    const count = buffer.readUInt32BE(4);
    // 0xCAFEBABE is also the Java class-file magic, and a class file puts its
    // major version where nfat_arch goes. The bound is what rejects those, and
    // it has to be BELOW 45: 45 is the lowest major version that exists (Java
    // 1.1), so any bound of 44 or less excludes every class file that will ever
    // be written. A bound of 64 did not — it stopped Java 21 (65) and let Java
    // 1.1 through 20 read as 45 to 64 architectures, needing only 8 + major*20
    // bytes of file to get past the length check too. 16 is chosen with room to
    // spare in the other direction: slices are keyed on (cputype, cpusubtype)
    // rather than on architecture — arm64 and arm64e are two of them — and
    // @electron/universal merges exactly two inputs, so the only fat .node this
    // script can meet has 2 slices. A file holding every architecture Apple has
    // ever shipped would be about twelve. Do not let this number drift upward:
    // too high admits junk as fake architectures and fails loudly and wrongly,
    // where too low only drops coverage quietly.
    if (count < 1 || count > 16 || read < 8 + count * stride) return null;
    const arches = [];
    for (let i = 0; i < count; i += 1) {
      const cputype = buffer.readUInt32BE(8 + i * stride);
      arches.push(MACHO_CPUTYPES.get(cputype) ?? `Mach-O cputype 0x${cputype.toString(16)}`);
    }
    return { platform: "darwin", format: "Mach-O (universal)", arches };
  }

  // PE — Windows. "MZ", then a 4-byte offset at 0x3C to the "PE\0\0" signature,
  // with the COFF Machine field 4 bytes after it. Every field is little-endian.
  //
  // There is NO Windows target: this branch is here so that the win32 prebuilds
  // onnxruntime-node's fat npm package drags into every bundle are classified
  // as foreign payload instead of vanishing into a silent skip. It is not
  // Windows support and does not imply any.
  if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
    if (read < 0x40) return null;
    const peOffset = buffer.readUInt32LE(0x3c);
    // A DOS stub is ~0x80 bytes and no linker puts the PE header near the file
    // start; an offset outside what we read is a file we cannot judge, not a
    // Windows binary we can lie about.
    if (peOffset < 0x40 || peOffset + 6 > read) return null;
    if (buffer.readUInt32LE(peOffset) !== 0x00004550) return null; // "PE\0\0"
    const machine = buffer.readUInt16LE(peOffset + 4);
    return { platform: "win32", format: "PE", arches: [PE_MACHINES.get(machine) ?? `PE machine 0x${machine.toString(16)}`] };
  }

  return null;
}

/** "linux ×2, win32 ×2" — what the foreign payload is, before naming every file. */
export function tallyPlatforms(entries) {
  const counts = new Map();
  for (const { platform } of entries) counts.set(platform, (counts.get(platform) ?? 0) + 1);
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, n]) => `${platform} ×${n}`)
    .join(", ");
}

/**
 * A universal macOS app is the one target that is not a single architecture:
 * @electron/universal keeps an x64 slice and an arm64 slice side by side, so a
 * THIN .node of either arch is correct in one. The per-file check degrades to
 * "one of the two" there rather than pretending to a precision it does not have.
 */
export function acceptableFor(expected) {
  return expected === "universal" ? new Set(["x64", "arm64"]) : new Set([expected]);
}

/** "x64", or "x64 or arm64" for a universal build — "expected universal" is not an architecture. */
export function expectedLabel(acceptable) {
  return [...acceptable].join(" or ");
}

/**
 * THE DECISION THAT FAILS A BUILD. Everything above this measures; this is the
 * part that says yes or no, and it is the reason the measuring is done at all.
 *
 * Four verdicts, and the distinction between the middle two is the whole point:
 *
 * - `unrecognised` — not an ELF, Mach-O or PE object. Counted and named, never
 *   fatal: a `.node` that is not an object file is a different bug, and
 *   reporting it as an architecture mismatch sends the reader to the wrong place.
 * - `foreign` — an object file for another platform. A binary for another
 *   platform CANNOT be the wrong arch for this one, because it is never going to
 *   be loaded here. Failing the build over its arch would fail over a file whose
 *   arch is irrelevant; counting it as correct would let it stand as evidence the
 *   bundle is right. It is neither, so it gets its own bucket.
 * - `wrong-arch` — same platform, and none of its slices is acceptable. FATAL.
 *   This is the failure the whole section exists to produce.
 * - `correct` — same platform, at least one acceptable slice.
 *
 * `wrong-arch` and `correct` both count as CHECKED by the caller; `foreign` and
 * `unrecognised` do not. That asymmetry is what stops a bundle full of foreign
 * payload reporting a reassuring number of files checked.
 *
 * A measurement we have no name for — "ELF machine 0x2b" — is not in any
 * acceptable set, so on the target platform it lands on `wrong-arch` and fails
 * loudly. That is deliberate: it is provably not what we ship.
 */
export function verdictFor(header, targetPlatform, acceptable) {
  if (!header) return "unrecognised";
  if (header.platform !== targetPlatform) return "foreign";
  if (!header.arches.some((arch) => acceptable.has(arch))) return "wrong-arch";
  return "correct";
}
