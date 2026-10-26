#!/usr/bin/env python3
"""Pre-rasterize Fira Code into src/cards/font-atlas.json (run via `npm run font`).

Dev-only: needs Python 3 + Pillow + fontTools. The generated atlas is committed, so the
runtime (src/cards/font.js) never reads the TTF and stays dependency-free.

Each face (weight x pixel size) stores tightly-cropped 8-bit anti-aliased alpha bitmaps for
printable ASCII plus a few extras, concatenated, deflated and base64-encoded. Glyph boxes are
relative to the pen origin on the baseline: [dx, dy, w, h, offset] (dy < 0 is above baseline).
"""
import base64
import json
import zlib
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
TTF = ROOT / 'assets' / 'fonts' / 'FiraCode-VariableFont_wght.ttf'
OUT = ROOT / 'src' / 'cards' / 'font-atlas.json'

CHARS = ''.join(chr(c) for c in range(0x20, 0x7F)) + '…·'
# Card text "scale" → pixel size. size = 10 * scale keeps the old 5x7 advance (6 * scale px).
SIZES = {2: 20, 3: 30, 4: 40}
WEIGHTS = {'regular': 450, 'bold': 600}


def face(weight, size, upm, cap_height):
    font = ImageFont.truetype(str(TTF), size)
    font.set_variation_by_axes([weight])
    advance = font.getlength('M')
    assert advance == int(advance), f'non-integer advance {advance} at {size}px'
    blob = bytearray()
    glyphs = {}
    for ch in CHARS:
        l, t, r, b = font.getbbox(ch, anchor='ls')
        w, h = max(0, r - l), max(0, b - t)
        if w and h:
            img = Image.new('L', (w, h), 0)
            ImageDraw.Draw(img).text((-l, -t), ch, font=font, fill=255, anchor='ls')
            glyphs[ch] = [l, t, w, h, len(blob)]
            blob += img.tobytes()
        else:
            glyphs[ch] = [0, 0, 0, 0, len(blob)]
    return {
        'size': size,
        'weight': weight,
        'advance': int(advance),
        'capHeight': round(cap_height / upm * size),
        'lineHeight': round(size * 1.25),
        'glyphs': glyphs,
        'alpha': base64.b64encode(zlib.compress(bytes(blob), 9)).decode('ascii'),
    }


def main():
    tt = TTFont(str(TTF))
    upm = tt['head'].unitsPerEm
    cap = tt['OS/2'].sCapHeight
    atlas = {
        'font': 'Fira Code',
        'license': 'SIL Open Font License 1.1 (assets/fonts/OFL.txt)',
        'source': 'assets/fonts/FiraCode-VariableFont_wght.ttf',
        'generator': 'scripts/build-font-atlas.py',
        'chars': CHARS,
        'faces': {
            f'{name}-{scale}': face(weight, size, upm, cap)
            for name, weight in WEIGHTS.items()
            for scale, size in SIZES.items()
        },
    }
    OUT.write_text(json.dumps(atlas, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    print(f'wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KiB, {len(atlas["faces"])} faces)')


if __name__ == '__main__':
    main()
