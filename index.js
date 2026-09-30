'use strict';
// Hakot Day — sales encoding PWA over Google Sheets.
// Google access uses native https + crypto (no googleapis package).

const express = require('express');
const https = require('https');
const crypto = require('crypto');

// ---------- Config ----------
const SHEET_ID = process.env.GOOGLE_SHEET_ID || '1bB3g3TlDbRYX5QY1AQkENU5Zq1o8xiaN1JMJdGNhVfY';
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL || '';
// Tolerates the key pasted with its JSON quotes and/or literal \n sequences.
const PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || '').trim()
  .replace(/^["']|["'],?$/g, '').replace(/\\n/g, '\n');
const SESSION_SECRET = process.env.SESSION_SECRET || 'hakot-day-dev-secret-change-me';
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 3011;

const DATA_SHEET = 'HakotData';
const STORES_SHEET = 'ListOfStores';
const USERS_SHEET = 'Users';
const LOG_SHEET = 'EntryLog';
const DATA_FIRST_ROW = 3; // rows 1-2 are the merged window headers + column headers

const WINDOWS = [
  { key: '10AM', label: '10:00 AM' },
  { key: '12PM', label: '12:00 PM' },
  { key: '3PM', label: '3:00 PM' },
  { key: '4PM', label: '4:00 PM' },
  { key: '6PM', label: '6:00 PM' },
  { key: '9PM', label: '9:00 PM' },
  { key: 'FINAL', label: 'FINAL SALES' },
];
// HakotData columns (0-based): A Date, B Area, C Store ID, D Store Name, E Sales LY, F TRX LY,
// then each window takes 4 columns: Sales, TRX, Basket Size, VS LY  (G..AH)
const NCOLS = 6 + WINDOWS.length * 4; // 34 -> A..AH
const winCol = i => 6 + i * 4;

const USER_HEADERS = ['Email', 'PasswordHash', 'Name', 'StoreID', 'StoreName', 'Area', 'Role', 'CreatedAt',
  'Status', 'ReviewedBy', 'ReviewedAt'];
// Status: pending (new sign-up) -> approved | disabled. Only approved accounts can log in.
const STATUSES = ['pending', 'approved', 'disabled'];
const ALL_STORES = { id: 'ALL', name: 'All stores', area: '' };
const LOG_HEADERS = ['Timestamp', 'Email', 'Name', 'HakotDate', 'StoreID', 'StoreName', 'Entry', 'Sales', 'TRX'];

// ---------- HTTP helper ----------
function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({}, headers, body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : {}; } catch (e) { json = { raw: text }; }
        resolve({ status: res.statusCode, json });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Google request timed out')));
    if (body) req.write(body);
    req.end();
  });
}

// ---------- Google auth (service account JWT) ----------
let tokenCache = { token: null, exp: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return tokenCache.token;
  if (!CLIENT_EMAIL || !PRIVATE_KEY) throw new Error('Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY');
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
    iss: CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  });
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(PRIVATE_KEY).toString('base64url');
  const body = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
    '&assertion=' + unsigned + '.' + sig;
  const r = await request('POST', 'https://oauth2.googleapis.com/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  if (r.status !== 200 || !r.json.access_token) {
    throw new Error('Google auth failed: ' + ((r.json && (r.json.error_description || r.json.error)) || r.status));
  }
  tokenCache = { token: r.json.access_token, exp: Date.now() + (r.json.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

async function sheets(method, path, payload) {
  const token = await getToken();
  const r = await request(method, 'https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + path,
    { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    payload ? JSON.stringify(payload) : null);
  if (r.status >= 300) {
    const msg = (r.json && r.json.error && r.json.error.message) || ('HTTP ' + r.status);
    throw new Error('Sheets API: ' + msg);
  }
  return r.json;
}

async function getValues(range) {
  const j = await sheets('GET', '/values/' + encodeURIComponent(range) +
    '?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER');
  return j.values || [];
}
function putValues(range, values) {
  return sheets('PUT', '/values/' + encodeURIComponent(range) + '?valueInputOption=USER_ENTERED',
    { majorDimension: 'ROWS', values });
}
function appendValues(range, values) {
  return sheets('POST', '/values/' + encodeURIComponent(range) +
    ':append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS',
    { majorDimension: 'ROWS', values });
}

// Creates the Users / EntryLog tabs on first run.
let sheetsReady = false;
async function ensureSheets() {
  if (sheetsReady) return;
  const meta = await sheets('GET', '?fields=sheets.properties.title');
  const titles = (meta.sheets || []).map(s => s.properties.title);
  const needed = [[USERS_SHEET, USER_HEADERS], [LOG_SHEET, LOG_HEADERS]].filter(([t]) => !titles.includes(t));
  if (needed.length) {
    await sheets('POST', ':batchUpdate', {
      requests: needed.map(([title]) => ({ addSheet: { properties: { title } } })),
    });
    for (const [title, headers] of needed) await putValues(title + '!A1', [headers]);
  }
  if (titles.includes(USERS_SHEET)) {
    // Older Users tab without the approval columns: add their headers.
    const head = (await getValues(USERS_SHEET + '!A1:K1'))[0] || [];
    if (idStr(head[8]) !== 'Status') await putValues(USERS_SHEET + '!I1:K1', [USER_HEADERS.slice(8)]);
  }
  sheetsReady = true;
}

// ---------- Value helpers ----------
// Numbers may come back as numbers or as text with commas — always normalise.
function num(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[,\s₱]/g, ''));
  return isNaN(n) ? '' : n;
}
function isoDate(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') {
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (isNaN(d)) return '';
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function idStr(v) { return String(v === undefined || v === null ? '' : v).trim(); }
// Stop user-typed text from being read as a formula by USER_ENTERED.
function safeText(s) { s = String(s || ''); return /^[=+\-@]/.test(s) ? "'" + s : s; }
function nowPH() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Manila', hour12: false }).replace(',', '');
}

// ---------- Data access ----------
async function loadStores() {
  const rows = await getValues(STORES_SHEET + '!A2:E');
  return rows
    .map(r => ({ region: idStr(r[0]), area: idStr(r[1]), id: idStr(r[2]), name: idStr(r[3]), remarks: idStr(r[4]) }))
    .filter(s => s.id);
}

async function loadUsers() {
  await ensureSheets();
  const rows = await getValues(USERS_SHEET + '!A2:K');
  return rows.map((r, i) => ({
    row: i + 2,
    email: idStr(r[0]).toLowerCase(),
    hash: idStr(r[1]),
    name: idStr(r[2]),
    storeId: idStr(r[3]),
    storeName: idStr(r[4]),
    area: idStr(r[5]),
    role: idStr(r[6]).toLowerCase() || 'user',
    createdAt: idStr(r[7]),
    status: idStr(r[8]).toLowerCase() || 'pending',
    reviewedBy: idStr(r[9]),
    reviewedAt: idStr(r[10]),
  })).filter(u => u.email);
}

function cellsToRec(c, row) {
  const rec = {
    row,
    date: isoDate(c[0]),
    area: idStr(c[1]),
    storeId: idStr(c[2]),
    storeName: idStr(c[3]),
    ly: num(c[4]),
    trxLy: num(c[5]),
    w: {},
  };
  WINDOWS.forEach((w, i) => { rec.w[w.key] = { sales: num(c[winCol(i)]), trx: num(c[winCol(i) + 1]) }; });
  return rec;
}

function recToCells(rec) {
  const id = /^\d+$/.test(rec.storeId) ? Number(rec.storeId) : safeText(rec.storeId);
  const out = [rec.date, safeText(rec.area), id, safeText(rec.storeName), rec.ly, rec.trxLy];
  WINDOWS.forEach(w => {
    const { sales, trx } = rec.w[w.key];
    const basket = sales !== '' && trx > 0 ? Math.round((sales / trx) * 100) / 100 : '';
    const vsly = sales !== '' && rec.ly > 0 ? ((sales / rec.ly) * 100).toFixed(2) + '%' : '';
    out.push(sales, trx, basket, vsly);
  });
  return out;
}

// Only rows with a real Date + Store ID are app data (skips area banner / sample rows).
async function loadData() {
  const rows = await getValues(DATA_SHEET + '!A' + DATA_FIRST_ROW + ':AH');
  const out = [];
  rows.forEach((r, i) => {
    const c = r.slice();
    while (c.length < NCOLS) c.push('');
    const rec = cellsToRec(c, DATA_FIRST_ROW + i);
    if (rec.date && rec.storeId) out.push(rec);
  });
  return out;
}

function publicRec(r) {
  return { date: r.date, area: r.area, storeId: r.storeId, storeName: r.storeName, ly: r.ly, trxLy: r.trxLy, w: r.w };
}

// ---------- Passwords & sessions ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}
function checkPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(pw, parts[1], 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

const COOKIE = 'hd_session';
const SESSION_DAYS = 30;
function signSession(email) {
  const payload = Buffer.from(JSON.stringify({ e: email, x: Date.now() + SESSION_DAYS * 86400000 })).toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function readSession(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [payload, mac] = token.split('.');
  const good = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return p.x > Date.now() ? p.e : null;
  } catch (e) { return null; }
}
function getCookie(req, name) {
  const all = req.headers.cookie || '';
  for (const part of all.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function setSessionCookie(req, res, email) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', COOKIE + '=' + signSession(email) +
    '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_DAYS * 86400 + secure);
}

function publicUser(u) {
  const role = ADMIN_EMAILS.includes(u.email) ? 'admin' : (u.role === 'admin' ? 'admin' : 'user');
  // allStores: sees and encodes every store (admins, and accounts signed up with "All stores").
  const allStores = role === 'admin' || u.storeId === ALL_STORES.id;
  return { email: u.email, name: u.name, storeId: u.storeId, storeName: u.storeName, area: u.area, role, allStores };
}
// ADMIN_EMAILS are always active so there is always someone who can approve.
// A Role=admin row typed into the sheet counts as approved unless it is disabled.
function effectiveStatus(u) {
  if (ADMIN_EMAILS.includes(u.email)) return 'approved';
  if (u.role === 'admin' && u.status !== 'disabled') return 'approved';
  return STATUSES.includes(u.status) ? u.status : 'pending';
}
function statusError(status) {
  return status === 'pending'
    ? 'Your account is waiting for admin approval. Please try again once an admin has approved it.'
    : 'Your account is not active. Please contact your admin.';
}

async function requireUser(req, res, next) {
  try {
    const email = readSession(getCookie(req, COOKIE));
    if (!email) return res.status(401).json({ error: 'Please log in.' });
    const u = (await loadUsers()).find(x => x.email === email);
    if (!u) return res.status(401).json({ error: 'Account not found. Please sign up again.' });
    const status = effectiveStatus(u);
    if (status !== 'approved') return res.status(401).json({ error: statusError(status) });
    req.user = publicUser(u);
    next();
  } catch (e) { next(e); }
}

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '100kb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/api/stores', wrap(async (req, res) => {
  const stores = await loadStores();
  res.json({ stores: stores.map(s => ({ id: s.id, name: s.name, area: s.area, remarks: s.remarks })) });
}));

app.post('/api/signup', wrap(async (req, res) => {
  const email = idStr(req.body.email).toLowerCase();
  const password = String(req.body.password || '');
  const name = idStr(req.body.name);
  const storeId = idStr(req.body.storeId);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  const store = storeId === ALL_STORES.id ? ALL_STORES : (await loadStores()).find(s => s.id === storeId);
  if (!store) return res.status(400).json({ error: 'Select your store.' });
  const users = await loadUsers();
  if (users.some(u => u.email === email)) return res.status(409).json({ error: 'This email is already registered. Please log in.' });
  const autoApproved = ADMIN_EMAILS.includes(email);
  await appendValues(USERS_SHEET + '!A:K', [[
    safeText(email), hashPassword(password), safeText(name), Number(store.id) || store.id,
    safeText(store.name), safeText(store.area), 'user', nowPH(),
    autoApproved ? 'approved' : 'pending', autoApproved ? 'ADMIN_EMAILS' : '', autoApproved ? nowPH() : '',
  ]]);
  if (!autoApproved) return res.json({ pending: true });
  setSessionCookie(req, res, email);
  res.json({ user: publicUser({ email, name, storeId: store.id, storeName: store.name, area: store.area, role: 'user' }) });
}));

app.post('/api/login', wrap(async (req, res) => {
  const email = idStr(req.body.email).toLowerCase();
  const password = String(req.body.password || '');
  const u = (await loadUsers()).find(x => x.email === email);
  if (!u || !checkPassword(password, u.hash)) return res.status(401).json({ error: 'Wrong email or password.' });
  const status = effectiveStatus(u);
  if (status !== 'approved') return res.status(403).json({ error: statusError(status), status });
  setSessionCookie(req, res, email);
  res.json({ user: publicUser(u) });
}));

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', requireUser, (req, res) => res.json({ user: req.user }));

// ---------- Admin: account approval ----------
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admins only.' });
  next();
}

app.get('/api/users', requireUser, requireAdmin, wrap(async (req, res) => {
  const users = await loadUsers();
  res.json({
    users: users.map(u => Object.assign(publicUser(u), {
      status: effectiveStatus(u), createdAt: u.createdAt, reviewedBy: u.reviewedBy, reviewedAt: u.reviewedAt,
      envAdmin: ADMIN_EMAILS.includes(u.email),
    })),
  });
}));

app.post('/api/users/status', requireUser, requireAdmin, wrap(async (req, res) => {
  const email = idStr(req.body.email).toLowerCase();
  const status = idStr(req.body.status).toLowerCase();
  if (!['approved', 'disabled'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
  if (email === req.user.email) return res.status(400).json({ error: 'You cannot change your own account.' });
  if (ADMIN_EMAILS.includes(email)) return res.status(400).json({ error: 'This admin is set in ADMIN_EMAILS and is always active.' });
  const u = (await loadUsers()).find(x => x.email === email);
  if (!u) return res.status(404).json({ error: 'User not found.' });
  await putValues(USERS_SHEET + '!I' + u.row + ':K' + u.row, [[status, safeText(req.user.email), nowPH()]]);
  res.json({ ok: true, email, status });
}));

// User: every Hakot Day row of their own store. Admin / All-stores: every store for the chosen date.
app.get('/api/data', requireUser, wrap(async (req, res) => {
  const all = await loadData();
  let rows;
  if (req.user.allStores) {
    const date = idStr(req.query.date);
    rows = date ? all.filter(r => r.date === date) : all;
  } else {
    rows = all.filter(r => r.storeId === req.user.storeId);
  }
  res.json({ rows: rows.map(publicRec) });
}));

app.post('/api/save', requireUser, wrap(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const date = idStr(req.body.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date.' });
  const storeId = req.user.allStores ? idStr(req.body.storeId) : req.user.storeId;
  const store = (await loadStores()).find(s => s.id === storeId);
  if (!store) return res.status(400).json({ error: 'Select a store from ListOfStores.' });

  const all = await loadData();
  const existing = all.find(r => r.date === date && r.storeId === storeId);
  const rec = existing || {
    date, storeId, ly: '', trxLy: '', w: Object.fromEntries(WINDOWS.map(w => [w.key, { sales: '', trx: '' }])),
  };
  rec.area = store.area;
  rec.storeName = store.name;
  const hasWindow = WINDOWS.some(w => rec.w[w.key].sales !== '');
  let logEntry;

  if (req.body.ly) {
    const sales = num(req.body.ly.sales), trx = num(req.body.ly.trx);
    if (sales === '' || sales < 0 || trx === '' || trx < 0) {
      return res.status(400).json({ error: 'Enter Sales Last Year and TRX Count LY (use 0 for new stores).' });
    }
    if (!isAdmin && hasWindow && rec.ly !== '') {
      return res.status(403).json({ error: 'Last Year figures are locked once a time window is saved. Ask an admin to change them.' });
    }
    rec.ly = sales; rec.trxLy = Math.round(trx);
    logEntry = ['LY', sales, Math.round(trx)];
  } else if (req.body.window) {
    const key = idStr(req.body.window.key);
    const w = WINDOWS.find(x => x.key === key);
    if (!w) return res.status(400).json({ error: 'Unknown time window.' });
    if (rec.ly === '') return res.status(400).json({ error: 'Enter the Last Year figures first.' });
    const sales = num(req.body.window.sales), trx = num(req.body.window.trx);
    if (sales === '' || sales < 0) return res.status(400).json({ error: 'Enter a valid Sales amount.' });
    if (trx === '' || trx < 0) return res.status(400).json({ error: 'Enter a valid TRX count.' });
    rec.w[key] = { sales, trx: Math.round(trx) };
    logEntry = [w.label, sales, Math.round(trx)];
  } else {
    return res.status(400).json({ error: 'Nothing to save.' });
  }

  const cells = recToCells(rec);
  if (existing) {
    await putValues(DATA_SHEET + '!A' + existing.row + ':AH' + existing.row, [cells]);
  } else {
    await appendValues(DATA_SHEET + '!A:AH', [cells]);
  }
  await ensureSheets();
  await appendValues(LOG_SHEET + '!A:I', [[
    nowPH(), safeText(req.user.email), safeText(req.user.name), date, Number(storeId) || storeId,
    safeText(store.name), logEntry[0], logEntry[1], logEntry[2],
  ]]);
  res.json({ rec: publicRec(rec) });
}));

// ---------- PWA assets ----------
const ICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" rx="112" fill="#2f6b1f"/>' +
  '<rect x="112" y="276" width="64" height="124" rx="14" fill="#b6e39a"/>' +
  '<rect x="224" y="196" width="64" height="204" rx="14" fill="#d9f2c7"/>' +
  '<rect x="336" y="112" width="64" height="288" rx="14" fill="#ffffff"/></svg>';

const MANIFEST = {
  name: 'Hakot Day Sales',
  short_name: 'Hakot Day',
  start_url: '/',
  display: 'standalone',
  background_color: '#f3f6f1',
  theme_color: '#2f6b1f',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
};

const SW_JS = String.raw`
const CACHE = 'hakot-day-v1';
const SHELL = ['/', '/manifest.webmanifest', '/icon.svg'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
`;

app.get('/icon.svg', (req, res) => res.type('image/svg+xml').send(ICON_SVG));
app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').send(JSON.stringify(MANIFEST)));
app.get('/sw.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-cache').send(SW_JS));

// ---------- Page ----------
// String.raw: nothing in the client code below is processed by the outer template literal,
// so backslashes/regexes are served exactly as written. Client code must not use backticks or ${.
const PAGE = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Hakot Day Sales</title>
<meta name="theme-color" content="#2f6b1f">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="apple-mobile-web-app-capable" content="yes">
<style>
:root{
  --bg:#f3f6f1;--card:#ffffff;--ink:#1b2a17;--muted:#667363;--line:#dfe6db;
  --brand:#2f6b1f;--brand-ink:#ffffff;--brand-soft:#e6f2df;--head:#38761d;--sub:#b6d7a8;--sub-ink:#1b2a17;
  --area:#fff2cc;--total:#eef5ea;--good:#1f7a32;--bad:#b3261e;--warn:#9a5b00;--shade:#f7faf5;--focus:#7fb86a;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#111610;--card:#1a2118;--ink:#e6eee2;--muted:#9aa896;--line:#2d372a;
    --brand:#5fae45;--brand-ink:#0d1a09;--brand-soft:#223320;--head:#2c5a1a;--sub:#2f4527;--sub-ink:#e6eee2;
    --area:#3a3417;--total:#1f2b1c;--good:#7fd48e;--bad:#ff8a80;--warn:#f0b35a;--shade:#161c14;--focus:#5fae45;
  }
}
:root[data-theme="dark"]{
  --bg:#111610;--card:#1a2118;--ink:#e6eee2;--muted:#9aa896;--line:#2d372a;
  --brand:#5fae45;--brand-ink:#0d1a09;--brand-soft:#223320;--head:#2c5a1a;--sub:#2f4527;--sub-ink:#e6eee2;
  --area:#3a3417;--total:#1f2b1c;--good:#7fd48e;--bad:#ff8a80;--warn:#f0b35a;--shade:#161c14;--focus:#5fae45;
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}
.bar{position:sticky;top:0;z-index:20;background:var(--brand);color:var(--brand-ink);padding:10px 16px;display:flex;align-items:center;gap:12px}
.bar .logo{width:30px;height:30px;border-radius:8px;background:rgba(255,255,255,.18);display:grid;place-items:center}
.bar h1{font-size:16px;margin:0;line-height:1.2}
.bar small{display:block;opacity:.85;font-size:12px}
.bar .sp{flex:1}
.bar .who{font-size:12px;text-align:right;opacity:.9;max-width:40vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{max-width:1280px;margin:0 auto;padding:16px;display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.card h2{font-size:16px;margin:0}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.between{justify-content:space-between}
.muted{color:var(--muted)}
.sm{font-size:12.5px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:12px}
label{display:grid;gap:4px;font-size:12.5px;color:var(--muted);font-weight:600}
input,select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:16px;font-weight:500}
input:focus,select:focus{outline:2px solid var(--focus);outline-offset:0;border-color:transparent}
input:disabled{background:var(--shade);color:var(--muted)}
.btn{border:1px solid var(--line);background:var(--card);padding:10px 16px;border-radius:10px;font-weight:600;cursor:pointer}
.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
.btn.ghost{background:transparent}
.btn.sm{padding:6px 12px;font-size:13px}
.btn.onbar{background:rgba(255,255,255,.14);border-color:rgba(255,255,255,.3);color:var(--brand-ink)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.step{border-top:1px dashed var(--line);margin-top:14px;padding-top:14px}
.step.disabled{opacity:.55}
.step-title{display:flex;align-items:center;gap:8px;font-weight:700}
.num{width:22px;height:22px;border-radius:50%;background:var(--brand-soft);color:var(--brand);display:grid;place-items:center;font-size:12px;font-weight:800}
.badge{font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:var(--brand-soft);color:var(--good)}
.badge.warn{color:var(--warn);background:transparent;border:1px solid var(--line)}
.hint{margin:6px 0 0;font-size:13px;color:var(--muted)}
.lyshow{display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-top:10px;padding:10px 12px;background:var(--shade);border-radius:10px}
.lyshow small{display:block;color:var(--muted);font-size:11.5px;font-weight:600}
.lyshow b{font-size:17px;font-variant-numeric:tabular-nums}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
.chip{border:1px solid var(--line);background:var(--card);border-radius:99px;padding:7px 12px;font-size:13px;font-weight:600;cursor:pointer}
.chip.done{background:var(--brand-soft);color:var(--good);border-color:transparent}
.chip.sel{outline:2px solid var(--brand);outline-offset:1px}
.chip.next:not(.sel){border-color:var(--brand)}
.preview{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-top:12px}
.pv{background:var(--shade);border-radius:10px;padding:8px 10px}
.pv small{display:block;font-size:11.5px;color:var(--muted);font-weight:600}
.pv b{font-variant-numeric:tabular-nums}
.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.progress{height:8px;background:var(--shade);border-radius:99px;overflow:hidden;margin-top:8px;border:1px solid var(--line)}
.progress i{display:block;height:100%;background:var(--brand)}
.tscroll{overflow:auto;max-height:72vh;margin-top:12px;border:1px solid var(--line);border-radius:10px}
table{border-collapse:separate;border-spacing:0;font-size:12.5px;font-variant-numeric:tabular-nums;min-width:100%}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);white-space:nowrap;text-align:right}
th{background:var(--head);color:#fff;font-weight:700;text-align:center;position:sticky;top:0;z-index:3}
thead tr:nth-child(2) th{top:31px;background:var(--sub);color:var(--sub-ink);font-weight:600}
thead tr:first-child th{height:31px}
td.l,th.l{text-align:left}
.stick{position:sticky;left:0;z-index:2;background:var(--card)}
th.stick{z-index:4;background:var(--head)}
tbody tr.clickable{cursor:pointer}
tbody tr.clickable:hover td{background:var(--brand-soft)}
tbody tr.cur td{background:var(--brand-soft)}
td.w1{background:var(--shade)}
tr.area td{background:var(--area);font-weight:700;text-align:left}
tr.sub td,tr.grand td{background:var(--total);font-weight:700}
tr.grand td{border-top:2px solid var(--brand)}
.empty{padding:28px;text-align:center;color:var(--muted)}
.auth{max-width:420px;margin:40px auto;padding:0 16px}
.auth .brand{text-align:center;margin-bottom:18px}
.auth .brand .logo{width:56px;height:56px;margin:0 auto 10px;border-radius:14px;overflow:hidden}
.auth h1{margin:0;font-size:22px}
.tabs{display:grid;grid-template-columns:1fr 1fr;background:var(--shade);border-radius:10px;padding:4px;margin-bottom:12px}
.tabs button{border:0;background:transparent;padding:8px;border-radius:8px;font-weight:600;cursor:pointer;color:var(--muted)}
.tabs button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}
form{display:grid;gap:12px}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--ink);color:var(--card);padding:10px 16px;border-radius:10px;font-size:14px;opacity:0;pointer-events:none;transition:opacity .2s;z-index:50;max-width:calc(100% - 32px)}
#toast.show{opacity:1}
#toast.err{background:var(--bad);color:#fff}
.loading{padding:60px 16px;text-align:center;color:var(--muted)}
.note{border:1px solid var(--line);border-left:4px solid var(--brand);background:var(--shade);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13.5px}
.note.warn{border-left-color:var(--warn)}
.note b{display:block;margin-bottom:2px}
.nav{max-width:1280px;margin:0 auto;padding:12px 16px 0;display:flex;gap:6px}
.nav button{border:1px solid var(--line);background:var(--card);border-radius:99px;padding:7px 16px;font-weight:600;cursor:pointer;color:var(--muted)}
.nav button.on{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}
.count{display:inline-block;min-width:20px;padding:0 6px;border-radius:99px;background:var(--bad);color:#fff;font-size:11.5px;line-height:18px;text-align:center;margin-left:4px}
h3.sec{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:18px 0 8px}
.plist{display:grid;gap:8px}
.pitem{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--shade)}
.st{font-size:11.5px;font-weight:700;padding:2px 8px;border-radius:99px;border:1px solid var(--line)}
.st.approved{color:var(--good);background:var(--brand-soft);border-color:transparent}
.st.pending{color:var(--warn)}
.st.disabled{color:var(--bad)}
@media (max-width:600px){ .bar .who{display:none} main{padding:12px} .card{padding:14px} }
</style>
</head>
<body>
<div id="app"><div class="loading">Loading…</div></div>
<div id="toast"></div>
<script>
var WINS=[{k:'10AM',l:'10:00 AM'},{k:'12PM',l:'12:00 PM'},{k:'3PM',l:'3:00 PM'},{k:'4PM',l:'4:00 PM'},{k:'6PM',l:'6:00 PM'},{k:'9PM',l:'9:00 PM'},{k:'FINAL',l:'Final Sales'}];
var S={me:null,stores:[],rows:[],date:todayPH(),store:'',win:null,authTab:'login',authNote:null,editLY:false,busy:false,view:'sales',users:[]};
var ICON='<svg viewBox="0 0 512 512" width="100%" height="100%"><rect width="512" height="512" rx="112" fill="#2f6b1f"/><rect x="112" y="276" width="64" height="124" rx="14" fill="#b6e39a"/><rect x="224" y="196" width="64" height="204" rx="14" fill="#d9f2c7"/><rect x="336" y="112" width="64" height="288" rx="14" fill="#fff"/></svg>';

function $(id){return document.getElementById(id)}
function todayPH(){return new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'})}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function num(v){if(v===''||v==null)return '';var x=parseFloat(String(v).replace(/[,\s₱]/g,''));return isNaN(x)?'':x}
function money(v){return v===''||v==null?'':Number(v).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}
function int(v){return v===''||v==null?'':Math.round(Number(v)).toLocaleString('en-PH')}
function pct(x){return x==null?'':(x*100).toFixed(2)+'%'}
function isAdmin(){return S.me&&S.me.role==='admin'}
function allStores(){return S.me&&S.me.allStores}
function defaultStore(){return allStores()?(S.stores[0]?S.stores[0].id:''):S.me.storeId}
function fmtDate(iso){if(!iso)return '';var p=iso.split('-');var d=new Date(+p[0],+p[1]-1,+p[2]);return d.toLocaleDateString('en-US',{month:'long',day:'2-digit',year:'numeric'})}
function storeById(id){for(var i=0;i<S.stores.length;i++){if(S.stores[i].id===String(id))return S.stores[i]}return null}
function winLabel(k){for(var i=0;i<WINS.length;i++){if(WINS[i].k===k)return WINS[i].l}return k}
function blankRec(st){var w={};WINS.forEach(function(x){w[x.k]={sales:'',trx:''}});return {date:S.date,storeId:st?st.id:'',storeName:st?st.name:'',area:st?st.area:'',ly:'',trxLy:'',w:w}}
function currentRec(){for(var i=0;i<S.rows.length;i++){var r=S.rows[i];if(r.date===S.date&&r.storeId===String(S.store))return r}return null}
function nextWin(rec){if(!rec)return WINS[0].k;for(var i=0;i<WINS.length;i++){if(rec.w[WINS[i].k].sales==='')return WINS[i].k}return null}
function basket(s,t){return s!==''&&t>0?s/t:null}
function vsly(s,ly){return s!==''&&ly>0?s/ly:null}

function toast(msg,err){var t=$('toast');t.textContent=msg;t.className='show'+(err?' err':'');clearTimeout(toast.h);toast.h=setTimeout(function(){t.className=''},err?4200:2400)}

async function api(path,body,method){
  var opt={method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json'},credentials:'same-origin'};
  if(body)opt.body=JSON.stringify(body);
  var r=await fetch(path,opt);var j={};
  try{j=await r.json()}catch(e){}
  if(!r.ok){var er=new Error(j.error||('Request failed ('+r.status+')'));er.status=r.status;throw er}
  return j;
}

async function loadData(){var j=await api('/api/data?date='+encodeURIComponent(S.date));S.rows=j.rows||[]}

function upsert(rec){
  for(var i=0;i<S.rows.length;i++){if(S.rows[i].date===rec.date&&S.rows[i].storeId===rec.storeId){S.rows[i]=rec;return}}
  S.rows.push(rec);
}

// ---------- Rendering ----------
function render(){if(!S.me)renderAuth();else renderMain()}

function storeOptions(sel,withAll){
  var areas=[],by={};
  S.stores.forEach(function(s){if(!by[s.area]){by[s.area]=[];areas.push(s.area)}by[s.area].push(s)});
  return (withAll?'<option value="ALL"'+(sel==='ALL'?' selected':'')+'>All stores</option>':'')+areas.map(function(a){return '<optgroup label="'+esc(a)+'">'+by[a].map(function(s){return '<option value="'+esc(s.id)+'"'+(String(sel)===s.id?' selected':'')+'>'+esc(s.id+' · '+s.name)+'</option>'}).join('')+'</optgroup>'}).join('');
}

function renderAuth(){
  var login=S.authTab==='login';
  var h='<div class="auth"><div class="brand"><div class="logo">'+ICON+'</div><h1>Hakot Day Sales</h1><div class="muted sm">Hourly sales encoding for every store</div></div><div class="card">';
  h+='<div class="tabs"><button data-act="tab" data-t="login" class="'+(login?'on':'')+'">Log in</button><button data-act="tab" data-t="signup" class="'+(login?'':'on')+'">Sign up</button></div>';
  if(S.authNote)h+='<div class="note '+(S.authNote.kind||'')+'"><b>'+esc(S.authNote.title)+'</b><div>'+esc(S.authNote.text)+'</div></div>';
  if(login){
    h+='<form data-form="login"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="btn primary" type="submit">Log in</button></form>';
  }else{
    h+='<form data-form="signup"><label>Full name<input name="name" autocomplete="name" required></label><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" minlength="6" autocomplete="new-password" required></label><label>Your store<select name="storeId" required><option value="">Select store…</option>'+storeOptions('',true)+'</select></label><button class="btn primary" type="submit">Create account</button></form><p class="hint">New accounts need admin approval before you can log in.</p>';
    if(!S.stores.length)h+='<p class="hint bad">Store list could not be loaded'+(S.storesError?': '+esc(S.storesError):'.')+'</p>';
  }
  h+='</div></div>';
  $('app').innerHTML=h;
}

function renderMain(){
  var sub=isAdmin()?'Admin · all stores':(allStores()?'All stores':esc(S.me.storeId+' · '+S.me.storeName));
  var h='<header class="bar"><div class="logo">'+ICON+'</div><div><h1>Hakot Day Sales</h1><small>'+sub+'</small></div><div class="sp"></div><div class="who">'+esc(S.me.name)+'<br>'+esc(S.me.email)+'</div><button class="btn sm onbar" data-act="logout">Log out</button></header>';
  if(isAdmin()){
    var pend=pendingCount();
    h+='<nav class="nav"><button data-act="view" data-v="sales" class="'+(S.view==='sales'?'on':'')+'">Sales</button><button data-act="view" data-v="users" class="'+(S.view==='users'?'on':'')+'">Users'+(pend?' <span class="count">'+pend+'</span>':'')+'</button></nav>';
  }
  if(isAdmin()&&S.view==='users'){
    h+='<main><section class="card" id="users"></section></main>';
    $('app').innerHTML=h;renderUsers();return;
  }
  h+='<main><section class="card" id="entry"></section><section class="card" id="tbl"></section></main>';
  $('app').innerHTML=h;
  renderEntry();renderTable();
}

function pendingCount(){return S.users.filter(function(u){return u.status==='pending'}).length}
async function loadUsers(){if(!isAdmin())return;var j=await api('/api/users');S.users=j.users||[]}

var STATUS_LABEL={pending:'Pending',approved:'Approved',disabled:'Disabled'};
function userActions(u){
  if(u.email===S.me.email)return '<span class="muted sm">You</span>';
  if(u.envAdmin)return '<span class="muted sm">Built-in admin</span>';
  var b='';
  if(u.status!=='approved')b+='<button class="btn primary sm" data-act="setStatus" data-e="'+esc(u.email)+'" data-s="approved">Approve</button>';
  if(u.status!=='disabled')b+='<button class="btn ghost sm" data-act="setStatus" data-e="'+esc(u.email)+'" data-s="disabled">'+(u.status==='pending'?'Reject':'Disable')+'</button>';
  return '<div class="row" style="gap:6px;justify-content:flex-end">'+b+'</div>';
}
function renderUsers(){
  var pend=S.users.filter(function(u){return u.status==='pending'});
  var h='<div class="row between"><div><h2>User accounts</h2><div class="muted sm">'+S.users.length+' accounts · '+pend.length+' waiting for approval</div></div><button class="btn ghost sm" data-act="refreshUsers">Refresh</button></div>';
  if(pend.length){
    h+='<h3 class="sec">Waiting for approval</h3><div class="plist">';
    pend.forEach(function(u){
      h+='<div class="pitem"><div><b>'+esc(u.name)+'</b><div class="muted sm">'+esc(u.email)+'</div><div class="sm">'+esc(u.storeId+' · '+u.storeName)+(u.area?' <span class="muted">('+esc(u.area)+')</span>':'')+'</div><div class="muted sm">Signed up '+esc(u.createdAt)+'</div></div>'+userActions(u)+'</div>';
    });
    h+='</div>';
  }else{
    h+='<div class="note" style="margin-top:12px"><b>No pending sign-ups</b><div>New accounts will appear here for approval.</div></div>';
  }
  var order={pending:0,approved:1,disabled:2};
  var list=S.users.slice().sort(function(a,b){return (order[a.status]-order[b.status])||a.name.localeCompare(b.name)});
  h+='<h3 class="sec">All accounts</h3><div class="tscroll"><table><thead><tr><th class="l">Name</th><th class="l">Email</th><th class="l">Store</th><th class="l">Role</th><th class="l">Status</th><th class="l">Reviewed</th><th></th></tr></thead><tbody>';
  list.forEach(function(u){
    h+='<tr><td class="l">'+esc(u.name)+'</td><td class="l">'+esc(u.email)+'</td><td class="l">'+esc(u.storeId+' · '+u.storeName)+'</td><td class="l">'+(u.role==='admin'?'Admin':'User')+'</td><td class="l"><span class="st '+u.status+'">'+STATUS_LABEL[u.status]+'</span></td><td class="l muted">'+esc(u.reviewedBy?u.reviewedBy+' · '+u.reviewedAt:'')+'</td><td>'+userActions(u)+'</td></tr>';
  });
  h+='</tbody></table></div>';
  $('users').innerHTML=h;
}

async function setStatus(btn){
  var email=btn.getAttribute('data-e'),st=btn.getAttribute('data-s');
  if(st==='disabled'&&!confirm(btn.textContent+' '+email+'? They will not be able to log in.'))return;
  if(S.busy)return;S.busy=true;btn.disabled=true;
  try{
    await api('/api/users/status',{email:email,status:st});
    S.users.forEach(function(u){if(u.email===email){u.status=st;u.reviewedBy=S.me.email;u.reviewedAt='just now'}});
    toast(st==='approved'?'Approved '+email:'Access removed for '+email);
    renderMain();
  }catch(e){toast(e.message,true);btn.disabled=false}
  finally{S.busy=false}
}

function renderEntry(){
  var st=storeById(S.store);
  var rec=currentRec();
  var lySet=!!rec&&rec.ly!=='';
  var hasWin=!!rec&&WINS.some(function(w){return rec.w[w.k].sales!==''});
  var canEditLY=isAdmin()||!hasWin;
  var nx=nextWin(rec);
  if(!S.win)S.win=nx||'FINAL';
  var dis=lySet?'':' disabled';

  var h='<div class="row between"><h2>Encode sales</h2><span class="muted sm">'+esc(fmtDate(S.date))+'</span></div>';
  h+='<div class="grid2"><label>Hakot Day date<input type="date" id="fDate" value="'+esc(S.date)+'"></label>';
  if(allStores())h+='<label>Store<select id="fStore">'+storeOptions(S.store)+'</select></label>';
  else h+='<label>Store<input disabled value="'+esc(st?st.id+' · '+st.name:S.me.storeId+' · '+S.me.storeName)+'"></label>';
  h+='</div>';

  // Step 1: Last Year
  h+='<div class="step"><div class="step-title"><span class="num">1</span>Last Year (LY)'+(lySet?' <span class="badge">Saved</span>':' <span class="badge warn">Required first</span>')+'</div>';
  if(!lySet||S.editLY){
    h+='<p class="hint">Enter the store sales and transaction count from the same day last year. This unlocks the time windows. Use 0 for new stores.</p>';
    h+='<div class="grid2"><label>Sales Last Year<input id="fLySales" inputmode="decimal" autocomplete="off" value="'+esc(lySet?rec.ly:'')+'"></label><label>TRX Count LY<input id="fLyTrx" inputmode="numeric" autocomplete="off" value="'+esc(lySet?rec.trxLy:'')+'"></label></div>';
    h+='<div class="actions"><button class="btn primary" data-act="saveLY">Save Last Year</button>'+(S.editLY?'<button class="btn ghost" data-act="cancelLY">Cancel</button>':'')+'</div>';
  }else{
    h+='<div class="lyshow"><div><small>Sales Last Year</small><b>'+money(rec.ly)+'</b></div><div><small>TRX Count LY</small><b>'+int(rec.trxLy)+'</b></div><div class="sp" style="flex:1"></div>'+(canEditLY?'<button class="btn ghost sm" data-act="editLY">Edit</button>':'<span class="muted sm">Locked · ask admin to change</span>')+'</div>';
  }
  h+='</div>';

  // Step 2: time windows
  var cur=rec?rec.w[S.win]:{sales:'',trx:''};
  h+='<div class="step'+(lySet?'':' disabled')+'"><div class="step-title"><span class="num">2</span>Time window sales <span class="muted sm" style="font-weight:500">(running total for the day)</span></div>';
  h+='<div class="chips">'+WINS.map(function(w){
    var done=!!rec&&rec.w[w.k].sales!=='';
    var cls='chip'+(done?' done':'')+(S.win===w.k?' sel':'')+(nx===w.k?' next':'');
    return '<button class="'+cls+'" data-act="win" data-k="'+w.k+'"'+dis+'>'+(done?'✓ ':'')+w.l+'</button>';
  }).join('')+'</div>';
  h+='<div class="grid2"><label>Sales · '+esc(winLabel(S.win))+'<input id="fSales" inputmode="decimal" autocomplete="off" value="'+esc(cur.sales)+'"'+dis+'></label><label>TRX count · '+esc(winLabel(S.win))+'<input id="fTrx" inputmode="numeric" autocomplete="off" value="'+esc(cur.trx)+'"'+dis+'></label></div>';
  h+='<div class="preview" id="preview"></div>';
  h+='<div class="actions"><button class="btn primary" data-act="saveWin"'+dis+'>'+(cur.sales!==''?'Update ':'Save ')+esc(winLabel(S.win))+'</button></div></div>';
  $('entry').innerHTML=h;
  updatePreview();
}

function prevSaved(rec,key){
  if(!rec)return null;var idx=WINS.findIndex(function(w){return w.k===key});
  for(var i=idx-1;i>=0;i--){var v=rec.w[WINS[i].k];if(v.sales!=='')return {k:WINS[i].k,sales:v.sales,trx:v.trx}}
  return null;
}
function laterSaved(rec,key){
  if(!rec)return null;var idx=WINS.findIndex(function(w){return w.k===key});
  for(var i=idx+1;i<WINS.length;i++){var v=rec.w[WINS[i].k];if(v.sales!=='')return {k:WINS[i].k,sales:v.sales,trx:v.trx}}
  return null;
}

function updatePreview(){
  var el=$('preview');if(!el)return;
  var rec=currentRec();var ly=rec?rec.ly:'';
  var s=num($('fSales')?$('fSales').value:''),t=num($('fTrx')?$('fTrx').value:'');
  var b=basket(s,t),v=vsly(s,ly),p=prevSaved(rec,S.win);
  var h='<div class="pv"><small>Basket size</small><b>'+(b==null?'—':money(b))+'</b></div>';
  h+='<div class="pv"><small>VS LY</small><b class="'+(v==null?'':(v>=1?'good':''))+'">'+(v==null?'—':pct(v))+'</b></div>';
  if(p){var d=s===''?null:s-p.sales;h+='<div class="pv"><small>vs '+esc(winLabel(p.k))+'</small><b class="'+(d==null?'':(d<0?'bad':'good'))+'">'+(d==null?'—':(d>=0?'+':'')+money(d))+'</b></div>'}
  el.innerHTML=h;
}

function winCells(o,shade){
  var cls=shade?' class="w1"':'';
  var vs=o.vs==null?'':'<span class="'+(o.vs>=1?'good':'')+'">'+pct(o.vs)+'</span>';
  return '<td'+cls+'>'+money(o.sales)+'</td><td'+cls+'>'+int(o.trx)+'</td><td'+cls+'>'+(o.basket==null?'':money(o.basket))+'</td><td'+cls+'>'+vs+'</td>';
}
function recWin(rec,k){var v=rec.w[k];return {sales:v.sales,trx:v.trx,basket:basket(v.sales,v.trx),vs:vsly(v.sales,rec.ly)}}
function recCells(rec){return WINS.map(function(w,i){return winCells(recWin(rec,w.k),i%2===0)}).join('')}

// Subtotals: VS LY compares only stores that reported that window and have LY.
function agg(recs){
  var o={ly:'',trxLy:'',w:{}};
  recs.forEach(function(r){if(r.ly!=='')o.ly=(o.ly||0)+r.ly;if(r.trxLy!=='')o.trxLy=(o.trxLy||0)+r.trxLy});
  WINS.forEach(function(w){
    var s=0,t=0,sl=0,l=0,n=0;
    recs.forEach(function(r){var v=r.w[w.k];if(v.sales!==''){n++;s+=v.sales;t+=(v.trx||0);if(r.ly>0){sl+=v.sales;l+=r.ly}}});
    o.w[w.k]={sales:n?s:'',trx:n?t:'',basket:t>0?s/t:null,vs:l>0?sl/l:null};
  });
  return o;
}
function aggCells(a){return WINS.map(function(w,i){return winCells(a.w[w.k],i%2===0)}).join('')}

function thead(first){
  var h='<thead><tr>'+first.map(function(f,i){return '<th rowspan="2" class="'+(i===f.stick?'stick l':'')+(f.l?' l':'')+'">'+f.t+'</th>'}).join('');
  h+=WINS.map(function(w){return '<th colspan="4">'+w.l.toUpperCase()+'</th>'}).join('')+'</tr><tr>';
  h+=WINS.map(function(){return '<th>Sales</th><th>TRX</th><th>Basket</th><th>VS LY</th>'}).join('')+'</tr></thead>';
  return h;
}

function renderTable(){
  var h;
  if(allStores()){
    var byId={};S.rows.forEach(function(r){if(r.date===S.date)byId[r.storeId]=r});
    var areas=[],by={};
    S.stores.forEach(function(s){if(!by[s.area]){by[s.area]=[];areas.push(s.area)}by[s.area].push(s)});
    var finals=S.stores.filter(function(s){var r=byId[s.id];return r&&r.w.FINAL.sales!==''}).length;
    var started=S.stores.filter(function(s){return !!byId[s.id]}).length;
    var total=S.stores.length||1;
    h='<div class="row between"><div><h2>All stores · '+esc(fmtDate(S.date))+'</h2><div class="muted sm">'+started+' of '+S.stores.length+' stores started · '+finals+' with final sales</div></div><button class="btn ghost sm" data-act="refresh">Refresh</button></div>';
    h+='<div class="progress"><i style="width:'+Math.round(finals/total*100)+'%"></i></div>';
    h+='<div class="tscroll"><table>'+thead([{t:'Store ID',l:1,stick:-1},{t:'Store name',l:1,stick:1},{t:'Sales LY',stick:-1},{t:'TRX LY',stick:-1}])+'<tbody>';
    var allRecs=[];
    areas.forEach(function(a){
      var recs=[];
      h+='<tr class="area"><td colspan="'+(4+WINS.length*4)+'">'+esc(a)+'</td></tr>';
      by[a].forEach(function(s){
        var r=byId[s.id]||blankRec(s);if(byId[s.id])recs.push(r);
        h+='<tr class="clickable'+(String(S.store)===s.id?' cur':'')+'" data-act="pick" data-id="'+esc(s.id)+'"><td class="l">'+esc(s.id)+'</td><td class="l stick">'+esc(s.name)+(s.remarks&&s.remarks.toLowerCase()==='new'?' <span class="badge">New</span>':'')+'</td><td>'+money(r.ly)+'</td><td>'+int(r.trxLy)+'</td>'+recCells(r)+'</tr>';
      });
      var ag=agg(recs);allRecs=allRecs.concat(recs);
      h+='<tr class="sub"><td class="l"></td><td class="l stick">Sub total</td><td>'+money(ag.ly)+'</td><td>'+int(ag.trxLy)+'</td>'+aggCells(ag)+'</tr>';
    });
    var g=agg(allRecs);
    h+='<tr class="grand"><td class="l"></td><td class="l stick">Grand total</td><td>'+money(g.ly)+'</td><td>'+int(g.trxLy)+'</td>'+aggCells(g)+'</tr>';
    h+='</tbody></table></div>';
  }else{
    var rows=S.rows.slice().sort(function(a,b){return a.date<b.date?1:-1});
    h='<div class="row between"><div><h2>My store · '+esc(S.me.storeName)+'</h2><div class="muted sm">'+rows.length+' Hakot Day'+(rows.length===1?'':'s')+' encoded · tap a row to open that date</div></div><button class="btn ghost sm" data-act="refresh">Refresh</button></div>';
    if(!rows.length){h+='<div class="empty">No entries yet. Start with the Last Year figures above.</div>'}
    else{
      h+='<div class="tscroll"><table>'+thead([{t:'Date',l:1,stick:0},{t:'Sales LY',stick:-1},{t:'TRX LY',stick:-1}])+'<tbody>';
      rows.forEach(function(r){
        h+='<tr class="clickable'+(r.date===S.date?' cur':'')+'" data-act="pickDate" data-d="'+esc(r.date)+'"><td class="l stick">'+esc(fmtDate(r.date))+'</td><td>'+money(r.ly)+'</td><td>'+int(r.trxLy)+'</td>'+recCells(r)+'</tr>';
      });
      h+='</tbody></table></div>';
    }
  }
  $('tbl').innerHTML=h;
}

// ---------- Actions ----------
async function withBusy(btn,fn){
  if(S.busy)return;S.busy=true;var old=btn?btn.textContent:'';
  if(btn){btn.disabled=true;btn.textContent='Saving…'}
  try{await fn()}catch(e){toast(e.message,true);if(e.status===401){S.me=null;S.authNote={kind:'warn',title:'Signed out',text:e.message};render()}}
  finally{S.busy=false;if(btn&&document.body.contains(btn)){btn.disabled=false;btn.textContent=old}}
}

async function saveLY(btn){
  var s=num($('fLySales').value),t=num($('fLyTrx').value);
  if(s===''||t===''){toast('Enter both Sales Last Year and TRX Count LY.',true);return}
  if(s===0&&!confirm('Sales Last Year is 0. Save it anyway (new store)?'))return;
  await withBusy(btn,async function(){
    var j=await api('/api/save',{date:S.date,storeId:S.store,ly:{sales:s,trx:t}});
    upsert(j.rec);S.editLY=false;S.win=nextWin(j.rec)||'FINAL';
    toast('Last Year figures saved');renderEntry();renderTable();
  });
}

async function saveWin(btn){
  var rec=currentRec();var s=num($('fSales').value),t=num($('fTrx').value);
  if(s===''){toast('Enter the sales amount.',true);return}
  if(t===''){toast('Enter the TRX count.',true);return}
  var p=prevSaved(rec,S.win),q=laterSaved(rec,S.win);
  if(p&&s<p.sales&&!confirm('Sales ('+money(s)+') is lower than '+winLabel(p.k)+' ('+money(p.sales)+'). Sales are a running total for the day. Save anyway?'))return;
  if(q&&s>q.sales&&!confirm('Sales ('+money(s)+') is higher than the later '+winLabel(q.k)+' entry ('+money(q.sales)+'). Save anyway?'))return;
  if(rec&&rec.w[S.win].sales!==''&&!confirm('Replace the saved '+winLabel(S.win)+' entry ('+money(rec.w[S.win].sales)+' / '+int(rec.w[S.win].trx)+')?'))return;
  await withBusy(btn,async function(){
    var j=await api('/api/save',{date:S.date,storeId:S.store,window:{key:S.win,sales:s,trx:t}});
    upsert(j.rec);toast(winLabel(S.win)+' saved');
    S.win=nextWin(j.rec)||S.win;renderEntry();renderTable();
  });
}

async function refresh(){
  try{await loadData();renderEntry();renderTable();toast('Updated')}catch(e){toast(e.message,true)}
}

document.addEventListener('click',function(e){
  var el=e.target.closest('[data-act]');if(!el||el.disabled)return;
  var a=el.getAttribute('data-act');
  if(a==='tab'){S.authTab=el.getAttribute('data-t');S.authNote=null;renderAuth()}
  else if(a==='logout'){api('/api/logout',{}).catch(function(){}).then(function(){S.me=null;S.rows=[];S.users=[];S.view='sales';S.authTab='login';S.authNote=null;render()})}
  else if(a==='saveLY'){saveLY(el)}
  else if(a==='editLY'){S.editLY=true;renderEntry()}
  else if(a==='cancelLY'){S.editLY=false;renderEntry()}
  else if(a==='win'){S.win=el.getAttribute('data-k');renderEntry();var f=$('fSales');if(f)f.focus()}
  else if(a==='saveWin'){saveWin(el)}
  else if(a==='refresh'){refresh()}
  else if(a==='view'){S.view=el.getAttribute('data-v');renderMain();if(S.view==='users')loadUsers().then(renderMain).catch(function(er){toast(er.message,true)})}
  else if(a==='refreshUsers'){loadUsers().then(function(){renderMain();toast('Updated')}).catch(function(er){toast(er.message,true)})}
  else if(a==='setStatus'){setStatus(el)}
  else if(a==='pick'){S.store=el.getAttribute('data-id');S.win=null;S.editLY=false;renderEntry();renderTable();window.scrollTo({top:0,behavior:'smooth'})}
  else if(a==='pickDate'){S.date=el.getAttribute('data-d');S.win=null;S.editLY=false;renderEntry();renderTable();window.scrollTo({top:0,behavior:'smooth'})}
});

document.addEventListener('change',async function(e){
  var id=e.target.id;
  if(id==='fDate'&&e.target.value){
    S.date=e.target.value;S.win=null;S.editLY=false;
    if(allStores()){try{await loadData()}catch(er){toast(er.message,true)}}
    renderEntry();renderTable();
  }else if(id==='fStore'){S.store=e.target.value;S.win=null;S.editLY=false;renderEntry();renderTable()}
});

document.addEventListener('input',function(e){if(e.target.id==='fSales'||e.target.id==='fTrx')updatePreview()});

document.addEventListener('keydown',function(e){
  if(e.key!=='Enter')return;var id=e.target.id;
  if(id==='fSales'){e.preventDefault();$('fTrx').focus()}
  else if(id==='fTrx'){e.preventDefault();var b=document.querySelector('[data-act=saveWin]');if(b)saveWin(b)}
  else if(id==='fLySales'){e.preventDefault();$('fLyTrx').focus()}
  else if(id==='fLyTrx'){e.preventDefault();var c=document.querySelector('[data-act=saveLY]');if(c)saveLY(c)}
});

document.addEventListener('submit',async function(e){
  var f=e.target;var kind=f.getAttribute('data-form');if(!kind)return;e.preventDefault();
  var data={};new FormData(f).forEach(function(v,k){data[k]=v});
  var btn=f.querySelector('button[type=submit]');var old=btn.textContent;btn.disabled=true;btn.textContent='Please wait…';
  try{
    var j=await api('/api/'+kind,data);
    if(j.pending){
      S.authTab='login';
      S.authNote={kind:'ok',title:'Account submitted',text:'Thanks, '+data.name+'. An admin needs to approve your account before you can log in.'};
      renderAuth();return;
    }
    S.me=j.user;S.store=defaultStore();S.date=todayPH();S.win=null;S.authNote=null;S.view='sales';
    await loadData();
    if(isAdmin()){try{await loadUsers()}catch(e2){}}
    render();toast('Welcome, '+S.me.name);
  }catch(er){
    if(er.status===403){S.authNote={kind:'warn',title:'Cannot log in yet',text:er.message};renderAuth();return}
    toast(er.message,true);btn.disabled=false;btn.textContent=old;
  }
});

(async function boot(){
  if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch(function(){})}
  try{S.stores=(await api('/api/stores')).stores||[]}catch(e){S.storesError=e.message}
  try{S.me=(await api('/api/me')).user}
  catch(e){S.me=null;if(e.status===401&&e.message!=='Please log in.')S.authNote={kind:'warn',title:'Signed out',text:e.message}}
  if(S.me){
    S.store=defaultStore();try{await loadData()}catch(e){toast(e.message,true)}
    if(isAdmin()){try{await loadUsers()}catch(e){}}
  }
  render();
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.type('html').set('Cache-Control', 'no-cache').send(PAGE));

// ---------- Errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Server error' });
});

if (require.main === module) {
  app.listen(PORT, () => console.log('Hakot Day running on http://localhost:' + PORT));
}
module.exports = app;
