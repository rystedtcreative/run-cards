// Detect runs that exited 0 without really finishing: a cancelled turn, a permission/approval
// the headless CLI couldn't grant, or a max-turns stop. Shared by the Grok and Claude adapters
// (their structured output shapes are compatible; see src/usage.js).
//
// Example: Grok Build in headless mode without --always-approve hits a tool that needs
// approval, cancels the turn (stopReason "cancelled") and still exits 0. That must not be a pass.
import { parseJsonObjects } from './usage.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Turn-level stop reasons that mean the run was cut short. */
const CANCEL_STOPS = new Set(['cancelled', 'canceled', 'aborted', 'interrupted', 'user_cancelled']);
const MAX_TURN_STOPS = new Set(['max_turn_requests', 'max_turns', 'max_turns_reached', 'error_max_turns']);
const REFUSAL_STOPS = new Set(['refusal']);

/** Tools that change files. Grok: search_replace / write (+ ACP kinds edit/delete/move); Claude: Edit / Write / MultiEdit / NotebookEdit. */
export const EDIT_TOOLS = new Set([
  'search_replace', 'write', 'edit_file', 'write_file', 'apply_patch', 'str_replace_based_edit_tool',
  'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
]);
const EDIT_KINDS = new Set(['edit', 'delete', 'move']);

export const isEditTool = (name) => typeof name === 'string' && (EDIT_TOOLS.has(name) || EDIT_TOOLS.has(name.toLowerCase()));

/**
 * Messages a CLI uses when a tool needed approval it couldn't get. Deliberately does not match
 * the bare POSIX "Permission denied" (EACCES), which shows up in ordinary shell output.
 */
export const PERMISSION_RE =
  /cancelled the execution for tool|requested permissions? to |haven'?t granted it|permission (?:to use \S+ )?(?:was |has been )?(?:denied|rejected) by|tool (?:use|call|execution) (?:was )?(?:denied|rejected|cancelled|canceled)|denied by (?:the )?(?:user|permission|policy)|(?:needs|requires?) (?:user )?approval|approval (?:is )?(?:required|unavailable)|permission (?:request|prompt) (?:was )?(?:cancelled|canceled|denied)/i;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textOf).join('\n');
  if (isObj(content)) {
    if (typeof content.text === 'string') return content.text;
    if (content.content !== undefined) return textOf(content.content);
  }
  return '';
}

/**
 * Raw facts from a run's captured output.
 * @returns {{ stopReason: string|null, maxTurns: boolean, permissionMessages: string[], denials: string[],
 *   stderrPermission: boolean, edits: number|null, toolCalls: number|null }}
 *   edits/toolCalls are null when the output format doesn't show tool calls (plain text, single json object).
 */
export function scanOutcome(stdout = '', stderr = '') {
  const objs = parseJsonObjects(stdout);
  let stopReason = null;
  let maxTurns = false;
  const permissionMessages = [];
  const denials = [];

  // Tool-call bookkeeping. Grok streaming-json: tool_call / tool_call_update; Messages / Claude
  // stream-json: assistant tool_use blocks + user tool_result blocks.
  const calls = new Map(); // id → { edit }
  let sawStream = false;
  let edits = 0;
  const done = new Set();
  const succeed = (id) => {
    if (done.has(id)) return;
    done.add(id);
    if (calls.get(id)?.edit) edits++;
  };

  for (const o of objs) {
    const type = typeof o.type === 'string' ? o.type : null;
    if (type && ['text', 'thought', 'tool_call', 'tool_call_update', 'usage', 'assistant', 'user', 'system', 'stream_event', 'plan'].includes(type)) sawStream = true;

    // Turn-level stop reason: grok json (no type) / streaming `end` / messages+claude `result`.
    if (!type || type === 'end' || type === 'result') {
      const sr = typeof o.stopReason === 'string' ? o.stopReason : typeof o.stop_reason === 'string' ? o.stop_reason : null;
      if (sr) stopReason = sr;
      if (typeof o.subtype === 'string' && MAX_TURN_STOPS.has(o.subtype)) maxTurns = true;
      if (Array.isArray(o.permission_denials)) {
        for (const d of o.permission_denials) denials.push(isObj(d) ? String(d.tool_name ?? d.toolName ?? '?') : String(d));
      }
    }
    if (type === 'max_turns_reached') maxTurns = true;

    if (type === 'tool_call' && typeof o.toolCallId === 'string') {
      calls.set(o.toolCallId, { edit: EDIT_KINDS.has(o.kind) || isEditTool(o.toolName) });
      if (o.status === 'completed') succeed(o.toolCallId);
    }
    if (type === 'tool_call_update' && typeof o.toolCallId === 'string') {
      if (o.status === 'completed') succeed(o.toolCallId);
      if (o.status === 'failed') {
        const t = textOf(o.content) || textOf(o.rawOutput);
        if (PERMISSION_RE.test(t)) permissionMessages.push(t.trim().split('\n')[0]);
      }
    }
    if ((type === 'assistant' || type === 'user') && isObj(o.message) && Array.isArray(o.message.content)) {
      for (const b of o.message.content) {
        if (!isObj(b)) continue;
        if (b.type === 'tool_use' && typeof b.id === 'string') calls.set(b.id, { edit: isEditTool(b.name) });
        if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
          const t = textOf(b.content);
          if (b.is_error) {
            if (PERMISSION_RE.test(t)) permissionMessages.push(t.trim().split('\n')[0]);
          } else succeed(b.tool_use_id);
        }
      }
    }
  }

  const stderrPermission = PERMISSION_RE.test(stderr || '');
  return {
    stopReason,
    maxTurns: maxTurns || (stopReason != null && MAX_TURN_STOPS.has(stopReason)),
    permissionMessages,
    denials,
    stderrPermission,
    edits: sawStream ? edits : null,
    toolCalls: sawStream ? calls.size : null,
  };
}

/**
 * Classify a run that exited 0. Returns `{ status, reason, ... }` where status is
 * 'blocked' | 'cancelled' | null (null = a real pass, leave it alone).
 *
 * - blocked:   a tool approval was denied/cancelled and no file edit got through
 *              (or the turn was cancelled because of it).
 * - cancelled: the turn stop reason says cancelled, or it stopped at the max-turns limit.
 */
export function classifyOutcome(scan) {
  const s = scan || {};
  const edits = s.edits ?? null;
  const cancelledStop = s.stopReason != null && CANCEL_STOPS.has(s.stopReason);
  const permission = (s.permissionMessages?.length ?? 0) > 0 || (s.denials?.length ?? 0) > 0 || s.stderrPermission;
  const editDenied = (s.denials ?? []).some(isEditTool);
  const noEdits = edits === 0 ? 'no file edits' : null;
  const facts = { stopReason: s.stopReason ?? null, edits, permissionDenials: (s.denials?.length ?? 0) + (s.permissionMessages?.length ?? 0) };

  if (permission && (cancelledStop || edits === 0 || (edits === null && (editDenied || s.stderrPermission)))) {
    const what = s.denials?.length ? `permission denied for ${[...new Set(s.denials)].join(', ')}` : 'a tool needed approval the headless run could not give';
    return { status: 'blocked', reason: [what, noEdits].filter(Boolean).join(' — '), ...facts };
  }
  if (cancelledStop) {
    return { status: 'cancelled', reason: [`stop reason "${s.stopReason}" (headless runs cancel when a tool needs approval)`, noEdits].filter(Boolean).join(' — '), ...facts };
  }
  if (s.maxTurns) {
    return { status: 'cancelled', reason: ['stopped at the max-turns limit', noEdits].filter(Boolean).join(' — '), ...facts };
  }
  if (s.stopReason != null && REFUSAL_STOPS.has(s.stopReason)) {
    return { status: 'blocked', reason: ['the model refused', noEdits].filter(Boolean).join(' — '), ...facts };
  }
  return { status: null, reason: null, ...facts };
}

/** scan + classify in one go (what the adapters expose). */
export function detectOutcome(stdout, stderr) {
  return classifyOutcome(scanOutcome(stdout, stderr));
}
