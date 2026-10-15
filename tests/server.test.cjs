'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp, classifyError, retryDelay, parseEnv } = require('../server.js');
const fakeKey = 'sk-test-this-is-an-inert-test-key';
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const success = steps => json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ steps }) }] }] });
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slashtasks-test-'));
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Fixture</title>');
  const server = createApp({ root, env: { OPENAI_API_KEY: fakeKey }, logger: { error() {} }, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, base, request: (route, body, headers = {}) => fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body)
  }) };
}
test('all quota and spend error codes are distinguished from temporary rate limits', () => {
  for (const code of ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded']) {
    const error = classifyError(429, code);
    assert.equal(error.needsSetup, true, code);
    assert.equal(error.retryAfter, undefined, code);
  }
  assert.equal(classifyError(429, 'rate_limit_exceeded', '12').retryAfter, 12);
  assert.equal(classifyError(401, 'invalid_api_key').needsSetup, true);
});
test('Retry-After accepts seconds or a future HTTP date', () => {
  assert.equal(retryDelay('4.5'), 5);
  assert.equal(retryDelay('invalid'), 30);
  assert.equal(retryDelay(new Date(20000).toUTCString(), 10000), 10);
});
test('environment parsing supports persisted quotes and preserves spaces inside values', () => {
  assert.deepEqual(parseEnv('OPENAI_API_KEY="sk-value"\nOPENAI_MODEL=gpt-4o-mini\nOTHER=ignored'), { OPENAI_API_KEY: 'sk-value', OPENAI_MODEL: 'gpt-4o-mini' });
});
test('API status never reveals a key and the saved file is private', async t => {
  const f = await fixture(t);
  const before = await (await fetch(f.base + '/api/status')).text();
  assert(!before.includes(fakeKey));
  const replacement = fakeKey + '-replacement';
  assert.equal((await f.request('/api/settings', { apiKey: replacement })).status, 200);
  const contents = fs.readFileSync(path.join(f.root, '.env'), 'utf8');
  assert(contents.includes(replacement));
  assert.equal(fs.statSync(path.join(f.root, '.env')).mode & 0o777, 0o600);
  assert(!(await (await fetch(f.base + '/api/status')).text()).includes(replacement));
});
test('server serves only public assets; keys, git data, server source, encoded traversal are inaccessible', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.root, '.env'), 'OPENAI_API_KEY=not-public');
  assert.equal((await fetch(f.base)).status, 200);
  for (const file of ['/.env', '/.git/config', '/server.js', '/%2eenv', '/..%2f.env']) {
    assert.equal((await fetch(f.base + file)).status, 404, file);
  }
});
test('settings rejects foreign origins and rebinding hosts', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/settings', { apiKey: fakeKey }, { Origin: 'https://foreign.example' })).status, 403);
  assert.equal((await f.request('/api/settings', { apiKey: fakeKey }, { Origin: 'null' })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const request = http.request(f.base + '/api/settings', { method: 'POST', headers: { Host: 'foreign.example', 'Content-Type': 'application/json' } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end(JSON.stringify({ apiKey: fakeKey }));
  });
  assert.equal(status, 403);
});
test('suggestions need configuration and validate input before contacting AI', async t => {
  let calls = 0;
  const f = await fixture(t, { env: {}, fetchImpl: async () => { calls++; return success([]); } });
  assert.equal((await f.request('/api/suggest-subtasks', { title: 'Task' })).status, 503);
  assert.equal(calls, 0);
});
test('successful suggestions use structured output and remove duplicates/existing steps', async t => {
  let sent;
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    sent = JSON.parse(options.body);
    return success(['Read the notes', 'Open a document', 'open a document', 'Write a title']);
  } });
  const response = await f.request('/api/suggest-subtasks', { title: 'Write update', existingSteps: ['Read the notes'] });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).steps, ['Open a document', 'Write a title']);
  assert.equal(sent.text.format.type, 'json_schema');
  assert.equal(sent.store, false);
  assert(!JSON.stringify(sent).includes(fakeKey));
});
test('quota errors do not retry and expose actionable safe codes', async t => {
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; return json({ error: { code: 'credit_balance_exhausted', message: fakeKey } }, 429); } });
  const response = await f.request('/api/suggest-subtasks', { title: 'Plan' });
  assert.equal(response.status, 429);
  const body = await response.text();
  assert(body.includes('credit_balance_exhausted'));
  assert(!body.includes(fakeKey));
  assert.equal(calls, 1);
});
test('temporary rate limits honor the upstream cooldown without another paid request', async t => {
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; return json({ error: { code: 'rate_limit_exceeded' } }, 429, { 'Retry-After': '60' }); } });
  const first = await f.request('/api/suggest-subtasks', { title: 'Plan' });
  assert.equal((await first.json()).retryAfter, 60);
  await f.request('/api/suggest-subtasks', { title: 'Plan' });
  assert.equal(calls, 1);
});
test('refusals, incomplete output, invalid JSON and network failures remain recoverable', async t => {
  const cases = [
    [async () => json({ status: 'incomplete', output: [] }), 502],
    [async () => json({ output: [{ content: [{ type: 'refusal' }] }] }), 422],
    [async () => json({ output: [{ content: [{ type: 'output_text', text: 'not json' }] }] }), 502],
    [async () => { throw new Error('Network unavailable'); }, 502]
  ];
  for (const [fetchImpl, expected] of cases) {
    const f = await fixture(t, { fetchImpl });
    assert.equal((await f.request('/api/suggest-subtasks', { title: 'Plan' })).status, expected);
  }
});
test('long upstream requests time out and release the in-flight lock', async t => {
  const f = await fixture(t, { timeoutMs: 20, fetchImpl: async (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }) });
  assert.equal((await f.request('/api/suggest-subtasks', { title: 'Plan' })).status, 504);
  assert.equal((await f.request('/api/suggest-subtasks', { title: 'Plan again' })).status, 504);
});
test('unknown 429 errors do not get mislabeled as a temporary rate limit', () => {
  const error = classifyError(429, 'unrecognized_account_limit');
  assert.equal(error.needsSetup, true);
  assert.equal(error.retryAfter, undefined);
});
test('a key saved in Settings survives a new server instance even if the old shell key differs', async t => {
  const f = await fixture(t);
  const replacement = fakeKey + '-saved';
  await f.request('/api/settings', { apiKey: replacement });
  let authorization;
  const other = createApp({ root: f.root, env: { OPENAI_API_KEY: fakeKey }, fetchImpl: async (_url, options) => {
    authorization = options.headers.Authorization; return success(['Start here']);
  } });
  await new Promise(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(async () => { other.closeAllConnections(); await new Promise(resolve => other.close(resolve)); });
  const base = 'http://127.0.0.1:' + other.address().port;
  const response = await fetch(base + '/api/suggest-subtasks', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Plan' }) });
  assert.equal(response.status, 200);
  assert.equal(authorization, 'Bearer ' + replacement);
});
test('invalid task input and malformed JSON do not spend an API call', async t => {
  let calls = 0;
  const f = await fixture(t, { fetchImpl: async () => { calls++; return success([]); } });
  for (const body of [{ title: '' }, { title: 'x'.repeat(121) }, { title: 42 }]) {
    assert.equal((await f.request('/api/suggest-subtasks', body)).status, 400);
  }
  const malformed = await fetch(f.base + '/api/suggest-subtasks', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.base }, body: '{bad' });
  assert.equal(malformed.status, 400);
  assert.equal(calls, 0);
});
