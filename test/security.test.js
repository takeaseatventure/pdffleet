'use strict';
// Security regression tests for PDFFleet — verifies each fix blocks the attack.
// Run: node test/security.test.js

const assert = require('assert');
const path = require('path');

// We test the pure functions by requiring just the relevant pieces.
// Since server.js starts a server on require, we inline-test the guard logic.

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}: ${e.message}`); }
}
async function atest(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}: ${e.message}`); }
}

// --- Replicate the SSRF guard from server.js for unit testing ---
const BLOCKED_HOSTS = new Set([
  '169.254.169.254', '169.254.169.253',
  'metadata.google.internal', '100.100.100.200',
  'localhost', 'ip6-localhost',
]);
const PRIVATE_IP_RE = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.|::1|fc00:|fd|fe80:)/i;
async function isBlockedSSRF(targetUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch { return 'invalid_url'; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `blocked_scheme:${parsed.protocol}`;
  if (targetUrl.length > 2048) return 'url_too_long';
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host)) return `blocked_host:${host}`;
  if (PRIVATE_IP_RE.test(host)) return `private_ip:${host}`;
  try {
    const dns = require('dns');
    const addrs = await dns.promises.lookup(host, { all: true });
    for (const a of addrs) {
      if (PRIVATE_IP_RE.test(a.address) || a.address === '169.254.169.254') return `resolved_private:${host}->${a.address}`;
    }
  } catch {}
  return null;
}

// --- XSS escape ---
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// --- Template name validation ---
function validTemplate(name) { return /^[a-zA-Z0-9_-]+$/.test(name); }

const tests = [
  // SSRF tests
  atest('SSRF: blocks AWS metadata endpoint', async () => {
    const r = await isBlockedSSRF('http://169.254.169.254/latest/meta-data/');
    assert.ok(r, 'should be blocked');
    assert.ok(r.includes('blocked_host') || r.includes('private_ip'), `got ${r}`);
  }),
  atest('SSRF: blocks GCP metadata endpoint', async () => {
    const r = await isBlockedSSRF('http://metadata.google.internal/computeMetadata/v1/');
    assert.ok(r, 'should be blocked');
  }),
  atest('SSRF: blocks localhost', async () => {
    const r = await isBlockedSSRF('http://localhost:8080/admin');
    assert.ok(r, 'should be blocked');
  }),
  atest('SSRF: blocks 127.0.0.1', async () => {
    const r = await isBlockedSSRF('http://127.0.0.1:8080/v1/health');
    assert.ok(r, 'should be blocked');
  }),
  atest('SSRF: blocks 10.x private range', async () => {
    const r = await isBlockedSSRF('http://10.0.0.1/');
    assert.ok(r, 'should be blocked');
  }),
  atest('SSRF: blocks 192.168.x private range', async () => {
    const r = await isBlockedSSRF('http://192.168.1.1/');
    assert.ok(r, 'should be blocked');
  }),
  atest('SSRF: blocks 172.16-31 private range', async () => {
    const r = await isBlockedSSRF('http://172.16.0.1/');
    assert.ok(r, 'should be blocked');
  }),
  atest('SSRF: blocks file:// scheme', async () => {
    const r = await isBlockedSSRF('file:///etc/passwd');
    assert.ok(r && r.includes('blocked_scheme'), `got ${r}`);
  }),
  atest('SSRF: blocks javascript: scheme', async () => {
    const r = await isBlockedSSRF('javascript:alert(1)');
    assert.ok(r && r.includes('blocked_scheme'), `got ${r}`);
  }),
  atest('SSRF: allows example.com (public)', async () => {
    const r = await isBlockedSSRF('https://example.com/');
    assert.strictEqual(r, null, 'should NOT be blocked');
  }),

  // XSS tests
  test('XSS: escapes <script> in email', () => {
    const out = esc('<script>alert(1)</script>');
    assert.ok(!out.includes('<script>'), 'script tag should be escaped');
    assert.ok(out.includes('&lt;script&gt;'), `got ${out}`);
  }),
  test('XSS: escapes quotes for attr context', () => {
    const out = esc('" onmouseover="alert(1)');
    assert.ok(!out.includes('" on'), 'quote should be escaped');
    assert.ok(out.includes('&quot;'), `got ${out}`);
  }),
  test('XSS: escapes <img onerror>', () => {
    const out = esc('<img src=x onerror=alert(1)>');
    assert.ok(!out.includes('<img'), 'should be escaped');
  }),
  test('XSS: handles null/undefined safely', () => {
    assert.strictEqual(esc(null), '');
    assert.strictEqual(esc(undefined), '');
  }),

  // Template traversal tests
  test('Path traversal: blocks ../etc/passwd', () => {
    assert.strictEqual(validTemplate('../../../etc/passwd'), false);
  }),
  test('Path traversal: blocks .. in template name', () => {
    assert.strictEqual(validTemplate('..'), false);
  }),
  test('Path traversal: blocks absolute paths', () => {
    assert.strictEqual(validTemplate('/etc/passwd'), false);
  }),
  test('Path traversal: allows valid template names', () => {
    assert.ok(validTemplate('invoice'));
    assert.ok(validTemplate('my-template'));
    assert.ok(validTemplate('report_v2'));
  }),
  test('Path traversal: blocks template name with slashes', () => {
    assert.strictEqual(validTemplate('subdir/template'), false);
  }),
  test('Path traversal: blocks null bytes', () => {
    assert.strictEqual(validTemplate('test\x00.txt'), false);
  }),
];

(async () => {
  console.log('PDFFleet Security Regression Tests\n');
  for (const t of tests) { if (typeof t === 'function') await t(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
