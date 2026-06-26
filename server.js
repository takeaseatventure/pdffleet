'use strict';
// PDFFleet — HTML/URL to PDF API. Accounts via Google/GitHub SSO (Dex), storage in Postgres,
// billing via Stripe webhook bound to the authenticated user. Self-hosted on the VM.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { Issuer, generators } = require('openid-client');
const jwt = require('jsonwebtoken');

// --------------------------------------------------------------------------- config
const PORT = parseInt(process.env.PORT || '8080', 10);
const BASE_URL = process.env.BASE_URL || 'https://pdffleet.com';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_LINK_HOBBY = process.env.STRIPE_LINK_HOBBY || 'https://buy.stripe.com/14AfZg79kepZ3b9cMr9Zm07';
const STRIPE_LINK_PRO = process.env.STRIPE_LINK_PRO || 'https://buy.stripe.com/28EbJ0alw3LlaDBeUz9Zm08';
const FREE_RPM = 20, PRO_RPM = 300, FREE_MONTHLY = 50, PRO_MONTHLY = 50000;
const MAX_BODY = 10 * 1024 * 1024;
const RENDER_TIMEOUT_MS = parseInt(process.env.RENDER_TIMEOUT_MS || '30000', 10);

// --------------------------------------------------------------------------- postgres
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY, sub text UNIQUE NOT NULL, email text, created_at timestamptz DEFAULT now());
    CREATE TABLE IF NOT EXISTS api_keys (
      key text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id),
      tier text NOT NULL DEFAULT 'free', plan text NOT NULL DEFAULT 'free',
      monthly_limit int NOT NULL DEFAULT ${FREE_MONTHLY}, created_at timestamptz DEFAULT now());
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id text PRIMARY KEY REFERENCES users(id), plan text, status text,
      stripe_customer text, stripe_subscription text, updated_at timestamptz DEFAULT now());
    CREATE TABLE IF NOT EXISTS usage (
      key text NOT NULL, ym text NOT NULL, count int NOT NULL DEFAULT 0, PRIMARY KEY (key, ym));
  `);
  console.log('[db] schema ready');
}
const curMonth = () => new Date().toISOString().slice(0, 7);

async function upsertUser(sub, email) {
  const id = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO users (id, sub, email) VALUES ($1,$2,$3)
     ON CONFLICT (sub) DO UPDATE SET email=EXCLUDED.email RETURNING id`, [id, sub, email]);
  return r.rows[0].id;
}
async function ensureApiKey(userId) {
  const ex = await pool.query('SELECT key FROM api_keys WHERE user_id=$1 LIMIT 1', [userId]);
  if (ex.rows[0]) return ex.rows[0].key;
  const key = 'pdff_' + crypto.randomBytes(18).toString('hex');
  await pool.query('INSERT INTO api_keys (key, user_id) VALUES ($1,$2)', [key, userId]);
  return key;
}
async function keyAuth(req) {
  const auth = req.headers['authorization'] || '';
  const q = new URL(req.url, 'http://x').searchParams;
  let key = null;
  if (auth.startsWith('Bearer ')) key = auth.slice(7).trim();
  else if (req.headers['x-api-key']) key = req.headers['x-api-key'];
  // NOTE: query-string apikey removed — it leaks into access logs, browser history,
  // and Referer headers. Use Authorization or X-API-Key headers instead.
  if (!key) return null;
  const r = await pool.query('SELECT key, user_id, tier, plan, monthly_limit FROM api_keys WHERE key=$1', [key]);
  return r.rows[0] || null;
}
async function usedThisMonth(key) {
  const r = await pool.query('SELECT count FROM usage WHERE key=$1 AND ym=$2', [key, curMonth()]);
  return r.rows[0] ? r.rows[0].count : 0;
}
async function bumpUsage(key) {
  await pool.query(`INSERT INTO usage (key, ym, count) VALUES ($1,$2,1)
    ON CONFLICT (key, ym) DO UPDATE SET count = usage.count + 1`, [key, curMonth()]);
}
async function upgradeUser(userId, plan, monthlyLimit, customer, subscription) {
  await pool.query(`UPDATE api_keys SET tier='pro', plan=$2, monthly_limit=$3 WHERE user_id=$1`,
    [userId, plan, monthlyLimit]);
  await pool.query(`INSERT INTO subscriptions (user_id, plan, status, stripe_customer, stripe_subscription, updated_at)
    VALUES ($1,$2,'active',$3,$4,now())
    ON CONFLICT (user_id) DO UPDATE SET plan=EXCLUDED.plan, status='active',
      stripe_customer=EXCLUDED.stripe_customer, stripe_subscription=EXCLUDED.stripe_subscription, updated_at=now()`,
    [userId, plan, customer, subscription]);
}
async function downgradeByCustomer(customer) {
  const r = await pool.query('SELECT user_id FROM subscriptions WHERE stripe_customer=$1', [customer]);
  if (!r.rows[0]) return;
  const uid = r.rows[0].user_id;
  await pool.query(`UPDATE api_keys SET tier='free', plan='free', monthly_limit=$2 WHERE user_id=$1`, [uid, FREE_MONTHLY]);
  await pool.query(`UPDATE subscriptions SET status='canceled', updated_at=now() WHERE user_id=$1`, [uid]);
}

// --------------------------------------------------------------------------- OIDC (Dex)
let oidc = null;
async function initOIDC() {
  const issuer = await Issuer.discover(process.env.OIDC_ISSUER);
  oidc = new issuer.Client({
    client_id: process.env.OIDC_CLIENT_ID,
    client_secret: process.env.OIDC_CLIENT_SECRET,
    redirect_uris: [BASE_URL + '/auth/callback'],
    response_types: ['code'],
  });
  console.log('[oidc] client ready for', issuer.metadata.issuer);
}

// --------------------------------------------------------------------------- cookies / session
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(p => p[0]));
}
function setCookie(res, name, val, maxAge) {
  const parts = [`${name}=${val}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAge != null) parts.push(`Max-Age=${maxAge}`);
  const prev = res.getHeader('Set-Cookie') || [];
  res.setHeader('Set-Cookie', [...(Array.isArray(prev) ? prev : [prev]).filter(Boolean), parts.join('; ')]);
}
function sessionUser(req) {
  try { return jwt.verify(parseCookies(req).pf_session || '', SESSION_SECRET).uid; } catch { return null; }
}

// --------------------------------------------------------------------------- renderer (headless chromium)
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = require('playwright');
    browserPromise = chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}
const VALID_FORMATS = ['Letter', 'Legal', 'Tabloid', 'Ledger', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

// SSRF protection — block internal/private IPs and dangerous schemes
const BLOCKED_HOSTS = new Set([
  '169.254.169.254', '169.254.169.253', // cloud metadata endpoints (AWS/GCP/Azure)
  'metadata.google.internal', '100.100.100.200', // GCP/Aliyun metadata
  'fd00.169.254.169.254.ipv6.bracketed', // IPv6 metadata
  'localhost', 'ip6-localhost',
]);
const PRIVATE_IP_RE = /^(10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|0\.|::1|fc00:|fd|fe80:)/i;
const MAX_URL_LENGTH = 2048;

async function isBlockedSSRF(targetUrl) {
  let parsed;
  try { parsed = new URL(targetUrl); } catch { return 'invalid_url'; }
  // scheme allowlist
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return `blocked_scheme:${parsed.protocol}`;
  if (targetUrl.length > MAX_URL_LENGTH) return 'url_too_long';
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.has(host)) return `blocked_host:${host}`;
  if (PRIVATE_IP_RE.test(host)) return `private_ip:${host}`;
  // resolve hostname and check the actual IP (prevents DNS rebinding tricks)
  try {
    const dns = require('dns');
    const addrs = await dns.promises.lookup(host, { all: true });
    for (const a of addrs) {
      const ip = a.address;
      if (PRIVATE_IP_RE.test(ip) || ip === '169.254.169.254') return `resolved_private:${host}->${ip}`;
    }
  } catch { /* DNS failure — let the browser fail naturally */ }
  return null;
}

// HTML-escape helper for safe interpolation into the dashboard template
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function renderToPDF({ html, url, template, data, options }) {
  if (!html && !url && !template) { const e = new Error('Provide one of: html, url, or template'); e.statusCode = 422; throw e; }
  // SSRF check for URL-based rendering
  if (url) {
    const blocked = await isBlockedSSRF(url);
    if (blocked) { const e = new Error(`URL not allowed: ${blocked}`); e.statusCode = 403; throw e; }
  }
  if (template) {
    // prevent path traversal — only allow alphanumeric, dash, underscore
    if (!/^[a-zA-Z0-9_-]+$/.test(template)) { const e = new Error('invalid template name'); e.statusCode = 422; throw e; }
    const tplPath = path.join(process.env.TEMPLATES_DIR || '/data/templates', `${template}.html`);
    const resolved = path.resolve(tplPath);
    const baseDir = path.resolve(process.env.TEMPLATES_DIR || '/data/templates');
    if (!resolved.startsWith(baseDir + path.sep)) { const e = new Error('template not found'); e.statusCode = 404; throw e; }
    if (!fs.existsSync(tplPath)) { const e = new Error(`template not found: ${template}`); e.statusCode = 404; throw e; }
    let tpl = fs.readFileSync(tplPath, 'utf8');
    if (data && typeof data ==='object') tpl = tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = k.split('.').reduce((o, key) => (o == null ? undefined : o[key]), data); return v == null ? '' : String(v); });
    html = tpl;
  }
  const pageOptions = { format: 'A4', printBackground: true, margin: { top: '20px', right: '20px', bottom: '20px', left: '20px' }, ...(options || {}) };
  if (pageOptions.format && !VALID_FORMATS.includes(pageOptions.format)) { const e = new Error(`invalid format: ${pageOptions.format}`); e.statusCode = 422; throw e; }
  const browser = await getBrowser();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    if (url) await page.goto(url, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT_MS });
    else await page.setContent(html, { waitUntil: 'networkidle', timeout: RENDER_TIMEOUT_MS });
    if (pageOptions.waitForSelector) { await page.waitForSelector(pageOptions.waitForSelector, { timeout: RENDER_TIMEOUT_MS }); delete pageOptions.waitForSelector; }
    return await page.pdf(pageOptions);
  } finally { await ctx.close(); }
}

// in-memory per-minute rate limiter
const buckets = new Map();
function rateCheck(key, tier) {
  const limit = tier === 'pro' ? PRO_RPM : FREE_RPM, now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.windowStart > 60000) { b = { count: 0, windowStart: now }; buckets.set(key, b); }
  b.count++;
  return { allowed: b.count <= limit, limit, remaining: Math.max(0, limit - b.count), reset: Math.ceil((b.windowStart + 60000 - now) / 1000) };
}

// --------------------------------------------------------------------------- stripe webhook verify
function verifyStripe(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET || !sigHeader) return false;
  const p = Object.fromEntries(sigHeader.split(',').map(x => x.split('=')));
  if (!p.t || !p.v1 || Math.abs(Date.now() / 1000 - Number(p.t)) > 300) return false;
  const exp = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${p.t}.${rawBody}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(p.v1)); } catch { return false; }
}
const planForAmount = c => c >= 2900 ? { plan: 'pro', monthlyLimit: PRO_MONTHLY } : { plan: 'hobby', monthlyLimit: 2000 };

// --------------------------------------------------------------------------- http utils
function sendJSON(res, s, o, h = {}) { const b = JSON.stringify(o); res.writeHead(s, { 'Content-Type': 'application/json', ...h }); res.end(b); }
function redirect(res, loc) { res.writeHead(302, { Location: loc }); res.end(); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml' };
const STATIC_DIR = process.env.STATIC_DIR || path.join(__dirname, 'site');
function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' || pathname.startsWith('/v1/') || pathname.startsWith('/auth/') || pathname === '/dashboard') return false;
  let filePath = path.join(STATIC_DIR, pathname);
  if (!filePath.startsWith(STATIC_DIR)) return false;
  try { if (fs.statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html'); }
  catch { if (!pathname.endsWith('.html')) { try { if (fs.statSync(filePath + '.html').isFile()) filePath += '.html'; else return false; } catch { return false; } } else return false; }
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
    res.end(data); return true;
  } catch { return false; }
}

function dashboardPage({ email, key, plan, used, limit, uid }) {
  const eEmail = esc(email);
  const eKey = esc(key);
  const eUid = esc(uid);
  const eBase = esc(BASE_URL);
  const ref = `?client_reference_id=${encodeURIComponent(eUid)}&prefilled_email=${encodeURIComponent(eEmail)}`;
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const isPaid = plan && plan !== 'free';
  const ePlan = esc(plan || 'free');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Dashboard — PDFFleet</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Sora:wght@600;700;800&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>:root{--bg:#F4F6FA;--surface:#fff;--navy:#0B1430;--ink:#131A2B;--muted:#5A6478;--rule:#E3E7EF;--blue:#2D5BFF;--save:#0E9F6E}
*{margin:0;padding:0;box-sizing:border-box}body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--ink)}
.wrap{max-width:760px;margin:0 auto;padding:0 24px}
.head{display:flex;align-items:center;justify-content:space-between;height:64px;border-bottom:1px solid var(--rule)}
.brand{font-family:Sora;font-weight:800;color:var(--navy);text-decoration:none;font-size:1.1rem}
.head a.out{font-family:JetBrains Mono,monospace;font-size:.82rem;color:var(--muted);text-decoration:none}
h1{font-family:Sora;font-weight:700;font-size:1.7rem;letter-spacing:-.03em;color:var(--navy);margin:36px 0 6px}
.sub{color:var(--muted);margin-bottom:28px}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:14px;padding:24px;margin-bottom:18px}
.lbl{font-family:JetBrains Mono,monospace;font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:10px}
.keyrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.keyrow code{flex:1;min-width:240px;font-family:JetBrains Mono,monospace;font-size:.9rem;background:var(--navy);color:#A9C4FF;padding:12px 14px;border-radius:9px;word-break:break-all}
.btn{font-family:Inter;font-weight:600;font-size:.9rem;padding:10px 18px;border-radius:9px;text-decoration:none;border:1.5px solid var(--rule);color:var(--ink);background:var(--surface);cursor:pointer}
.btn-blue{background:var(--blue);color:#fff;border-color:var(--blue)}
.bar{height:8px;background:var(--rule);border-radius:6px;overflow:hidden;margin:10px 0}.bar>i{display:block;height:100%;background:var(--blue);width:${pct}%}
.plan{display:inline-block;font-family:JetBrains Mono,monospace;font-size:.78rem;padding:3px 10px;border-radius:20px;background:${isPaid ? 'rgba(14,159,110,.12)' : 'var(--rule)'};color:${isPaid ? 'var(--save)' : 'var(--muted)'}}
.up{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.hint{margin-top:12px;font-size:.82rem;color:var(--muted)}.hint code{font-family:JetBrains Mono,monospace;font-size:.76rem;background:#F0F2F7;padding:2px 6px;border-radius:5px;word-break:break-all}</style></head>
<body><header class="head"><div class="wrap" style="display:flex;align-items:center;justify-content:space-between;height:64px"><a class="brand" href="/">PDFFleet</a><a class="out" href="/auth/logout">Sign out</a></div></header>
<main class="wrap"><h1>Your dashboard</h1><p class="sub">Signed in as ${eEmail}.</p>
<div class="card"><div class="lbl">Your API key</div><div class="keyrow"><code id="k">${eKey}</code><button class="btn" onclick="navigator.clipboard.writeText('${eKey}');this.textContent='Copied'">Copy</button></div>
<p class="hint">Use it: <code>curl -X POST ${eBase}/v1/pdf -H "Authorization: Bearer ${eKey}" -H "Content-Type: application/json" -d '{"html":"&lt;h1&gt;Hi&lt;/h1&gt;"}' -o out.pdf</code></p></div>
<div class="card"><div class="lbl">Plan &amp; usage</div><span class="plan">${ePlan.toUpperCase()}</span>
<div class="bar"><i></i></div><p style="font-size:.86rem;color:var(--muted)">${used} / ${limit} PDFs this month</p>
${isPaid ? '' : `<div class="up"><a class="btn btn-blue" href="${STRIPE_LINK_HOBBY}${ref}">Upgrade to Hobby \u2014 $9/mo</a><a class="btn" href="${STRIPE_LINK_PRO}${ref}">Pro \u2014 $29/mo</a></div>`}</div>
</main></body></html>`;
}

// --------------------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const pathname = u.pathname;
    res.setHeader('Access-Control-Allow-Origin', '*'); // API endpoints accept key auth, not cookies
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (serveStatic(req, res, pathname)) return;

    // ---- health ----
    if (req.method === 'GET' && pathname === '/v1/health') {
      let dbOk = true; try { await pool.query('SELECT 1'); } catch { dbOk = false; }
      return sendJSON(res, 200, { status: dbOk ? 'ok' : 'degraded', service: 'pdffleet-api', db: dbOk, auth: !!oidc, timestamp: new Date().toISOString() });
    }

    // ---- auth: login ----
    if (req.method === 'GET' && pathname === '/auth/login') {
      if (!oidc) return sendJSON(res, 503, { error: 'auth_unavailable' });
      const state = generators.state(), nonce = generators.nonce();
      setCookie(res, 'pf_oidc', jwt.sign({ state, nonce }, SESSION_SECRET, { expiresIn: '10m' }), 600);
      return redirect(res, oidc.authorizationUrl({ scope: 'openid email profile', state, nonce }));
    }
    // ---- auth: callback ----
    if (req.method === 'GET' && pathname === '/auth/callback') {
      if (!oidc) return sendJSON(res, 503, { error: 'auth_unavailable' });
      let chk;
      try { chk = jwt.verify(parseCookies(req).pf_oidc || '', SESSION_SECRET); } catch { return redirect(res, '/auth/login'); }
      try {
        const params = oidc.callbackParams(req);
        const tokenSet = await oidc.callback(BASE_URL + '/auth/callback', params, { state: chk.state, nonce: chk.nonce });
        const claims = tokenSet.claims();
        const uid = await upsertUser(claims.sub, claims.email);
        await ensureApiKey(uid);
        setCookie(res, 'pf_session', jwt.sign({ uid }, SESSION_SECRET, { expiresIn: '30d' }), 30 * 86400);
        return redirect(res, '/dashboard');
      } catch (e) { console.error('[auth] callback error:', e.message); return sendJSON(res, 400, { error: 'auth_failed', message: e.message }); }
    }
    // ---- auth: logout ----
    if (req.method === 'GET' && pathname === '/auth/logout') {
      setCookie(res, 'pf_session', '', 0);
      return redirect(res, '/');
    }
    // ---- dashboard ----
    if (req.method === 'GET' && pathname === '/dashboard') {
      const uid = sessionUser(req);
      if (!uid) return redirect(res, '/auth/login');
      const ur = await pool.query('SELECT email FROM users WHERE id=$1', [uid]);
      if (!ur.rows[0]) { setCookie(res, 'pf_session', '', 0); return redirect(res, '/auth/login'); }
      const key = await ensureApiKey(uid);
      const kr = await pool.query('SELECT plan, monthly_limit FROM api_keys WHERE key=$1', [key]);
      const used = await usedThisMonth(key);
      const html = dashboardPage({ email: ur.rows[0].email, key, plan: kr.rows[0].plan, used, limit: kr.rows[0].monthly_limit, uid });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
    }

    // ---- stripe webhook (public, signature-verified) ----
    if (req.method === 'POST' && pathname === '/v1/stripe-webhook') {
      const raw = await readBody(req);
      if (!verifyStripe(raw, req.headers['stripe-signature'])) return sendJSON(res, 400, { error: 'invalid_signature' });
      let ev; try { ev = JSON.parse(raw); } catch { return sendJSON(res, 400, { error: 'bad_json' }); }
      try {
        if (ev.type === 'checkout.session.completed') {
          const s = ev.data.object, uid = s.client_reference_id;
          if (uid) { const { plan, monthlyLimit } = planForAmount(s.amount_total || 0); await upgradeUser(uid, plan, monthlyLimit, s.customer, s.subscription); console.log(`[stripe] upgraded user ${uid} -> ${plan}`); }
        } else if (ev.type === 'customer.subscription.deleted') { await downgradeByCustomer(ev.data.object.customer); }
      } catch (e) { console.error('[stripe] handler error:', e.message); }
      return sendJSON(res, 200, { received: true });
    }

    // ---- render: POST /v1/pdf (key auth) ----
    if (req.method === 'POST' && pathname === '/v1/pdf') {
      const k = await keyAuth(req);
      if (!k) return sendJSON(res, 401, { error: 'unauthorized', message: `Get a key by signing in at ${BASE_URL}/auth/login` });
      const rl = rateCheck(k.key, k.tier);
      res.setHeader('X-RateLimit-Limit', rl.limit); res.setHeader('X-RateLimit-Remaining', rl.remaining);
      if (!rl.allowed) return sendJSON(res, 429, { error: 'rate_limited', message: `${rl.limit}/min on ${k.tier}. Retry in ${rl.reset}s.` });
      if (k.monthly_limit > 0 && (await usedThisMonth(k.key)) >= k.monthly_limit)
        return sendJSON(res, 402, { error: 'quota_exceeded', message: `Monthly limit reached. Upgrade at ${BASE_URL}/dashboard` });
      let payload; try { payload = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { error: 'bad_request', message: 'Invalid JSON body.' }); }
      try {
        const pdf = await renderToPDF(payload);
        await bumpUsage(k.key);
        const fn = (payload.filename || 'document').replace(/[^a-zA-Z0-9-_]/g, '').slice(0, 60) || 'document';
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Content-Disposition': `attachment; filename="${fn}.pdf"` });
        return res.end(pdf);
      } catch (e) { const st = e.statusCode || 500; return sendJSON(res, st, { error: st === 500 ? 'render_failed' : 'invalid_request', message: e.message }); }
    }

    // ---- usage ----
    if (req.method === 'GET' && pathname === '/v1/usage') {
      const k = await keyAuth(req);
      if (!k) return sendJSON(res, 401, { error: 'unauthorized' });
      return sendJSON(res, 200, { tier: k.tier, plan: k.plan, usedThisMonth: await usedThisMonth(k.key), monthlyLimit: k.monthly_limit });
    }

    return sendJSON(res, 404, { error: 'not_found', path: pathname });
  } catch (e) { console.error('[server] error:', e.message); try { sendJSON(res, 500, { error: 'server_error' }); } catch {} }
});

(async () => {
  await initDB();
  try { await initOIDC(); } catch (e) { console.error('[oidc] init failed (will retry on first login):', e.message); }
  server.listen(PORT, () => console.log(`[pdffleet-api] listening on :${PORT}`));
})();

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { server.close(); try { await pool.end(); } catch {} process.exit(0); });
