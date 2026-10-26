import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCardFields, buildCloseCardFields } from '../src/cards/contract.js';
import { renderOpenCard, renderCloseCard, wrapText, summaryRows, toCardText, CARD_WIDTH, CARD_HEIGHT } from '../src/cards/render.js';
import { PNG_SIGNATURE } from '../src/cards/png.js';
import { hex } from '../src/cards/canvas.js';
import { THEMES } from '../src/cards/themes.js';
import { loadLogo } from '../src/cards/logo.js';
import { SUPPORTED_CHARS, face } from '../src/cards/font.js';
import { decodePng } from './helpers.js';

const NOENV = { env: {} };

function assertValidCard(png, tool) {
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
  const img = decodePng(png);
  assert.equal(img.width, CARD_WIDTH);
  assert.equal(img.height, CARD_HEIGHT);
  assert.deepEqual(img.pixel(2, 2), [...hex(THEMES[tool].outer), 255], 'outer background');
  assert.deepEqual(img.pixel(CARD_WIDTH - 60, CARD_HEIGHT - 50), [...hex(THEMES[tool].panel), 255], 'panel colour');
  return img;
}

for (const tool of ['grok', 'claude']) {
  test(`${tool}: opening card renders a ${CARD_WIDTH}x${CARD_HEIGHT} PNG with brand background`, () => {
    const f = buildOpenCardFields({ tool, model: 'm', effort: 'high', prompt: 'do the thing '.repeat(80) }, NOENV);
    assertValidCard(renderOpenCard(f), tool);
  });

  for (const [exitCode, timedOut] of [[0, false], [1, false], [124, true]]) {
    test(`${tool}: closing card renders (exit ${exitCode}${timedOut ? ', timeout' : ''})`, () => {
      const f = buildCloseCardFields(
        { tool, exitCode, timedOut, tokens: exitCode ? null : { input: 1, output: 2 }, output: 'a\nb\n'.repeat(40), durationMs: 1234 },
        NOENV,
      );
      const img = assertValidCard(renderCloseCard(f), tool);
      // Status pill colour is drawn near the top of the content column.
      const status = timedOut ? 'timeout' : exitCode ? 'fail' : 'pass';
      assert.deepEqual(img.pixel(450, 96), [...hex(THEMES[tool][status]), 255]);
    });
  }
  for (const status of ['cancelled', 'blocked']) {
    test(`${tool}: ${status} closing card has its own non-green pill`, () => {
      const f = buildCloseCardFields({ tool, exitCode: 0, output: 'x', outcome: { status, reason: 'r' } }, NOENV);
      assert.equal(f.status, status);
      const img = assertValidCard(renderCloseCard(f), tool);
      const px = img.pixel(450, 96).slice(0, 3);
      assert.deepEqual(px, hex(THEMES[tool][status]));
      assert.notDeepEqual(px, hex(THEMES[tool].pass));
      const [r, g, b] = px;
      assert.ok(!(g > r + 40 && g > b + 40), `${status} pill must not read as green: ${px}`);
    });
  }
}

test('every status has a distinct pill colour per theme', () => {
  for (const tool of ['grok', 'claude']) {
    const colours = ['pass', 'fail', 'timeout', 'cancelled', 'blocked'].map((s) => THEMES[tool][s]);
    assert.equal(new Set(colours).size, colours.length, tool);
  }
});

test('grok theme is dark, claude theme is light', () => {
  const lum = (c) => hex(c).reduce((a, b) => a + b, 0) / 3;
  assert.ok(lum(THEMES.grok.panel) < 50);
  assert.ok(lum(THEMES.claude.panel) > 200);
});

test('closing card with no output still renders', () => {
  const f = buildCloseCardFields({ tool: 'grok', exitCode: 0, output: '' }, NOENV);
  assertValidCard(renderCloseCard(f), 'grok');
});

test('wrapText wraps words, hard-breaks long tokens, ellipsises overflow', () => {
  assert.deepEqual(wrapText('aa bb cc', 5, 5), ['aa bb', 'cc']);
  assert.deepEqual(wrapText('abcdefghij', 4, 5), ['abcd', 'efgh', 'ij']);
  const lines = wrapText('one two three four five six', 7, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].endsWith('…'));
});

test('summaryRows wraps a single long line to multiple rows without ellipsis', () => {
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const rows = summaryRows([long], 40, 10);
  assert.ok(rows.length > 1);
  assert.ok(rows.every((r) => r.length <= 40));
  assert.equal(rows.join(' '), long);
  assert.ok(!rows.some((r) => r.includes('…')));
});

test('summaryRows keeps the first rows on overflow and ends with an ellipsis', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  const rows = summaryRows(lines, 40, 3);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.slice(0, 2), ['line 0', 'line 1']);
  assert.equal(rows[2], 'line 2…');
  assert.ok(!rows[0].includes('…') && !rows[1].includes('…'));
  assert.deepEqual(summaryRows(lines, 40, 10), lines);
  assert.deepEqual(summaryRows([], 40, 3), ['(no output)']);
});

test('toCardText folds unicode to drawable glyphs', () => {
  assert.equal(toCardText('“hi” — ✓ → 漢'), '"hi" - v > ?');
  for (const ch of toCardText('any ‘text’ • here')) assert.ok(SUPPORTED_CHARS.includes(ch), ch);
});

test('official logo PNGs decode and are drawn in the left column', () => {
  const sizes = { grok: 600, claude: 512 };
  for (const tool of ['grok', 'claude']) {
    const logo = loadLogo(tool);
    assert.equal(logo.width, sizes[tool]);
    assert.equal(logo.height, sizes[tool]);
    assert.equal(logo.data.length, logo.width * logo.height * 4);
  }
  // Grok: black mark on a white tile.
  const grokImg = decodePng(renderOpenCard(buildOpenCardFields({ tool: 'grok', prompt: 'x' }, NOENV)));
  assert.deepEqual(grokImg.pixel(140, 258), [255, 255, 255, 255], 'white tile');
  assert.ok(grokImg.pixel(176, 258)[0] < 60, 'dark ring of the mark (left side)');
  // Claude: terracotta tile with a cream burst at the centre.
  const claudeImg = decodePng(renderOpenCard(buildOpenCardFields({ tool: 'claude', prompt: 'x' }, NOENV)));
  const [r, g, b] = claudeImg.pixel(140, 330);
  assert.ok(r > 180 && g < 140 && b < 110, `terracotta tile, got ${[r, g, b]}`);
  assert.ok(claudeImg.pixel(212, 258).slice(0, 3).every((v) => v > 230), 'cream burst at tile centre');
});

test('Fira Code atlas: monospace faces for every card scale, printable ASCII + extras', () => {
  for (let c = 0x20; c < 0x7f; c++) assert.ok(SUPPORTED_CHARS.includes(String.fromCharCode(c)));
  assert.ok(SUPPORTED_CHARS.includes('…') && SUPPORTED_CHARS.includes('·'));
  for (const scale of [2, 3, 4]) {
    for (const bold of [false, true]) {
      const f = face(scale, bold);
      assert.equal(f.advance, 6 * scale);
      const [, , w, h, off] = f.glyphs.M;
      assert.ok(w > 0 && h > 0 && off + w * h <= f.alpha.length);
      // Anti-aliased: partial coverage values exist (not a 1-bit bitmap font).
      assert.ok([...f.alpha.subarray(off, off + w * h)].some((a) => a > 0 && a < 255));
    }
  }
});
