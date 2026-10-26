import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import claude, { parseClaudeArgs, scanArgs, readClaudeDefaults } from '../src/adapters/claude.js';
import { tmp, FAKE_GROK, WRAPPER } from './helpers.js';

// Isolated env: no ~/.claude settings or ANTHROPIC_MODEL leak into the tests.
const ENV = { HOME: '/nonexistent-home', PATH: '' };
const parse = (args, env = ENV) => parseClaudeArgs(args, { env });

test('-p is a boolean switch; the prompt is positional', () => {
  const r = parse(['-p', 'fix it', '--model', 'claude-opus-5-5', '--effort', 'high']);
  assert.deepEqual(r, {
    model: 'claude-opus-5-5',
    effort: 'high',
    prompt: 'fix it',
    headless: true,
    outputFormat: 'text',
    subcommand: null,
  });
  assert.equal(parse(['fix it', '--print']).prompt, 'fix it');
  assert.equal(parse(['--print', '--', '-p looks like a flag']).prompt, '-p looks like a flag');
});

test('--flag=value forms and --output-format', () => {
  const r = parse(['-p', '--model=sonnet', '--effort=xhigh', '--output-format=stream-json', '--verbose', 'summarise']);
  assert.equal(r.model, 'sonnet');
  assert.equal(r.effort, 'xhigh');
  assert.equal(r.outputFormat, 'stream-json');
  assert.equal(r.prompt, 'summarise');
  assert.equal(parse(['--output-format', 'json', 'x']).headless, true, '--output-format alone implies headless');
});

test('interactive: positional prompt, no headless flag, value flags not mistaken for prompt', () => {
  const r = parse(['--permission-mode', 'plan', '--continue', 'refactor the parser']);
  assert.equal(r.prompt, 'refactor the parser');
  assert.equal(r.headless, false);
  assert.equal(r.model, null);
  assert.equal(r.effort, null);
  assert.equal(parse([]).prompt, '');
});

test('variadic flags consume tokens until the next flag (like commander)', () => {
  assert.equal(parse(['--add-dir', '../a', '../b', '-p', 'go']).prompt, 'go');
  assert.equal(parse(['--allowedTools', 'Bash', 'Edit', '--', 'do it']).prompt, 'do it');
  assert.equal(scanArgs(['--add-dir', '../a', '../b']).flags.get('--add-dir'), '../a ../b');
});

test('optional-value flags (-r/--resume) consume a following non-flag token', () => {
  assert.equal(parse(['-r', 'abc123', '-p', 'continue']).prompt, 'continue');
  assert.equal(parse(['--resume', '-p', 'continue']).prompt, 'continue');
});

test('-p with no positional prompt → prompt read from stdin', () => {
  assert.equal(parse(['-p']).prompt, '(prompt on stdin)');
  assert.equal(parse(['-p', '--input-format', 'stream-json']).prompt, '(stream-json prompt on stdin)');
});

test('subcommands are not prompts', () => {
  const r = parse(['mcp', 'list']);
  assert.equal(r.subcommand, 'mcp');
  assert.equal(r.prompt, 'claude mcp list');
  assert.equal(r.headless, true);
});

test('model/effort defaults: ANTHROPIC_MODEL, then settings.json; flags win', () => {
  const home = tmp();
  mkdirSync(join(home, '.claude'));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', effortLevel: 'medium' }));
  const env = { HOME: home, PATH: '' };
  assert.deepEqual(readClaudeDefaults(env), { model: 'opus', effort: 'medium' });
  assert.deepEqual(readClaudeDefaults({ ...env, ANTHROPIC_MODEL: 'from-env' }), { model: 'from-env', effort: 'medium' });
  assert.equal(parse(['-p', 'x', '--model', 'cli-wins'], env).model, 'cli-wins');
  assert.equal(parse(['-p', 'x'], env).effort, 'medium');
  const cfg = tmp();
  writeFileSync(join(cfg, 'settings.json'), 'not json');
  assert.deepEqual(readClaudeDefaults({ CLAUDE_CONFIG_DIR: cfg }), { model: null, effort: null });
});

test('extractTokens + summaryText for json, stream-json and plain output', () => {
  const json = JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } });
  assert.deepEqual(claude.extractTokens(json), { input: 100, output: 5, total: 105 });
  assert.equal(claude.summaryText(json, ''), 'done');

  const stream = [
    { type: 'system', subtype: 'init', model: 'claude-opus-5-5' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }], usage: { input_tokens: 3, output_tokens: 1 } } },
    { type: 'result', subtype: 'success', result: 'final answer', usage: { input_tokens: 7, output_tokens: 2 } },
  ].map((o) => JSON.stringify(o)).join('\n');
  assert.deepEqual(claude.extractTokens(stream), { input: 7, output: 2, total: 9 });
  assert.equal(claude.summaryText(stream, ''), 'final answer');

  assert.equal(claude.extractTokens('plain'), null);
  assert.equal(claude.summaryText('plain out\n', 'err'), 'plain out\n');
  assert.equal(claude.summaryText('', 'only err'), 'only err');
  assert.equal(claude.summaryText('out', 'boom', { failed: true }), 'boom\nout');
});

test('discovery: CLAUDE_BIN wins; wrapper symlink named claude is skipped on PATH', () => {
  assert.equal(claude.findBinary({ env: { PATH: '', CLAUDE_BIN: FAKE_GROK } }), FAKE_GROK);
  const wrapperDir = join(tmp('cw-'), 'bin');
  const realDir = join(tmp('cr-'), 'bin');
  mkdirSync(wrapperDir, { recursive: true });
  mkdirSync(realDir, { recursive: true });
  symlinkSync(WRAPPER, join(wrapperDir, 'claude'));
  symlinkSync(FAKE_GROK, join(realDir, 'claude'));
  assert.equal(claude.findBinary({ env: { PATH: `${wrapperDir}:${realDir}` } }), join(realDir, 'claude'));
  assert.throws(() => claude.findBinary({ env: { PATH: tmp() } }), /CLAUDE_BIN/);
});

test('claude summaryText puts stderr first on failure so long output cannot push it off the card', () => {
  const stdout = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const failed = claude.summaryText(stdout, 'fatal: boom\n', { failed: true }).split('\n');
  assert.equal(failed[0], 'fatal: boom');
  assert.equal(failed[1], 'line 1');
  assert.ok(failed.indexOf('fatal: boom') < 12);
  const passed = claude.summaryText(stdout, 'warning: noisy', { failed: false });
  assert.equal(passed, stdout);
  assert.ok(!passed.includes('warning'));
});
