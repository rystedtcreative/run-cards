import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import grok, { parseGrokArgs, scanArgs, readGrokConfigDefaults } from '../src/adapters/grok.js';
import claude from '../src/adapters/claude.js';
import { getAdapter, ADAPTERS } from '../src/adapters/index.js';
import { findRealBinary, BinaryNotFoundError, WRAPPER_MARKER } from '../src/discover.js';
import { tmp, FAKE_GROK, WRAPPER } from './helpers.js';

// Isolated env: no ~/.grok config leaks into the tests.
const ENV = { HOME: '/nonexistent-home', PATH: '' };
const parse = (args, env = ENV) => parseGrokArgs(args, { env });

test('parses -p / --single with model and effort', () => {
  const r = parse(['-p', 'fix it', '-m', 'grok-4.6', '--reasoning-effort', 'high']);
  assert.deepEqual(
    { model: r.model, effort: r.effort, prompt: r.prompt, headless: r.headless },
    { model: 'grok-4.6', effort: 'high', prompt: 'fix it', headless: true },
  );
});

test('parses --flag=value forms and --effort alias', () => {
  const r = parse(['--single=hello world', '--model=grok-code', '--effort=low', '--output-format=json']);
  assert.equal(r.prompt, 'hello world');
  assert.equal(r.model, 'grok-code');
  assert.equal(r.effort, 'low');
  assert.equal(r.outputFormat, 'json');
});

test('positional prompt (interactive) is detected and not confused with flag values', () => {
  const r = parse(['--cwd', '/repo', '--always-approve', 'refactor the parser']);
  assert.equal(r.prompt, 'refactor the parser');
  assert.equal(r.headless, false);
  assert.equal(r.model, null);
  assert.equal(r.effort, null);
});

test('optional-value flags (-w/--resume) consume a following non-flag token like clap', () => {
  assert.equal(parse(['--worktree=feat', 'create this feature']).prompt, 'create this feature');
  assert.equal(parse(['-r', '-p', 'continue']).prompt, 'continue');
});

test('--prompt-file reads the prompt; missing file degrades gracefully', () => {
  const dir = tmp();
  const f = join(dir, 'prompt.md');
  writeFileSync(f, 'prompt from file');
  assert.equal(parse(['--prompt-file', f]).prompt, 'prompt from file');
  assert.match(parse(['--prompt-file', join(dir, 'nope')]).prompt, /prompt file/);
  assert.equal(parse(['--prompt-file', f]).headless, true);
});

test('--prompt-json extracts text blocks', () => {
  const r = parse(['--prompt-json', JSON.stringify([{ type: 'text', text: 'hi' }, { type: 'image', source: {} }])]);
  assert.equal(r.prompt, 'hi\n[image]');
});

test('subcommands are not prompts', () => {
  const r = parse(['models']);
  assert.equal(r.subcommand, 'models');
  assert.equal(r.prompt, 'grok models');
  assert.equal(r.headless, true);
});

test('-- ends flag parsing', () => {
  assert.equal(parse(['--', '-p looks like a flag']).prompt, '-p looks like a flag');
});

test('scanArgs: last flag wins, short attached value', () => {
  const { flags } = scanArgs(['-m', 'a', '--model', 'b', '-mc']);
  assert.equal(flags.get('--model'), 'b');
  assert.equal(flags.get('-m'), 'c');
});

test('model/effort fall back to ~/.grok/config.toml [models] defaults', () => {
  const home = tmp();
  mkdirSync(join(home, '.grok'));
  writeFileSync(
    join(home, '.grok', 'config.toml'),
    '[cli]\ndefault = "nope"\n\n[models]\ndefault = "grok-4.5" # comment\ndefault_reasoning_effort = "medium"\n[model.x]\ndefault = "nope2"\n',
  );
  const env = { HOME: home, PATH: '' };
  assert.deepEqual(readGrokConfigDefaults(env), { model: 'grok-4.5', effort: 'medium' });
  const r = parse(['-p', 'x'], env);
  assert.equal(r.model, 'grok-4.5');
  assert.equal(r.effort, 'medium');
  assert.equal(parse(['-p', 'x', '-m', 'cli-wins'], env).model, 'cli-wins');
});

test('GROK_CONFIG JSON env overrides config defaults', () => {
  const env = { HOME: '/nonexistent', GROK_CONFIG: '{"models":{"default":"from-env","default_reasoning_effort":"xhigh"}}' };
  assert.deepEqual(readGrokConfigDefaults(env), { model: 'from-env', effort: 'xhigh' });
});

test('extractTokens + summaryText for json and plain output', () => {
  const json = JSON.stringify({ text: 'done', usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } });
  assert.deepEqual(grok.extractTokens(json), { input: 1, output: 2, total: 3 });
  assert.equal(grok.summaryText(json, ''), 'done');
  assert.equal(grok.summaryText('plain out\n', 'err'), 'plain out\n');
  assert.equal(grok.summaryText('', 'only err'), 'only err');
  assert.equal(grok.summaryText('out', 'boom', { failed: true }), 'boom\nout');
  assert.equal(grok.extractTokens('plain'), null);
});

// --- binary discovery -----------------------------------------------------------------

function pathDir(entries) {
  const dir = join(tmp('disc-'), 'bin');
  mkdirSync(dir, { recursive: true });
  for (const [name, target] of Object.entries(entries)) symlinkSync(target, join(dir, name));
  return dir;
}

test('discovery: finds grok on PATH', () => {
  const dir = pathDir({ grok: FAKE_GROK });
  assert.equal(grok.findBinary({ env: { PATH: dir } }), join(dir, 'grok'));
});

test('discovery: skips a `grok` that is the wrapper (symlink) and keeps searching', () => {
  const wrapperDir = pathDir({ grok: WRAPPER });
  const realDir = pathDir({ grok: FAKE_GROK });
  assert.equal(grok.findBinary({ env: { PATH: `${wrapperDir}:${realDir}` } }), join(realDir, 'grok'));
});

test('discovery: skips shim scripts carrying the wrapper marker', () => {
  const dir = join(tmp('shim-'), 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'grok'), `#!/bin/sh\n# ${WRAPPER_MARKER}\nexec run-cards grok "$@"\n`);
  chmodSync(join(dir, 'grok'), 0o755);
  const realDir = pathDir({ grok: FAKE_GROK });
  assert.equal(grok.findBinary({ env: { PATH: `${dir}:${realDir}` } }), join(realDir, 'grok'));
});

test('discovery: GROK_BIN wins over PATH', () => {
  const dir = pathDir({ grok: FAKE_GROK });
  assert.equal(grok.findBinary({ env: { PATH: dir, GROK_BIN: FAKE_GROK } }), FAKE_GROK);
});

test('discovery: GROK_BIN pointing at the wrapper or nowhere is rejected', () => {
  assert.throws(() => grok.findBinary({ env: { GROK_BIN: WRAPPER } }), /wrapper itself/);
  assert.throws(() => grok.findBinary({ env: { GROK_BIN: '/no/such/grok' } }), BinaryNotFoundError);
});

test('discovery: nothing on PATH → helpful error', () => {
  assert.throws(() => findRealBinary('grok', { envVar: 'GROK_BIN', env: { PATH: tmp() } }), /set GROK_BIN/);
});

// --- adapter registry ------------------------------------------------------------------

test('registry exposes grok and claude (both implemented) with the same interface', () => {
  assert.equal(getAdapter('grok'), grok);
  assert.equal(getAdapter('claude'), claude);
  assert.equal(getAdapter('toString'), null);
  const keys = ['id', 'displayName', 'implemented', 'binName', 'binEnv', 'findBinary', 'parseArgs', 'extractTokens', 'summaryText'];
  for (const a of Object.values(ADAPTERS)) for (const k of keys) assert.ok(k in a, `${a.id} missing ${k}`);
  assert.equal(grok.implemented, true);
  assert.equal(claude.implemented, true);
});

test('grok summaryText puts stderr first on failure so long output cannot push it off the card', () => {
  const stdout = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
  const failed = grok.summaryText(stdout, 'fatal: boom\n', { failed: true }).split('\n');
  assert.equal(failed[0], 'fatal: boom');
  assert.equal(failed[1], 'line 1');
  assert.ok(failed.indexOf('fatal: boom') < 12);
  const passed = grok.summaryText(stdout, 'warning: noisy', { failed: false });
  assert.equal(passed, stdout);
  assert.ok(!passed.includes('warning'));
});
