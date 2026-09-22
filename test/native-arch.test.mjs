import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  acceptableFor,
  archFromPath,
  expectedLabel,
  formatUncheckedReport,
  identify,
  normaliseArch,
  tallyPlatforms,
  tallyVerdicts,
  verdictFor,
} from "../scripts/lib/native-arch.mjs";

/**
 * What these tests exist to catch.
 *
 * KYB-544 added the (platform, arch) assertion to `verify-package.mjs` and
 * proved it properly — on a real macOS build, with a negative control, with
 * assertions that it could not pass vacuously. Every one of those proofs lived
 * in a temporary workflow that was deleted when KYB-544 merged. What survived
 * into `main` was a check that has only ever passed, and a check that has only
 * ever passed is not a check.
 *
 * So the interesting cases below are almost all the ones where the code must
 * say NO, or must say something more specific than yes:
 *
 * - a Java class file shares Mach-O's fat magic, and its version number sits
 *   exactly where the slice count goes. The bound that rejects it is the single
 *   most delicate constant in the classifier.
 * - a big-endian ELF read as little-endian yields a confident wrong answer,
 *   which is the classifier's least acceptable failure mode.
 * - a machine or cputype we have no name for must be REPORTED as a measurement,
 *   not skipped — the file is still provably not what we are shipping.
 * - an architecture that cannot be determined must come back null, never the
 *   verifying host's own. That substitution is the exact blind spot the whole
 *   section exists to remove.
 *
 * Headers are synthesised here rather than fixtured. A committed binary would
 * be a large opaque blob whose interesting bytes nobody could see, and half of
 * these shapes — a fat header claiming more slices than the file holds — cannot
 * be produced by a compiler at all.
 */

const scratch = mkdtempSync(join(tmpdir(), "kyber-studio-native-arch-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
/** identify() takes a path, so every case needs bytes on disk. */
function binaryFile(bytes) {
  const at = join(scratch, `case-${(counter += 1)}.node`);
  writeFileSync(at, bytes);
  return at;
}

/** Same, at a path of the caller's choosing — for the cases about paths. */
function binaryFileAt(subpath, bytes) {
  const at = join(scratch, subpath);
  mkdirSync(dirname(at), { recursive: true });
  writeFileSync(at, bytes);
  return at;
}

function elf({ machine, endian = "le", size = 64 }) {
  const b = Buffer.alloc(size);
  b[0] = 0x7f;
  b[1] = 0x45; // E
  b[2] = 0x4c; // L
  b[3] = 0x46; // F
  b[4] = 2; // EI_CLASS — 64-bit
  b[5] = endian === "be" ? 2 : 1; // EI_DATA
  b[6] = 1; // EI_VERSION
  if (size >= 0x14) {
    if (endian === "be") b.writeUInt16BE(machine, 0x12);
    else b.writeUInt16LE(machine, 0x12);
  }
  return b;
}

function machoThin({ magic = 0xfeedfacf, cputype, bigEndian = false }) {
  const b = Buffer.alloc(64);
  if (bigEndian) {
    b.writeUInt32BE(magic, 0);
    b.writeUInt32BE(cputype, 4);
  } else {
    b.writeUInt32LE(magic, 0);
    b.writeUInt32LE(cputype, 4);
  }
  return b;
}

/**
 * `declared` defaults to the number of slices actually written, so a test only
 * states it when the point is that the header lies about the file.
 */
function machoFat({ magic = 0xcafebabe, cputypes = [], declared, size }) {
  const stride = magic === 0xcafebabf ? 32 : 20;
  const count = declared ?? cputypes.length;
  const bytes = size ?? 8 + Math.max(cputypes.length, 1) * stride;
  const b = Buffer.alloc(bytes);
  b.writeUInt32BE(magic, 0);
  b.writeUInt32BE(count, 4);
  cputypes.forEach((cputype, i) => {
    if (8 + i * stride + 4 <= bytes) b.writeUInt32BE(cputype, 8 + i * stride);
  });
  return b;
}

/**
 * THE SIZE IS THE WHOLE TEST. A 64-byte class file is rejected by the fat
 * header's length check (`read < 8 + count * stride`) long before the
 * slice-count bound is consulted, so a small fixture passes whatever the bound
 * is — including the 64 that KYB-544 had to abandon. 2 KiB is past the length
 * check for every major version up to 102, which puts the bound back on trial.
 * Do not shrink this buffer.
 */
function javaClass({ major, minor = 0 }) {
  const b = Buffer.alloc(2048);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt16BE(minor, 4);
  b.writeUInt16BE(major, 6);
  return b;
}

function pe({ machine = 0x8664, peOffset = 0x80, signature = 0x00004550, size = 0x100 }) {
  const b = Buffer.alloc(size);
  b[0] = 0x4d; // M
  b[1] = 0x5a; // Z
  b.writeUInt32LE(peOffset, 0x3c);
  if (peOffset + 6 <= size) {
    b.writeUInt32LE(signature, peOffset);
    b.writeUInt16LE(machine, peOffset + 4);
  }
  return b;
}

// ── ELF ────────────────────────────────────────────────────────────────

test("an ELF binary is classified as linux, with its architecture", () => {
  assert.deepEqual(identify(binaryFile(elf({ machine: 0x3e }))), {
    platform: "linux",
    format: "ELF",
    arches: ["x64"],
  });
  assert.deepEqual(identify(binaryFile(elf({ machine: 0xb7 }))).arches, ["arm64"]);
  assert.deepEqual(identify(binaryFile(elf({ machine: 0x03 }))).arches, ["ia32"]);
  assert.deepEqual(identify(binaryFile(elf({ machine: 0x28 }))).arches, ["armv7l"]);
});

test("a big-endian ELF has its machine read big-endian", () => {
  // The whole point of honouring EI_DATA. Read little-endian, 0x003e becomes
  // 0x3e00 and the answer is a confidently wrong "ELF machine 0x3e00" instead
  // of x64 — a wrong answer, which is worse here than no answer.
  const header = identify(binaryFile(elf({ machine: 0x3e, endian: "be" })));
  assert.deepEqual(header.arches, ["x64"]);
  assert.equal(header.platform, "linux");
});

test("an ELF machine with no name is reported as a measurement, not skipped", () => {
  // It is still an object file, and it is still provably not what we ship — so
  // it must reach the arch check and fail it, rather than being passed over.
  const header = identify(binaryFile(elf({ machine: 0x2b })));
  assert.equal(header.platform, "linux");
  assert.deepEqual(header.arches, ["ELF machine 0x2b"]);
});

test("an ELF header too short to hold a machine field is not guessed at", () => {
  assert.equal(identify(binaryFile(elf({ machine: 0x3e, size: 0x10 }))), null);
});

// ── Mach-O, thin ───────────────────────────────────────────────────────

test("a thin Mach-O is classified as darwin, with its architecture", () => {
  assert.deepEqual(identify(binaryFile(machoThin({ cputype: 0x0100000c }))), {
    platform: "darwin",
    format: "Mach-O",
    arches: ["arm64"],
  });
  assert.deepEqual(identify(binaryFile(machoThin({ cputype: 0x01000007 }))).arches, ["x64"]);
});

test("a 32-bit Mach-O magic is recognised too", () => {
  const header = identify(binaryFile(machoThin({ magic: 0xfeedface, cputype: 0x0000000c })));
  assert.equal(header.platform, "darwin");
  assert.deepEqual(header.arches, ["armv7l"]);
});

test("a big-endian Mach-O has its cputype read the same way round as its magic", () => {
  const header = identify(binaryFile(machoThin({ cputype: 0x0100000c, bigEndian: true })));
  assert.deepEqual(header.arches, ["arm64"]);
});

test("an unnamed Mach-O cputype is reported as a measurement", () => {
  assert.deepEqual(identify(binaryFile(machoThin({ cputype: 0x0100000f }))).arches, [
    "Mach-O cputype 0x100000f",
  ]);
});

// ── Mach-O, universal — and the Java class file that looks just like one ─

test("a universal Mach-O reports every slice it carries", () => {
  const header = identify(binaryFile(machoFat({ cputypes: [0x01000007, 0x0100000c] })));
  assert.equal(header.platform, "darwin");
  assert.equal(header.format, "Mach-O (universal)");
  assert.deepEqual(header.arches, ["x64", "arm64"]);
});

test("a 64-bit fat header is read at its own stride", () => {
  // fat_arch_64 entries are 32 bytes, not 20. Read at the wrong stride the
  // second slice's cputype comes out of the middle of the first entry, so the
  // two arches here differ deliberately: a stride bug cannot produce them.
  const header = identify(binaryFile(machoFat({ magic: 0xcafebabf, cputypes: [0x01000007, 0x0100000c] })));
  assert.equal(header.format, "Mach-O (universal)");
  assert.deepEqual(header.arches, ["x64", "arm64"]);
});

test("a Java class file is not mistaken for a universal binary", () => {
  // Same magic, and the class file's major version sits exactly where
  // nfat_arch does. This is what the slice-count bound is for, and the reason
  // it must stay below 45 — the lowest major version that exists.
  //
  // These fixtures are 2 KiB deliberately: see javaClass. With a 64-byte one
  // this test passes with the bound at 16, at 64, and with the bound deleted
  // entirely — it would have read as coverage while protecting nothing.
  for (const major of [45, 52, 61, 64, 65]) {
    assert.equal(
      identify(binaryFile(javaClass({ major }))),
      null,
      `a class file with major version ${major} must not read as a fat binary`,
    );
  }
});

test("a fat header claiming an implausible number of slices is rejected", () => {
  assert.equal(identify(binaryFile(machoFat({ cputypes: [], declared: 0 }))), null);
  assert.equal(
    identify(binaryFile(machoFat({ cputypes: [0x01000007], declared: 17, size: 8 + 17 * 20 }))),
    null,
  );
});

test("sixteen slices is still accepted — the bound is inclusive", () => {
  // Pinned on both sides so that a future narrowing of the bound is a decision
  // somebody takes deliberately rather than a silent loss of coverage.
  const cputypes = Array.from({ length: 16 }, () => 0x0100000c);
  const header = identify(binaryFile(machoFat({ cputypes })));
  assert.equal(header.format, "Mach-O (universal)");
  assert.equal(header.arches.length, 16);
});

test("a fat header claiming more slices than the file holds is rejected", () => {
  assert.equal(
    identify(binaryFile(machoFat({ cputypes: [0x01000007, 0x0100000c], declared: 8, size: 48 }))),
    null,
  );
});

// ── PE ─────────────────────────────────────────────────────────────────

test("a PE binary is classified as win32, with its architecture", () => {
  assert.deepEqual(identify(binaryFile(pe({ machine: 0x8664 }))), {
    platform: "win32",
    format: "PE",
    arches: ["x64"],
  });
  assert.deepEqual(identify(binaryFile(pe({ machine: 0xaa64 }))).arches, ["arm64"]);
  assert.deepEqual(identify(binaryFile(pe({ machine: 0x014c }))).arches, ["ia32"]);
  assert.deepEqual(identify(binaryFile(pe({ machine: 0x01c4 }))).arches, ["armv7l"]);
});

test("the old Windows CE ARM machine degrades to a named measurement", () => {
  // Left out of the table on purpose. This pins that decision: it must read as
  // a measurement rather than quietly becoming armv7l.
  assert.deepEqual(identify(binaryFile(pe({ machine: 0x01c0 }))).arches, ["PE machine 0x1c0"]);
});

test("an MZ file that is not a PE is not judged", () => {
  // A DOS executable, or anything else beginning MZ. Reporting it as a Windows
  // binary would be a lie about a file we cannot read.
  assert.equal(identify(binaryFile(pe({ signature: 0x0000dead }))), null);
});

test("a PE offset pointing somewhere implausible is not followed", () => {
  assert.equal(identify(binaryFile(pe({ peOffset: 0x20 }))), null, "before the DOS stub ends");
  assert.equal(identify(binaryFile(pe({ peOffset: 9000 }))), null, "beyond what was read");
});

// ── Not an object file at all ──────────────────────────────────────────

test("a file that is not an object file is not an architecture mismatch", () => {
  // It comes back null so the caller counts it as unrecognised. A `.node` that
  // is not ELF, Mach-O or PE is a different bug, and reporting it as a wrong
  // architecture would send whoever reads the failure to the wrong place.
  assert.equal(identify(binaryFile(Buffer.from("#!/bin/sh\necho not a binary\n"))), null);
  assert.equal(identify(binaryFile(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0]))), null);
});

test("a file too short to hold any magic is not judged", () => {
  assert.equal(identify(binaryFile(Buffer.alloc(0))), null);
  assert.equal(identify(binaryFile(Buffer.from([0x7f, 0x45, 0x4c]))), null);
});

// ── the bytes decide, not the directory ────────────────────────────────

test("a file is classified by what it measures, never by the directory it sits in", () => {
  // An x64 binary sitting in a directory called arm64 is precisely the bug this
  // check exists to catch, so the path must carry no weight whatsoever.
  const elfInDarwinDir = binaryFileAt(
    "onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node",
    elf({ machine: 0x3e }),
  );
  assert.deepEqual(identify(elfInDarwinDir), {
    platform: "linux",
    format: "ELF",
    arches: ["x64"],
  });

  const machoInLinuxDir = binaryFileAt(
    "onnxruntime-node/bin/napi-v6/linux/x64/onnxruntime_binding.node",
    machoThin({ cputype: 0x0100000c }),
  );
  assert.equal(identify(machoInLinuxDir).platform, "darwin");
});

test("a foreign-container file at a path this target resolves is still foreign", () => {
  // Pinning the open question KYB-544 deferred rather than settling it. Today a
  // PE binary sitting where a linux build would look is classified win32, which
  // makes it non-fatal payload rather than a fault. That is Paul's call to
  // revisit; this test is here so the day it changes, something says so.
  const peOnLinuxPath = binaryFileAt(
    "@img/sharp-linux-x64/lib/sharp-linux-x64.node",
    pe({ machine: 0x8664 }),
  );
  assert.equal(identify(peOnLinuxPath).platform, "win32");
});

// ── normaliseArch ──────────────────────────────────────────────────────

test("the spellings of an architecture all normalise to one name", () => {
  assert.equal(normaliseArch("x86_64"), "x64");
  assert.equal(normaliseArch("amd64"), "x64");
  assert.equal(normaliseArch("aarch64"), "arm64");
  assert.equal(normaliseArch("arm"), "armv7l");
  assert.equal(normaliseArch("x86"), "ia32");
  assert.equal(normaliseArch("universal"), "universal");
});

test("case and surrounding whitespace do not change an architecture", () => {
  assert.equal(normaliseArch("  ARM64 "), "arm64");
  assert.equal(normaliseArch("X86_64"), "x64");
});

test("an architecture we do not know is null, never a guess", () => {
  assert.equal(normaliseArch("riscv64"), null);
  assert.equal(normaliseArch(""), null);
  assert.equal(normaliseArch(undefined), null);
});

// ── archFromPath ───────────────────────────────────────────────────────

test("an electron-builder output directory names the architecture", () => {
  assert.equal(archFromPath("dist/mac-arm64/KYBER Studio.app"), "arm64");
  assert.equal(archFromPath("dist/linux-arm64-unpacked"), "arm64");
  assert.equal(archFromPath("dist/darwin-arm64"), "arm64");
});

test("no architecture segment means electron-builder's default, not unknown", () => {
  assert.equal(archFromPath("dist/linux-unpacked"), "x64");
  assert.equal(archFromPath("dist/mac"), "x64");
  assert.equal(archFromPath("dist/win-unpacked"), "x64");
});

test("the output directory wins over a platform-shaped directory further up", () => {
  // Segments are searched from the end for exactly this: a CI workspace or a
  // checkout path can contain anything.
  assert.equal(archFromPath("/build/linux-x64/ci/dist/linux-arm64-unpacked"), "arm64");
  assert.equal(archFromPath("/home/ci/mac-x64/out/dist/mac-arm64/KYBER Studio.app"), "arm64");
});

test("a platform segment naming an architecture we cannot check fails loudly", () => {
  // The important half is the second assertion: it must NOT fall through to the
  // linux-x64 further up the path and answer x64 for a riscv64 build.
  assert.equal(archFromPath("dist/linux-riscv64-unpacked"), null);
  assert.equal(archFromPath("/build/linux-x64/dist/linux-riscv64-unpacked"), null);
});

test("a path that names no platform yields null rather than the host's architecture", () => {
  // The one substitution that must never happen: defaulting to process.arch is
  // the assumption this whole check exists to catch.
  assert.equal(archFromPath("/Volumes/KYBER Studio/KYBER Studio.app"), null);
  assert.equal(archFromPath("/tmp/downloads/some-app"), null);
});

// ── tallyPlatforms ─────────────────────────────────────────────────────

test("foreign payload is tallied per platform, in a stable order", () => {
  // win32 appearing here is the visible evidence that the PE branch ran at all.
  assert.equal(
    tallyPlatforms([
      { platform: "win32" },
      { platform: "linux" },
      { platform: "win32" },
      { platform: "linux" },
    ]),
    "linux ×2, win32 ×2",
  );
  assert.equal(tallyPlatforms([{ platform: "linux" }]), "linux ×1");
  assert.equal(tallyPlatforms([]), "");
});

// ── the decision that fails a build ────────────────────────────────────

test("what counts as the right architecture, including the universal case", () => {
  assert.deepEqual(acceptableFor("x64"), new Set(["x64"]));
  assert.deepEqual(acceptableFor("arm64"), new Set(["arm64"]));
  // A universal macOS app is the one target that is not a single architecture.
  assert.deepEqual(acceptableFor("universal"), new Set(["x64", "arm64"]));
  // And "universal" must never reach the reader as though it were an arch.
  assert.equal(expectedLabel(acceptableFor("universal")), "x64 or arm64");
  assert.equal(expectedLabel(acceptableFor("x64")), "x64");
});

test("a same-platform binary of the expected architecture is correct", () => {
  const acceptable = acceptableFor("x64");
  assert.equal(verdictFor({ platform: "linux", arches: ["x64"] }, "linux", acceptable), "correct");
});

test("a same-platform binary of the wrong architecture is fatal", () => {
  // The failure the whole section exists to produce.
  const acceptable = acceptableFor("arm64");
  assert.equal(verdictFor({ platform: "linux", arches: ["x64"] }, "linux", acceptable), "wrong-arch");
});

test("a foreign-platform binary is never fatal, whatever architecture it is", () => {
  // It is not going to be loaded here, so its arch is irrelevant. Failing the
  // build over it would fail over a file that cannot matter.
  const acceptable = acceptableFor("arm64");
  assert.equal(verdictFor({ platform: "win32", arches: ["x64"] }, "linux", acceptable), "foreign");
  assert.equal(verdictFor({ platform: "darwin", arches: ["ia32"] }, "linux", acceptable), "foreign");
});

test("a foreign-platform binary is not evidence the bundle is right either", () => {
  // The other half, and the easier one to get wrong: a win32 x64 binary in an
  // x64 linux bundle matches the expected arch exactly, and must STILL be
  // foreign — otherwise foreign payload inflates the checked count and a bundle
  // full of the wrong platform reports a reassuring number of files verified.
  // (No `notEqual(..., "correct")` beside it: the assertion above already
  // excludes every other verdict, so a second one could never fail and would be
  // coverage in appearance only — which this ticket has been bitten by once.)
  const acceptable = acceptableFor("x64");
  assert.equal(verdictFor({ platform: "win32", arches: ["x64"] }, "linux", acceptable), "foreign");
});

test("the set of verdicts is closed at four", () => {
  // What makes the caller's `default: throw` safe rather than merely unreached.
  const verdicts = new Set();
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const arches of [["x64"], ["arm64"], ["ia32"], [], ["ELF machine 0x2b"], ["x64", "arm64"]]) {
      for (const expected of ["x64", "arm64", "ia32", "universal"]) {
        for (const target of ["linux", "darwin", "win32"]) {
          verdicts.add(verdictFor({ platform, arches }, target, acceptableFor(expected)));
        }
      }
    }
  }
  verdicts.add(verdictFor(null, "linux", acceptableFor("x64")));
  assert.deepEqual([...verdicts].sort(), ["correct", "foreign", "unrecognised", "wrong-arch"]);
});

test("a file that is not an object file is unrecognised, not a mismatch", () => {
  assert.equal(verdictFor(null, "linux", acceptableFor("x64")), "unrecognised");
});

test("a universal target accepts either slice and still rejects a third", () => {
  const acceptable = acceptableFor("universal");
  assert.equal(verdictFor({ platform: "darwin", arches: ["x64"] }, "darwin", acceptable), "correct");
  assert.equal(verdictFor({ platform: "darwin", arches: ["arm64"] }, "darwin", acceptable), "correct");
  assert.equal(verdictFor({ platform: "darwin", arches: ["ia32"] }, "darwin", acceptable), "wrong-arch");
});

test("a fat binary passes on any one acceptable slice and fails on none", () => {
  const acceptable = acceptableFor("arm64");
  assert.equal(verdictFor({ platform: "darwin", arches: ["x64", "arm64"] }, "darwin", acceptable), "correct");
  assert.equal(verdictFor({ platform: "darwin", arches: ["x64", "ia32"] }, "darwin", acceptable), "wrong-arch");
  // A fat header we could read but whose slices we cannot name is still not ours.
  assert.equal(
    verdictFor({ platform: "darwin", arches: ["Mach-O cputype 0x100000f"] }, "darwin", acceptable),
    "wrong-arch",
  );
});

test("a measurement with no name fails loudly on the target platform", () => {
  // "ELF machine 0x2b" is in no acceptable set, so it lands on wrong-arch rather
  // than being quietly skipped. It is provably not what we ship.
  assert.equal(
    verdictFor({ platform: "linux", arches: ["ELF machine 0x2b"] }, "linux", acceptableFor("x64")),
    "wrong-arch",
  );
});

test("measuring and deciding join up, from bytes to verdict", () => {
  // The two halves of the check against one real header, so a change that makes
  // the classifier and the decision disagree cannot pass both suites.
  const linuxX64 = identify(binaryFile(elf({ machine: 0x3e })));
  assert.equal(verdictFor(linuxX64, "linux", acceptableFor("x64")), "correct");
  assert.equal(verdictFor(linuxX64, "linux", acceptableFor("arm64")), "wrong-arch");
  assert.equal(verdictFor(linuxX64, "darwin", acceptableFor("x64")), "foreign");

  const notAnObject = identify(binaryFile(Buffer.from("#!/bin/sh\n")));
  assert.equal(verdictFor(notAnObject, "linux", acceptableFor("x64")), "unrecognised");
});

/**
 * `tallyVerdicts` — the walk's bookkeeping (KYB-562).
 *
 * These exist to catch ONE edit: counting a file the section did not arch-check
 * as one it did. `wrong-arch` and `correct` are checked; `foreign` and
 * `unrecognised` are not. Break that and nothing else fails — the build goes
 * green with a bigger, more comforting number, which is a silent failure in the
 * machinery whose entire job is to make a silent failure loud.
 *
 * Until KYB-562 these five lines sat inside the loop in `verify-package.mjs`,
 * which is a script: importing it runs it, so no committed test could reach
 * them. An edit adding `checked += 1` to the `foreign` case would have passed
 * the whole suite.
 *
 * The verdicts are handed in rather than derived here. `verdictFor` is already
 * exhaustively tested above, and what is under test below is only what the
 * caller DOES with its answer — so the inputs are synthetic verdict lists and no
 * file is read.
 */
const nativeAt = (n) => ({
  file: `/dist/linux-unpacked/resources/app.asar.unpacked/${n}.node`,
  shown: `resources/app.asar.unpacked/${n}.node`,
});
const LINUX_X64 = { platform: "linux", format: "ELF", arches: ["x64"] };
const LINUX_ARM64 = { platform: "linux", format: "ELF", arches: ["arm64"] };
const WIN32_X64 = { platform: "win32", format: "PE", arches: ["x64"] };
const entry = (verdict, header, n = 0) => ({ native: nativeAt(n), header, verdict });

test("an empty walk tallies to nothing", () => {
  assert.deepEqual(tallyVerdicts([]), {
    checked: 0,
    unrecognised: 0,
    foreignPlatform: [],
    wrongArch: [],
  });
});

test("a correct file counts as checked", () => {
  const { checked, wrongArch, foreignPlatform, unrecognised } = tallyVerdicts([
    entry("correct", LINUX_X64),
  ]);
  assert.equal(checked, 1);
  assert.deepEqual(wrongArch, []);
  assert.deepEqual(foreignPlatform, []);
  assert.equal(unrecognised, 0);
});

test("a wrong-arch file counts as checked AND is reported", () => {
  // Both halves matter and they fail independently. Dropping the `checked`
  // increment here is the third mutation KYB-562 names: the file WAS examined
  // and found wrong, so a bundle of nothing but mismatches must not report that
  // it checked none of them.
  const { checked, wrongArch } = tallyVerdicts([entry("wrong-arch", LINUX_ARM64)]);
  assert.equal(checked, 1);
  assert.equal(wrongArch.length, 1);
});

test("a foreign file is never counted as checked", () => {
  // The first mutation KYB-562 names. A win32 x64 binary in an x64 linux bundle
  // matches the expected arch exactly and is still not evidence of anything —
  // it is not going to be loaded here, so it was never arch-checked.
  const { checked, foreignPlatform } = tallyVerdicts([entry("foreign", WIN32_X64)]);
  assert.equal(checked, 0);
  assert.equal(foreignPlatform.length, 1);
});

test("an unrecognised file is never counted as checked", () => {
  // The second mutation KYB-562 names. `identify` returned null: we do not know
  // what this file is, which is the opposite of having verified it.
  const { checked, unrecognised } = tallyVerdicts([entry("unrecognised", null)]);
  assert.equal(checked, 0);
  assert.equal(unrecognised, 1);
});

test("the checked/unchecked asymmetry holds across a mixed walk", () => {
  // Eight files, three of them arch-checked. The single assertion that fails
  // under any of the four increment mutations at once, and the shape a real
  // bundle actually has: some payload for this platform, some for others.
  const tally = tallyVerdicts([
    entry("correct", LINUX_X64, 0),
    entry("foreign", WIN32_X64, 1),
    entry("unrecognised", null, 2),
    entry("wrong-arch", LINUX_ARM64, 3),
    entry("foreign", WIN32_X64, 4),
    entry("correct", LINUX_X64, 5),
    entry("unrecognised", null, 6),
    entry("foreign", WIN32_X64, 7),
  ]);
  assert.equal(tally.checked, 3, "only correct and wrong-arch are checked");
  assert.equal(tally.unrecognised, 2);
  assert.equal(tally.foreignPlatform.length, 3);
  assert.equal(tally.wrongArch.length, 1);
});

test("reported files keep the order the walk found them in", () => {
  // The report prints these lists straight out, file by file. A reordering here
  // would be invisible in the counts and wrong on the screen.
  const tally = tallyVerdicts([
    entry("foreign", WIN32_X64, 2),
    entry("wrong-arch", LINUX_ARM64, 9),
    entry("foreign", WIN32_X64, 0),
    entry("wrong-arch", LINUX_ARM64, 4),
    entry("foreign", WIN32_X64, 1),
  ]);
  assert.deepEqual(
    tally.foreignPlatform.map(({ shown }) => shown),
    [nativeAt(2).shown, nativeAt(0).shown, nativeAt(1).shown],
  );
  assert.deepEqual(
    tally.wrongArch.map(({ shown }) => shown),
    [nativeAt(9).shown, nativeAt(4).shown],
  );
});

test("a reported file carries exactly the fields its report line reads", () => {
  // `reportUncheckedFiles` destructures { shown, format, arches } off a foreign
  // entry and `tallyPlatforms` reads its `platform`; the wrong-arch report reads
  // { shown, arches }. The whole object is pinned rather than those fields, so
  // that a field appearing or vanishing is a failure here rather than a surprise
  // on the screen.
  //
  // It does NOT pin the merge direction — measured, not assumed: flipping the
  // spread survives this assertion, because nothing in `nativeAt` collides with
  // the header. The test below is the one that pins it.
  const foreign = tallyVerdicts([entry("foreign", WIN32_X64, 3)]).foreignPlatform[0];
  assert.deepEqual(foreign, { ...nativeAt(3), platform: "win32", format: "PE", arches: ["x64"] });

  const wrong = tallyVerdicts([entry("wrong-arch", LINUX_ARM64, 3)]).wrongArch[0];
  assert.deepEqual(wrong, { ...nativeAt(3), arches: ["arm64"] });
  // NOT the header's platform/format: the wrong-arch line names the file and the
  // arches it found, and carrying more would be shape nothing reads.
  assert.equal("format" in wrong, false);
  assert.equal("platform" in wrong, false);
});

test("the header wins where it and the walk's own record disagree", () => {
  // `nodeFilesIn` yields { file, shown } and nothing else, so today no key
  // collides and the merge direction is invisible — flipping `{ ...native,
  // ...header }` to `{ ...header, ...native }` survives every other test in this
  // file. That was measured by mutation, not assumed.
  //
  // It stops being invisible the moment anyone adds a field like `format` to the
  // walk's record, which is a natural thing to add: the report would silently
  // begin printing the PATH's idea of what the file is instead of the BYTES'.
  // That is this section's oldest failure mode — substituting an assumption for
  // a measurement — so the direction is pinned here with a record that
  // deliberately carries the collision.
  const native = { ...nativeAt(5), format: "guessed-from-the-path", arches: ["guessed-from-the-path"] };
  const { foreignPlatform } = tallyVerdicts([{ native, header: WIN32_X64, verdict: "foreign" }]);
  assert.equal(foreignPlatform[0].format, "PE");
  assert.deepEqual(foreignPlatform[0].arches, ["x64"]);
});

test("a fifth verdict throws and names the file, rather than being counted", () => {
  // What makes the `default:` branch a guard rather than dead code. `verdictFor`
  // is closed at four verdicts (proved above), so this cannot arise today — it
  // exists for the day someone adds a fifth and does not come back here. Landing
  // silently is the failure mode the asymmetry exists to prevent.
  assert.throws(
    () => tallyVerdicts([entry("probably-fine", LINUX_X64, 7)]),
    { message: `unhandled verdict for ${nativeAt(7).shown}` },
  );
});

test("a fifth verdict is fatal even when everything around it is fine", () => {
  // It must not be swallowed by a walk that otherwise tallies cleanly.
  assert.throws(
    () => tallyVerdicts([entry("correct", LINUX_X64, 0), entry("who-knows", LINUX_X64, 1), entry("correct", LINUX_X64, 2)]),
    { message: `unhandled verdict for ${nativeAt(1).shown}` },
  );
});

test("each call tallies its own walk and nothing accumulates between them", () => {
  // Module-level collections would make a second call report the first one's
  // files too. Nothing calls this twice today; a reducer that cannot be called
  // twice is a trap for whoever first does.
  const first = tallyVerdicts([entry("foreign", WIN32_X64), entry("wrong-arch", LINUX_ARM64)]);
  const second = tallyVerdicts([entry("foreign", WIN32_X64)]);
  assert.equal(first.foreignPlatform.length, 1);
  assert.equal(second.foreignPlatform.length, 1);
  assert.equal(second.wrongArch.length, 0);
  assert.equal(second.checked, 0);
});

test("tallying does not mutate the walk it was handed", () => {
  // The entries are the walk's own record. Spreading into new objects rather
  // than decorating these is what keeps the reducer pure.
  const entries = [entry("foreign", WIN32_X64, 1), entry("wrong-arch", LINUX_ARM64, 2)];
  const before = structuredClone(entries);
  tallyVerdicts(entries);
  assert.deepEqual(entries, before);
});

/**
 * `formatUncheckedReport` — the report about files the arch check did NOT judge.
 *
 * Why these exist (KYB-586). This wording used to sit in `verify-package.mjs`,
 * reading the tally out of module scope, so nothing could call it: the script
 * runs on import, and the function took no arguments to give it. Deleting its
 * `foreignPlatform` branch left the whole suite green while every bundle
 * stopped reporting foreign payload — and this script's way of saying "all is
 * well" is also to say nothing. A pass and a failure looked identical.
 *
 * So the tests below pin two separate things: the words, and the fact that
 * there are any. The second matters more.
 */

/** A foreign entry as the walk builds it: `{ ...native, ...header }`. */
function foreignEntry(shown, format, arches, platform) {
  return { file: `/abs/${shown}`, shown, format, arches, platform };
}

const FOREIGN_LINUX_X64 = foreignEntry("…/napi-v6/linux/x64/onnxruntime_binding.node", "ELF", ["x64"], "linux");
const FOREIGN_WIN32_ARM64 = foreignEntry("…/napi-v6/win32/arm64/onnxruntime_binding.node", "PE", ["arm64"], "win32");

/** The tally shape `tallyVerdicts` returns, with only the fields this reads set. */
function uncheckedTally({ foreignPlatform = [], unrecognised = 0 } = {}) {
  return { checked: 0, unrecognised, foreignPlatform, wrongArch: [] };
}

test("nothing unchecked means nothing said", () => {
  assert.deepEqual(formatUncheckedReport(uncheckedTally()), []);
});

test("a single foreign file is described in the singular", () => {
  const lines = formatUncheckedReport(uncheckedTally({ foreignPlatform: [FOREIGN_LINUX_X64] }));
  assert.match(lines[0], /1 bundled \.node file is for another platform \(linux ×1\), not arch-checked:/);
  assert.doesNotMatch(lines[0], /files are/);
});

test("several foreign files are described in the plural, tallied per platform", () => {
  const lines = formatUncheckedReport(uncheckedTally({ foreignPlatform: [FOREIGN_LINUX_X64, FOREIGN_WIN32_ARM64] }));
  assert.match(lines[0], /2 bundled \.node files are for another platform \(linux ×1, win32 ×1\), not arch-checked:/);
});

/**
 * Each file sits directly above its own measurement — pinned with `deepEqual`
 * on a slice rather than with `includes`.
 *
 * This test previously made four `lines.includes(...)` assertions, which are
 * order-blind: they cannot tell "every file above its own measurement" from
 * "every path, then every measurement". Splitting the loop in two passed all
 * four while reporting the linux binary's path above the win32 binary's format
 * — a reader of a real bundle would conclude an ELF file was a PE. Caught in
 * review. The test's NAME claimed a pairing its assertions never checked, which
 * is the defect this whole ticket is about, one level in.
 */
test("every foreign file is paired with its own measurement, in order", () => {
  const lines = formatUncheckedReport(uncheckedTally({ foreignPlatform: [FOREIGN_LINUX_X64, FOREIGN_WIN32_ARM64] }));
  assert.deepEqual(lines.slice(1, 5), [
    `    ${FOREIGN_LINUX_X64.shown}`,
    "        ELF, x64",
    `    ${FOREIGN_WIN32_ARM64.shown}`,
    "        PE, arm64",
  ]);
});

test("a universal foreign binary lists every slice it carries", () => {
  const fat = foreignEntry("…/some.node", "Mach-O", ["x64", "arm64"], "darwin");
  const lines = formatUncheckedReport(uncheckedTally({ foreignPlatform: [fat] }));
  assert.ok(lines.includes("        Mach-O, x64 + arm64"), lines.join("\n"));
});

test("one unreadable file is singular, more than one is plural", () => {
  const one = formatUncheckedReport(uncheckedTally({ unrecognised: 1 }));
  assert.equal(one.length, 1);
  assert.match(one[0], /1 bundled \.node file was skipped: not an ELF, Mach-O or PE object\./);

  const three = formatUncheckedReport(uncheckedTally({ unrecognised: 3 }));
  assert.match(three[0], /3 bundled \.node files were skipped: not an ELF, Mach-O or PE object\./);
});

/**
 * The whole report for a known tally, line for line.
 *
 * The assertions above sample: they match a substring of the header and two of
 * the six prose lines. Review found that dropping the leading newline from a
 * header, or deleting one prose line, left them all green — so "the same lines
 * in the same order", which is this ticket's first acceptance criterion, was
 * defended by nothing. This pins it.
 */
test("the whole report for a known tally is exactly these lines", () => {
  const lines = formatUncheckedReport(uncheckedTally({ foreignPlatform: [FOREIGN_LINUX_X64], unrecognised: 2 }));
  assert.deepEqual(lines, [
    "\n  1 bundled .node file is for another platform (linux ×1), not arch-checked:",
    `    ${FOREIGN_LINUX_X64.shown}`,
    "        ELF, x64",
    "  Their platform is not this build's, so the per-platform resolution these",
    "  packages use does not select them here. That is a property of the files",
    "  measured above, NOT a load path this check traced — a foreign-container",
    "  file sitting at a path this target does resolve would still land here.",
    "  Dead weight in the artefact rather than a fault in it, and trimming them",
    "  is a packaging change with its own ticket.",
    "\n  2 bundled .node files were skipped: not an ELF, Mach-O or PE object.",
  ]);
});

test("both kinds of unchecked file are reported, foreign first", () => {
  const lines = formatUncheckedReport(uncheckedTally({ foreignPlatform: [FOREIGN_LINUX_X64], unrecognised: 2 }));
  const foreignAt = lines.findIndex((l) => l.includes("for another platform"));
  const skippedAt = lines.findIndex((l) => l.includes("were skipped"));
  assert.notEqual(foreignAt, -1, "no foreign block");
  assert.notEqual(skippedAt, -1, "no skipped line");
  assert.ok(foreignAt < skippedAt, "the skipped line came before the foreign block");
});

test("the report explains that a foreign file is a measurement, not a traced load path", () => {
  const lines = formatUncheckedReport(uncheckedTally({ foreignPlatform: [FOREIGN_LINUX_X64] }));
  const prose = lines.join("\n");
  assert.match(prose, /NOT a load path this check traced/);
  assert.match(prose, /Dead weight in the artefact rather than a fault in it/);
});

/**
 * The property the deleted `if` would have violated, stated directly rather
 * than left to be inferred from the cases above: if anything went unchecked,
 * the report says so. This is the assertion that a silent report fails.
 */
test("the report is empty if and only if nothing went unchecked", () => {
  for (const nForeign of [0, 1, 2]) {
    for (const unrecognised of [0, 1, 2]) {
      const foreignPlatform = [FOREIGN_LINUX_X64, FOREIGN_WIN32_ARM64].slice(0, nForeign);
      const lines = formatUncheckedReport(uncheckedTally({ foreignPlatform, unrecognised }));
      const somethingUnchecked = nForeign > 0 || unrecognised > 0;
      assert.equal(
        lines.length > 0,
        somethingUnchecked,
        `${nForeign} foreign + ${unrecognised} unrecognised produced ${lines.length} lines`,
      );
    }
  }
});

/**
 * A malformed tally must not read as a clean one. These four are the reason the
 * function validates rather than destructuring optimistically: a refactor that
 * renames or drops a field of `tallyVerdicts`'s return would otherwise make the
 * report go quiet, which is indistinguishable from a bundle with nothing wrong.
 */
test("a tally missing its foreign list throws rather than reporting nothing", () => {
  assert.throws(() => formatUncheckedReport({ unrecognised: 0 }), /foreignPlatform must be an array/);
});

test("a tally missing its unrecognised count throws rather than reporting nothing", () => {
  assert.throws(() => formatUncheckedReport({ foreignPlatform: [] }), /unrecognised must be a non-negative integer/);
});

test("a negative or fractional unrecognised count is rejected", () => {
  assert.throws(() => formatUncheckedReport({ foreignPlatform: [], unrecognised: -1 }), /non-negative integer/);
  assert.throws(() => formatUncheckedReport({ foreignPlatform: [], unrecognised: 1.5 }), /non-negative integer/);
});

test("something that is not a tally at all throws", () => {
  assert.throws(() => formatUncheckedReport(null), /a tally is required, got null/);
  assert.throws(() => formatUncheckedReport(undefined), /a tally is required, got undefined/);
  assert.throws(() => formatUncheckedReport("3 files"), /a tally is required, got string/);
});
