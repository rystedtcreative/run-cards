// End-to-end: spawn bin/run-cards against the fake grok/claude binary and inspect cards + sidecar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, symlinkSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FAKE_GROK, WRAPPER, tmp, fakeGrokPathDir, decodePng, runCards, withoutAnnounce } from './helpers.js';
import { resolveInvocation } from '../src/cli.js';
import { execFileSync } from 'node:child_process';
import { hex } from '../src/cards/canvas.js';
import { THEMES } from '../src/cards/themes.js';

test('pass: full passthrough, exit 0, open+close PNGs and masked sidecar', () => {
  const r = runCards(['grok', '-p', 'fix it with xai-AbCdEfGhIjKlMnOpQrStUvWx0123', '-m', 'grok-4.6', '--effort', 'high'], { FAKE_GROK_MODE: 'pass' });
  assert.equal(r.status, 0, r.stderr);
  // Bot sees exactly what the CLI printed — including the secret, which is the CLI's own output.
  assert.match(r.stdout, /^line 1\n[\s\S]*line 20\nsecret: sk-ant-api03-SHOULDNOTAPPEARONCARD0123456789\n$/);
  assert.equal(withoutAnnounce(r.stderr), 'warn: something on stderr\n', 'wrapper adds nothing but the path lines');
  assert.equal(runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'pass', CLI_RUN_CARDS_QUIET: '1' }).stderr, 'warn: something on stderr\n', 'QUIET: byte-identical stderr');

  assert.equal(r.runs.length, 1);
  assert.match(r.runs[0], /runs\/\d{8}-\d{6}-[0-9a-f]{6}$/);
  for (const f of ['open.png', 'close.png']) {
    const png = decodePng(readFileSync(join(r.runs[0], f)));
    assert.equal(png.width, 1200);
    assert.equal(png.height, 630);
  }
  const s = r.sidecar;
  assert.equal(s.tool, 'grok');
  assert.equal(s.status, 'pass');
  assert.equal(s.exitCode, 0);
  assert.equal(s.model, 'grok-4.6');
  assert.equal(s.effort, 'high');
  assert.match(s.prompt, /^fix it with xai-…\[REDACTED\]$/);
  assert.ok(!JSON.stringify(s).includes('AbCdEfGhIjKl'), 'prompt secret masked everywhere in sidecar');
  assert.ok(!JSON.stringify(s).includes('SHOULDNOTAPPEAR'), 'output secret masked in summary');
  assert.equal(s.summary.length, 12);
  assert.equal(s.cards.open, join(r.runs[0], 'open.png'));
  assert.equal(s.cards.close, join(r.runs[0], 'close.png'));
  assert.equal(s.cards.openMd, join(r.runs[0], 'open.md'));
  assert.equal(s.cards.closeMd, join(r.runs[0], 'close.md'));
  for (const f of ['open.md', 'close.md']) {
    const md = readFileSync(join(r.runs[0], f), 'utf8');
    assert.ok(!md.includes('AbCdEfGhIjKl') && !md.includes('SHOULDNOTAPPEAR'), `${f} is masked`);
    assert.equal(statSync(join(r.runs[0], f)).mode & 0o777, 0o600);
  }
  assert.equal(typeof s.durationMs, 'number');
  assert.deepEqual(s.errors, []);

  const latest = JSON.parse(readFileSync(join(r.dir, 'latest.json'), 'utf8'));
  assert.equal(latest.runDir, r.runs[0]);
  assert.equal(statSync(r.runs[0]).mode & 0o777, 0o700);
  assert.equal(statSync(join(r.runs[0], 'run.json')).mode & 0o777, 0o600);
});

test('fail: exit code preserved, stderr in summary', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail' });
  assert.equal(r.status, 3);
  assert.equal(r.sidecar.status, 'fail');
  assert.equal(r.sidecar.exitCode, 3);
  assert.match(r.sidecar.summary.join('\n'), /build failed/);
  assert.ok(existsSync(join(r.runs[0], 'close.png')));
});

test('json output: tokens parsed into sidecar, summary is the response text', () => {
  const r = runCards(['grok', '-p', 'x', '--output-format', 'json'], { FAKE_GROK_MODE: 'json' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.sidecar.tokens, { input: 1000, output: 50, total: 1050 });
  assert.deepEqual(r.sidecar.summary, ['All done.', 'Fixed the bug in src/app.js.']);
  assert.equal(JSON.parse(r.stdout).text, 'All done.\nFixed the bug in src/app.js.', 'raw JSON still passed through');
});

test('timeout: closing card marked timed out, exit 124', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'hang', CLI_RUN_CARDS_TIMEOUT_MS: '400', CLI_RUN_CARDS_KILL_GRACE_MS: '200' });
  assert.equal(r.status, 124);
  assert.equal(r.sidecar.status, 'timeout');
  assert.equal(r.sidecar.timedOut, true);
  assert.match(r.sidecar.summary.at(-1), /timed out after 0s — process killed/);
  assert.ok(existsSync(join(r.runs[0], 'close.png')));
});

test('stdin is passed through to the real CLI', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'stdin' }, { input: 'piped prompt\n' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'piped prompt\n');
});

test('CLI_RUN_CARDS_DISABLED=1: passthrough only, no cards', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail', CLI_RUN_CARDS_DISABLED: '1' });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, 'working...\n');
  assert.equal(r.runs.length, 0);
  assert.equal(existsSync(r.dir + '/latest.json'), false);
});

test('CLI_RUN_CARDS_SUMMARY_LINES; CLI_RUN_CARDS_VERBOSE is a no-op (paths never printed twice)', () => {
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'pass', CLI_RUN_CARDS_SUMMARY_LINES: '3', CLI_RUN_CARDS_VERBOSE: '1' });
  assert.equal(r.sidecar.summary.length, 3);
  assert.equal(r.stderr.match(/open\.png/g).length, 1);
  assert.equal(r.stderr.match(/close\.png/g).length, 1);
  assert.equal(r.stderr.match(/run\.json/g).length, 1);
});

test('unwritable run dir: CLI still runs and keeps its exit code', () => {
  const blocker = join(tmp('blocker-'), 'not-a-dir');
  writeFileSync(blocker, 'file where a directory should be');
  const r = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail', CLI_RUN_CARDS_DIR: join(blocker, 'run-cards') });
  assert.equal(r.status, 3);
  assert.equal(r.stdout, 'working...\n');
  assert.match(r.stderr, /could not write opening card/);
});

test('real binary discovered on PATH when GROK_BIN unset (wrapper on PATH skipped)', () => {
  const wrapperDir = join(tmp('wpath-'), 'bin');
  mkdirSync(wrapperDir, { recursive: true });
  symlinkSync(WRAPPER, join(wrapperDir, 'grok'));
  const realDir = fakeGrokPathDir();
  const r = runCards(['grok', '-p', 'x'], { GROK_BIN: '', FAKE_GROK_MODE: 'args', PATH: `${wrapperDir}:${realDir}:${process.env.PATH}` });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['-p', 'x']);
});

test('invoked through a symlink named `grok` → acts as `run-cards grok`', () => {
  const dir = join(tmp('alias-'), 'bin');
  mkdirSync(dir, { recursive: true });
  symlinkSync(WRAPPER, join(dir, 'grok'));
  const r = runCards(['-p', 'via alias'], { FAKE_GROK_MODE: 'args' }, { entry: join(dir, 'grok') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['-p', 'via alias']);
  assert.equal(r.sidecar.prompt, 'via alias');
});

test('missing real binary → 127 with guidance', () => {
  const r = runCards(['grok', '-p', 'x'], { GROK_BIN: '', PATH: tmp() });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /GROK_BIN/);
});

test('claude: live passthrough, args forwarded verbatim, cards written', () => {
  const r = runCards(['claude', '-p', 'fix it', '--model', 'claude-opus-5-5', '--effort', 'high'], { CLAUDE_BIN: FAKE_GROK, FAKE_GROK_MODE: 'args' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['-p', 'fix it', '--model', 'claude-opus-5-5', '--effort', 'high']);
  assert.equal(withoutAnnounce(r.stderr), '');
  const s = r.sidecar;
  assert.equal(s.tool, 'claude');
  assert.equal(s.toolName, 'Claude Code');
  assert.equal(s.binary, FAKE_GROK);
  assert.equal(s.model, 'claude-opus-5-5');
  assert.equal(s.effort, 'high');
  assert.equal(s.prompt, 'fix it');
  assert.equal(s.status, 'pass');
  for (const f of ['open.png', 'close.png']) {
    const png = decodePng(readFileSync(join(r.runs[0], f)));
    assert.equal(png.width, 1200);
    assert.equal(png.height, 630);
  }
  assert.deepEqual(s.errors, []);
});

test('claude: fail keeps exit code; json result → tokens + summary', () => {
  const fail = runCards(['claude', '-p', 'x'], { CLAUDE_BIN: FAKE_GROK, FAKE_GROK_MODE: 'fail' });
  assert.equal(fail.status, 3);
  assert.equal(fail.sidecar.status, 'fail');
  assert.match(fail.sidecar.summary.join('\n'), /build failed/);

  const json = runCards(['claude', '-p', 'x', '--output-format', 'json'], { CLAUDE_BIN: FAKE_GROK, FAKE_GROK_MODE: 'claude-json' });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(json.sidecar.tokens, { input: 500, output: 75, total: 575 });
  assert.deepEqual(json.sidecar.summary, ['Patched src/app.js.', 'All tests pass.']);
  assert.equal(JSON.parse(json.stdout).type, 'result', 'raw JSON still passed through');
});

test('claude: CLI_RUN_CARDS_DISABLED=1 passes through without cards', () => {
  const r = runCards(['claude', '-p', 'x'], { CLAUDE_BIN: FAKE_GROK, FAKE_GROK_MODE: 'args', CLI_RUN_CARDS_DISABLED: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['-p', 'x']);
  assert.equal(r.runs.length, 0);
});

test('invoked through a symlink named `claude` → acts as `run-cards claude`', () => {
  const dir = join(tmp('calias-'), 'bin');
  mkdirSync(dir, { recursive: true });
  symlinkSync(WRAPPER, join(dir, 'claude'));
  const r = runCards(['-p', 'via alias'], { CLAUDE_BIN: FAKE_GROK, FAKE_GROK_MODE: 'args' }, { entry: join(dir, 'claude') });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ['-p', 'via alias']);
  assert.equal(r.sidecar.tool, 'claude');
});

test('usage errors', () => {
  assert.equal(runCards([]).status, 2);
  assert.equal(runCards(['nope']).status, 2);
  const help = runCards(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /run-cards <adapter>/);
  assert.match(runCards(['--version']).stdout, /^run-cards \d+\.\d+\.\d+/);
});

test('resolveInvocation', () => {
  assert.deepEqual(resolveInvocation(['grok', '-p', 'x'], '/x/bin/run-cards'), { adapterName: 'grok', args: ['-p', 'x'] });
  assert.deepEqual(resolveInvocation(['-p', 'x'], '/usr/local/bin/grok'), { adapterName: 'grok', args: ['-p', 'x'] });
});

// --- cancelled / blocked runs (exit 0 but not finished) ---------------------------------------

test('grok headless run cancelled for approval (exit 0, stopReason "cancelled") → CANCELLED, not pass; exit code still 0', () => {
  const r = runCards(['grok', '-p', 'build the plugin', '--output-format', 'json'], { FAKE_GROK_MODE: 'grok-cancelled-json' });
  assert.equal(r.status, 0, 'wrapper returns the CLI exit code unchanged');
  const s = r.sidecar;
  assert.equal(s.status, 'cancelled');
  assert.match(s.reason, /stop reason "cancelled"/);
  assert.deepEqual(s.outcome, { stopReason: 'cancelled', edits: null, permissionDenials: 0 });
  assert.match(s.summary[0], /^\[run-cards\] cancelled: /);
  const png = decodePng(readFileSync(join(r.runs[0], 'close.png')));
  assert.deepEqual(png.pixel(450, 96).slice(0, 3), hex(THEMES.grok.cancelled), 'grey CANCELLED pill');
  assert.match(readFileSync(join(r.runs[0], 'close.md'), 'utf8'), /^\*\*Grok Build · ⏹️ CANCELLED\*\* · exit 0 · /);
  assert.equal(JSON.parse(readFileSync(join(r.dir, 'latest.json'), 'utf8')).status, 'cancelled');
});

test('grok streaming-json: tool approval cancelled, nothing edited → BLOCKED', () => {
  const r = runCards(['grok', '-p', 'x', '--output-format', 'streaming-json'], { FAKE_GROK_MODE: 'grok-stream-blocked' });
  assert.equal(r.status, 0);
  assert.equal(r.sidecar.status, 'blocked');
  assert.equal(r.sidecar.outcome.edits, 0);
  assert.match(r.sidecar.reason, /no file edits/);
  const png = decodePng(readFileSync(join(r.runs[0], 'close.png')));
  assert.deepEqual(png.pixel(450, 96).slice(0, 3), hex(THEMES.grok.blocked));
});

test('claude: permission denied for Write (json and stream-json) → BLOCKED; max turns → CANCELLED', () => {
  const json = runCards(['claude', '-p', 'x', '--output-format', 'json'], { CLAUDE_BIN: FAKE_GROK, FAKE_GROK_MODE: 'claude-denied' });
  assert.equal(json.status, 0);
  assert.equal(json.sidecar.status, 'blocked');
  assert.match(json.sidecar.reason, /permission denied for Write/);
  const stream = runCards(['claude', '-p', 'x', '--output-format', 'stream-json'], { CLAUDE_BIN: FAKE_GROK, FAKE_GROK_MODE: 'claude-stream-denied' });
  assert.equal(stream.sidecar.status, 'blocked');
  const png = decodePng(readFileSync(join(stream.runs[0], 'close.png')));
  assert.deepEqual(png.pixel(450, 96).slice(0, 3), hex(THEMES.claude.blocked));
  const maxTurns = runCards(['claude', '-p', 'x', '--output-format', 'json'], { CLAUDE_BIN: FAKE_GROK, FAKE_GROK_MODE: 'claude-max-turns' });
  assert.equal(maxTurns.sidecar.status, 'cancelled');
});

test('real passes and fails are unchanged (plain, json, streaming with edits, failing exit)', () => {
  for (const [mode, args] of [['pass', []], ['json', ['--output-format', 'json']], ['grok-stream-edited', ['--output-format', 'streaming-json']]]) {
    const r = runCards(['grok', '-p', 'x', ...args], { FAKE_GROK_MODE: mode });
    assert.equal(r.sidecar.status, 'pass', mode);
    assert.equal(r.sidecar.reason, null, mode);
    assert.ok(!r.sidecar.summary.some((l) => l.startsWith('[run-cards]')), mode);
  }
  const edited = runCards(['grok', '-p', 'x', '--output-format', 'streaming-json'], { FAKE_GROK_MODE: 'grok-stream-edited' });
  assert.equal(edited.sidecar.outcome.edits, 1);
  const fail = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'fail' });
  assert.equal(fail.sidecar.status, 'fail');
  assert.equal(fail.sidecar.reason, null);
});

// --- Markdown cards ---------------------------------------------------------------------------

function gitRepo() {
  const dir = tmp('repo-');
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  g('init', '-q', '-b', 'feat/demo');
  g('remote', 'add', 'origin', 'https://x-access-token:ghs_NOTAREALTOKEN1234567890@github.com/acme/widgets.git');
  writeFileSync(join(dir, 'README'), 'x\n');
  g('add', 'README');
  g('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
  return dir;
}

test('open.md / close.md: repo, branch and the commit the run made', () => {
  const repo = gitRepo();
  const r = runCards(['grok', '-p', 'add a feature file', '-m', 'grok-4.7', '--effort', 'high'], { FAKE_GROK_MODE: 'commit' }, { cwd: repo });
  assert.equal(r.status, 0, r.stderr);
  const openMd = readFileSync(join(r.runs[0], 'open.md'), 'utf8');
  assert.match(openMd, /^\*\*Grok Build · ▶️ RUN STARTED\*\*\nModel: `grok-4\.7` · Effort: high\nRepo: `acme\/widgets` · Branch: `feat\/demo`\nPrompt: add a feature file\nStarted: /);
  const closeMd = readFileSync(join(r.runs[0], 'close.md'), 'utf8');
  assert.match(closeMd, /^\*\*Grok Build · ✅ PASSED\*\* · exit 0 · \d+s\n/);
  assert.match(closeMd, /\nCommit: `[0-9a-f]{7,}` feat: add feature\.txt\n/);
  assert.match(closeMd, /Output \(start\):\n```\nCommitted feature\.txt\.\n```\n$/);
  for (const t of [openMd, closeMd, JSON.stringify(r.sidecar)]) assert.ok(!t.includes('NOTAREALTOKEN'), 'remote credentials never written');
  assert.equal(r.sidecar.repo, 'acme/widgets');
  assert.equal(r.sidecar.branch, 'feat/demo');
  assert.equal(r.sidecar.commit.subject, 'feat: add feature.txt');
  assert.equal(r.sidecar.commit.count, 1);
});

test('close.md: no commit → "Commit: none"; outside git → no repo/commit lines; grok --cwd is used for git', () => {
  const repo = gitRepo();
  const none = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'pass' }, { cwd: repo });
  assert.match(readFileSync(join(none.runs[0], 'close.md'), 'utf8'), /\nCommit: none\n/);

  const outside = tmp('nogit-');
  const plain = runCards(['grok', '-p', 'x'], { FAKE_GROK_MODE: 'pass' }, { cwd: outside });
  const md = readFileSync(join(plain.runs[0], 'close.md'), 'utf8');
  assert.ok(!md.includes('Repo:') && !md.includes('Commit:'), md);
  assert.equal(plain.sidecar.repo, null);

  const viaCwd = runCards(['grok', '-p', 'x', '--cwd', repo], { FAKE_GROK_MODE: 'args' }, { cwd: outside });
  assert.match(readFileSync(join(viaCwd.runs[0], 'open.md'), 'utf8'), /Repo: `acme\/widgets`/);
});
