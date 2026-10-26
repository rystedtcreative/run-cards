// Claude Code adapter (fully wired, same interface as adapters/grok.js).
// Flag knowledge is based on `claude --help` (v2.1.x): `-p/--print` is a boolean switch and
// the prompt is positional (`claude -p "fix it"`, `claude -p -- "fix it"`).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findRealBinary } from '../discover.js';
import { extractFinalText, extractTokenUsage } from '../usage.js';
import { detectOutcome } from '../outcome.js';

// Flags that always consume the next token as their value.
const VALUE_FLAGS = new Set([
  '--model', '--effort', '--output-format', '--input-format', '--fallback-model', '--permission-mode',
  '--permission-prompt-tool', '--system-prompt', '--system-prompt-file', '--append-system-prompt',
  '--append-system-prompt-file', '--settings', '--setting-sources', '--session-id', '--agent', '--agents',
  '--max-turns', '--max-budget-usd', '--json-schema',
]);
// Variadic flags (commander `<values...>`): consume following tokens until the next flag.
// `claude --add-dir ../lib "prompt"` really does treat "prompt" as a dir — use `--` to end them.
const VARIADIC_FLAGS = new Set([
  '--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools',
  '--mcp-config', '--plugin-dir', '--betas',
]);
// Flags with an optional value: consume the next token unless it is a flag.
const OPTIONAL_VALUE_FLAGS = new Set(['-r', '--resume', '-d', '--debug']);

const SUBCOMMANDS = new Set([
  'agents', 'auth', 'config', 'doctor', 'install', 'mcp', 'migrate-installer', 'plugin', 'plugins',
  'setup-token', 'update', 'upgrade',
]);

/** Tokenise argv into { flags: Map<flag, value|true>, positionals: string[] }. Last flag wins. */
export function scanArgs(args) {
  const flags = new Map();
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      flags.set(a.slice(0, eq), a.slice(eq + 1));
    } else if (VALUE_FLAGS.has(a)) {
      flags.set(a, args[i + 1] ?? '');
      i++;
    } else if (VARIADIC_FLAGS.has(a)) {
      const values = [];
      while (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) values.push(args[++i]);
      flags.set(a, values.join(' ') || true);
    } else if (OPTIONAL_VALUE_FLAGS.has(a)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(a, next);
        i++;
      } else flags.set(a, true);
    } else if (a.startsWith('-') && a !== '-') {
      flags.set(a, true);
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function flag(flags, ...names) {
  for (const n of names) if (flags.has(n) && typeof flags.get(n) === 'string') return flags.get(n);
  return null;
}

/**
 * Best-effort model/effort defaults when no flag is given: $ANTHROPIC_MODEL, then
 * `model` / `effortLevel` in $CLAUDE_CONFIG_DIR/settings.json (default ~/.claude/settings.json).
 */
export function readClaudeDefaults(env = process.env) {
  const out = { model: env.ANTHROPIC_MODEL || null, effort: null };
  const dir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
  try {
    const s = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    if (!out.model && typeof s?.model === 'string') out.model = s.model;
    if (typeof s?.effortLevel === 'string') out.effort = s.effortLevel;
  } catch {
    /* missing or not JSON — ignore */
  }
  return out;
}

/**
 * Extract card-relevant facts from the claude argv.
 * @returns {{ model: string|null, effort: string|null, prompt: string, headless: boolean, outputFormat: string, subcommand: string|null }}
 */
export function parseClaudeArgs(args, { env = process.env } = {}) {
  const { flags, positionals } = scanArgs(args);
  const subcommand = positionals.length && SUBCOMMANDS.has(positionals[0]) ? positionals[0] : null;
  const print = flags.has('-p') || flags.has('--print');
  const headless = print || flags.has('--output-format') || subcommand != null;

  let prompt = '';
  if (subcommand) prompt = `claude ${positionals.join(' ')}`;
  else if (positionals.length) prompt = positionals.join(' ');
  else if (print) prompt = flag(flags, '--input-format') === 'stream-json' ? '(stream-json prompt on stdin)' : '(prompt on stdin)';

  let model = flag(flags, '--model');
  let effort = flag(flags, '--effort');
  if (!model || !effort) {
    const defaults = readClaudeDefaults(env);
    model = model || defaults.model;
    effort = effort || defaults.effort;
  }
  const outputFormat = flag(flags, '--output-format') || 'text';
  return { model: model || null, effort: effort || null, prompt, headless, outputFormat, subcommand };
}

export default {
  id: 'claude',
  displayName: 'Claude Code',
  implemented: true,
  binName: 'claude',
  binEnv: 'CLAUDE_BIN',

  findBinary({ env = process.env, selfPaths } = {}) {
    return findRealBinary('claude', { envVar: 'CLAUDE_BIN', env, selfPaths });
  },

  parseArgs(args, opts) {
    return parseClaudeArgs(args, opts);
  },

  /** Token usage from `--output-format json|stream-json` (the `result` object's `usage`). */
  extractTokens(stdout) {
    return extractTokenUsage(stdout);
  },

  /**
   * Text to summarise on the close card: the `result` text if structured, else raw stdout.
   * On failure stderr comes first so the error survives the card's first-lines truncation.
   */
  summaryText(stdout, stderr, { failed = false } = {}) {
    const main = extractFinalText(stdout) ?? stdout ?? '';
    if (!main.trim()) return stderr || '';
    return failed && stderr && stderr.trim() ? `${stderr.trimEnd()}\n${main}` : main;
  },

  /**
   * Did an exit-0 run really finish? Detects a cancelled stop reason, permission / approval
   * denials and max-turns stops, and counts file edits when the output format shows tool calls.
   * @returns {{ status: 'blocked'|'cancelled'|null, reason: string|null, stopReason: string|null, edits: number|null, permissionDenials: number }}
   */
  detectOutcome(stdout, stderr) {
    return detectOutcome(stdout, stderr);
  },
};
