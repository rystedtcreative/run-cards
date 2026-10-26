import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTokenUsage, extractFinalText, normaliseUsage, parseJsonObjects } from '../src/usage.js';

const grokJson = JSON.stringify({
  text: "Here's a summary",
  stopReason: 'end_turn',
  usage: { input_tokens: 7210, cache_read_input_tokens: 41000, cache_creation_input_tokens: 0, output_tokens: 1893, reasoning_tokens: 412, total_tokens: 50103 },
});

test('grok --output-format json: usage + text', () => {
  assert.deepEqual(extractTokenUsage(grokJson), { input: 48210, output: 1893, total: 50103 });
  assert.equal(extractFinalText(grokJson), "Here's a summary");
});

test('grok streaming-json: end line wins; text chunks joined', () => {
  const nd = [
    { type: 'thought', data: 'hmm' },
    { type: 'text', data: 'Hello ' },
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
    { type: 'text', data: 'world' },
    { type: 'end', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } },
  ].map((o) => JSON.stringify(o)).join('\n');
  assert.deepEqual(extractTokenUsage(nd), { input: 20, output: 8, total: 28 });
  assert.equal(extractFinalText(nd), 'Hello world');
});

test('streaming-json without end: per-response usage lines summed', () => {
  const nd = [
    { type: 'usage', usage: { input_tokens: 10, output_tokens: 5 } },
    { type: 'usage', usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((o) => JSON.stringify(o)).join('\n');
  assert.deepEqual(extractTokenUsage(nd), { input: 11, output: 6, total: 17 });
});

test('messages stream: result line text + usage', () => {
  const nd = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }], usage: { input_tokens: 3, output_tokens: 4 } } },
    { type: 'result', result: 'final answer', usage: { input_tokens: 30, output_tokens: 40 } },
  ].map((o) => JSON.stringify(o)).join('\n');
  assert.deepEqual(extractTokenUsage(nd), { input: 30, output: 40, total: 70 });
  assert.equal(extractFinalText(nd), 'final answer');
});

test('error objects surface their message', () => {
  assert.equal(extractFinalText('{"type":"error","message":"Couldn\'t start session"}'), "error: Couldn't start session");
});

test('plain text → null (caller uses raw output)', () => {
  assert.equal(extractTokenUsage('just text\nmore'), null);
  assert.equal(extractFinalText('just text'), null);
  assert.deepEqual(parseJsonObjects(''), []);
  assert.deepEqual(parseJsonObjects('{broken'), []);
});

test('normaliseUsage handles camelCase and OpenAI shapes', () => {
  assert.deepEqual(normaliseUsage({ inputTokens: 1, outputTokens: 2 }), { input: 1, output: 2, total: 3 });
  assert.deepEqual(normaliseUsage({ prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 }), { input: 5, output: 6, total: 11 });
  assert.equal(normaliseUsage({}), null);
  assert.equal(normaliseUsage(null), null);
});
