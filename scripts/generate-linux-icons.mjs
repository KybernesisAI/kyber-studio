#!/usr/bin/env node
// Regenerates build/icons/ from build/icon.png — the hicolor icon set that the
// .deb and the AppImage ship. Run by hand after changing build/icon.png:
//
//   node scripts/generate-linux-icons.mjs
//
// WHY THIS EXISTS, because a single large PNG looks like it should be enough.
// electron-builder does NOT derive size variants from one file. Given a lone
// 1024x1024 build/icon.png, its generator emits exactly one entry —
//   {"icons":[{"file":"build/icon.png","size":1024}]}
// — and app-builder-lib's FpmTarget then installs that single icon to
// /usr/share/icons/hicolor/1024x1024/apps/. The hicolor theme's index.theme
// does not list a 1024x1024 directory, so no desktop ever looks there and the
// application menu falls back to a generic icon. That was KYB-609.
//
// Every size below IS listed in hicolor's index.theme, so each one lands in a
// directory a desktop actually searches. 1024 is deliberately absent.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "build", "icon.png");
const OUT = join(ROOT, "build", "icons");
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

mkdirSync(OUT, { recursive: true });

for (const size of SIZES) {
  const buffer = await sharp(SOURCE).resize(size, size).png().toBuffer();
  writeFileSync(join(OUT, `${size}x${size}.png`), buffer);
  console.log(`wrote ${size}x${size}.png (${buffer.length} bytes)`);
}
