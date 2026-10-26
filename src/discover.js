// Locate the real CLI binary, never resolving back to this wrapper (which may be
// installed on PATH under the same name, e.g. a `grok` symlink → run-cards).
import { accessSync, constants, existsSync, openSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Marker present in the wrapper entrypoint (and in any shim that delegates to it). */
export const WRAPPER_MARKER = 'cli-run-cards:wrapper';

export const WRAPPER_ENTRY = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'run-cards');

function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isExecutableFile(p) {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True if the file's head (first 4 KiB) carries the wrapper marker. Binaries won't. */
function hasWrapperMarker(p) {
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('latin1').includes(WRAPPER_MARKER);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function isWrapper(p, selfPaths = defaultSelfPaths()) {
  const real = safeRealpath(p);
  return selfPaths.has(real) || hasWrapperMarker(real);
}

export function defaultSelfPaths() {
  const s = new Set([safeRealpath(WRAPPER_ENTRY)]);
  if (process.argv[1]) s.add(safeRealpath(process.argv[1]));
  return s;
}

export class BinaryNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BinaryNotFoundError';
  }
}

/**
 * @param {string} name       binary name on PATH, e.g. 'grok'
 * @param {object} opts
 * @param {string} opts.envVar override env var, e.g. 'GROK_BIN'
 * @param {object} [opts.env]
 * @param {Set<string>} [opts.selfPaths] realpaths that are this wrapper
 * @returns {string} absolute path to the real binary
 */
export function findRealBinary(name, { envVar, env = process.env, selfPaths = defaultSelfPaths() } = {}) {
  const override = envVar && env[envVar];
  if (override) {
    const p = isAbsolute(override) ? override : resolve(override);
    if (!existsSync(p)) throw new BinaryNotFoundError(`${envVar}=${override} does not exist`);
    if (!isExecutableFile(p)) throw new BinaryNotFoundError(`${envVar}=${override} is not an executable file`);
    if (isWrapper(p, selfPaths)) throw new BinaryNotFoundError(`${envVar}=${override} points at the run-cards wrapper itself`);
    return p;
  }
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (!isExecutableFile(p)) continue;
      if (isWrapper(p, selfPaths)) continue;
      return p;
    }
  }
  throw new BinaryNotFoundError(
    `could not find the real \`${name}\` on PATH (wrapper entries skipped). Install it or set ${envVar}=/path/to/${name}.`,
  );
}
