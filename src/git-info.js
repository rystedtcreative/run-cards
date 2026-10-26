// Best-effort git facts for the Markdown cards: repo, branch, and the commit a run made.
// Never throws, never prompts, short timeouts; credentials in remote URLs are dropped.
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

const GIT_TIMEOUT_MS = 3000;

function git(cwd, args, env) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_TIMEOUT_MS,
      env: { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `owner/name` from a remote URL (https, ssh, scp-style), without any user:token@ part.
 * Returns null when the URL doesn't look like a hosted repo.
 */
export function repoNameFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  let path;
  const scp = url.match(/^[^/@\s]+@[^:/\s]+:(.+)$/); // git@github.com:owner/name.git
  if (scp) path = scp[1];
  else {
    try {
      path = new URL(url).pathname;
    } catch {
      path = url;
    }
  }
  const parts = path.replace(/\.git\/?$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  if (!parts.length) return null;
  return parts.slice(-2).join('/');
}

/** @returns {{ repo: string, branch: string|null, head: string|null } | null}  null = not a git work tree */
export function readGitState(cwd, env = process.env) {
  const top = git(cwd, ['rev-parse', '--show-toplevel'], env);
  if (!top) return null;
  const remote = git(cwd, ['config', '--get', 'remote.origin.url'], env);
  const branch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], env) || null;
  const head = git(cwd, ['rev-parse', '-q', '--verify', 'HEAD'], env) || null;
  return { repo: repoNameFromUrl(remote) || basename(top), branch, head };
}

/**
 * What changed between two states: the newest commit (short sha + subject) and how many were
 * added, or null when HEAD didn't move.
 * @returns {{ sha: string, subject: string, count: number } | null}
 */
export function newCommit(cwd, before, after, env = process.env) {
  if (!after?.head || after.head === before?.head) return null;
  const line = git(cwd, ['log', '-1', '--format=%h%x09%s', after.head], env);
  if (!line) return null;
  const tab = line.indexOf('\t');
  const sha = tab < 0 ? line : line.slice(0, tab);
  const subject = tab < 0 ? '' : line.slice(tab + 1);
  let count = 1;
  if (before?.head) {
    const n = Number(git(cwd, ['rev-list', '--count', `${before.head}..${after.head}`], env));
    if (Number.isInteger(n) && n > 0) count = n;
  }
  return { sha, subject, count };
}
