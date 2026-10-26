import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(here, '..');
export const FAKE_GROK = join(here, 'fixtures', 'fake-grok');
export const WRAPPER = join(ROOT, 'bin', 'run-cards');

export function tmp(prefix = 'run-cards-test-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Run bin/run-cards synchronously against the fake CLI; returns spawnSync result + run dirs + parsed run.json. */
export function runCards(args, env = {}, opts = {}) {
  const dir = env.CLI_RUN_CARDS_DIR ?? tmp('cards-');
  const r = spawnSync(process.execPath, [opts.entry ?? WRAPPER, ...args], {
    env: { PATH: process.env.PATH, HOME: '/nonexistent-home', GROK_BIN: FAKE_GROK, CLI_RUN_CARDS_DIR: dir, ...env },
    encoding: 'utf8',
    input: opts.input ?? '',
    cwd: opts.cwd,
    timeout: 20000,
  });
  const runsDir = join(dir, 'runs');
  const runs = existsSync(runsDir) ? readdirSync(runsDir).map((d) => join(runsDir, d)) : [];
  const sidecar = runs[0] && existsSync(join(runs[0], 'run.json')) ? JSON.parse(readFileSync(join(runs[0], 'run.json'), 'utf8')) : null;
  return { ...r, dir, runs, sidecar };
}

export const ANNOUNCE_RE = /^run-cards: (open-card|open-md|close-card|close-md|run-json) (\/\S.*)$/;

/** The `run-cards: <kind> <path>` lines on stderr, in order. */
export function announceLines(stderr) {
  return stderr
    .split('\n')
    .map((l) => l.match(ANNOUNCE_RE))
    .filter(Boolean)
    .map((m) => ({ kind: m[1], path: m[2], line: m[0] }));
}

/** stderr with the announce lines removed (what the CLI itself printed, plus any warnings). */
export function withoutAnnounce(stderr) {
  return stderr
    .split(/(?<=\n)/)
    .filter((l) => !ANNOUNCE_RE.test(l.replace(/\n$/, '')))
    .join('');
}

/** A PATH dir containing `grok` → fake-grok. */
export function fakeGrokPathDir() {
  const dir = join(tmp('path-'), 'bin');
  mkdirSync(dir, { recursive: true });
  symlinkSync(FAKE_GROK, join(dir, 'grok'));
  return dir;
}

/** Minimal PNG decoder for RGBA/filter-0 images produced by src/cards/png.js. */
export function decodePng(buf) {
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  return {
    width,
    height,
    pixel(x, y) {
      const i = y * stride + 1 + x * 4;
      return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
    },
  };
}
