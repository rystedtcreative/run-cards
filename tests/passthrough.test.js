import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runPassthrough, TailBuffer, TIMEOUT_EXIT_CODE, signalExitCode } from '../src/passthrough.js';
import { FAKE_GROK } from './helpers.js';

function sinks() {
  const out = new PassThrough();
  const err = new PassThrough();
  const seen = { out: '', err: '' };
  out.on('data', (c) => (seen.out += c));
  err.on('data', (c) => (seen.err += c));
  return { out, err, seen };
}

const run = (mode, extra = {}) => {
  const s = sinks();
  return runPassthrough({
    bin: FAKE_GROK,
    args: extra.args ?? ['-p', 'x'],
    env: { ...process.env, FAKE_GROK_MODE: mode },
    stdout: s.out,
    stderr: s.err,
    ...extra,
  }).then((r) => ({ r, seen: s.seen }));
};

test('tees stdout/stderr byte-for-byte (unmasked) and captures them', async () => {
  const { r, seen } = await run('pass');
  assert.equal(r.exitCode, 0);
  assert.equal(r.timedOut, false);
  assert.match(seen.out, /^line 1\n/);
  assert.match(seen.out, /sk-ant-api03-SHOULDNOTAPPEARONCARD/, 'passthrough must not alter output');
  assert.equal(seen.out, r.stdout);
  assert.equal(seen.err, 'warn: something on stderr\n');
  assert.equal(r.stderr, seen.err);
});

test('args are passed through verbatim', async () => {
  const args = ['-p', 'with spaces & $symbols', '--model', 'm', '', '--x=1'];
  const { r } = await run('args', { args });
  assert.deepEqual(JSON.parse(r.stdout), args);
});

test('propagates non-zero exit codes', async () => {
  const { r, seen } = await run('fail');
  assert.equal(r.exitCode, 3);
  assert.match(seen.err, /build failed/);
});

test('timeout kills a hung process (escalating to SIGKILL) and returns 124', async () => {
  const t0 = Date.now();
  const { r, seen } = await run('hang', { timeoutMs: 300, killGraceMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, TIMEOUT_EXIT_CODE);
  assert.match(seen.out, /starting/);
  assert.ok(Date.now() - t0 < 5000);
});

test('child killed by a signal → 128 + signo', async () => {
  const { r } = await run('signal');
  assert.equal(r.signal, 'SIGTERM');
  assert.equal(r.exitCode, 143);
  assert.equal(signalExitCode('SIGKILL'), 137);
});

test('spawn failure → 127 with a message', async () => {
  const s = sinks();
  const r = await runPassthrough({ bin: '/no/such/binary', args: [], stdout: s.out, stderr: s.err });
  assert.equal(r.exitCode, 127);
  assert.match(r.spawnError, /failed to start/);
});

test('TailBuffer keeps only the last N bytes', () => {
  const b = new TailBuffer(10);
  b.push(Buffer.from('0123456789'));
  b.push(Buffer.from('abc'));
  assert.equal(b.toString(), '3456789abc');
  b.push(Buffer.from('x'.repeat(25)));
  assert.equal(b.toString(), 'x'.repeat(10));
  assert.equal(b.truncated, true);
});
