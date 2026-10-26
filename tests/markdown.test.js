// open.md / close.md: compact text cards for text-only group rooms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenCardFields, buildCloseCardFields } from '../src/cards/contract.js';
import { renderOpenMarkdown, renderCloseMarkdown, outputStart, MD_OUTPUT_MAX_LINES } from '../src/cards/markdown.js';
import { repoNameFromUrl } from '../src/git-info.js';

const NOENV = { env: {} };
const open = buildOpenCardFields(
  { tool: 'grok', toolName: 'Grok Build', model: 'grok-4.7', effort: 'high', prompt: 'Fix the flaky test.\nUse sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx0123 if needed.', startedAt: '2026-10-09T17:17:15.481Z' },
  NOENV,
);
const git = { repo: 'acme/widgets', branch: 'feat/123-example', head: 'a'.repeat(40) };

test('open.md: tool, model, effort, repo, branch, prompt summary, start time; masked', () => {
  const md = renderOpenMarkdown(open, { git }, NOENV);
  assert.equal(
    md,
    [
      '**Grok Build · ▶️ RUN STARTED**',
      'Model: `grok-4.7` · Effort: high',
      'Repo: `acme/widgets` · Branch: `feat/123-example`',
      'Prompt: Fix the flaky test. Use sk-ant-…[REDACTED] if needed.',
      'Started: 2026-10-09 17:17:15 UTC',
      '',
    ].join('\n'),
  );
});

test('open.md: no git → no repo line; no effort → no effort', () => {
  const o = buildOpenCardFields({ tool: 'claude', toolName: 'Claude Code', prompt: 'x' }, NOENV);
  const md = renderOpenMarkdown(o, {}, NOENV);
  assert.ok(!md.includes('Repo:'));
  assert.ok(md.includes('Model: `default`\n'));
});

test('close.md: status, duration, why, commit, tokens, start of output in a fence', () => {
  const close = buildCloseCardFields(
    { tool: 'grok', toolName: 'Grok Build', exitCode: 0, durationMs: 266285, tokens: { input: 195679, output: 23335 }, output: 'Done.\nAll 5 tests pass.' },
    NOENV,
  );
  const md = renderCloseMarkdown(close, { open, git, commit: { sha: '0b78c8f', subject: 'rc-dashboards 0.1.0: plugin foundation', count: 2 } }, NOENV);
  const lines = md.split('\n');
  assert.equal(lines[0], '**Grok Build · ✅ PASSED** · exit 0 · 4m 26s');
  assert.ok(md.includes('\nCommit: `0b78c8f` rc-dashboards 0.1.0: plugin foundation (+1 more)\n'));
  assert.ok(md.includes('\nTokens: in 196k / out 23k / total 219k\n'));
  assert.ok(md.endsWith('Output (start):\n```\nDone.\nAll 5 tests pass.\n```\n'));
  assert.ok(!md.includes('Why:'));
});

test('close.md: cancelled/blocked show the label and a Why line; no duplicate [run-cards] line', () => {
  const close = buildCloseCardFields({ tool: 'grok', toolName: 'Grok Build', exitCode: 0, output: 'Reading files.', outcome: { status: 'cancelled', reason: 'stop reason "cancelled"' } }, NOENV);
  close.summary = ['[run-cards] cancelled: stop reason "cancelled"', ...close.summary];
  const md = renderCloseMarkdown(close, { open, git, commit: null }, NOENV);
  assert.match(md, /^\*\*Grok Build · ⏹️ CANCELLED\*\* · exit 0 · 0s\nWhy: stop reason "cancelled"\n/);
  assert.ok(md.includes('\nCommit: none\n'));
  assert.ok(!md.includes('[run-cards]'));
  const blocked = buildCloseCardFields({ tool: 'claude', toolName: 'Claude Code', exitCode: 0, output: '', outcome: { status: 'blocked', reason: 'permission denied for Write' } }, NOENV);
  assert.match(renderCloseMarkdown(blocked, { open }, NOENV), /⛔ BLOCKED\*\*[\s\S]*Why: permission denied for Write[\s\S]*```\n\(no output\)\n```\n$/);
});

test('close.md: output fence survives backticks; output is compact', () => {
  const close = buildCloseCardFields({ tool: 'grok', exitCode: 1, output: 'see ```js\ncode\n```\n' + 'x\n'.repeat(40) }, NOENV);
  const md = renderCloseMarkdown(close, { open }, NOENV);
  assert.ok(md.includes('\n````\nsee ```js\n'), md);
  assert.ok(md.trimEnd().endsWith('````'));
  const out = md.split('Output (start):\n')[1].split('\n').slice(1, -2);
  assert.ok(out.length <= MD_OUTPUT_MAX_LINES, `${out.length} lines`);
  assert.ok(out.at(-1).endsWith('…'), 'truncation marked');
});

test('close.md masks secrets in commit subject and repo', () => {
  const close = buildCloseCardFields({ tool: 'grok', exitCode: 0, output: 'ok' }, NOENV);
  const md = renderCloseMarkdown(close, { open, git: { repo: 'o/r', branch: null }, commit: { sha: 'abc1234', subject: 'add key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', count: 1 } }, NOENV);
  assert.ok(!md.includes('ABCDEFGHIJKLMNOP'));
  assert.ok(md.includes('Branch: (detached HEAD)'));
});

test('outputStart: caps lines and characters', () => {
  assert.deepEqual(outputStart(['a', 'b']), ['a', 'b']);
  assert.equal(outputStart(Array(20).fill('line')).length, MD_OUTPUT_MAX_LINES);
  assert.ok(outputStart(['y'.repeat(5000)])[0].length <= 160);
  assert.deepEqual(outputStart([]), []);
});

test('repoNameFromUrl: owner/name from https/ssh/scp URLs, never credentials', () => {
  assert.equal(repoNameFromUrl('https://github.com/acme/widgets.git'), 'acme/widgets');
  assert.equal(repoNameFromUrl('git@github.com:acme/widgets.git'), 'acme/widgets');
  assert.equal(repoNameFromUrl('ssh://git@host:22/team/repo'), 'team/repo');
  assert.equal(repoNameFromUrl('https://x-access-token:ghs_secret123@github.com/o/r.git'), 'o/r');
  assert.equal(repoNameFromUrl('/srv/git/proj.git'), 'git/proj');
  assert.equal(repoNameFromUrl(''), null);
  assert.equal(repoNameFromUrl(null), null);
});
