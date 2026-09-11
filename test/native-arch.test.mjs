import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  acceptableFor,
  archFromPath,
  expectedLabel,
  identify,
  normaliseArch,
  tallyPlatforms,
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
