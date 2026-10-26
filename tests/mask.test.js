import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maskSecrets, maskDeep, MASK } from '../src/mask.js';

const NOENV = { env: {} };
const m = (s) => maskSecrets(s, NOENV);

test('masks vendor API keys while keeping a short prefix', () => {
  const cases = [
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-proj-AbCdEfGhIjKlMnOpQrStUvWx',
    'xai-AbCdEfGhIjKlMnOpQrStUvWx0123',
    'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghijkl',
    'glpat-abcdefghijklmnop1234',
    'xoxb-1234567890-abcdefghij',
    'sk_live_abcdefghijklmnop1234',
    'AIzaSyA1234567890abcdefghijklmnopqrstu',
    'AKIAIOSFODNN7EXAMPLE',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'hf_abcdefghijklmnopqrstuvwxyz01234567',
  ];
  for (const secret of cases) {
    const out = m(`use ${secret} please`);
    assert.ok(!out.includes(secret), `leaked: ${secret} → ${out}`);
    assert.ok(out.includes(MASK), out);
  }
});

test('masks JWTs, bearer tokens, URL credentials and PEM keys', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.equal(m(`token ${jwt}`).includes(jwt), false);
  assert.match(m('Authorization: Bearer abcdef123456789xyz'), /Bearer \[REDACTED\]/);
  assert.equal(m('git clone https://bob:hunter2pass@github.com/x/y'), `git clone https://bob:${MASK}@github.com/x/y`);
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(m(`key:\n${pem}\nafter`), 'key:\n[REDACTED PRIVATE KEY]\nafter');
});

test('masks key=value style secrets but not numeric token counts', () => {
  assert.equal(m('API_KEY=abc123def456'), `API_KEY=${MASK}`);
  assert.equal(m('"password": "correct horse"').includes('correct'), true); // value stops at space…
  assert.equal(m('"password": "correcthorse"'), `"password": "${MASK}"`);
  assert.equal(m('client_secret: s3cr3tv4lue'), `client_secret: ${MASK}`);
  assert.equal(m('"input_tokens": 7210000'), '"input_tokens": 7210000');
  assert.equal(m('author: Jane Doe'), 'author: Jane Doe');
});

test('leaves ordinary text, git SHAs and paths alone', () => {
  const s = 'commit 46f7bbf0a1b2c3d4e5f60718293a4b5c6d7e8f90 in src/cards/render.js — 48 tests passed';
  assert.equal(m(s), s);
  assert.equal(m('node_modules/some-really-long-package-name/dist/index.js'), 'node_modules/some-really-long-package-name/dist/index.js');
});

test('masks generic high-entropy blobs', () => {
  const blob = 'Zx9QwE7rT2yU5iO8pA3sD6fG1hJ4kL0zX';
  assert.equal(m(`value ${blob}`), `value ${MASK}`);
});

test('masks literal values of secret-named env vars', () => {
  const env = { MY_SERVICE_TOKEN: 'plainwordsecret', HOME: '/home/x', SHORT_KEY: 'abc' };
  assert.equal(maskSecrets('token is plainwordsecret!', { env }), `token is ${MASK}!`);
  assert.equal(maskSecrets('home is /home/x', { env }), 'home is /home/x');
});

test('extraSecrets are always masked', () => {
  assert.equal(maskSecrets('the client is AcmeCorp', { env: {}, extraSecrets: ['AcmeCorp'] }), `the client is ${MASK}`);
});

test('maskDeep walks objects and arrays, leaving non-strings', () => {
  const out = maskDeep({ a: ['xai-AbCdEfGhIjKlMnOpQrStUvWx0123'], n: 5, nested: { b: 'ok' } }, NOENV);
  assert.ok(out.a[0].includes(MASK));
  assert.equal(out.n, 5);
  assert.equal(out.nested.b, 'ok');
});

test('null/undefined pass through', () => {
  assert.equal(maskSecrets(null), null);
  assert.equal(maskSecrets(undefined), undefined);
});
