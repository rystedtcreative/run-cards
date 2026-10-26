// Run directory layout:
//   $CLI_RUN_CARDS_DIR (default ~/.cli-run-cards)/
//     latest.json                     → pointer to the most recent run
//     runs/<YYYYMMDD-HHMMSS (UTC)>-<id>/   (or runs/<$CLI_RUN_CARDS_RUN_ID>/ when the caller picks the id)
//       open.png  open.md  close.png  close.md  run.json
// Directories are 0700 and files 0600: prompts and output may contain client data.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function baseDir(env = process.env) {
  return resolve(env.CLI_RUN_CARDS_DIR || join(env.HOME || homedir(), '.cli-run-cards'));
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A caller-chosen run id must be a safe single path segment. */
export function isValidRunId(id) {
  return typeof id === 'string' && RUN_ID_RE.test(id) && !id.includes('..');
}

/**
 * Create a fresh run directory; returns { id, dir, root }.
 * With `runId` (already validated) the dir is exactly runs/<runId>/ and the leaf mkdir is
 * non-recursive, so an existing dir fails atomically with EEXIST instead of being reused.
 */
export function createRunDir({ env = process.env, now = new Date(), id = randomBytes(3).toString('hex'), runId = null } = {}) {
  const root = baseDir(env);
  if (runId) {
    const dir = join(root, 'runs', runId);
    mkdirSync(join(root, 'runs'), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    return { id: runId, dir, root };
  }
  const dir = join(root, 'runs', `${stamp(now)}-${id}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { id, dir, root };
}

/** Atomic-ish write (tmp + rename) so readers never see a half-written file. */
function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}

export function writeCard(dir, name, png) {
  const path = join(dir, `${name}.png`);
  writeAtomic(path, png);
  return path;
}

/** Markdown text version of a card (open.md / close.md). */
export function writeCardText(dir, name, text) {
  const path = join(dir, `${name}.md`);
  writeAtomic(path, text);
  return path;
}

export function writeSidecar(dir, data) {
  const path = join(dir, 'run.json');
  writeAtomic(path, JSON.stringify(data, null, 2) + '\n');
  return path;
}

export function writeLatest(root, data) {
  const path = join(root, 'latest.json');
  writeAtomic(path, JSON.stringify(data, null, 2) + '\n');
  return path;
}
