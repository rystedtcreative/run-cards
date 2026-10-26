// Spawn the real CLI, tee its stdout/stderr live to ours (byte-for-byte, unmasked —
// the caller sees exactly what the CLI printed), keep a bounded tail for the cards,
// and enforce an optional timeout.
import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';

export const TIMEOUT_EXIT_CODE = 124; // same convention as coreutils `timeout`
export const SPAWN_FAILURE_EXIT_CODE = 127;
const DEFAULT_CAPTURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5000;
const STDIO_DRAIN_MS = 2000;

/** Keeps only the last `limit` bytes written to it. */
export class TailBuffer {
  constructor(limit = DEFAULT_CAPTURE_BYTES) {
    this.limit = limit;
    this.chunks = [];
    this.size = 0;
    this.truncated = false;
  }

  push(chunk) {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit) {
      const excess = this.size - this.limit;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
      this.truncated = true;
    }
  }

  toString() {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

export function signalExitCode(signal) {
  const n = signal && osConstants.signals[signal];
  return n ? 128 + n : 1;
}

/**
 * @param {object} o
 * @param {string} o.bin
 * @param {string[]} o.args
 * @param {object} [o.env]
 * @param {number} [o.timeoutMs]   0/undefined = no timeout
 * @param {number} [o.killGraceMs] SIGTERM → SIGKILL grace period
 * @param {boolean} [o.inheritStdio] hand the TTY straight to the child (interactive TUI); no capture
 * @param {NodeJS.WritableStream} [o.stdout] tee target (default process.stdout)
 * @param {NodeJS.WritableStream} [o.stderr] tee target (default process.stderr)
 * @param {number} [o.captureBytes]
 * @param {(child: import('node:child_process').ChildProcess) => void} [o.onSpawn]
 * @returns {Promise<{exitCode:number, signal:string|null, timedOut:boolean, stdout:string, stderr:string,
 *   durationMs:number, spawnError:string|null, captured:boolean}>}
 */
export function runPassthrough({
  bin,
  args,
  env = process.env,
  timeoutMs = 0,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  inheritStdio = false,
  stdout = process.stdout,
  stderr = process.stderr,
  captureBytes = DEFAULT_CAPTURE_BYTES,
  onSpawn,
}) {
  const started = Date.now();
  const outBuf = new TailBuffer(captureBytes);
  const errBuf = new TailBuffer(captureBytes);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { env, stdio: inheritStdio ? 'inherit' : ['inherit', 'pipe', 'pipe'] });
    } catch (err) {
      resolve(result(SPAWN_FAILURE_EXIT_CODE, null, false, err.message));
      return;
    }
    onSpawn?.(child);

    let timedOut = false;
    let settled = false;
    let killTimer;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            killTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
            killTimer.unref();
          }, timeoutMs)
        : null;

    const tee = (src, sink, buf) => {
      if (!src) return;
      src.on('data', (chunk) => {
        buf.push(chunk);
        if (!sink.write(chunk)) {
          src.pause();
          sink.once('drain', () => src.resume());
        }
      });
    };
    tee(child.stdout, stdout, outBuf);
    tee(child.stderr, stderr, errBuf);

    const finish = (code, signal, spawnError = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      let exitCode;
      if (spawnError) exitCode = SPAWN_FAILURE_EXIT_CODE;
      else if (timedOut) exitCode = TIMEOUT_EXIT_CODE;
      else if (code != null) exitCode = code;
      else exitCode = signalExitCode(signal);
      resolve(result(exitCode, signal, timedOut, spawnError));
    };

    child.on('error', (err) => finish(null, null, `failed to start ${bin}: ${err.message}`));
    child.on('close', (code, signal) => finish(code, signal));
    // 'close' waits for stdio to end; a grandchild holding the pipes open must not hang us.
    child.on('exit', (code, signal) => {
      setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, signal);
      }, STDIO_DRAIN_MS).unref();
    });
  });

  function result(exitCode, signal, timedOut, spawnError) {
    return {
      exitCode,
      signal: signal || null,
      timedOut,
      stdout: outBuf.toString(),
      stderr: errBuf.toString(),
      durationMs: Date.now() - started,
      spawnError,
      captured: !inheritStdio,
    };
  }
}
