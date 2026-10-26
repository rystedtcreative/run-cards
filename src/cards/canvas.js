// Tiny software rasterizer: anti-aliased shapes via signed distance fields, Fira Code text
// from a pre-rasterized alpha atlas, and RGBA image blits. Enough to draw run cards without
// native deps.
import { face, glyph } from './font.js';
import { encodePng, resizeRgba } from './png.js';

/** Parse '#rrggbb' → [r,g,b]. */
export function hex(c) {
  const n = parseInt(c.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class Canvas {
  constructor(width, height, background = '#000000') {
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    const [r, g, b] = hex(background);
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = 255;
    }
  }

  blend(x, y, rgb, alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const a = alpha > 1 ? 1 : alpha;
    const d = this.data;
    d[i] = d[i] + (rgb[0] - d[i]) * a;
    d[i + 1] = d[i + 1] + (rgb[1] - d[i + 1]) * a;
    d[i + 2] = d[i + 2] + (rgb[2] - d[i + 2]) * a;
  }

  /** Fill any shape described by a signed distance function sdf(px,py) (<0 inside). */
  fillSdf(x0, y0, x1, y1, sdf, color, opacity = 1) {
    const rgb = hex(color);
    const xa = Math.max(0, Math.floor(x0) - 1);
    const ya = Math.max(0, Math.floor(y0) - 1);
    const xb = Math.min(this.width - 1, Math.ceil(x1) + 1);
    const yb = Math.min(this.height - 1, Math.ceil(y1) + 1);
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const cov = clamp01(0.5 - sdf(x + 0.5, y + 0.5));
        if (cov > 0) this.blend(x, y, rgb, cov * opacity);
      }
    }
  }

  fillRect(x, y, w, h, color, opacity = 1) {
    const rgb = hex(color);
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.blend(xx, yy, rgb, opacity);
    }
  }

  fillRoundRect(x, y, w, h, r, color, opacity = 1) {
    this.fillSdf(x, y, x + w, y + h, roundRectSdf(x, y, w, h, r), color, opacity);
  }

  fillCircle(cx, cy, r, color, opacity = 1) {
    this.fillSdf(cx - r, cy - r, cx + r, cy + r, (px, py) => Math.hypot(px - cx, py - cy) - r, color, opacity);
  }

  ring(cx, cy, r, thickness, color, opacity = 1) {
    const R = r + thickness / 2;
    this.fillSdf(cx - R, cy - R, cx + R, cy + R,
      (px, py) => Math.abs(Math.hypot(px - cx, py - cy) - r) - thickness / 2, color, opacity);
  }

  /** Thick line with round caps. */
  line(x1, y1, x2, y2, thickness, color, opacity = 1) {
    const h = thickness / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    this.fillSdf(Math.min(x1, x2) - h, Math.min(y1, y2) - h, Math.max(x1, x2) + h, Math.max(y1, y2) + h, (px, py) => {
      const t = clamp01(((px - x1) * dx + (py - y1) * dy) / len2);
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)) - h;
    }, color, opacity);
  }

  /**
   * Draw a single line of text. `y` is the cap-height top of the line (baseline at
   * y + capHeight). Returns the advance width in px.
   */
  text(str, x, y, scale, color, opacity = 1, { bold = false } = {}) {
    const rgb = hex(color);
    const f = face(scale, bold);
    const baseline = Math.round(y) + f.capHeight;
    let pen = Math.round(x);
    for (const ch of String(str)) {
      const [dx, dy, w, h, off] = glyph(f, ch);
      for (let gy = 0; gy < h; gy++) {
        for (let gx = 0; gx < w; gx++) {
          const a = f.alpha[off + gy * w + gx];
          if (a) this.blend(pen + dx + gx, baseline + dy + gy, rgb, (a / 255) * opacity);
        }
      }
      pen += f.advance;
    }
    return pen - Math.round(x);
  }

  /**
   * Draw straight-alpha RGBA pixels scaled into (x, y, w, h). Optional `mask(px, py)` returns
   * extra coverage in [0,1] per destination pixel (e.g. rounded-corner clipping).
   */
  drawImage(img, x, y, w, h, { mask } = {}) {
    const px = img.width === w && img.height === h ? img.data : resizeRgba(img.data, img.width, img.height, w, h);
    for (let yy = 0; yy < h; yy++) {
      for (let xx = 0; xx < w; xx++) {
        const i = (yy * w + xx) * 4;
        const cov = (px[i + 3] / 255) * (mask ? mask(xx + 0.5, yy + 0.5) : 1);
        if (cov > 0) this.blend(x + xx, y + yy, [px[i], px[i + 1], px[i + 2]], cov);
      }
    }
  }

  toPng() {
    return encodePng(this.width, this.height, this.data);
  }
}

/** Horizontal advance per character at a given scale (Fira Code is monospace). */
export function textAdvance(scale) {
  return face(scale).advance;
}

/** Baseline-to-baseline distance at a given scale. */
export function lineHeight(scale) {
  return face(scale).lineHeight;
}

/** Cap height in px at a given scale (`text()` draws caps from y to y + capHeight). */
export function capHeight(scale) {
  return face(scale).capHeight;
}

export function textWidth(str, scale) {
  return [...String(str)].length * textAdvance(scale);
}

/** Signed distance to a rounded rect (x, y, w, h, r); < 0 inside. */
export function roundRectSdf(x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  return (px, py) => {
    const qx = Math.abs(px - cx) - hw;
    const qy = Math.abs(py - cy) - hh;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
}
