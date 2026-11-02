#!/usr/bin/env node
// Regenerates the app icon from the SVG sources in build/icon-source/:
//
//   build/icon.png    1024x1024, square, full bleed. Windows (electron-builder
//                     derives the .ico from it) and the source for the Linux set.
//   build/icon.icns   macOS. macOS does not mask app icons, so these images carry
//                     Apple's grid: an 824px rounded tile on a transparent canvas.
//
//   npm i --no-save sharp@0.34
//   node scripts/generate-app-icon.mjs
//   node scripts/generate-linux-icons.mjs   # build/icons/ is derived from icon.png
//   git add build/icon.png build/icon.icns build/icons
//
// The sources are the brand's own app icon files with nothing redrawn: the K and
// the tile proportions come from the brand generator; only the ground colour
// (Graphite) and, for macOS, the placement on Apple's grid differ.
//   icon.svg            square tile, heavy mark at 58%      (brand: app-icon-*-square)
//   icon-mac.svg        the same, on Apple's 824px tile
//   icon-mac-small.svg  solid mark at 70%                   (brand: favicon-tile)
// The brand's minimum for the line mark is 24px tall, so the 16 and 32 pixel
// macOS images use the solid mark, as the brand's own favicon does.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "build", "icon-source");

const render = (file, size) =>
  sharp(join(SRC, file), { density: Math.max(72, (72 * size) / 1024) * 4 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toBuffer();

writeFileSync(join(ROOT, "build", "icon.png"), await render("icon.svg", 1024));

// ICNS: a big-endian container of (type, length, PNG) chunks. Every type below
// accepts PNG data.
const ICNS = [
  ["icp4", 16, "icon-mac-small.svg"],
  ["ic11", 32, "icon-mac-small.svg"], // 16@2x
  ["icp5", 32, "icon-mac-small.svg"],
  ["ic12", 64, "icon-mac.svg"], // 32@2x
  ["icp6", 64, "icon-mac.svg"],
  ["ic07", 128, "icon-mac.svg"],
  ["ic13", 256, "icon-mac.svg"], // 128@2x
  ["ic08", 256, "icon-mac.svg"],
  ["ic14", 512, "icon-mac.svg"], // 256@2x
  ["ic09", 512, "icon-mac.svg"],
  ["ic10", 1024, "icon-mac.svg"], // 512@2x
];
const chunks = [];
for (const [type, size, file] of ICNS) {
  const png = await render(file, size);
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(png.length + 8, 4);
  chunks.push(head, png);
}
const body = Buffer.concat(chunks);
const head = Buffer.alloc(8);
head.write("icns", 0, "ascii");
head.writeUInt32BE(body.length + 8, 4);
writeFileSync(join(ROOT, "build", "icon.icns"), Buffer.concat([head, body]));

console.log("wrote build/icon.png and build/icon.icns");
