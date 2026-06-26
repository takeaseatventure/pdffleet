'use strict';
// Core test suite for takeaseat PDF API.
// Spins up the server on a random port and exercises the real HTTP endpoints.
// Run: node test/run.js  (requires the server to launch headless Chromium)

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 18099 + Math.floor(Math.random() * 100);
const ADMIN_KEY = 'test_admin_' + Math.random().toString(36).slice(2);
const DEMO_KEY = 'test_demo_' + Math.random().toString(36).slice(2);

const TMP_DATA = path.join(__dirname, '.tmp-data-' + PORT);
fs.mkdirSync(TMP_DATA, { recursive: true });

let serverProc;
let pass = 0, fail = 0;
const results = [];

function assert(name, cond, detail) {
  if (cond) { pass++; results.push(`  ✓ ${name}`); }
  else { fail++; results.push(`  ✗ ${name}  ${detail || ''}`); }
}

function request(method, pathStr, { body, headers = {}, key } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: '127.0.0.1', port: PORT, path: pathStr, method,
      headers: { ...headers },
    };
    if (data) opts.headers['Content-Type'] = 'application/json';
    if (key) opts.headers['Authorization'] = `Bearer ${key}`;
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await request('GET', '/v1/health');
      if (r.status === 200) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

async function main() {
  // Launch server
  serverProc = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), ADMIN_KEY, DEMO_KEY, API_KEYS_PATH: path.join(TMP_DATA, 'keys.json'), TEMPLATES_DIR: path.join(TMP_DATA, 'templates') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const ready = await waitForHealth();
  assert('server boots and /v1/health returns 200', ready, 'health endpoint never returned 200');

  // ---- 1. Auth enforcement ----
  const noKey = await request('POST', '/v1/pdf', { body: { html: '<h1>hi</h1>' } });
  assert('POST /v1/pdf without key → 401', noKey.status === 401, `got ${noKey.status}`);

  const badKey = await request('POST', '/v1/pdf', { body: { html: '<h1>hi</h1>' }, key: 'wrong' });
  assert('POST /v1/pdf with wrong key → 401', badKey.status === 401, `got ${badKey.status}`);

  const demoUsage = await request('GET', '/v1/usage', { key: DEMO_KEY });
  assert('GET /v1/usage with valid demo key → 200', demoUsage.status === 200, `got ${demoUsage.status}`);
  assert('usage reports free tier', JSON.parse(demoUsage.body.toString()).tier === 'free', demoUsage.body.toString());

  // ---- 2. Render: HTML → PDF succeeds ----
  const r1 = await request('POST', '/v1/pdf', {
    body: { html: '<html><body><h1>Hello takeaseat</h1><p>Invoice #12345</p></body></html>', options: { format: 'A4' } },
    key: DEMO_KEY,
  });
  assert('POST /v1/pdf html → 200', r1.status === 200, `got ${r1.status}: ${r1.body.toString().slice(0,200)}`);
  assert('response content-type is application/pdf', r1.headers['content-type'] === 'application/pdf', r1.headers['content-type']);
  assert('PDF body starts with %PDF magic', r1.body.slice(0, 4).toString() === '%PDF', r1.body.slice(0, 4).toString());
  assert('PDF body > 1000 bytes', r1.body.length > 1000, `got ${r1.body.length} bytes`);

  // ---- 3. Options applied: A4 vs Letter should differ in size ----
  const a4 = await request('POST', '/v1/pdf', { body: { html: '<p>x</p>', options: { format: 'A4' } }, key: DEMO_KEY });
  const letter = await request('POST', '/v1/pdf', { body: { html: '<p>x</p>', options: { format: 'Letter' } }, key: DEMO_KEY });
  assert('A4 render succeeds', a4.status === 200);
  assert('Letter render succeeds', letter.status === 200);
  assert('page sizes differ (A4 vs Letter)', a4.body.length !== letter.body.length, `both ${a4.body.length}`);

  // ---- 4. Options: printBackground=false omits bg colors ----
  const bgHtml = '<html><body style="background:red;color:white">BG</body></html>';
  const withBg = await request('POST', '/v1/pdf', { body: { html: bgHtml, options: { printBackground: true } }, key: DEMO_KEY });
  const noBg = await request('POST', '/v1/pdf', { body: { html: bgHtml, options: { printBackground: false } }, key: DEMO_KEY });
  assert('printBackground=true succeeds', withBg.status === 200);
  assert('printBackground=false succeeds', noBg.status === 200);
  assert('printBackground changes output', withBg.body.length !== noBg.body.length);

  // ---- 5. Render from URL ----
  const urlR = await request('POST', '/v1/pdf', { body: { url: 'https://example.com', options: { format: 'A4' } }, key: DEMO_KEY });
  assert('POST /v1/pdf url=example.com → 200', urlR.status === 200, `got ${urlR.status}`);

  // ---- 6. Template + data merge ----
  fs.mkdirSync(path.join(TMP_DATA, 'templates'), { recursive: true });
  fs.writeFileSync(path.join(TMP_DATA, 'templates', 'invoice.html'), '<html><body><h1>{{title}}</h1><p>Amount: ${{amount}}</p></body></html>');
  const tplR = await request('POST', '/v1/pdf', { body: { template: 'invoice', data: { title: 'Invoice 99', amount: 42.5 } }, key: DEMO_KEY });
  assert('POST /v1/pdf template=invoice → 200', tplR.status === 200, `got ${tplR.status}`);

  // ---- 7. Invalid format rejected ----
  const badFmt = await request('POST', '/v1/pdf', { body: { html: '<p>x</p>', options: { format: 'BANANA' } }, key: DEMO_KEY });
  assert('invalid format → 4xx', badFmt.status >= 400 && badFmt.status < 500, `got ${badFmt.status}`);

  // ---- 8. Missing payload rejected ----
  const emptyBody = await request('POST', '/v1/pdf', { body: {}, key: DEMO_KEY });
  assert('empty body (no html/url/template) → 4xx', emptyBody.status >= 400 && emptyBody.status < 500, `got ${emptyBody.status}`);

  // ---- 9. Admin key creation ----
  const adminCreate = await request('POST', '/v1/keys', { body: { tier: 'pro', label: 'test-pro-customer' }, key: ADMIN_KEY });
  assert('admin POST /v1/keys → 201', adminCreate.status === 201, `got ${adminCreate.status}: ${adminCreate.body.toString()}`);
  const newKeyObj = JSON.parse(adminCreate.body.toString());
  assert('new key has pro tier', newKeyObj.tier === 'pro');
  const newKeyList = await request('GET', '/v1/keys', { key: ADMIN_KEY });
  assert('admin GET /v1/keys → 200', newKeyList.status === 200);

  // Non-admin cannot create keys
  const demoCreate = await request('POST', '/v1/keys', { body: { tier: 'pro' }, key: DEMO_KEY });
  assert('non-admin POST /v1/keys → 403/404', demoCreate.status === 403 || demoCreate.status === 404, `got ${demoCreate.status}`);

  // ---- 10. Rate limit (force-hit with tiny loop) ----
  // Free tier is 20/min in config; we send 25 rapid requests and expect at least one 429.
  if (process.env.SKIP_RATE_TEST !== '1') {
    let rateLimited = 0;
    for (let i = 0; i < 25; i++) {
      const r = await request('POST', '/v1/pdf', { body: { html: `<p>${i}</p>` }, key: DEMO_KEY });
      if (r.status === 429) rateLimited++;
    }
    assert('rate limit triggers (429 seen)', rateLimited > 0, `got ${rateLimited} 429s out of 25`);
  } else {
    results.push('  ⊘ rate limit test skipped (SKIP_RATE_TEST=1)');
  }

  // ---- Report ----
  console.log('\n' + results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed\n`);

  serverProc.kill('SIGTERM');
  await sleep(300);
  try { fs.rmSync(TMP_DATA, { recursive: true, force: true }); } catch {}
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('TEST HARNESS ERROR:', e);
  if (serverProc) serverProc.kill('SIGTERM');
  process.exit(2);
});
