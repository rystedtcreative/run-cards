// Grok Build adapter (v1, fully wired).
// Flag knowledge is based on `grok --help` / ~/.grok/docs/user-guide/14-headless-mode.md.
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findRealBinary } from '../discover.js';
import { extractFinalText, extractTokenUsage } from '../usage.js';
import { detectOutcome } from '../outcome.js';

// Flags that always consume the next token as their value.
const VALUE_FLAGS = new Set([
  '--agent', '--agents', '--allow', '--allowedTools', '--cwd', '--debug-file', '--deny', '--disallowedTools',
  '--disallowed-tools', '--json-schema', '--leader-socket', '-m', '--model', '--max-turns', '--output-format',
  '-p', '--single', '--permission-mode', '--prompt-file', '--prompt-json', '--reasoning-effort', '--effort',
  '--rules', '-s', '--session-id', '--sandbox', '--system-prompt-override', '--system-prompt', '--tools',
  '--worktree-ref', '--ref', '--agent-profile', '--plugin-dir', '--grok-ws-origin', '--grok-ws-url',
  '--cli-chat-proxy-base-url', '--xai-api-base-url',
]);
// Flags with an optional value (clap `num_args = 0..=1`): consume the next token unless it is a flag.
const OPTIONAL_VALUE_FLAGS = new Set(['-r', '--resume', '-w', '--worktree']);

const SUBCOMMANDS = new Set([
  'agent', 'clone', 'completions', 'cursor-worker', 'dashboard', 'doctor', 'du', 'disk-usage', 'export', 'help',
  'inspect', 'leader', 'login', 'logout', 'mcp', 'memory', 'models', 'plugin', 'sessions', 'setup', 'trace',
  'update', 'usage', 'version', 'v', 'worktree', 'wrap',
]);

const PROMPT_FILE_MAX_BYTES = 64 * 1024;

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
    } else if (OPTIONAL_VALUE_FLAGS.has(a)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags.set(a, next);
        i++;
      } else flags.set(a, true);
    } else if (/^-[a-zA-Z]./.test(a) && VALUE_FLAGS.has(a.slice(0, 2))) {
      flags.set(a.slice(0, 2), a.slice(2)); // -mgrok-4 style
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

function promptFromJson(json) {
  try {
    const v = JSON.parse(json);
    const blocks = Array.isArray(v) ? v : v?.content ?? [v];
    const texts = blocks.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : b?.type ? `[${b.type}]` : '')).filter(Boolean);
    return texts.join('\n') || json;
  } catch {
    return json;
  }
}

function promptFromFile(path) {
  try {
    if (statSync(path).size > PROMPT_FILE_MAX_BYTES) {
      return readFileSync(path, 'utf8').slice(0, PROMPT_FILE_MAX_BYTES);
    }
    return readFileSync(path, 'utf8');
  } catch {
    return `(prompt file: ${path})`;
  }
}

/** Cheap read of ~/.grok/config.toml `[models] default` / `default_reasoning_effort`. */
export function readGrokConfigDefaults(env = process.env) {
  const out = { model: null, effort: null };
  if (env.GROK_CONFIG) {
    try {
      const c = JSON.parse(env.GROK_CONFIG);
      out.model = c?.models?.default ?? null;
      out.effort = c?.models?.default_reasoning_effort ?? null;
    } catch {
      /* not JSON — ignore */
    }
  }
  const home = env.GROK_HOME || join(env.HOME || homedir(), '.grok');
  let text;
  try {
    text = readFileSync(join(home, 'config.toml'), 'utf8');
  } catch {
    return out;
  }
  let section = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    const sec = line.match(/^\[+\s*([^\]]+?)\s*\]+$/);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (section !== 'models') continue;
    const kv = line.match(/^([A-Za-z_]+)\s*=\s*"([^"]*)"/);
    if (!kv) continue;
    if (kv[1] === 'default' && !out.model) out.model = kv[2];
    if (kv[1] === 'default_reasoning_effort' && !out.effort) out.effort = kv[2];
  }
  return out;
}

/**
 * Extract card-relevant facts from the grok argv.
 * @returns {{ model: string|null, effort: string|null, prompt: string, headless: boolean, outputFormat: string, subcommand: string|null }}
 */
export function parseGrokArgs(args, { env = process.env } = {}) {
  const { flags, positionals } = scanArgs(args);
  const subcommand = positionals.length && SUBCOMMANDS.has(positionals[0]) ? positionals[0] : null;

  let prompt = flag(flags, '-p', '--single');
  const promptFile = flag(flags, '--prompt-file');
  const promptJson = flag(flags, '--prompt-json');
  if (prompt == null && promptFile) prompt = promptFromFile(promptFile);
  if (prompt == null && promptJson) prompt = promptFromJson(promptJson);
  const headless = prompt != null || flags.has('--output-format') || flags.has('--json-schema') || subcommand != null;
  if (prompt == null && !subcommand && positionals.length) prompt = positionals.join(' ');
  if (prompt == null && subcommand) prompt = `grok ${positionals.join(' ')}`;

  let model = flag(flags, '-m', '--model');
  let effort = flag(flags, '--reasoning-effort', '--effort');
  if (!model || !effort) {
    const defaults = readGrokConfigDefaults(env);
    model = model || defaults.model;
    effort = effort || defaults.effort;
  }
  const outputFormat = flag(flags, '--output-format') || (flags.has('--json-schema') ? 'json' : 'plain');
  return { model: model || null, effort: effort || null, prompt: prompt ?? '', headless, outputFormat, subcommand };
}

export default {
  id: 'grok',
  displayName: 'Grok Build',
  implemented: true,
  binName: 'grok',
  binEnv: 'GROK_BIN',

  findBinary({ env = process.env, selfPaths } = {}) {
    return findRealBinary('grok', { envVar: 'GROK_BIN', env, selfPaths });
  },

  parseArgs(args, opts) {
    return parseGrokArgs(args, opts);
  },

  /** Token usage from structured output (json / streaming-json / streaming-messages-json). */
  extractTokens(stdout) {
    return extractTokenUsage(stdout);
  },

  /**
   * Text to summarise on the close card: final response if structured, else raw stdout.
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

  /** Directory the CLI works in (`--cwd`), else null = the wrapper's cwd. Used for repo / branch / commit. */
  workDir(args) {
    const v = flag(scanArgs(args).flags, '--cwd');
    return v || null;
  },
};
