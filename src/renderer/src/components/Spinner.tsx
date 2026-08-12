import { type ReactNode, useEffect, useState } from "react";

/**
 * Braille "columns" loader, ported from Eve Studio.
 *
 * Frames are generated rather than listed: fill each of six columns bottom-up,
 * then flash full and empty. A generated sequence stays smooth at any size and
 * cannot drift out of order the way a hand-typed frame list does.
 *
 * Adapted from gunnargray-dev/unicode-animations.
 */
const BRAILLE_FRAMES: string[] = (() => {
  const DOT_MAP = [
    [0x01, 0x08],
    [0x02, 0x10],
    [0x04, 0x20],
    [0x40, 0x80],
  ];
  const W = 6;
  const H = 4;
  const grid = (): boolean[][] => Array.from({ length: H }, () => Array<boolean>(W).fill(false));
  const toBraille = (g: boolean[][]): string => {
    let out = "";
    for (let c = 0; c < Math.ceil(W / 2); c++) {
      let code = 0x2800;
      for (let r = 0; r < H; r++) {
        for (let d = 0; d < 2; d++) {
          const col = c * 2 + d;
          if (g[r]?.[col]) code |= DOT_MAP[r]?.[d] ?? 0;
        }
      }
      out += String.fromCodePoint(code);
    }
    return out;
  };

  const frames: string[] = [];
  for (let col = 0; col < W; col++) {
    for (let fillTo = H - 1; fillTo >= 0; fillTo--) {
      const g = grid();
      for (let pc = 0; pc < col; pc++) for (let r = 0; r < H; r++) g[r]![pc] = true;
      for (let r = fillTo; r < H; r++) g[r]![col] = true;
      frames.push(toBraille(g));
    }
  }
  const full = grid();
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) full[r]![c] = true;
  frames.push(toBraille(full));
  frames.push(toBraille(grid()));
  return frames;
})();

export function Spinner({ className }: { className?: string }): ReactNode {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setFrame((f) => (f + 1) % BRAILLE_FRAMES.length), 60);
    return () => clearInterval(iv);
  }, []);
  return (
    <span className={`spinner${className ? ` ${className}` : ""}`} aria-hidden="true">
      {BRAILLE_FRAMES[frame]}
    </span>
  );
}
