// Text-only versions of the cards (open.md / close.md) for rooms that don't take images.
// Same facts as the PNGs plus repo / branch / commit; inputs are already masked by contract.js,
// and repo / branch / commit text is masked here.
import { maskSecrets } from '../mask.js';
import { formatDuration, formatTokens, STATUS_LABEL, truncate } from './contract.js';

export const MD_PROMPT_MAX_CHARS = 200;
export const MD_OUTPUT_MAX_LINES = 8;
export const MD_OUTPUT_MAX_CHARS = 900;
const MD_LINE_MAX_CHARS = 160;

export const STATUS_ICON = { running: '▶️', pass: '✅', fail: '❌', timeout: '⏱️', cancelled: '⏹️', blocked: '⛔' };

/** Inline code that survives backticks in the value. */
function code(s) {
  const v = String(s).replace(/\s+/g, ' ').trim();
  if (!v) return v;
  const longest = Math.max(0, ...(v.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return longest ? `${fence} ${v} ${fence}` : `${fence}${v}${fence}`;
}

function fenceBlock(lines) {
  const body = lines.join('\n');
  const longest = Math.max(2, ...(body.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}\n${body}\n${fence}`;
}

/** First lines of the output, compact: at most N lines / M chars, long lines cut. */
export function outputStart(summary, maxLines = MD_OUTPUT_MAX_LINES, maxChars = MD_OUTPUT_MAX_CHARS) {
  const out = [];
  let used = 0;
  const src = (summary ?? []).map((l) => l.replace(/\s+$/, ''));
  for (let i = 0; i < src.length; i++) {
    let l = src[i].length > MD_LINE_MAX_CHARS ? src[i].slice(0, MD_LINE_MAX_CHARS - 1) + '…' : src[i];
    if (out.length >= maxLines || used + l.length > maxChars) {
      if (out.length) out[out.length - 1] = out[out.length - 1].replace(/…?$/, '…');
      else out.push(l.slice(0, Math.max(1, maxChars - 1)) + '…');
      break;
    }
    out.push(l);
    used += l.length + 1;
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

function modelLine(open) {
  return [`Model: ${code(open.model)}`, open.effort ? `Effort: ${open.effort}` : null].filter(Boolean).join(' · ');
}

function repoLine(git, maskOpts) {
  if (!git) return null;
  const parts = [`Repo: ${code(maskSecrets(git.repo, maskOpts))}`];
  parts.push(git.branch ? `Branch: ${code(maskSecrets(git.branch, maskOpts))}` : 'Branch: (detached HEAD)');
  return parts.join(' · ');
}

function promptLine(open) {
  return `Prompt: ${truncate(open.promptFull || open.prompt, MD_PROMPT_MAX_CHARS) || open.prompt}`;
}

/**
 * @param {import('./contract.js').OpenCardFields} open
 * @param {{ git?: {repo:string, branch:string|null}|null }} [ctx]
 */
export function renderOpenMarkdown(open, { git = null } = {}, maskOpts) {
  const lines = [
    `**${open.toolName} · ${STATUS_ICON.running} RUN STARTED**`,
    modelLine(open),
    repoLine(git, maskOpts),
    promptLine(open),
    `Started: ${open.startedAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')}`,
  ];
  return lines.filter(Boolean).join('\n') + '\n';
}

/**
 * @param {import('./contract.js').CloseCardFields} close
 * @param {{ open: import('./contract.js').OpenCardFields, git?: object|null, commit?: {sha:string,subject:string,count:number}|null }} ctx
 */
export function renderCloseMarkdown(close, { open, git = null, commit = null }, maskOpts) {
  const label = STATUS_LABEL[close.status] || 'FAILED';
  const meta = [`exit ${close.exitCode}`, close.signal, formatDuration(close.durationMs)].filter(Boolean).join(' · ');
  const lines = [`**${close.toolName} · ${STATUS_ICON[close.status] || STATUS_ICON.fail} ${label}** · ${meta}`];
  if (close.reason) lines.push(`Why: ${close.reason}`);
  lines.push(modelLine(open), repoLine(git, maskOpts), promptLine(open));
  if (commit) {
    const more = commit.count > 1 ? ` (+${commit.count - 1} more)` : '';
    lines.push(`Commit: ${code(commit.sha)} ${truncate(maskSecrets(commit.subject, maskOpts), 120)}${more}`.trimEnd());
  } else if (git) lines.push('Commit: none');
  const tok = formatTokens(close.tokens);
  if (tok) lines.push(`Tokens: ${tok}`);
  // The PNG leads its output with "[run-cards] <status>: <reason>"; here that's the Why: line.
  const summary = close.reason && close.summary[0]?.startsWith(`[run-cards] ${close.status}:`) ? close.summary.slice(1) : close.summary;
  const out = outputStart(summary);
  lines.push('', 'Output (start):', fenceBlock(out.length ? out : ['(no output)']));
  return lines.filter((l) => l != null).join('\n') + '\n';
}
