// Official vendor marks (assets/logos/{tool}.png, see assets/logos/README.md), decoded with
// the built-in PNG decoder and drawn into a rounded tile on the card's left column.
import { readFileSync } from 'node:fs';
import { roundRectSdf } from './canvas.js';
import { decodePng } from './png.js';
import { themeFor } from './themes.js';

const LOGO_FILES = { grok: 'grok.png', claude: 'claude.png' };
const cache = new Map();

/** Decoded RGBA for a tool's logo (cached per process). */
export function loadLogo(tool) {
  const name = Object.hasOwn(LOGO_FILES, tool) ? tool : 'grok';
  if (!cache.has(name)) cache.set(name, decodePng(readFileSync(new URL(`../../assets/logos/${LOGO_FILES[name]}`, import.meta.url))));
  return cache.get(name);
}

/**
 * Draw the logo tile into a Canvas with top-left at (x, y). The tile is filled with
 * `theme.logo.tile`, then the official PNG is scaled into it with `theme.logo.inset`
 * padding on each side, clipped to the tile's rounded corners.
 */
export function drawLogo(canvas, tool, x, y, size) {
  const { logo } = themeFor(tool);
  const radius = Math.round(size * 0.22);
  canvas.fillRoundRect(x, y, size, size, radius, logo.tile);
  const pad = Math.round(size * logo.inset);
  const inner = size - 2 * pad;
  const sdf = roundRectSdf(-pad, -pad, size, size, radius);
  const mask = (px, py) => Math.min(1, Math.max(0, 0.5 - sdf(px, py)));
  canvas.drawImage(loadLogo(tool), x + pad, y + pad, inner, inner, { mask });
}
