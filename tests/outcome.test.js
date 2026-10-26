// Exit-0 runs that didn't finish: cancelled stop reason, permission / approval denials, max turns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome, detectOutcome, scanOutcome, PERMISSION_RE } from '../src/outcome.js';
import grok from '../src/adapters/grok.js';
import claude from '../src/adapters/claude.js';

const nd = (...objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

test('grok json, stopReason "cancelled" (the 2026-10-09 headless incident) → cancelled', () => {
  const out = JSON.stringify({ text: "I'll start by reading the project conventions.", stopReason: 'cancelled', num_turns: 4, usage: { input_tokens: 1, output_tokens: 1 } });
  const o = grok.detectOutcome(out, '');
  assert.equal(o.status, 'cancelled');
  assert.equal(o.stopReason, 'cancelled');
  assert.equal(o.edits, null, 'single json object: edits not countable');
  assert.match(o.reason, /stop reason "cancelled"/);
});

test('grok streaming-json: approval cancelled for a tool, no edits → blocked, with "no file edits"', () => {
  const out = nd(
    { type: 'tool_call', toolCallId: 'a', kind: 'read', toolName: 'read_file', status: 'in_progress' },
    { type: 'tool_call_update', toolCallId: 'a', status: 'completed' },
    { type: 'tool_call', toolCallId: 'b', kind: 'execute', toolName: 'run_terminal_command', status: 'in_progress' },
    { type: 'tool_call_update', toolCallId: 'b', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'User cancelled the execution for tool `run_terminal_command`' } }] },
    { type: 'end', stopReason: 'cancelled' },
  );
  const scan = scanOutcome(out, '');
  assert.equal(scan.edits, 0);
  assert.equal(scan.toolCalls, 2);
  assert.equal(scan.permissionMessages.length, 1);
  const o = classifyOutcome(scan);
  assert.equal(o.status, 'blocked');
  assert.match(o.reason, /approval.*no file edits/);
});

test('grok streaming-json: completed edit + end_turn → real pass (null status), edits counted', () => {
  const out = nd(
    { type: 'tool_call', toolCallId: 'e', kind: 'edit', toolName: 'search_replace', status: 'in_progress' },
    { type: 'tool_call_update', toolCallId: 'e', status: 'completed' },
    { type: 'tool_call', toolCallId: 'w', kind: 'other', toolName: 'write', status: 'in_progress' },
    { type: 'tool_call_update', toolCallId: 'w', status: 'completed' },
    { type: 'tool_call_update', toolCallId: 'w', status: 'completed' },
    { type: 'end', stopReason: 'end_turn' },
  );
  const o = detectOutcome(out, '');
  assert.equal(o.status, null);
  assert.equal(o.edits, 2, 'counted once per tool call');
});

test('streaming run with zero edits but a normal end_turn stays a pass (read-only prompts are legit)', () => {
  const o = detectOutcome(nd({ type: 'text', data: 'The code looks fine.' }, { type: 'end', stopReason: 'end_turn' }), '');
  assert.equal(o.status, null);
  assert.equal(o.edits, 0);
});

test('a denied tool that did not stop edits from landing stays a pass', () => {
  const out = nd(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Bash' }, { type: 'tool_use', id: 'e', name: 'Edit' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: "Claude requested permissions to use Bash, but you haven't granted it yet." }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e', is_error: false, content: 'ok' }] } },
    { type: 'result', subtype: 'success', result: 'done', stop_reason: 'end_turn' },
  );
  const o = claude.detectOutcome(out, '');
  assert.equal(o.status, null);
  assert.equal(o.edits, 1);
  assert.equal(o.permissionDenials, 1);
});

test('claude json: permission_denials on an edit tool → blocked', () => {
  const out = JSON.stringify({ type: 'result', subtype: 'success', result: 'Need permission.', permission_denials: [{ tool_name: 'Write', tool_use_id: 't' }] });
  const o = claude.detectOutcome(out, '');
  assert.equal(o.status, 'blocked');
  assert.match(o.reason, /permission denied for Write/);
});

test('claude json: permission_denials only on a non-edit tool, edits unknown → left as pass', () => {
  const out = JSON.stringify({ type: 'result', subtype: 'success', result: 'Done anyway.', permission_denials: [{ tool_name: 'Bash' }] });
  assert.equal(claude.detectOutcome(out, '').status, null);
});

test('claude stream-json: Edit refused for permission, nothing edited → blocked', () => {
  const out = nd(
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: [{ type: 'text', text: "Claude requested permissions to write to /r/a.js, but you haven't granted it yet." }] }] } },
    { type: 'result', subtype: 'success', result: 'Could not edit.', stop_reason: 'end_turn' },
  );
  const o = claude.detectOutcome(out, '');
  assert.equal(o.status, 'blocked');
  assert.equal(o.edits, 0);
});

test('max turns (result subtype / stop reason / event) → cancelled', () => {
  assert.equal(detectOutcome(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }), '').status, 'cancelled');
  assert.equal(detectOutcome(nd({ type: 'end', stopReason: 'max_turn_requests' }), '').status, 'cancelled');
  assert.equal(detectOutcome(nd({ type: 'max_turns_reached' }, { type: 'end', stopReason: 'end_turn' }), '').status, 'cancelled');
});

test('refusal stop reason → blocked', () => {
  assert.equal(detectOutcome(JSON.stringify({ text: 'no', stopReason: 'refusal' }), '').status, 'blocked');
});

test('plain text output: only stderr approval messages count, never the model prose', () => {
  assert.equal(detectOutcome('I fixed it.\n', '').status, null);
  assert.equal(detectOutcome('I fixed it.\n', 'error: tool requires approval in headless mode\n').status, 'blocked');
  // The model talking about permissions in its answer is not evidence.
  assert.equal(detectOutcome('Note: the tool call was denied by the user last week, so I re-ran it.\n', '').status, null);
});

test('PERMISSION_RE ignores the ordinary EACCES "Permission denied"', () => {
  assert.equal(PERMISSION_RE.test('ls: cannot open directory /root: Permission denied'), false);
  assert.equal(PERMISSION_RE.test('User cancelled the execution for tool `write`'), true);
  assert.equal(PERMISSION_RE.test("Claude requested permissions to write to /x, but you haven't granted it yet."), true);
});

test('normal outputs stay passes: grok json end_turn, claude json success, empty output', () => {
  assert.equal(grok.detectOutcome(JSON.stringify({ text: 'ok', stopReason: 'end_turn' }), '').status, null);
  assert.equal(claude.detectOutcome(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', permission_denials: [] }), '').status, null);
  assert.equal(detectOutcome('', '').status, null);
  assert.equal(detectOutcome(undefined, undefined).status, null);
});

test('grok adapter: workDir reads --cwd', () => {
  assert.equal(grok.workDir(['-p', 'x', '--cwd', '/tmp/w']), '/tmp/w');
  assert.equal(grok.workDir(['-p', 'x', '--cwd=rel']), 'rel');
  assert.equal(grok.workDir(['-p', 'x']), null);
});
