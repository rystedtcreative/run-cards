// Shared card contract. Every adapter (grok, claude, …) produces raw run facts;
// these builders normalise + mask them into the exact fields the renderer draws.
// Renderer and sidecar never see unmasked text.
import { maskSecrets } from '../mask.js';

export const DEFAULT_SUMMARY_LINES = 12;
export const PROMPT_CARD_MAX_CHARS = 280;
export const SUMMARY_LINE_MAX_CHARS = 2000; // memory bound only; the renderer wraps

/**
 * @typedef {Object} OpenCardFields
 * @property {'open'} kind
 * @property {string} tool              adapter id, e.g. 'grok'
 * @property {string} toolName          display name, e.g. 'Grok Build'
 * @property {string} model             model id or 'default'
 * @property {string|null} effort       reasoning effort; null → row omitted
 * @property {string} prompt            masked + truncated for the card
 * @property {string} promptFull        masked, untruncated (sidecar only)
 * @property {string} startedAt         ISO timestamp
 */

/**
 * @typedef {Object} TokenUsage
 * @property {number|null} input
 * @property {number|null} output
 * @property {number|null} total
 */

/**
 * @typedef {Object} CloseCardFields
 * @property {'close'} kind
 * @property {string} tool
 * @property {string} toolName
 * @property {'pass'|'fail'|'timeout'|'cancelled'|'blocked'} status  cancelled/blocked: exit 0 but the run didn't finish (see src/outcome.js)
 * @property {string|null} reason      why a run is cancelled/blocked; null otherwise
 * @property {number} exitCode          exit code the wrapper will return
 * @property {string|null} signal       terminating signal, if any
 * @property {TokenUsage|null} tokens   null → row omitted
 * @property {string[]} summary         masked last-N lines of final output
 * @property {number} durationMs
 * @property {string} endedAt
 */

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

/** Collapse whitespace and truncate with an ellipsis. */
export function truncate(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/**
 * First N meaningful lines of output, ANSI-stripped, masked, capped per line to bound memory.
 * Carriage-return progress redraws keep only their final state.
 */
export function summarizeOutput(text, maxLines = DEFAULT_SUMMARY_LINES, maskOpts) {
  if (!text) return [];
  const lines = maskSecrets(stripAnsi(text), maskOpts)
    .split('\n')
    .map((l) => l.split('\r').filter(Boolean).pop() ?? '')
    .map((l) => l.replace(/\t/g, '  ').trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.slice(0, maxLines).map((l) => (l.length > SUMMARY_LINE_MAX_CHARS ? l.slice(0, SUMMARY_LINE_MAX_CHARS - 1) + '…' : l));
}

export function buildOpenCardFields({ tool, toolName, model, effort, prompt, startedAt = new Date() }, maskOpts) {
  const masked = maskSecrets(prompt ?? '', maskOpts);
  return {
    kind: 'open',
    tool,
    toolName: toolName || tool,
    model: model ? maskSecrets(String(model), maskOpts) : 'default',
    effort: effort ? maskSecrets(String(effort), maskOpts) : null,
    prompt: truncate(masked, PROMPT_CARD_MAX_CHARS) || '(no prompt — interactive session)',
    promptFull: masked,
    startedAt: new Date(startedAt).toISOString(),
  };
}

function normaliseTokens(tokens) {
  if (!tokens) return null;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
  const input = num(tokens.input);
  const output = num(tokens.output);
  let total = num(tokens.total);
  if (total == null && input != null && output != null) total = input + output;
  if (input == null && output == null && total == null) return null;
  return { input, output, total };
}

export function buildCloseCardFields(
  { tool, toolName, exitCode, signal = null, timedOut = false, tokens = null, output = '', summaryLines = DEFAULT_SUMMARY_LINES, durationMs = 0, endedAt = new Date(), outcome = null },
  maskOpts,
) {
  const code = Number.isInteger(exitCode) ? exitCode : 1;
  // Exit code decides pass/fail/timeout; an exit-0 run the adapter saw cancelled or blocked
  // gets that status instead of pass. Non-zero exits and timeouts are never reclassified.
  const early = code === 0 && !timedOut && UNFINISHED_STATUSES.includes(outcome?.status) ? outcome.status : null;
  const status = timedOut ? 'timeout' : early ?? (code === 0 ? 'pass' : 'fail');
  return {
    kind: 'close',
    tool,
    toolName: toolName || tool,
    status,
    reason: early && outcome.reason ? maskSecrets(String(outcome.reason), maskOpts) : null,
    exitCode: code,
    signal: signal || null,
    tokens: normaliseTokens(tokens),
    summary: summarizeOutput(output, summaryLines, maskOpts),
    durationMs: Math.max(0, Math.round(durationMs)),
    endedAt: new Date(endedAt).toISOString(),
  };
}

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatCount(n) {
  if (n == null) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function formatTokens(t) {
  if (!t) return null;
  const parts = [];
  if (t.input != null) parts.push(`in ${formatCount(t.input)}`);
  if (t.output != null) parts.push(`out ${formatCount(t.output)}`);
  if (t.total != null) parts.push(`total ${formatCount(t.total)}`);
  return parts.join(' / ');
}

/** Exit-0 endings that are not a pass. */
export const UNFINISHED_STATUSES = ['cancelled', 'blocked'];

export const STATUS_LABEL = { pass: 'PASSED', fail: 'FAILED', timeout: 'TIMED OUT', cancelled: 'CANCELLED', blocked: 'BLOCKED' };
