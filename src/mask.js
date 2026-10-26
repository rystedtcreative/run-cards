// Secret masking for anything that lands on a card, in the sidecar JSON, or in logs.
// Best-effort and deliberately aggressive: a false positive costs a few characters
// on a card; a false negative leaks a credential into a PNG.

export const MASK = '[REDACTED]';

/** Keep a short prefix so humans can tell which kind of key was masked. */
function keepPrefix(match, prefixLen) {
  return match.slice(0, prefixLen) + '…' + MASK;
}

// Order matters: specific token formats first, generic heuristics last.
const PATTERNS = [
  // PEM private key blocks (multi-line)
  { re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, replace: () => '[REDACTED PRIVATE KEY]' },
  // Anthropic / OpenAI / xAI style keys
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, replace: (m) => keepPrefix(m, 7) },
  { re: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, replace: (m) => keepPrefix(m, 3) },
  { re: /\bxai-[A-Za-z0-9_-]{16,}/g, replace: (m) => keepPrefix(m, 4) },
  // GitHub tokens
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: (m) => keepPrefix(m, 4) },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: (m) => keepPrefix(m, 11) },
  // GitLab, Slack, Stripe, Google, AWS, npm, HF
  { re: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: (m) => keepPrefix(m, 6) },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: (m) => keepPrefix(m, 5) },
  { re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: (m) => keepPrefix(m, 8) },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, replace: (m) => keepPrefix(m, 4) },
  { re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: (m) => keepPrefix(m, 4) },
  { re: /\bnpm_[A-Za-z0-9]{30,}/g, replace: (m) => keepPrefix(m, 4) },
  { re: /\bhf_[A-Za-z0-9]{30,}/g, replace: (m) => keepPrefix(m, 3) },
  // JWTs
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replace: () => '[REDACTED JWT]' },
  // Authorization headers
  { re: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: (_m, kind) => `${kind} ${MASK}` },
  // URLs with embedded credentials: scheme://user:pass@host
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, replace: (_m, scheme, user) => `${scheme}${user}:${MASK}@` },
  // key=value / key: value / "key": "value" where the key name smells secret
  {
    re: /((?:["']?)[A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|credential|private[_-]?key|access[_-]?key|authorization|auth[_-]?token)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)([^\s"',;}{]{6,})\2/gi,
    // Keep numeric values (token counts) and already-handled `Bearer [REDACTED]` headers.
    replace: (m, lhs, q, val) => (/^(\d+|Bearer|Basic|Token|\[REDACTED.*)$/i.test(val) ? m : `${lhs}${q}${MASK}${q}`),
  },
  // Long high-entropy blobs (mixed case + digits, 32+ chars). Skips pure hex (git SHAs).
  {
    re: /\b[A-Za-z0-9+_-]{32,}={0,2}/g,
    replace: (m) => (looksHighEntropy(m) ? MASK : m),
  },
];

function looksHighEntropy(s) {
  if (/^[0-9a-f]+$/i.test(s)) return false; // hashes/SHAs are fine to show
  if (/^[a-z_/-]+$/i.test(s)) return false; // long identifiers / paths
  const count = (re) => (s.match(re) || []).length;
  // Random keys mix all three classes; identifiers rarely carry 4+ digits and 4+ capitals.
  return count(/[A-Z]/g) >= 4 && count(/[a-z]/g) >= 4 && count(/[0-9]/g) >= 4;
}

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

/** Collect values of secret-looking env vars so they can be masked verbatim. */
export function secretEnvValues(env = process.env) {
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < 8) continue;
    if (SECRET_ENV_NAME.test(k)) out.push(v);
  }
  // Longest first so overlapping values mask fully.
  return out.sort((a, b) => b.length - a.length);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Mask secrets in text.
 * @param {string} text
 * @param {{ extraSecrets?: string[], env?: object }} [opts]
 *   extraSecrets: literal values to always mask; env: env to harvest secret values from
 *   (defaults to process.env; pass {} to disable).
 */
export function maskSecrets(text, opts = {}) {
  if (text == null) return text;
  let out = String(text);
  const literals = [...(opts.extraSecrets || []), ...secretEnvValues(opts.env ?? process.env)];
  for (const lit of literals) {
    if (lit && lit.length >= 6) out = out.replace(new RegExp(escapeRe(lit), 'g'), MASK);
  }
  for (const { re, replace } of PATTERNS) out = out.replace(re, replace);
  return out;
}

/** Deep-mask every string inside a JSON-able value. */
export function maskDeep(value, opts) {
  if (typeof value === 'string') return maskSecrets(value, opts);
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, opts);
    return out;
  }
  return value;
}
