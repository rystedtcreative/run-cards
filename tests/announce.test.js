// Path announce lines (`run-cards: open-card|open-md|close-card|close-md|run-json <abs>`) and CLI_RUN_CARDS_RUN_ID.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { FAKE_GROK, WRAPPER, tmp, runCards, announceLines, ANNOUNCE_RE } from './helpers.js';
import { isValidRunId } from '../src/run-dir.js';

test('open-card + open-md are announced before the CLI finishes; close-card, close-md, run-json after', async () => {
  const dir = tmp('cards-');
  const child = spawn(process.execPath, [WRAPPER, 'grok', '-p', 'x'], {
    env: { PATH: process.env.PATH, HOME: '/nonexistent-home', GROK_BIN: FAKE_GROK, CLI_RUN_CARDS_DIR: dir, FAKE_GROK_MODE: 'slow' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let seenOpen = null;
  let seenOpenMd = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    const open = announceLines(stderr).find((l) => l.kind === 'open-card');
    if (open && !seenOpen) {
      // Checked the moment the line arrives: the fake CLI is still sleeping.
      seenOpen = { path: open.path, pngExists: existsSync(open.path), childDone: stderr.includes('slow: finishing') };
      seenOpen.closeExists = existsSync(join(open.path, '..', 'close.png'));
    }
    const openMd = announceLines(stderr).find((l) => l.kind === 'open-md');
    if (openMd && !seenOpenMd) seenOpenMd = { exists: existsSync(openMd.path), childDone: stderr.includes('slow: finishing') };
  });
  const code = await new Promise((res) => child.on('close', res));
  assert.equal(code, 0, stderr);

  assert.ok(seenOpen, stderr);
  assert.equal(seenOpen.pngExists, true, 'open.png on disk when announced');
  assert.equal(seenOpen.childDone, false, 'announced before the CLI finished');
  assert.equal(seenOpen.closeExists, false, 'close card not written yet when open-card announced');

  assert.deepEqual(seenOpenMd, { exists: true, childDone: false }, 'open.md announced (and on disk) before the CLI finished');

  const iOpen = stderr.indexOf('run-cards: open-card ');
  const iChild = stderr.indexOf('slow: finishing');
  const iOpenMd = stderr.indexOf('run-cards: open-md ');
  const iClose = stderr.indexOf('run-cards: close-card ');
  const iCloseMd = stderr.indexOf('run-cards: close-md ');
  const iJson = stderr.indexOf('run-cards: run-json ');
  assert.ok(iOpen >= 0 && iOpen < iOpenMd && iOpenMd < iChild && iChild < iClose && iClose < iCloseMd && iCloseMd < iJson, stderr);
});

test('announce lines: exact format, absolute paths, each exactly once, files exist with final state', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail' });
  assert.equal(r.status, 3);
  const raw = r.stderr.split('\n').filter((l) => l.startsWith('run-cards: '));
  assert.equal(raw.length, 5, r.stderr);
  for (const l of raw) assert.match(l, ANNOUNCE_RE);
  assert.ok(r.stderr.endsWith('\n'));

  const lines = announceLines(r.stderr);
  assert.deepEqual(lines.map((l) => l.kind), ['open-card', 'open-md', 'close-card', 'close-md', 'run-json']);
  const [open, openMd, close, closeMd, json] = lines.map((l) => l.path);
  for (const p of [open, openMd, close, closeMd, json]) {
    assert.ok(isAbsolute(p), p);
    assert.ok(existsSync(p), p);
  }
  assert.equal(open, join(r.runs[0], 'open.png'));
  assert.equal(close, join(r.runs[0], 'close.png'));
  assert.equal(openMd, join(r.runs[0], 'open.md'));
  assert.equal(closeMd, join(r.runs[0], 'close.md'));
  assert.equal(json, join(r.runs[0], 'run.json'));
  const s = JSON.parse(readFileSync(json, 'utf8'));
  assert.equal(s.status, 'fail');
  assert.equal(s.exitCode, 3);
  assert.deepEqual(s.cards, { open, close, openMd, closeMd });
  assert.match(readFileSync(closeMd, 'utf8'), /FAILED\*\* · exit 3/);
});

test('CLI_RUN_CARDS_QUIET=1 suppresses the announce lines (cards still written)', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail', CLI_RUN_CARDS_QUIET: '1' });
  assert.equal(r.status, 3);
  assert.equal(r.stderr, 'error: build failed with 3 errors\n');
  assert.ok(existsSync(join(r.runs[0], 'close.png')));
  assert.equal(runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail', CLI_RUN_CARDS_QUIET: '0' }).stderr.match(/^run-cards: /gm).length, 5);
  assert.ok(existsSync(join(r.runs[0], 'close.md')));
});

test('timeout: close-card and run-json are announced for the timed-out run', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'hang', CLI_RUN_CARDS_TIMEOUT_MS: '400', CLI_RUN_CARDS_KILL_GRACE_MS: '200' });
  assert.equal(r.status, 124);
  const lines = announceLines(r.stderr);
  assert.deepEqual(lines.map((l) => l.kind), ['open-card', 'open-md', 'close-card', 'close-md', 'run-json']);
  assert.ok(existsSync(lines[2].path));
  assert.match(readFileSync(lines[3].path, 'utf8'), /TIMED OUT/);
  assert.equal(JSON.parse(readFileSync(lines[4].path, 'utf8')).status, 'timeout');
});

test('CLI_RUN_CARDS_DISABLED=1: no announce lines', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail', CLI_RUN_CARDS_DISABLED: '1' });
  assert.equal(r.status, 3);
  assert.equal(r.stderr, 'error: build failed with 3 errors\n');
});

test('card write failure: nothing announced, warning kept', () => {
  const blocker = join(tmp('blocker-'), 'not-a-dir');
  writeFileSync(blocker, 'file where a directory should be');
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail', CLI_RUN_CARDS_DIR: join(blocker, 'run-cards') });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /could not write opening card/);
  assert.deepEqual(announceLines(r.stderr), []);
});

test('CLI_RUN_CARDS_RUN_ID: run dir is <root>/runs/<id>, sidecar.id is the id', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'pass', CLI_RUN_CARDS_RUN_ID: 'ticket-42_v1.0' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.runs, [join(r.dir, 'runs', 'ticket-42_v1.0')]);
  assert.equal(r.sidecar.id, 'ticket-42_v1.0');
  assert.equal(r.sidecar.runDir, r.runs[0]);
  assert.equal(announceLines(r.stderr)[0].path, join(r.dir, 'runs', 'ticket-42_v1.0', 'open.png'));
});

test('CLI_RUN_CARDS_RUN_ID: invalid values exit 2 without spawning the CLI', () => {
  const bad = ['../x', 'a/b', '.hidden', 'a..b', '..', ' ', '\t', '-x', '_x', 'a b', 'a\nb', 'x'.repeat(129)];
  for (const id of bad) {
    const marker = join(tmp('marker-'), 'ran');
    const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'pass', FAKE_GROK_MARKER: marker, CLI_RUN_CARDS_RUN_ID: id });
    assert.equal(r.status, 2, `${JSON.stringify(id)}: ${r.stderr}`);
    assert.match(r.stderr, /^run-cards: invalid CLI_RUN_CARDS_RUN_ID/);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(marker), false, `CLI spawned for ${JSON.stringify(id)}`);
    assert.equal(existsSync(join(r.dir, 'runs')), false);
  }
});

test('CLI_RUN_CARDS_RUN_ID: existing run dir → exit 2, not spawned, dir untouched', () => {
  const dir = tmp('cards-');
  const existing = join(dir, 'runs', 'dup');
  mkdirSync(existing, { recursive: true });
  writeFileSync(join(existing, 'keep.txt'), 'original');
  const marker = join(tmp('marker-'), 'ran');
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'pass', FAKE_GROK_MARKER: marker, CLI_RUN_CARDS_DIR: dir, CLI_RUN_CARDS_RUN_ID: 'dup' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^run-cards: run directory .*runs\/dup already exists/);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readdirSync(existing), ['keep.txt']);
  assert.equal(readFileSync(join(existing, 'keep.txt'), 'utf8'), 'original');
  assert.equal(existsSync(join(dir, 'latest.json')), false);
});

test('CLI_RUN_CARDS_RUN_ID is ignored when CLI_RUN_CARDS_DISABLED=1; empty means unset', () => {
  const disabled = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'args', CLI_RUN_CARDS_DISABLED: '1', CLI_RUN_CARDS_RUN_ID: '../x' });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.runs.length, 0);

  const empty = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'args', CLI_RUN_CARDS_RUN_ID: '' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.runs[0], /runs\/\d{8}-\d{6}-[0-9a-f]{6}$/);
});

test('isValidRunId', () => {
  for (const ok of ['a', 'A1', '0', 'run-1', 'r.1_x', 'x'.repeat(128)]) assert.equal(isValidRunId(ok), true, ok);
  for (const bad of ['', '.', '..', '.a', 'a..b', 'a/b', 'a\\b', 'x'.repeat(129), 'é', null, undefined]) assert.equal(isValidRunId(bad), false, String(bad));
});
