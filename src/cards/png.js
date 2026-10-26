// Minimal PNG encoder (8-bit RGBA, no interlace) and decoder (8-bit grey/RGB/palette/RGBA,
// non-interlaced — enough for the bundled logos) using node:zlib.
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode an RGBA pixel buffer as PNG.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba length = width*height*4
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Decode a PNG to straight-alpha RGBA.
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, data: Uint8Array }}
 */
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const kind = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      [depth, type] = [data[8], data[9]];
      interlace = data[12];
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') trns = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  const channels = CHANNELS[type];
  if (depth !== 8 || !channels || interlace) {
    throw new Error(`unsupported PNG (bit depth ${depth}, colour type ${type}, interlace ${interlace})`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[row + x - channels] : 0;
      const b = y ? px[row - stride + x] : 0;
      const c = y && x >= channels ? px[row - stride + x - channels] : 0;
      const v = raw[src + x];
      px[row + x] = filter === 0 ? v : filter === 1 ? v + a : filter === 2 ? v + b : filter === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c);
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += channels) {
    const o = i * 4;
    if (type === 6) out.set(px.subarray(j, j + 4), o);
    else if (type === 2) out.set([px[j], px[j + 1], px[j + 2], 255], o);
    else if (type === 0) out.set([px[j], px[j], px[j], 255], o);
    else if (type === 4) out.set([px[j], px[j], px[j], px[j + 1]], o);
    else {
      const p = px[j];
      out.set([palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2], trns && p < trns.length ? trns[p] : 255], o);
    }
  }
  return { width, height, data: out };
}

/** Area-average (box filter) resample of straight-alpha RGBA, alpha-weighted. Best for downscaling. */
export function resizeRgba(src, sw, sh, dw, dh) {
  const pass = (data, w, h, nw, horizontal) => {
    const len = horizontal ? w : h;
    const nlen = nw;
    const out = new Float64Array((horizontal ? nw * h : w * nw) * 4);
    const ratio = len / nlen;
    const lines = horizontal ? h : w;
    for (let line = 0; line < lines; line++) {
      for (let d = 0; d < nlen; d++) {
        const s0 = d * ratio;
        const s1 = s0 + ratio;
        let r = 0, g = 0, b = 0, a = 0, wsum = 0;
        for (let s = Math.floor(s0); s < Math.ceil(s1) && s < len; s++) {
          const wgt = Math.min(s + 1, s1) - Math.max(s, s0);
          const i = (horizontal ? line * w + s : s * w + line) * 4;
          const al = data[i + 3] * wgt;
          r += data[i] * al;
          g += data[i + 1] * al;
          b += data[i + 2] * al;
          a += al;
          wsum += wgt;
        }
        const o = (horizontal ? line * nw + d : d * w + line) * 4;
        if (a > 0) {
          out[o] = r / a;
          out[o + 1] = g / a;
          out[o + 2] = b / a;
        }
        out[o + 3] = a / wsum;
      }
    }
    return out;
  };
  const tmp = pass(src, sw, sh, dw, true);
  const res = pass(tmp, dw, sh, dh, false);
  return Uint8Array.from(res, (v) => Math.round(v));
}
