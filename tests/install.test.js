// scripts/install.sh: dry-run prints without touching anything; a real run against a local
// clone of this repo is idempotent and only creates the run-cards symlink.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, tmp } from './helpers.js';

const SCRIPT = join(ROOT, 'scripts', 'install.sh');
const hasGit = spawnSync('git', ['--version']).status === 0;

function install(args, env) {
  return spawnSync('bash', [SCRIPT, ...args], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8', timeout: 60000 });
}

test('install --help', () => {
  const r = install(['--help'], {});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--dry-run/);
  assert.equal(install(['--bogus'], {}).status, 2);
});

for (const [label, args, extra] of [
  ['--dry-run', ['--dry-run'], {}],
  ['DRY_RUN=1', [], { DRY_RUN: '1' }],
]) {
  test(`install ${label}: prints ln -sfn to the right target, creates nothing, no grok/claude links`, () => {
    const base = tmp('install-dry-');
    const src = join(base, 'src', 'cli-run-cards');
    const bin = join(base, 'bin');
    const r = install(args, { CLI_RUN_CARDS_SRC: src, CLI_RUN_CARDS_BIN_DIR: bin, CLI_RUN_CARDS_REPO: 'file:///nonexistent/repo.git', ...extra });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(`ln -sfn ${src}/bin/run-cards ${bin}/run-cards`), r.stdout);
    assert.ok(r.stdout.includes(`git clone --branch main file:///nonexistent/repo.git ${src}`), r.stdout);
    assert.doesNotMatch(r.stdout, /\/(grok|claude)\b/);
    assert.deepEqual(readdirSync(base), [], 'dry run created nothing');
  });
}

test('install real run against a local clone: idempotent, symlink points into the checkout', { skip: !hasGit && 'git not available' }, () => {
  const base = tmp('install-real-');
  const bare = join(base, 'repo.git');
  const clone = spawnSync('git', ['clone', '--quiet', '--bare', ROOT, bare], { encoding: 'utf8' });
  assert.equal(clone.status, 0, clone.stderr);
  const src = join(base, 'src', 'cli-run-cards');
  const bin = join(base, 'local', 'bin');
  const env = { CLI_RUN_CARDS_SRC: src, CLI_RUN_CARDS_BIN_DIR: bin, CLI_RUN_CARDS_REPO: `file://${bare}` };

  for (let i = 0; i < 2; i++) {
    const r = install([], env);
    assert.equal(r.status, 0, `run ${i + 1}: ${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^run-cards \d+\.\d+\.\d+$/m, 'verified with run-cards --version');
    assert.equal(readlinkSync(join(bin, 'run-cards')), join(src, 'bin', 'run-cards'));
    assert.deepEqual(readdirSync(bin), ['run-cards'], 'no grok/claude symlinks');
    const branch = spawnSync('git', ['-C', src, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
    assert.equal(branch.stdout.trim(), 'main');
  }
  assert.match(install([], env).stdout, /pull --ff-only/, 'second+ run updates instead of cloning');
  assert.ok(existsSync(join(src, '.git')));
});
