// Shared parsing of structured CLI output (JSON / NDJSON). Grok's `--output-format json|
// streaming-json|streaming-messages-json` and Claude Code's `--output-format json|stream-json`
// use compatible shapes, so both adapters reuse this.

/** Parse stdout as one JSON value or as NDJSON; returns the list of objects found. */
export function parseJsonObjects(text) {
  if (!text) return [];
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const v = JSON.parse(trimmed);
      return Array.isArray(v) ? v.filter(isObj) : [v];
    } catch {
      /* fall through to NDJSON */
    }
  }
  const out = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try {
      const v = JSON.parse(l);
      if (isObj(v)) out.push(v);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Normalise a usage object (snake_case, camelCase or OpenAI-style) to {input, output, total}. */
export function normaliseUsage(u) {
  if (!isObj(u)) return null;
  const pick = (...keys) => {
    for (const k of keys) if (num(u[k]) != null) return u[k];
    return null;
  };
  const uncached = pick('input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens');
  const cacheRead = pick('cache_read_input_tokens', 'cacheReadInputTokens') ?? 0;
  const cacheWrite = pick('cache_creation_input_tokens', 'cacheCreationInputTokens') ?? 0;
  const output = pick('output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens');
  const input = uncached == null ? null : uncached + cacheRead + cacheWrite;
  let total = pick('total_tokens', 'totalTokens');
  if (total == null && input != null && output != null) total = input + output;
  if (input == null && output == null && total == null) return null;
  return { input, output, total };
}

function sumUsage(list) {
  const acc = { input: null, output: null, total: null };
  for (const u of list) {
    for (const k of ['input', 'output', 'total']) if (u[k] != null) acc[k] = (acc[k] ?? 0) + u[k];
  }
  return acc.input == null && acc.output == null && acc.total == null ? null : acc;
}

/**
 * Extract token usage from structured output, or null when the CLI did not report any.
 * Preference: final summary object (json / `end` / `result`) → sum of per-response
 * `usage` lines → sum of assistant message usages.
 */
export function extractTokenUsage(text) {
  const objs = parseJsonObjects(text);
  if (!objs.length) return null;

  const finals = objs.filter((o) => isObj(o.usage) && (!o.type || o.type === 'end' || o.type === 'result' || o.type === 'error'));
  if (finals.length) {
    const u = normaliseUsage(finals[finals.length - 1].usage);
    if (u) return u;
  }
  const perResponse = objs.filter((o) => o.type === 'usage' && isObj(o.usage)).map((o) => normaliseUsage(o.usage)).filter(Boolean);
  if (perResponse.length) return sumUsage(perResponse);

  const perMessage = objs
    .filter((o) => o.type === 'assistant' && isObj(o.message) && isObj(o.message.usage))
    .map((o) => normaliseUsage(o.message.usage))
    .filter(Boolean);
  if (perMessage.length) return sumUsage(perMessage);
  return null;
}

/**
 * Extract the final human-readable response from structured output, or null if the output
 * is not structured (plain text — use it as-is).
 */
export function extractFinalText(text) {
  const objs = parseJsonObjects(text);
  if (!objs.length) return null;

  const last = objs[objs.length - 1];
  if (typeof last.result === 'string') return last.result; // json / messages `result` line
  if (typeof last.text === 'string' && !last.type) return last.text; // grok json
  const err = [...objs].reverse().find((o) => o.type === 'error' && typeof o.message === 'string');

  const chunks = objs.filter((o) => o.type === 'text' && typeof o.data === 'string').map((o) => o.data);
  if (chunks.length) return chunks.join('') + (err ? `\nerror: ${err.message}` : '');

  const assistant = objs.filter((o) => o.type === 'assistant' && isObj(o.message) && Array.isArray(o.message.content));
  if (assistant.length) {
    const blocks = assistant[assistant.length - 1].message.content.filter((b) => b && b.type === 'text');
    if (blocks.length) return blocks.map((b) => b.text).join('\n');
  }
  if (err) return `error: ${err.message}`;
  return null;
}
