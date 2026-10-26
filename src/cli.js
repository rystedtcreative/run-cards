// run-cards <adapter> [args…]
// Opens a card, runs the real CLI with the same args (full passthrough), closes a card,
// exits with the CLI's exit code. Card failures never change the CLI's result.
import { basename, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { ADAPTERS, getAdapter } from './adapters/index.js';
import { BinaryNotFoundError } from './discover.js';
import { buildCloseCardFields, buildOpenCardFields, DEFAULT_SUMMARY_LINES, summarizeOutput } from './cards/contract.js';
import { renderCloseCard, renderOpenCard } from './cards/render.js';
import { renderCloseMarkdown, renderOpenMarkdown } from './cards/markdown.js';
import { newCommit, readGitState } from './git-info.js';
import { maskSecrets } from './mask.js';
import { runPassthrough, SPAWN_FAILURE_EXIT_CODE } from './passthrough.js';
import { baseDir, createRunDir, isValidRunId, writeCard, writeCardText, writeLatest, writeSidecar } from './run-dir.js';

export const USAGE_EXIT_CODE = 2;
const DEFAULT_HEADLESS_TIMEOUT_MS = 60 * 60 * 1000;

const HELP = `run-cards — passthrough wrapper that writes opening/closing run cards (PNG + Markdown)

Usage:
  run-cards <adapter> [args…]     run the real CLI with [args…] unchanged
  run-cards --help | --version

Adapters:
  grok      Grok Build (real binary: $GROK_BIN or \`grok\` on PATH, skipping this wrapper)
  claude    Claude Code (real binary: $CLAUDE_BIN or \`claude\` on PATH, skipping this wrapper)

Everything after <adapter> is passed to the real CLI verbatim. stdout/stderr are
streamed live and the CLI's exit code is returned (124 on timeout).

As each artifact is written, one line is printed to stderr (stable format, absolute paths):
  run-cards: open-card <path/open.png>     before the CLI starts
  run-cards: open-md <path/open.md>        same card as Markdown text (for text-only group rooms)
  run-cards: close-card <path/close.png>   after it exits (also on timeout)
  run-cards: close-md <path/close.md>      same card as Markdown text
  run-cards: run-json <path/run.json>      after run.json holds the final state
A card that fails to write is not announced. In group rooms post the .md text;
in a 1:1 attach the PNGs.

Close-card status: pass / fail (exit code) / timeout, or cancelled / blocked when the CLI
exited 0 but the run didn't finish (cancelled stop reason, max turns, permission or
approval denied). The wrapper's exit code is always the CLI's own.

Environment:
  CLI_RUN_CARDS_DIR            root for runs (default ~/.cli-run-cards)
  CLI_RUN_CARDS_RUN_ID=<id>    use runs/<id>/ instead of a generated id. <id> must match
                               ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ without "..", and the dir
                               must not exist yet; otherwise exit 2 without running the CLI.
                               Ignored when CLI_RUN_CARDS_DISABLED=1
  CLI_RUN_CARDS_DISABLED=1     plain passthrough, no cards, no path lines
  CLI_RUN_CARDS_QUIET=1        don't print the open-card / close-card / run-json lines
  CLI_RUN_CARDS_TIMEOUT_MS     kill after N ms (default 3600000 headless, none interactive; 0 = off)
  CLI_RUN_CARDS_KILL_GRACE_MS  SIGTERM → SIGKILL grace (default 5000)
  CLI_RUN_CARDS_SUMMARY_LINES  output lines on the closing card (default ${DEFAULT_SUMMARY_LINES})
  CLI_RUN_CARDS_VERBOSE        deprecated no-op (paths are announced by default)
  GROK_BIN / CLAUDE_BIN        explicit path to the real binary

Examples:
  run-cards grok -p "fix the failing test" --output-format json
  run-cards claude -p "fix the failing test" --output-format json --effort high
`;

function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function intEnv(env, name, fallback) {
  const v = env[name];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

const truthy = (v) => v != null && v !== '' && v !== '0' && v.toLowerCase?.() !== 'false';

/**
 * Resolve which adapter to use. Supports `run-cards grok …` and being invoked through a
 * symlink named after the adapter (e.g. ~/bin/grok → run-cards).
 */
export function resolveInvocation(argv, invokedAs = process.argv[1]) {
  const self = invokedAs ? basename(invokedAs).replace(/\.(c|m)?js$/, '') : '';
  if (self && self !== 'run-cards' && getAdapter(self)) return { adapterName: self, args: argv };
  return { adapterName: argv[0], args: argv.slice(1) };
}

/**
 * @param {string[]} argv  arguments after the executable
 * @param {object} [deps]  injectable for tests
 * @returns {Promise<number>} exit code
 */
export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.stdout ?? process.stdout;
  const err = deps.stderr ?? process.stderr;
  const warn = (msg) => err.write(`run-cards: ${msg}\n`);
  // Stable API (skills grep for these): exactly `run-cards: <kind> <abs path>\n`, one write each.
  const quiet = truthy(env.CLI_RUN_CARDS_QUIET);
  const announce = (kind, path) => {
    if (!quiet) err.write(`run-cards: ${kind} ${path}\n`);
  };

  const { adapterName, args } = resolveInvocation(argv, deps.invokedAs);
  if (!adapterName || adapterName === '-h' || adapterName === '--help' || adapterName === 'help') {
    (adapterName ? out : err).write(HELP);
    return adapterName ? 0 : USAGE_EXIT_CODE;
  }
  if (adapterName === '-v' || adapterName === '--version') {
    out.write(`run-cards ${readVersion()}\n`);
    return 0;
  }
  const adapter = getAdapter(adapterName);
  if (!adapter) {
    warn(`unknown adapter "${adapterName}". Available: ${Object.keys(ADAPTERS).join(', ')}`);
    return USAGE_EXIT_CODE;
  }

  let bin;
  try {
    bin = adapter.findBinary({ env, selfPaths: deps.selfPaths });
  } catch (e) {
    warn(e instanceof BinaryNotFoundError ? e.message : `binary discovery failed: ${e.message}`);
    return SPAWN_FAILURE_EXIT_CODE;
  }

  const interactiveTty = Boolean((deps.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY)));
  const passOpts = {
    bin,
    args,
    env,
    stdout: out,
    stderr: err,
    killGraceMs: intEnv(env, 'CLI_RUN_CARDS_KILL_GRACE_MS', 5000),
  };

  if (truthy(env.CLI_RUN_CARDS_DISABLED)) {
    const r = await runPassthrough({ ...passOpts, inheritStdio: interactiveTty, timeoutMs: intEnv(env, 'CLI_RUN_CARDS_TIMEOUT_MS', 0) });
    if (r.spawnError) warn(r.spawnError);
    return r.exitCode;
  }

  if (!adapter.implemented) {
    warn(`the ${adapter.displayName} adapter is not implemented yet. Set CLI_RUN_CARDS_DISABLED=1 to pass through without cards.`);
    return USAGE_EXIT_CODE;
  }

  const runId = env.CLI_RUN_CARDS_RUN_ID || null;
  if (runId != null && !isValidRunId(runId)) {
    warn(`invalid CLI_RUN_CARDS_RUN_ID ${JSON.stringify(runId)}: must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ and not contain ".."`);
    return USAGE_EXIT_CODE;
  }

  const parsed = adapter.parseArgs(args, { env });
  const inheritStdio = interactiveTty && !parsed.headless;
  const timeoutMs = intEnv(env, 'CLI_RUN_CARDS_TIMEOUT_MS', inheritStdio ? 0 : DEFAULT_HEADLESS_TIMEOUT_MS);
  const summaryLines = Math.max(1, intEnv(env, 'CLI_RUN_CARDS_SUMMARY_LINES', DEFAULT_SUMMARY_LINES));
  const maskOpts = { env };
  const startedAt = new Date();
  let workDir = process.cwd();
  try {
    const wd = adapter.workDir?.(args);
    if (wd) workDir = resolve(process.cwd(), wd);
  } catch {
    /* keep cwd */
  }
  const gitBefore = readGitState(workDir, env);

  // --- opening card (before spawn) -------------------------------------------------------
  const sidecar = {
    version: 1,
    id: null,
    tool: adapter.id,
    toolName: adapter.displayName,
    binary: bin,
    args: args.map((a) => maskSecrets(a, maskOpts)),
    cwd: process.cwd(),
    model: null,
    effort: null,
    prompt: null,
    repo: gitBefore ? maskSecrets(gitBefore.repo, maskOpts) : null,
    branch: gitBefore?.branch ? maskSecrets(gitBefore.branch, maskOpts) : null,
    commit: null,
    status: 'running',
    reason: null,
    outcome: null,
    exitCode: null,
    signal: null,
    timedOut: false,
    startedAt: startedAt.toISOString(),
    endedAt: null,
    durationMs: null,
    tokens: null,
    summary: null,
    cards: { open: null, close: null, openMd: null, closeMd: null },
    errors: [],
  };
  let run = null;
  let open = null;
  try {
    try {
      run = createRunDir({ env, now: startedAt, runId });
    } catch (e) {
      if (runId && e.code === 'EEXIST') {
        warn(`run directory ${join(baseDir(env), 'runs', runId)} already exists (CLI_RUN_CARDS_RUN_ID must be unique); not running`);
        return USAGE_EXIT_CODE;
      }
      throw e;
    }
    sidecar.id = run.id;
    sidecar.runDir = run.dir;
    open = buildOpenCardFields({ tool: adapter.id, toolName: adapter.displayName, ...parsed, startedAt }, maskOpts);
    Object.assign(sidecar, { model: open.model, effort: open.effort, prompt: open.promptFull });
    sidecar.cards.open = writeCard(run.dir, 'open', renderOpenCard(open));
    announce('open-card', sidecar.cards.open);
  } catch (e) {
    sidecar.errors.push(`open card: ${e.message}`);
    warn(`could not write opening card: ${e.message}`);
  }
  if (run && open) {
    sidecar.cards.openMd = safe(() => writeCardText(run.dir, 'open', renderOpenMarkdown(open, { git: gitBefore }, maskOpts)), sidecar, warn, 'opening card text');
    if (sidecar.cards.openMd) announce('open-md', sidecar.cards.openMd);
  }
  if (run) safe(() => writeSidecar(run.dir, sidecar), sidecar, warn);

  // --- the actual run (full passthrough) ---------------------------------------------------
  const forward = installSignalForwarding(deps.forwardSignals !== false, interactiveTty);
  const result = await runPassthrough({ ...passOpts, inheritStdio, timeoutMs, onSpawn: forward.attach });
  forward.detach();
  if (result.spawnError) warn(result.spawnError);

  // --- closing card (after exit) ------------------------------------------------------------
  const failed = result.exitCode !== 0;
  let summaryText = '';
  let tokens = null;
  try {
    summaryText = result.captured ? adapter.summaryText(result.stdout, result.stderr, { failed }) : '(interactive session — output not captured)';
    tokens = result.captured ? adapter.extractTokens(result.stdout, result.stderr) : null;
  } catch (e) {
    sidecar.errors.push(`parse output: ${e.message}`);
  }
  let outcome = null;
  if (result.captured && !result.spawnError && adapter.detectOutcome) {
    try {
      outcome = adapter.detectOutcome(result.stdout, result.stderr);
    } catch (e) {
      sidecar.errors.push(`detect outcome: ${e.message}`);
    }
  }
  if (result.spawnError) summaryText = result.spawnError;
  if (result.timedOut) summaryText = `${summaryText.trimEnd()}\n[run-cards] timed out after ${Math.round(timeoutMs / 1000)}s — process killed`.trimStart();

  const close = buildCloseCardFields(
    {
      tool: adapter.id,
      toolName: adapter.displayName,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      tokens,
      output: summaryText,
      summaryLines,
      durationMs: result.durationMs,
      outcome,
    },
    maskOpts,
  );
  if (close.reason) {
    // Lead the output with why it isn't a pass, so it survives the first-lines truncation.
    const why = summarizeOutput(`[run-cards] ${close.status}: ${close.reason}`, 2, maskOpts);
    close.summary = [...why, ...close.summary].slice(0, Math.max(summaryLines, why.length + 1));
  }
  const gitAfter = gitBefore ? readGitState(workDir, env) : null;
  const commit = gitBefore && gitAfter ? newCommit(workDir, gitBefore, gitAfter, env) : null;
  Object.assign(sidecar, {
    status: close.status,
    reason: close.reason,
    outcome: outcome ? { stopReason: outcome.stopReason, edits: outcome.edits, permissionDenials: outcome.permissionDenials } : null,
    commit: commit ? { sha: commit.sha, subject: maskSecrets(commit.subject, maskOpts), count: commit.count } : null,
    exitCode: close.exitCode,
    signal: close.signal,
    timedOut: result.timedOut,
    endedAt: close.endedAt,
    durationMs: close.durationMs,
    tokens: close.tokens,
    summary: close.summary,
  });
  if (run) {
    safe(() => (sidecar.cards.close = writeCard(run.dir, 'close', renderCloseCard(close))), sidecar, warn, 'closing card');
    const gitEnd = gitAfter ?? gitBefore;
    const openForText = open ?? buildOpenCardFields({ tool: adapter.id, toolName: adapter.displayName, ...parsed, startedAt }, maskOpts);
    safe(
      () => (sidecar.cards.closeMd = writeCardText(run.dir, 'close', renderCloseMarkdown(close, { open: openForText, git: gitEnd, commit }, maskOpts))),
      sidecar,
      warn,
      'closing card text',
    );
    const sidecarPath = safe(() => writeSidecar(run.dir, sidecar), sidecar, warn);
    if (sidecar.cards.close) announce('close-card', sidecar.cards.close);
    if (sidecar.cards.closeMd) announce('close-md', sidecar.cards.closeMd);
    if (sidecarPath) announce('run-json', sidecarPath);
    safe(
      () => writeLatest(run.root, { id: run.id, runDir: run.dir, status: sidecar.status, exitCode: sidecar.exitCode, cards: sidecar.cards, sidecar: `${run.dir}/run.json` }),
      sidecar,
      warn,
    );
  }
  return result.exitCode;
}

function safe(fn, sidecar, warn, what = 'run files') {
  try {
    return fn();
  } catch (e) {
    sidecar.errors.push(`${what}: ${e.message}`);
    warn(`could not write ${what}: ${e.message}`);
    return null;
  }
}

/**
 * Forward termination signals to the child so a bot killing the wrapper also stops the CLI,
 * and the wrapper survives long enough to write the closing card. In an interactive TTY,
 * Ctrl-C already reaches the child via the process group, so SIGINT is not re-sent.
 */
function installSignalForwarding(enabled, interactiveTty) {
  if (!enabled) return { attach() {}, detach() {} };
  const signals = ['SIGTERM', 'SIGHUP', 'SIGINT'];
  let child = null;
  const handlers = {};
  for (const sig of signals) {
    handlers[sig] = () => {
      if (sig === 'SIGINT' && interactiveTty) return;
      if (child && child.exitCode == null) child.kill(sig);
    };
    process.on(sig, handlers[sig]);
  }
  return {
    attach(c) {
      child = c;
    },
    detach() {
      for (const sig of signals) process.off(sig, handlers[sig]);
    },
  };
}
