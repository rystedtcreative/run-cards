// Fira Code glyph atlas (pre-rasterized by scripts/build-font-atlas.py → font-atlas.json).
// Runtime only reads the committed JSON — no TTF parsing, no native deps.
// Fira Code © The Fira Code Project Authors, SIL Open Font License 1.1 (assets/fonts/OFL.txt).
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const atlas = JSON.parse(readFileSync(new URL('./font-atlas.json', import.meta.url), 'utf8'));

/** Characters the atlas can draw; everything else must be folded first (see toCardText). */
export const SUPPORTED_CHARS = atlas.chars;

/** Text scales with a rasterized face (scale n ≈ 10n px Fira Code, advance 6n px). */
export const SCALES = [...new Set(Object.keys(atlas.faces).map((k) => Number(k.split('-')[1])))].sort((a, b) => a - b);

const cache = new Map();

/**
 * Face for a text scale. Glyph boxes are [dx, dy, w, h, offset] relative to the pen origin on
 * the baseline; `alpha` holds the concatenated 8-bit coverage bitmaps.
 * @returns {{ size: number, advance: number, capHeight: number, lineHeight: number, glyphs: Record<string, number[]>, alpha: Buffer }}
 */
export function face(scale, bold = false) {
  const s = SCALES.includes(scale) ? scale : SCALES.reduce((a, b) => (Math.abs(b - scale) < Math.abs(a - scale) ? b : a));
  const key = `${bold ? 'bold' : 'regular'}-${s}`;
  if (!cache.has(key)) {
    const f = atlas.faces[key];
    cache.set(key, { ...f, alpha: inflateSync(Buffer.from(f.alpha, 'base64')) });
  }
  return cache.get(key);
}

/** Glyph box for `ch` (unsupported chars draw as '?'). */
export function glyph(f, ch) {
  return f.glyphs[ch] ?? f.glyphs['?'];
}
