#!/usr/bin/env node
// Regenerates build/icons/ — the hicolor icon set the Linux .deb installs. (The
// AppImage consumes the same set; this file makes no claim about whether an
// un-integrated AppImage displays it.)
//
//   npm i --no-save sharp@0.34   # see DEPENDENCY below
//   node scripts/generate-linux-icons.mjs
//   git add build/icons       # the output is committed, not built on demand
//
// WHY THIS EXISTS, because one large PNG looks like it should be enough.
// electron-builder does NOT derive size variants from a single file. Given a
// lone 1024x1024 build/icon.png its generator emits exactly one entry —
//   {"icons":[{"file":"build/icon.png","size":1024}]}
// — and app-builder-lib's FpmTarget installs that icon, alone, to
// /usr/share/icons/hicolor/1024x1024/apps/. The index.theme governing that tree
// ships in the hicolor-icon-theme package, and its Directories= key lists these
// pixel sizes — alongside @2 variants, scalable, symbolic and non-Application
// contexts, so expect hundreds of entries, not thirteen:
//   16x16 22x22 24x24 32x32 36x36 48x48 64x64 72x72 96x96 128x128 192x192
//   256x256 512x512 — and no 1024x1024. Nothing searches that directory, so the
// application menu fell back to a generic icon. That was KYB-609.
//
// WHY THESE EIGHT SIZES. Each one appears in that Directories= list. The five
// indexed sizes left out (22, 36, 72, 96, 192) cost only slight softness at
// some HiDPI sizes: every hicolor stanza is Type=Threshold, so a lookup for an
// absent size scales the nearest present one instead of failing. Only an
// UNINDEXED size can reproduce the original bug, which is why 1024 is gone.
//
// DEPENDENCY. sharp is not declared in package.json. It resolves transitively
// today, which is not a thing to rely on, so install it for the length of this
// one job with `npm i --no-save sharp@0.34` — that leaves package.json and the
// lockfile untouched. The major is pinned so a regeneration years from now does
// not emit different bytes from a newer libvips encoder.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "build", "icon.png");
const OUT = join(ROOT, "build", "icons");
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

// sharp's default fit is "cover", which would silently CROP a non-square
// source. Refuse instead: a new icon that is not square needs a deliberate
// decision about padding, not a quiet centre-crop nobody reviews.
const { width, height } = await sharp(SOURCE).metadata();
if (width !== height) {
  throw new Error(
    `${SOURCE} is ${width}x${height}; a square source is required. ` +
      `Pad or crop it deliberately before regenerating.`,
  );
}

// Only now, with the source validated, clear the output. electron-builder globs
// OUT and reads each icon's size from its dimensions, so a leftover file from an
// earlier run would keep shipping. This runs AFTER the check above on purpose:
// wiping the committed set and then rejecting the source would leave a developer
// with neither.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

for (const size of SIZES) {
  const buffer = await sharp(SOURCE).resize(size, size).png().toBuffer();
  writeFileSync(join(OUT, `${size}x${size}.png`), buffer);
  console.log(`wrote ${size}x${size}.png (${buffer.length} bytes)`);
}
