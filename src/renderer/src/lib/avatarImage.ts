/**
 * Turning a file someone picked into an avatar worth storing.
 *
 * @remarks
 * A picture chosen for an avatar is almost never the size of an avatar. People
 * pick a photo off their desktop or a logo out of a brand folder — four
 * megapixels, often with an alpha channel — for something rendered at
 * thirty-four pixels square.
 *
 * Storing that as-is would work and would be quietly wrong: it inflates the
 * settings file that holds it, it is re-decoded on every render, and it is
 * carried around forever for detail no one can see. Resizing once, here, costs
 * a few milliseconds and makes the stored value small enough to treat as a
 * piece of text.
 */

/**
 * Rendered size. Twice the largest place an avatar is drawn, so it stays sharp
 * on a retina display without storing more than that needs.
 */
const SIZE = 128;

/** Refuse a file that is not an image before doing anything expensive with it. */
export function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}

/**
 * Read, square-crop and resize an image into a data URL.
 *
 * @remarks
 * Cropped from the centre rather than squashed. A stretched face is worse than
 * a cropped one, and every avatar here is drawn in a circle, so the corners
 * were never going to be visible anyway.
 *
 * PNG rather than JPEG: logos are a common choice and they have transparent
 * backgrounds, which JPEG turns into a black box.
 */
export async function toAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not read that image.");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);
    return canvas.toDataURL("image/png");
  } finally {
    bitmap.close();
  }
}
