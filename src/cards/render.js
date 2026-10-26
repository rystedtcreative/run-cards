// Card renderer: OpenCardFields / CloseCardFields → PNG Buffer.
// Seam: everything goes through renderOpenCard/renderCloseCard. Swapping in a richer
// backend (sharp, canvas, resvg) only means re-implementing these two functions.
import { Canvas, capHeight, textAdvance, lineHeight, textWidth } from './canvas.js';
import { drawLogo } from './logo.js';
import { themeFor } from './themes.js';
import { formatDuration, formatTokens, STATUS_LABEL } from './contract.js';

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const MARGIN = 32;
const LEFT_COL = 360;
const CONTENT_X = MARGIN + LEFT_COL + 44;
const CONTENT_W = CARD_WIDTH - MARGIN - 44 - CONTENT_X;

const FOLD = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '•': '*', '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '→': '>', '←': '<', '›': '>', '‹': '<', '»': '>>', '«': '<<', '×': 'x', '…': '…', ' ': ' ' };

/** Fold text into what the font atlas can draw (printable ASCII + … ·). */
export function toCardText(s) {
  return [...String(s ?? '')]
    .map((ch) => FOLD[ch] ?? (/[\x20-\x7e…·]/.test(ch) ? ch : '?'))
    .join('');
}

/** Word-wrap to `width` chars; hard-break long words; ellipsis if > maxLines. */
export function wrapText(text, width, maxLines) {
  const words = toCardText(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let w of words) {
    while (w.length > width) {
      if (cur) {
        lines.push(cur);
        cur = '';
      }
      lines.push(w.slice(0, width));
      w = w.slice(width);
    }
    if (!cur) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = kept[maxLines - 1];
    kept[maxLines - 1] = (last.length >= width ? last.slice(0, width - 1) : last).trimEnd() + '…';
    return kept;
  }
  return lines;
}

function clip(text, maxChars) {
  const s = toCardText(text);
  return s.length > maxChars ? s.slice(0, maxChars - 1) + '…' : s;
}

function frame(tool) {
  const theme = themeFor(tool);
  const c = new Canvas(CARD_WIDTH, CARD_HEIGHT, theme.outer);
  c.fillRoundRect(MARGIN, MARGIN, CARD_WIDTH - 2 * MARGIN, CARD_HEIGHT - 2 * MARGIN, 36, theme.panel);
  c.fillRect(MARGIN + LEFT_COL, MARGIN + 48, 2, CARD_HEIGHT - 2 * MARGIN - 96, theme.divider);

  // Left column: logo tile, wordmark, caption.
  const logoSize = 176;
  const colCx = MARGIN + LEFT_COL / 2;
  drawLogo(c, tool, Math.round(colCx - logoSize / 2), 170, logoSize);
  const wm = theme.wordmark;
  c.text(wm, Math.round(colCx - textWidth(wm, 3) / 2), 380, 3, theme.text, 1, { bold: true });
  const cap = 'RUN CARD';
  c.text(cap, Math.round(colCx - textWidth(cap, 2) / 2), 420, 2, theme.muted);
  return { c, theme };
}

function label(c, theme, text, y) {
  c.text(text.toUpperCase(), CONTENT_X, y, 2, theme.muted);
  return y + lineHeight(2) + 4;
}

function chip(c, text, x, y, scale, bg, ink) {
  const padX = 6 * scale;
  const h = capHeight(scale) + 8 * scale;
  const w = textWidth(text, scale) + 2 * padX;
  c.fillRoundRect(x, y, w, h, h / 2, bg);
  c.text(text, x + padX, y + Math.round((h - capHeight(scale)) / 2), scale, ink, 1, { bold: true });
  return { w, h };
}

/** @param {import('./contract.js').OpenCardFields} f */
export function renderOpenCard(f) {
  const { c, theme } = frame(f.tool);
  const charsAt3 = Math.floor(CONTENT_W / textAdvance(3));
  let y = 80;

  chip(c, 'RUN STARTED', CONTENT_X, y, 3, theme.text, theme.panel);
  y += 72;

  y = label(c, theme, 'Model', y);
  c.text(clip(f.model, charsAt3), CONTENT_X, y, 3, theme.text);
  y += lineHeight(3) + 18;

  if (f.effort) {
    y = label(c, theme, 'Effort', y);
    c.text(clip(f.effort, charsAt3), CONTENT_X, y, 3, theme.text);
    y += lineHeight(3) + 18;
  }

  y = label(c, theme, 'Prompt', y);
  const footerY = CARD_HEIGHT - MARGIN - 44;
  const maxLines = Math.max(1, Math.floor((footerY - 12 - y) / lineHeight(3)));
  for (const line of wrapText(f.prompt, charsAt3, maxLines)) {
    c.text(line, CONTENT_X, y, 3, theme.text);
    y += lineHeight(3);
  }

  c.text(`started ${f.startedAt.replace('T', ' ').replace(/\.\d+Z$/, 'Z')}`, CONTENT_X, footerY, 2, theme.muted);
  return c.toPng();
}

/** Wrap summary lines to `width` chars; keep the first `room` rows, marking dropped content with a trailing ellipsis. */
export function summaryRows(summary, width, room) {
  if (!summary.length) return ['(no output)'];
  const rows = summary.flatMap((line) => {
    const wrapped = wrapText(line, width, Infinity);
    return wrapped.length ? wrapped : [''];
  });
  if (rows.length <= room) return rows;
  const kept = rows.slice(0, room);
  const last = kept.length - 1;
  kept[last] = kept[last].slice(0, width - 1) + '…';
  return kept;
}

/** @param {import('./contract.js').CloseCardFields} f */
export function renderCloseCard(f) {
  const { c, theme } = frame(f.tool);
  const charsAt2 = Math.floor(CONTENT_W / textAdvance(2));
  let y = 72;

  const statusColor = theme[f.status] || theme.fail;
  const pill = chip(c, STATUS_LABEL[f.status] || 'FAILED', CONTENT_X, y, 4, statusColor, theme.pillInk);
  const meta = [`exit ${f.exitCode}`, f.signal, formatDuration(f.durationMs)].filter(Boolean).join(' · ');
  c.text(toCardText(meta), CONTENT_X + pill.w + 24, y + Math.round((pill.h - capHeight(3)) / 2), 3, theme.muted);
  y += 84;

  const tok = formatTokens(f.tokens);
  if (tok) {
    y = label(c, theme, 'Tokens', y);
    c.text(clip(tok, Math.floor(CONTENT_W / textAdvance(3))), CONTENT_X, y, 3, theme.text);
    y += lineHeight(3) + 16;
  }

  y = label(c, theme, 'Output', y) + 10;
  const bottom = CARD_HEIGHT - MARGIN - 28;
  const lh = lineHeight(2);
  const room = Math.max(1, Math.floor((bottom - y) / lh));
  const lines = summaryRows(f.summary, charsAt2, room);
  // Subtle code-block backdrop behind the summary.
  c.fillRoundRect(CONTENT_X - 14, y - 10, CONTENT_W + 28, Math.min(room, lines.length) * lh + 16, 12, theme.divider, 0.45);
  for (const line of lines) {
    c.text(clip(line, charsAt2), CONTENT_X, y, 2, theme.text);
    y += lh;
  }
  return c.toPng();
}

export function renderCard(fields) {
  return fields.kind === 'open' ? renderOpenCard(fields) : renderCloseCard(fields);
}
