#!/usr/bin/env node
/**
 * Materialise the Microsoft VC++ x64 redistributable that the NSIS installer
 * embeds as dictation's prerequisite.
 *
 * @remarks
 * The shipped `onnxruntime.dll` and `onnxruntime_binding.node` are linked with
 * MSVC toolset 14.44 and load-time import `VCRUNTIME140.dll`,
 * `VCRUNTIME140_1.dll`, `MSVCP140.dll` and `MSVCP140_1.dll` — 163 C++ symbols
 * from `MSVCP140.dll` alone, in `onnxruntime.dll`. The MSVC runtime is forward
 * compatible but not backward, so a machine carrying an older runtime fails at
 * initialisation rather than at load: `ERROR_DLL_INIT_FAILED` (Win32 1114),
 * which is what a Windows 11 box with the 2019 16.4 runtime (14.24) did.
 * Measured in KYB-627, confirmed by installing the redistributable and
 * watching dictation start working.
 *
 * Dictation must work on a client's machine with nothing installed, so the
 * prerequisite travels inside our installer — the same argument that makes the
 * speech model a build input in `fetch-speech-model.mjs`. The end user never
 * fetches anything.
 *
 * The URL and SHA-256 are pinned in `build/windows-vc-redist.json`. A changed
 * binary therefore fails packaging rather than being embedded silently: the
 * version, hash, signature and redistribution terms get looked at by a person
 * before anything ships. That is the whole point of the manifest, and it is why
 * this script deletes a file that fails verification instead of leaving it on
 * disk for the next run to find.
 *
 * Runs on any host — it only downloads and hashes — so it can be exercised and
 * its failure mode reproduced without a Windows machine. Safe to run
 * repeatedly: a verified copy short-circuits.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const BUILD = join(ROOT, "build");

const manifestPath = join(BUILD, "windows-vc-redist.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

/**
 * `build/vendor/` rather than anywhere under `resources/`.
 *
 * The installer embeds this file from `${BUILD_RESOURCES_DIR}`; it must not end
 * up inside the packaged app, where it would be 25 MB of dead weight the user
 * can never run.
 */
const destination = join(BUILD, "vendor", `vc_redist.${manifest.architecture}.exe`);

/** Hash a file without reading it all into memory — this one is ~25 MB. */
async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

async function sizeOf(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

const label = `vc_redist.${manifest.architecture}.exe ${manifest.version}`;

if ((await sizeOf(destination)) > 0 && (await sha256(destination)) === manifest.sha256) {
  process.stdout.write(`  using verified ${label}\n`);
  process.exit(0);
}

await mkdir(dirname(destination), { recursive: true });
await rm(destination, { force: true });

/**
 * Download to a temporary name and only adopt it once the hash matches, so an
 * interrupted or tampered download can never be mistaken for a verified one by
 * a later run.
 */
const partial = `${destination}.download`;
await rm(partial, { force: true });

process.stdout.write(`  fetching ${label} … `);

/**
 * Wrapped, because an unwrapped `fetch` rejection reaches the operator as a bare
 * `TypeError: fetch failed` with no cause and no guidance — and a DNS or
 * connection failure is by far the commonest way this script fails, so the
 * careful message below would otherwise be unreachable in exactly the case it
 * was written for.
 */
let response;
try {
  response = await fetch(manifest.url);
} catch (cause) {
  process.stdout.write("failed\n");
  process.stderr.write(
    `\nprepare-windows-vc-redist: could not reach ${manifest.url}\n` +
      `  ${cause instanceof Error ? cause.message : String(cause)}\n` +
      `${cause?.cause ? `  cause: ${cause.cause}\n` : ""}` +
      `  Nothing was downloaded and nothing was embedded in the installer.\n` +
      `  This is almost always no network or a proxy in the way; the pinned\n` +
      `  Microsoft URL itself is immutable.\n`,
  );
  process.exit(1);
}

if (!response.ok || !response.body) {
  process.stdout.write("failed\n");
  process.stderr.write(
    `\nprepare-windows-vc-redist: ${manifest.url}\n` +
      `  responded ${response.status} ${response.statusText}.\n` +
      `  The pinned Microsoft download URL is immutable, so a non-200 here means\n` +
      `  either no network or that Microsoft withdrew this build. If it was\n` +
      `  withdrawn, pick the current redistributable (>= toolset ${manifest.minimumToolset}),\n` +
      `  and update url, version and sha256 in build/windows-vc-redist.json together.\n`,
  );
  process.exit(1);
}

try {
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
} catch (cause) {
  await rm(partial, { force: true });
  process.stdout.write("failed\n");
  process.stderr.write(
    `\nprepare-windows-vc-redist: the download did not complete.\n` +
      `  ${cause instanceof Error ? cause.message : String(cause)}\n` +
      `  The partial file has been deleted, so the next run starts clean.\n`,
  );
  process.exit(1);
}

const actual = await sha256(partial);
if (actual !== manifest.sha256) {
  await rm(partial, { force: true });
  process.stdout.write("hash mismatch\n");
  process.stderr.write(
    `\nprepare-windows-vc-redist: refusing to embed an unverified binary.\n` +
      `  expected sha256: ${manifest.sha256}\n` +
      `  actual sha256:   ${actual}\n` +
      `  downloaded from: ${manifest.url}\n\n` +
      `  The download has been deleted. Nothing was embedded in the installer.\n` +
      `  If Microsoft has republished this file, verify the new binary's version\n` +
      `  and signature by hand, then update build/windows-vc-redist.json.\n`,
  );
  process.exit(1);
}

await rename(partial, destination);

const bytes = await sizeOf(destination);
process.stdout.write(`verified, ${(bytes / 1024 / 1024).toFixed(1)} MB\n`);
