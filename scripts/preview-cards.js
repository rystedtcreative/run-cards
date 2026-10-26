// Renders sample open/close cards for every theme into ./preview/ for eyeballing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildOpenCardFields, buildCloseCardFields } from '../src/cards/contract.js';
import { renderOpenCard, renderCloseCard } from '../src/cards/render.js';
import { renderOpenMarkdown, renderCloseMarkdown } from '../src/cards/markdown.js';

const out = new URL('../preview/', import.meta.url);
mkdirSync(out, { recursive: true });
const prompt =
  'Fix the flaky integration test in tests/api/users.test.ts — it times out on CI about 1 in 5 runs. ' +
  'Use the key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 only if needed. Keep the diff minimal and explain the root cause.';
const output = [
  'Reading tests/api/users.test.ts',
  'Found race: server.listen() not awaited before first request',
  'Patched tests/api/setup.ts (+4 -1)',
  'Running npm test…',
  '  ✓ users › creates user (41ms)',
  '  ✓ users › lists users (12ms)',
  '  ✓ users › rejects duplicate email (9ms)',
  '',
  'Tests: 48 passed, 48 total',
  'export GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  'Root cause: the test server started listening asynchronously and the first request',
  'occasionally raced it. Awaiting the listen promise in beforeAll fixes it.',
  'Done.',
].join('\n');

for (const tool of ['grok', 'claude']) {
  const toolName = tool === 'grok' ? 'Grok Build' : 'Claude Code';
  const open = buildOpenCardFields({ tool, toolName, model: tool === 'grok' ? 'grok-4.6' : 'claude-opus-5-5', effort: 'high', prompt }, { env: {} });
  const git = { repo: 'acme/widgets', branch: 'fix/flaky-users-test' };
  writeFileSync(new URL(`${tool}-open.png`, out), renderOpenCard(open));
  writeFileSync(new URL(`${tool}-open.md`, out), renderOpenMarkdown(open, { git }, { env: {} }));
  const outcomes = {
    cancelled: { status: 'cancelled', reason: 'stop reason "cancelled" (headless runs cancel when a tool needs approval)' },
    blocked: { status: 'blocked', reason: 'a tool needed approval the headless run could not give — no file edits' },
  };
  for (const [status, exitCode, timedOut] of [['pass', 0, false], ['fail', 1, false], ['timeout', 124, true], ['cancelled', 0, false], ['blocked', 0, false]]) {
    const outcome = outcomes[status] ?? null;
    const text = outcome ? `[run-cards] ${status}: ${outcome.reason}\n${output}` : output;
    const close = buildCloseCardFields(
      { tool, toolName, exitCode, timedOut, outcome, tokens: status === 'pass' ? { input: 48210, output: 1893, total: 50103 } : null, output: text, durationMs: 94_000 },
      { env: {} },
    );
    const commit = status === 'pass' ? { sha: '0b78c8f', subject: 'fix(tests): await server.listen before the first request', count: 1 } : null;
    writeFileSync(new URL(`${tool}-close-${status}.png`, out), renderCloseCard(close));
    writeFileSync(new URL(`${tool}-close-${status}.md`, out), renderCloseMarkdown(close, { open, git, commit }, { env: {} }));
  }
}
console.log('wrote preview/*.png and preview/*.md');
