import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOpenCardFields,
  buildCloseCardFields,
  summarizeOutput,
  truncate,
  formatTokens,
  formatDuration,
  PROMPT_CARD_MAX_CHARS,
  DEFAULT_SUMMARY_LINES,
} from '../src/cards/contract.js';

const NOENV = { env: {} };

test('open card: model/effort/prompt, no bot name or ticket fields', () => {
  const f = buildOpenCardFields({ tool: 'grok', toolName: 'Grok Build', model: 'grok-4.6', effort: 'high', prompt: 'fix it' }, NOENV);
  assert.equal(f.kind, 'open');
  assert.equal(f.model, 'grok-4.6');
  assert.equal(f.effort, 'high');
  assert.equal(f.prompt, 'fix it');
  assert.deepEqual(Object.keys(f).sort(), ['effort', 'kind', 'model', 'prompt', 'promptFull', 'startedAt', 'tool', 'toolName']);
});

test('open card: model defaults, effort omitted when unknown', () => {
  const f = buildOpenCardFields({ tool: 'grok', prompt: 'x' }, NOENV);
  assert.equal(f.model, 'default');
  assert.equal(f.effort, null);
  assert.equal(f.toolName, 'grok');
});

test('open card: long prompt truncated with ellipsis, full masked prompt kept', () => {
  const prompt = 'word '.repeat(200) + 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const f = buildOpenCardFields({ tool: 'grok', prompt }, NOENV);
  assert.ok(f.prompt.length <= PROMPT_CARD_MAX_CHARS);
  assert.ok(f.prompt.endsWith('…'));
  assert.ok(f.promptFull.includes('[REDACTED]'));
  assert.ok(!f.promptFull.includes('AbCdEfGhIjKl'));
});

test('open card: empty prompt shows interactive placeholder', () => {
  assert.match(buildOpenCardFields({ tool: 'grok', prompt: '' }, NOENV).prompt, /interactive/);
});

test('close card: pass / fail / timeout from exit code', () => {
  const base = { tool: 'grok', output: 'ok' };
  assert.equal(buildCloseCardFields({ ...base, exitCode: 0 }, NOENV).status, 'pass');
  assert.equal(buildCloseCardFields({ ...base, exitCode: 2 }, NOENV).status, 'fail');
  assert.equal(buildCloseCardFields({ ...base, exitCode: 124, timedOut: true }, NOENV).status, 'timeout');
  assert.equal(buildCloseCardFields({ ...base, exitCode: undefined }, NOENV).status, 'fail');
});

test('close card: tokens normalised, total derived, null when absent', () => {
  const t = buildCloseCardFields({ tool: 'grok', exitCode: 0, tokens: { input: 10, output: 5 } }, NOENV).tokens;
  assert.deepEqual(t, { input: 10, output: 5, total: 15 });
  assert.equal(buildCloseCardFields({ tool: 'grok', exitCode: 0 }, NOENV).tokens, null);
  assert.equal(buildCloseCardFields({ tool: 'grok', exitCode: 0, tokens: {} }, NOENV).tokens, null);
});

test('close card: summary is first N lines, masked, ANSI-stripped', () => {
  const output = Array.from({ length: 30 }, (_, i) => `\x1b[32mline ${i + 1}\x1b[0m`).join('\n') + '\n\n';
  const f = buildCloseCardFields({ tool: 'grok', exitCode: 0, output }, NOENV);
  assert.equal(f.summary.length, DEFAULT_SUMMARY_LINES);
  assert.equal(f.summary[0], 'line 1');
  assert.equal(f.summary.at(-1), 'line 12');
  const masked = buildCloseCardFields({ tool: 'grok', exitCode: 0, output: 'GITHUB ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n\n' }, NOENV);
  assert.match(masked.summary[0], /^GITHUB ghp_…\[REDACTED\]$/);
  assert.ok(f.summary.every((l) => !l.includes('\x1b')));
});

test('summarizeOutput keeps the final state of \\r progress lines and does not cut at 120 chars', () => {
  assert.deepEqual(summarizeOutput('10%\r50%\r100%\ndone', 5, NOENV), ['100%', 'done']);
  assert.equal(summarizeOutput('x'.repeat(500), 5, NOENV)[0].length, 500);
  assert.ok(summarizeOutput('x'.repeat(5000), 5, NOENV)[0].length <= 2000);
  assert.deepEqual(summarizeOutput('\n\na\nb\nc\n\n', 2, NOENV), ['a', 'b']);
  assert.deepEqual(summarizeOutput('', 5, NOENV), []);
});

test('formatters', () => {
  assert.equal(truncate('a  b\n c', 10), 'a b c');
  assert.equal(formatTokens({ input: 48210, output: 1893, total: 50103 }), 'in 48k / out 1.9k / total 50k');
  assert.equal(formatTokens({ input: null, output: 12, total: null }), 'out 12');
  assert.equal(formatTokens(null), null);
  assert.equal(formatDuration(4_000), '4s');
  assert.equal(formatDuration(94_000), '1m 34s');
  assert.equal(formatDuration(3_720_000), '1h 2m');
});

test('close card: exit-0 run the adapter saw cancelled/blocked gets that status; fails/timeouts never reclassified', () => {
  const base = { tool: 'grok', output: 'ok' };
  const cancelled = buildCloseCardFields({ ...base, exitCode: 0, outcome: { status: 'cancelled', reason: 'stop reason "cancelled"' } }, NOENV);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reason, 'stop reason "cancelled"');
  assert.equal(buildCloseCardFields({ ...base, exitCode: 0, outcome: { status: 'blocked', reason: 'x' } }, NOENV).status, 'blocked');
  assert.equal(buildCloseCardFields({ ...base, exitCode: 2, outcome: { status: 'cancelled', reason: 'x' } }, NOENV).status, 'fail');
  assert.equal(buildCloseCardFields({ ...base, exitCode: 124, timedOut: true, outcome: { status: 'blocked' } }, NOENV).status, 'timeout');
  const pass = buildCloseCardFields({ ...base, exitCode: 0, outcome: { status: null, reason: null } }, NOENV);
  assert.equal(pass.status, 'pass');
  assert.equal(pass.reason, null);
  assert.equal(buildCloseCardFields({ ...base, exitCode: 0, outcome: { status: 'bogus' } }, NOENV).status, 'pass');
  assert.match(
    buildCloseCardFields({ ...base, exitCode: 0, outcome: { status: 'blocked', reason: 'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx' } }, NOENV).reason,
    /\[REDACTED\]/,
  );
});
