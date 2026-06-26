'use strict';
// PDFFleet — HTML/URL to PDF API — render HTML/URL to PDF via headless Chromium
// Spec: /workspace/NEXT-BUILD.md  |  Self-hosted on the VM.

const http = require('http');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '8080', 10);
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(16).toString('hex');

// API keys are stored as a JSON map: { "key": { "tier": "free|pro", "monthlyLimit": N, "label": "..." } }
// On first boot with no keys, an admin key + a demo free key are seeded.
const API_KEYS_PATH = process.env.API_KEYS_PATH || '/data/api_keys.json';

// Rate limit: per-key request count window (simple in-memory counter, resets on restart).
const FREE_RPM = parseInt(process.env.FREE_RPM || '20', 10);   // requests per minute, free tier
const PRO_RPM = parseInt(process.env.PRO_RPM || '300', 10);    // requests per minute, pro tier
const FREE_MONTHLY = parseInt(process.env.FREE_MONTHLY || '50', 10);
const PRO_MONTHLY = parseInt(process.env.PRO_MONTHLY || '50000', 10);

// Max body size for HTML payloads (10 MB) — protects against abuse.
const MAX_BODY = 10 * 1024 * 1024;

// Render timeout (ms) — protects against slow/hanging page renders.
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '30000', 10);

// ---------------------------------------------------------------------------
// Tiny filesystem helpers (no deps; keys persist across restarts)
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

function loadKeys() {
  try {
    if (!fs.existsSync(API_KEYS_PATH)) return {};
    const raw = fs.readFileSync(API_KEYS_PATH, 'utf8');
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function saveKeys(keys) {
  try {
    fs.mkdirSync(path.dirname(API_KEYS_PATH), { recursive: true });
    fs.writeFileSync(API_KEYS_PATH, JSON.stringify(keys, null, 2));
  } catch (e) {
    console.error('[keys] failed to persist:', e.message);
  }
}

function ensureKeys() {
  let keys = loadKeys();
  let dirty = false;
  if (!keys[ADMIN_KEY]) {
    keys[ADMIN_KEY] = { tier: 'admin', monthlyLimit: 0, label: 'admin', created: new Date().toISOString() };
    dirty = true;
    console.log('[keys] seeded ADMIN_KEY (tier=admin)');
  }
  // Seed a public demo free key so the API is testable out of the box.
  const DEMO_KEY = process.env.DEMO_KEY;
  if (DEMO_KEY && !keys[DEMO_KEY]) {
    keys[DEMO_KEY] = { tier: 'free', monthlyLimit: FREE_MONTHLY, label: 'public-demo', created: new Date().toISOString() };
    dirty = true;
    console.log('[keys] seeded DEMO_KEY (tier=free, label=public-demo)');
  }
  if (dirty) saveKeys(keys);
  return keys;
}

let KEYS = ensureKeys();

// ---------------------------------------------------------------------------
// Rate limiter (token-bucket-ish, per minute, per key; in-memory)
// ---------------------------------------------------------------------------
const buckets = new Map(); // key -> { count, windowStart }
function rateCheck(apiKey) {
  const tier = KEYS[apiKey]?.tier || 'free';
  const limit = tier === 'pro' ? PRO_RPM : FREE_RPM;
  const now = Date.now();
  let b = buckets.get(apiKey);
  if (!b || now - b.windowStart > 60_000) {
    b = { count: 0, windowStart: now };
    buckets.set(apiKey, b);
  }
  b.count++;
  const allowed = b.count <= limit;
  return { allowed, limit, remaining: Math.max(0, limit - b.count), reset: Math.ceil((b.windowStart + 60_000 - now) / 1000) };
}

// Monthly usage counter (in-memory; resets on restart — adequate for v1).
const usage = new Map(); // key -> count this month
function bumpUsage(apiKey) {
  usage.set(apiKey, (usage.get(apiKey) || 0) + 1);
}
function overMonthly(apiKey) {
  const k = KEYS[apiKey];
  if (!k) return true;
  if (k.monthlyLimit === 0) return false; // admin / unlimited
  return (usage.get(apiKey) || 0) >= k.monthlyLimit;
}

// ---------------------------------------------------------------------------
// Playwright browser pool (lazy init, reuse for perf)
// ---------------------------------------------------------------------------
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = require('playwright');
    browserPromise = chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    browserPromise.catch(() => { browserPromise = null; });
    console.log('[browser] launching headless chromium');
  }
  return browserPromise;
}

// ---------------------------------------------------------------------------
// Core renderer
// ---------------------------------------------------------------------------
const VALID_PAGE_FORMATS = ['Letter', 'Legal', 'Tabloid', 'Ledger', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

/**
 * Render a page to PDF.
 * @param {object} opts
 * @param {string} [opts.html]      - inline HTML to render
 * @param {string} [opts.url]       - URL to render (mutually exclusive with html)
 * @param {string} [opts.template]  - template name for JSON-merge mode
 * @param {object} [opts.data]      - merge data for template mode
 * @param {object} [opts.options]   - playwright pdf() options (format, margin, printBackground, etc.)
 * @returns {Promise<Buffer>}
 */
async function renderToPDF({ html, url, template, data, options }) {
  if (!html && !url && !template) {
    const e = new Error('Provide one of: html, url, or template');
    e.statusCode = 422;
    throw e;
  }

  // Template mode: load a template from /data/templates/<name>.html and merge {{mustache}}-style tokens.
  if (template) {
    const tplPath = path.join(process.env.TEMPLATES_DIR || '/data/templates', `${template}.html`);
    if (!fs.existsSync(tplPath)) {
      const e = new Error(`template not found: ${template}`);
      e.statusCode = 404;
      throw e;
    }
    let tpl = fs.readFileSync(tplPath, 'utf8');
    if (data && typeof data === 'object') {
      tpl = tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
        const v = k.split('.').reduce((o, key) => (o == null ? undefined : o[key]), data);
        return v == null ? '' : String(v);
      });
    }
    html = tpl;
  }

  // Merge playwright options with safe defaults.
  const pageOptions = {
    format: 'A4',
    printBackground: true,
    margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' },
    ...(options || {}),
  };
  if (pageOptions.format && !VALID_PAGE_FORMATS.includes(pageOptions.format)) {
    const e = new Error(`invalid format: ${pageOptions.format}. valid: ${VALID_PAGE_FORMATS.join(', ')}`);
    e.statusCode = 422;
    throw e;
  }

  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    if (url) {
      await page.goto(url, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT_MS });
    } else {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT_MS });
    }
    // Optional wait selector
    if (pageOptions.waitForSelector) {
      await page.waitForSelector(pageOptions.waitForSelector, { timeout: RENDER_TIMEOUT_MS });
      delete pageOptions.waitForSelector;
    }
    const pdf = await page.pdf(pageOptions);
    return pdf;
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// HTTP server (no framework; minimal, correct)
// ---------------------------------------------------------------------------
function sendJSON(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(body);
}

function sendPDF(res, buffer, filename) {
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': buffer.length,
    'Content-Disposition': filename ? `attachment; filename="${filename}"` : 'attachment; filename="document.pdf"',
  });
  res.end(buffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authenticate(req) {
  const auth = req.headers['authorization'] || '';
  const q = new URL(req.url, 'http://x').searchParams;
  let key = null;
  if (auth.startsWith('Bearer ')) key = auth.slice(7).trim();
  else if (q.get('apikey')) key = q.get('apikey');
  else if (req.headers['x-api-key']) key = req.headers['x-api-key'];
  if (!key || !KEYS[key]) return { ok: false };
  return { ok: true, key, tier: KEYS[key].tier, label: KEYS[key].label };
}

// ---------------------------------------------------------------------------
// Static file server (for landing pages / comparison pages)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'site');

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET') return false;
  // Never intercept /v1/* routes
  if (pathname.startsWith('/v1/') || pathname === '/v1') return false;

  let filePath = path.join(STATIC_DIR, pathname);
  // Security: prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) return false;

  // Serve directory → index.html
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // Try appending .html (clean URLs)
    if (!pathname.endsWith('.html')) {
      try {
        const stat2 = fs.statSync(filePath + '.html');
        if (stat2.isFile()) filePath = filePath + '.html';
        else return false;
      } catch {
        return false;
      }
    } else {
      return false;
    }
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=300' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = u.pathname;

  // ---- CORS (permissive; API is key-authed, not cookie) ----
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ---- Static files (landing pages, comparison pages) ----
  if (serveStatic(req, res, pathname)) return;

  // ---- GET /v1/health (no auth) ----
  if (req.method === 'GET' && pathname === '/v1/health') {
    let browserOk = false;
    try { await getBrowser(); browserOk = true; } catch { /* will report false */ }
    return sendJSON(res, 200, {
      status: browserOk ? 'ok' : 'degraded',
      service: 'pdffleet-api',
      version: require('./package.json').version,
      browser: browserOk ? 'chromium-ready' : 'unavailable',
      timestamp: new Date().toISOString(),
    });
  }

  // ---- GET / (landing/health combo for curl) ----
  if (req.method === 'GET' && (pathname === '/' || pathname === '/v1')) {
    return sendJSON(res, 200, {
      service: 'pdffleet-api',
      version: require('./package.json').version,
      docs: 'POST /v1/pdf with Authorization: Bearer <key> and JSON body { html | url | template, options? }',
      health: '/v1/health',
    });
  }

  // Everything below requires auth
  const auth = authenticate(req);
  if (!auth.ok) return sendJSON(res, 401, { error: 'unauthorized', message: 'Missing or invalid API key. Get one at https://pdffleet.com/#pricing' });

  // ---- POST /v1/pdf — the main render endpoint ----
  if (req.method === 'POST' && pathname === '/v1/pdf') {
    // Rate limit
    const rl = rateCheck(auth.key);
    res.setHeader('X-RateLimit-Limit', rl.limit);
    res.setHeader('X-RateLimit-Remaining', rl.remaining);
    res.setHeader('X-RateLimit-Reset', rl.reset);
    if (!rl.allowed) return sendJSON(res, 429, { error: 'rate_limited', message: `${rl.limit} requests/min on ${auth.tier} tier. Retry in ${rl.reset}s.`, retryAfter: rl.reset });

    // Monthly cap
    if (overMonthly(auth.key)) {
      const used = usage.get(auth.key) || 0;
      const cap = KEYS[auth.key].monthlyLimit;
      return sendJSON(res, 402, { error: 'quota_exceeded', message: `Monthly limit reached (${used}/${cap}). Upgrade at https://pdffleet.com/#pricing` });
    }

    // Parse body
    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw);
    } catch (e) {
      return sendJSON(res, 400, { error: 'bad_request', message: 'Invalid JSON body.' });
    }

    try {
      const pdf = await renderToPDF(payload);
      bumpUsage(auth.key);
      const filename = (payload.filename || 'document').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 60);
      return sendPDF(res, pdf, filename || 'document');
    } catch (e) {
      const status = e.statusCode || 500;
      return sendJSON(res, status, { error: status === 500 ? 'render_failed' : 'invalid_request', message: e.message });
    }
  }

  // ---- GET /v1/usage — current usage for the calling key ----
  if (req.method === 'GET' && pathname === '/v1/usage') {
    return sendJSON(res, 200, {
      key: auth.key.slice(0, 8) + '…',
      tier: auth.tier,
      label: auth.label,
      usedThisPeriod: usage.get(auth.key) || 0,
      monthlyLimit: KEYS[auth.key].monthlyLimit,
      ratePerMinute: auth.tier === 'pro' ? PRO_RPM : FREE_RPM,
    });
  }

  // ---- POST /v1/keys (admin only) — create a new API key ----
  if (req.method === 'POST' && pathname === '/v1/keys' && auth.tier === 'admin') {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const newKey = crypto.randomBytes(20).toString('hex');
      KEYS[newKey] = {
        tier: body.tier === 'pro' ? 'pro' : 'free',
        monthlyLimit: body.tier === 'pro' ? (body.monthlyLimit || PRO_MONTHLY) : FREE_MONTHLY,
        label: (body.label || '').slice(0, 60),
        created: new Date().toISOString(),
      };
      saveKeys(KEYS);
      return sendJSON(res, 201, { key: newKey, ...KEYS[newKey] });
    } catch (e) {
      return sendJSON(res, 400, { error: 'bad_request', message: e.message });
    }
  }

  // ---- GET /v1/keys (admin only) — list keys (masked) ----
  if (req.method === 'GET' && pathname === '/v1/keys' && auth.tier === 'admin') {
    const list = Object.entries(KEYS).map(([k, v]) => ({ key: k.slice(0, 8) + '…' + k.slice(-4), ...v }));
    return sendJSON(res, 200, { count: list.length, keys: list });
  }

  return sendJSON(res, 404, { error: 'not_found', path: pathname });
});

server.listen(PORT, () => {
  console.log(`[pdffleet-api] listening on :${PORT}  (admin key tier present)`);
});

// Graceful shutdown
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    console.log(`[pdffleet-api] ${sig} received, shutting down`);
    server.close();
    if (browserPromise) {
      try { (await browserPromise).close(); } catch {}
    }
    process.exit(0);
  });
}
