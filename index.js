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
// Users!G Role: 'user' (store account, encodes one store), 'areamanager' (views chosen stores), 'admin'.
const ROLE_LABELS = { user: 'Store', areamanager: 'Area manager', admin: 'Admin' };
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
  // Day-total block beside FINAL SALES (AI..AL).
  const tot = await getValues(DATA_SHEET + '!AI1:AL2');
  if (idStr((tot[0] || [])[0]) !== 'TOTAL') {
    await putValues(DATA_SHEET + '!AI1:AL2', [['TOTAL', '', '', ''], ['Sales', 'TRX', 'Basket Size', 'VS LY']]);
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

// Each window holds that slot's own sales/TRX (not a running total).
// Per slot: Basket = slot sales / slot TRX; VS LY = running total through that slot / Sales LY.
// AI..AL: TOTAL Sales, TRX, Basket, VS LY = sum of all saved slots.
const pctText = (v, ly) => (ly > 0 ? ((v / ly) * 100).toFixed(2) + '%' : '');
const basketOf = (s, t) => (t > 0 ? Math.round((s / t) * 100) / 100 : '');
function recToCells(rec) {
  const id = /^\d+$/.test(rec.storeId) ? Number(rec.storeId) : safeText(rec.storeId);
  const out = [rec.date, safeText(rec.area), id, safeText(rec.storeName), rec.ly, rec.trxLy];
  let cumSales = 0, cumTrx = 0, any = false;
  WINDOWS.forEach(w => {
    const { sales, trx } = rec.w[w.key];
    if (sales === '') { out.push('', trx, '', ''); return; }
    any = true; cumSales += sales; cumTrx += trx === '' ? 0 : trx;
    out.push(sales, trx, trx !== '' ? basketOf(sales, trx) : '', pctText(cumSales, rec.ly));
  });
  out.push(any ? cumSales : '', any ? cumTrx : '', any ? basketOf(cumSales, cumTrx) : '', any ? pctText(cumSales, rec.ly) : '');
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
  // Users!D StoreID holds one ID for store accounts, or "ALL" / "105, 138, …" for area managers.
  const ids = idStr(u.storeId).split(',').map(x => x.trim()).filter(Boolean);
  const role = (ADMIN_EMAILS.includes(u.email) || u.role === 'admin') ? 'admin'
    : (u.role === 'areamanager' || ids.includes(ALL_STORES.id) || ids.length > 1) ? 'areamanager' : 'user';
  const viewer = role !== 'user'; // admins and area managers only view; store accounts encode
  // scope: store IDs this account may see; null = every store.
  const scope = role === 'admin' || ids.includes(ALL_STORES.id) ? null : (viewer ? ids : ids.slice(0, 1));
  return {
    email: u.email, name: u.name, storeId: u.storeId, storeName: u.storeName, area: u.area,
    role, roleLabel: ROLE_LABELS[role], viewer, scope,
  };
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
  const isArea = req.body.position === 'area';
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!name) return res.status(400).json({ error: 'Enter your name.' });
  const stores = await loadStores();
  let store;
  if (isArea) {
    // Area manager: "ALL" or a list of store IDs.
    const raw = req.body.storeIds;
    const ids = raw === ALL_STORES.id ? [] : (Array.isArray(raw) ? raw : []).map(idStr);
    const picked = stores.filter(s => ids.includes(s.id));
    if (raw !== ALL_STORES.id && !picked.length) return res.status(400).json({ error: 'Select the stores you manage.' });
    if (raw === ALL_STORES.id || picked.length === stores.length) {
      store = ALL_STORES;
    } else {
      store = {
        id: "'" + picked.map(s => s.id).join(', '), // leading ' keeps Sheets from reading it as a number
        name: picked.map(s => s.name).join(', '),
        area: Array.from(new Set(picked.map(s => s.area))).join(', '),
      };
    }
  } else {
    store = stores.find(s => s.id === idStr(req.body.storeId));
    if (!store) return res.status(400).json({ error: 'Select your store.' });
  }
  const role = isArea ? 'areamanager' : 'user';
  const users = await loadUsers();
  if (users.some(u => u.email === email)) return res.status(409).json({ error: 'This email is already registered. Please log in.' });
  const autoApproved = ADMIN_EMAILS.includes(email);
  await appendValues(USERS_SHEET + '!A:K', [[
    safeText(email), hashPassword(password), safeText(name), Number(store.id) || store.id,
    safeText(store.name), safeText(store.area), role, nowPH(),
    autoApproved ? 'approved' : 'pending', autoApproved ? 'ADMIN_EMAILS' : '', autoApproved ? nowPH() : '',
  ]]);
  if (!autoApproved) return res.json({ pending: true });
  setSessionCookie(req, res, email);
  res.json({ user: publicUser({ email, name, storeId: store.id.replace(/^'/, ''), storeName: store.name, area: store.area, role }) });
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

// Store account: every Hakot Day row of its store. Admin / area manager: their stores for the chosen date.
app.get('/api/data', requireUser, wrap(async (req, res) => {
  const all = await loadData();
  const scope = req.user.scope;
  let rows = scope ? all.filter(r => scope.includes(r.storeId)) : all;
  if (req.user.viewer) {
    const date = idStr(req.query.date);
    if (date) rows = rows.filter(r => r.date === date);
  }
  res.json({ rows: rows.map(publicRec) });
}));

app.post('/api/save', requireUser, wrap(async (req, res) => {
  // Admin / area-manager accounts are view-only; only store accounts encode.
  if (req.user.viewer) {
    return res.status(403).json({ error: 'Admin and area manager accounts are view-only. Only store accounts can encode.' });
  }
  const date = idStr(req.body.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date.' });
  const storeId = req.user.storeId;
  const store = (await loadStores()).find(s => s.id === storeId);
  if (!store) return res.status(400).json({ error: 'Select a store from ListOfStores.' });

  const all = await loadData();
  const existing = all.find(r => r.date === date && r.storeId === storeId);
  const rec = existing || {
    date, storeId, ly: '', trxLy: '', w: Object.fromEntries(WINDOWS.map(w => [w.key, { sales: '', trx: '' }])),
  };
  rec.area = store.area;
  rec.storeName = store.name;
  let logEntry;

  if (req.body.ly) {
    const sales = num(req.body.ly.sales), trx = num(req.body.ly.trx);
    if (sales === '' || sales < 0 || trx === '' || trx < 0) {
      return res.status(400).json({ error: 'Enter Sales Last Year and TRX Count LY (use 0 for new stores).' });
    }
    rec.ly = sales; rec.trxLy = Math.round(trx);
    logEntry = ['LY', sales, Math.round(trx)];
  } else if (req.body.window) {
    const key = idStr(req.body.window.key);
    const w = WINDOWS.find(x => x.key === key);
    if (!w) return res.status(400).json({ error: 'Unknown time window.' });
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
    await putValues(DATA_SHEET + '!A' + existing.row + ':AL' + existing.row, [cells]);
  } else {
    await appendValues(DATA_SHEET + '!A:AL', [cells]);
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
  '<rect width="512" height="512" rx="112" fill="#0b1f3a"/>' +
  '<rect x="112" y="272" width="64" height="128" rx="16" fill="#60a5fa"/>' +
  '<rect x="224" y="192" width="64" height="208" rx="16" fill="#bfdbfe"/>' +
  '<rect x="336" y="112" width="64" height="288" rx="16" fill="#ffffff"/></svg>';

const MANIFEST = {
  name: 'Hakot Day Sales',
  short_name: 'Hakot Day',
  start_url: '/',
  display: 'standalone',
  background_color: '#f3f5f8',
  theme_color: '#0b1f3a',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
};

const SW_JS = String.raw`
const CACHE = 'hakot-day-v2';
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
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Hakot Day Sales</title>
<meta name="description" content="Hour-by-hour Hakot Day sales encoding and performance against last year.">
<meta name="theme-color" content="#ffffff">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Hakot Day">
<script>
(function(){try{document.documentElement.setAttribute('data-theme',localStorage.getItem('hd-theme')||'light')}catch(e){}})();
</script>
<style>
/* ================= Design tokens ================= */
:root{
  --font:Inter,"Segoe UI Variable Text","Segoe UI",Roboto,system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  --r-sm:6px;--r-md:8px;--r-lg:10px;
  --ease:cubic-bezier(.2,0,.2,1);--t:180ms;
  --sidebar-w:244px;--sidebar-wc:68px;--header-h:56px;
}
:root,:root[data-theme="light"]{
  color-scheme:light;
  --bg:#f3f5f8;--surface:#ffffff;--surface-2:#f8fafc;--surface-3:#eef2f6;
  --border:#e3e8ef;--border-strong:#cdd5e0;
  --text:#1f2937;--text-2:#4b5563;--text-3:#6b7280;
  --primary:#1d4ed8;--primary-hover:#1e40af;--primary-soft:#eaf0fd;--primary-ink:#ffffff;
  --nav-bg:#0b1f3a;--nav-text:#c9d4e4;--nav-muted:#8a9bb5;--nav-hover:rgba(255,255,255,.06);--nav-active:rgba(255,255,255,.11);--nav-accent:#60a5fa;--nav-line:rgba(255,255,255,.07);
  --success:#15803d;--success-bg:#e7f5ec;--danger:#b91c1c;--danger-bg:#fdecec;--warning:#a16207;--warning-bg:#fdf4e1;--info:#1d4ed8;--info-bg:#eaf0fd;--neutral:#4b5563;--neutral-bg:#eef1f5;
  --series:#2a78d6;--series-wash:rgba(42,120,214,.10);--track:#dbe7fb;--grid:#e9edf2;--axis:#c3cad4;--good-fill:#0ca30c;
  --group:#f2f5f9;--total:#f7f9fb;--hover:#f5f8fc;--sel:#eef4fe;
  --shadow-1:0 1px 2px rgba(16,24,40,.05);--shadow-2:0 4px 12px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.06);--shadow-3:0 18px 44px rgba(16,24,40,.20);
  --ring:0 0 0 3px rgba(37,99,235,.32);
  --skel:#e8ecf1;--skel-hi:#f4f6f9;
  --tip-bg:#0f172a;--tip-text:#f8fafc;
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0e131a;--surface:#161c25;--surface-2:#1a212c;--surface-3:#212a36;
  --border:#27313f;--border-strong:#354255;
  --text:#e5eaf1;--text-2:#b3bfcd;--text-3:#8e9bac;
  --primary:#2563eb;--primary-hover:#3b74f0;--primary-soft:rgba(59,130,246,.16);--primary-ink:#ffffff;
  --nav-bg:#0a0f16;--nav-text:#c2cbd8;--nav-muted:#7f8c9e;--nav-hover:rgba(255,255,255,.05);--nav-active:rgba(255,255,255,.09);--nav-accent:#60a5fa;--nav-line:rgba(255,255,255,.06);
  --success:#4ade80;--success-bg:rgba(34,197,94,.14);--danger:#f87171;--danger-bg:rgba(239,68,68,.14);--warning:#fbbf24;--warning-bg:rgba(245,158,11,.14);--info:#60a5fa;--info-bg:rgba(59,130,246,.15);--neutral:#b3bfcd;--neutral-bg:rgba(148,163,184,.13);
  --series:#3987e5;--series-wash:rgba(57,135,229,.16);--track:#1f3350;--grid:#222b37;--axis:#3a4656;--good-fill:#0ca30c;
  --group:#1b232e;--total:#19202a;--hover:#1c2531;--sel:#1b2638;
  --shadow-1:0 1px 2px rgba(0,0,0,.3);--shadow-2:0 4px 14px rgba(0,0,0,.35);--shadow-3:0 18px 44px rgba(0,0,0,.55);
  --ring:0 0 0 3px rgba(96,165,250,.45);
  --skel:#1f2732;--skel-hi:#28323f;
  --tip-bg:#e5eaf1;--tip-text:#0f172a;
}
@media (prefers-color-scheme:dark){
  :root[data-theme="system"]{
    color-scheme:dark;
    --bg:#0e131a;--surface:#161c25;--surface-2:#1a212c;--surface-3:#212a36;
    --border:#27313f;--border-strong:#354255;
    --text:#e5eaf1;--text-2:#b3bfcd;--text-3:#8e9bac;
    --primary:#2563eb;--primary-hover:#3b74f0;--primary-soft:rgba(59,130,246,.16);--primary-ink:#ffffff;
    --nav-bg:#0a0f16;--nav-text:#c2cbd8;--nav-muted:#7f8c9e;--nav-hover:rgba(255,255,255,.05);--nav-active:rgba(255,255,255,.09);--nav-accent:#60a5fa;--nav-line:rgba(255,255,255,.06);
    --success:#4ade80;--success-bg:rgba(34,197,94,.14);--danger:#f87171;--danger-bg:rgba(239,68,68,.14);--warning:#fbbf24;--warning-bg:rgba(245,158,11,.14);--info:#60a5fa;--info-bg:rgba(59,130,246,.15);--neutral:#b3bfcd;--neutral-bg:rgba(148,163,184,.13);
    --series:#3987e5;--series-wash:rgba(57,135,229,.16);--track:#1f3350;--grid:#222b37;--axis:#3a4656;--good-fill:#0ca30c;
    --group:#1b232e;--total:#19202a;--hover:#1c2531;--sel:#1b2638;
    --shadow-1:0 1px 2px rgba(0,0,0,.3);--shadow-2:0 4px 14px rgba(0,0,0,.35);--shadow-3:0 18px 44px rgba(0,0,0,.55);
    --ring:0 0 0 3px rgba(96,165,250,.45);
    --skel:#1f2732;--skel-hi:#28323f;
    --tip-bg:#e5eaf1;--tip-text:#0f172a;
  }
}

/* ================= Base ================= */
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
button,input,select,textarea{font:inherit;color:inherit}
a{color:var(--primary)}
h1,h2,h3{margin:0;font-weight:600;letter-spacing:-.005em}
.ic{width:16px;height:16px;flex:none;display:inline-block;vertical-align:middle}
:focus{outline:none}
:focus-visible{box-shadow:var(--ring);outline:none}
.sr-only{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.skip{position:absolute;left:12px;top:-60px;z-index:200;background:var(--primary);color:#fff;border:0;border-radius:var(--r-sm);padding:8px 14px;font-weight:600;cursor:pointer}
.skip:focus{top:12px}
.muted{color:var(--text-3)}
.num,.tnum{font-variant-numeric:tabular-nums}
.sp{flex:1}
[hidden]{display:none!important}

/* ================= Shell ================= */
.shell{display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr);min-height:100vh;min-height:100dvh;transition:grid-template-columns var(--t) var(--ease)}
.sidebar{position:sticky;top:0;height:100vh;height:100dvh;background:var(--nav-bg);color:var(--nav-text);display:flex;flex-direction:column;z-index:40;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom);overflow:hidden}
.brand{display:flex;align-items:center;gap:10px;height:var(--header-h);padding:0 16px;border-bottom:1px solid var(--nav-line);flex:none}
.brand-mark{width:30px;height:30px;flex:none;display:block}
.brand-text{min-width:0}
.brand-name{font-weight:650;color:#fff;font-size:14.5px;line-height:1.2;white-space:nowrap}
.brand-sub{font-size:11.5px;color:var(--nav-muted);white-space:nowrap}
.nav{flex:1;overflow-y:auto;overflow-x:hidden;padding:8px 10px 12px}
.nav-sec{font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--nav-muted);padding:16px 10px 6px;white-space:nowrap}
.nav-item{position:relative;display:flex;align-items:center;gap:12px;width:100%;height:38px;padding:0 10px;margin:1px 0;border:0;background:transparent;color:var(--nav-text);border-radius:var(--r-sm);font-size:13.5px;font-weight:500;cursor:pointer;text-decoration:none;white-space:nowrap;transition:background var(--t) var(--ease),color var(--t) var(--ease)}
.nav-item .ic{width:18px;height:18px}
.nav-item:hover{background:var(--nav-hover);color:#fff}
.nav-item[aria-current="page"]{background:var(--nav-active);color:#fff;font-weight:600}
.nav-item[aria-current="page"]::before{content:"";position:absolute;left:-10px;top:9px;bottom:9px;width:3px;border-radius:0 3px 3px 0;background:var(--nav-accent)}
.nav-count{margin-left:auto;background:#dc2626;color:#fff;font-size:11px;font-weight:700;border-radius:99px;padding:0 7px;line-height:18px;min-width:20px;text-align:center}
.sidebar-foot{padding:8px 10px;border-top:1px solid var(--nav-line);flex:none}
.main{min-width:0;display:flex;flex-direction:column}
.topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:8px;height:calc(var(--header-h) + env(safe-area-inset-top));padding:env(safe-area-inset-top) 20px 0;background:var(--surface);border-bottom:1px solid var(--border)}
.crumbs{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text-3);min-width:0;white-space:nowrap;overflow:hidden}
.crumbs .sep{width:14px;height:14px;opacity:.6}
.crumb-cur{color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis}
.topbar .menu-btn{display:none}
.scrim{display:none}
.offline-pill{display:none;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:99px;background:var(--warning-bg);color:var(--warning);font-size:12px;font-weight:600}
body.is-offline .offline-pill{display:inline-flex}
.user-btn{display:flex;align-items:center;gap:10px;height:40px;padding:0 8px 0 4px;border:1px solid transparent;border-radius:var(--r-md);background:transparent;cursor:pointer;transition:background var(--t)}
.user-btn:hover{background:var(--surface-3)}
.avatar{width:32px;height:32px;border-radius:50%;background:var(--primary-soft);color:var(--primary);display:grid;place-items:center;font-size:12.5px;font-weight:700;flex:none}
.user-meta{display:grid;text-align:left;line-height:1.25}
.user-name{font-size:13px;font-weight:600;color:var(--text);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.user-role{font-size:11.5px;color:var(--text-3);white-space:nowrap}
.user-btn .chev{width:14px;height:14px;color:var(--text-3)}
.content{width:100%;max-width:1480px;margin:0 auto;padding:24px 28px 40px}
.content:focus{box-shadow:none}

@media (min-width:1025px){
  .shell.collapsed{grid-template-columns:var(--sidebar-wc) minmax(0,1fr)}
  .shell.collapsed .brand{padding:0 19px}
  .shell.collapsed .brand-text,.shell.collapsed .nav-label,.shell.collapsed .nav-count{display:none}
  .shell.collapsed .nav-sec{height:1px;padding:0;margin:12px 8px;background:var(--nav-line);font-size:0}
  .shell.collapsed .nav-item{justify-content:center;padding:0}
  .shell.collapsed .nav-item[data-count]::after{content:"";position:absolute;top:8px;right:12px;width:7px;height:7px;border-radius:50%;background:#ef4444}
  .shell.collapsed .nav-item:hover .tipx{display:block}
  .shell.collapsed .collapse-btn .ic{transform:scaleX(-1)}
}
.tipx{display:none;position:absolute;left:calc(100% + 12px);top:50%;transform:translateY(-50%);background:var(--tip-bg);color:var(--tip-text);padding:5px 9px;border-radius:var(--r-sm);font-size:12px;font-weight:500;white-space:nowrap;box-shadow:var(--shadow-2);pointer-events:none;z-index:60}
.has-tip{position:relative}
.has-tip:hover::after,.has-tip:focus-visible::after{content:attr(data-tip);position:absolute;top:calc(100% + 6px);left:50%;transform:translateX(-50%);background:var(--tip-bg);color:var(--tip-text);padding:5px 9px;border-radius:var(--r-sm);font-size:12px;font-weight:500;white-space:nowrap;box-shadow:var(--shadow-2);pointer-events:none;z-index:60}

@media (max-width:1024px){
  .shell,.shell.collapsed{grid-template-columns:minmax(0,1fr)}
  .sidebar{position:fixed;left:0;top:0;bottom:0;height:auto;width:min(284px,86vw);transform:translateX(-102%);transition:transform .22s var(--ease);box-shadow:var(--shadow-3)}
  .drawer-open .sidebar{transform:none}
  .scrim{display:block;position:fixed;inset:0;background:rgba(15,23,42,.45);opacity:0;pointer-events:none;transition:opacity .2s var(--ease);z-index:35}
  .drawer-open .scrim{opacity:1;pointer-events:auto}
  .topbar .menu-btn{display:inline-flex}
  .collapse-btn{display:none}
  .topbar{padding-left:10px;padding-right:12px}
  .content{padding:20px 20px 32px}
}
@media (max-width:640px){
  .user-meta,.user-btn .chev,.crumb-root,.crumbs .sep{display:none}
  .content{padding:16px 14px 28px}
}

/* ================= Page structure ================= */
.page-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.page-title{font-size:26px;font-weight:650;letter-spacing:-.015em;line-height:1.2}
.page-sub{color:var(--text-3);font-size:13px;margin-top:4px}
.page-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
@media (max-width:640px){.page-title{font-size:21px}.page-head{margin-bottom:14px}}

.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);box-shadow:var(--shadow-1);min-width:0}
.card+.card{margin-top:16px}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);flex-wrap:wrap}
.card-t{font-size:15px;font-weight:600;line-height:1.3}
.card-s{font-size:12.5px;color:var(--text-3);margin-top:2px}
.card-b{padding:16px}
.toolbar .tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;flex:1 1 auto;justify-content:flex-end}
.sec{padding:16px;border-top:1px solid var(--border)}
.card-h+.sec{border-top:0}
.sec-t{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3)}
.sec-note{font-size:12px;font-weight:500;letter-spacing:0;text-transform:none;color:var(--text-3)}
.grid-2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.mt{margin-top:14px}
.row-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}

/* ================= Buttons ================= */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:36px;padding:0 14px;border-radius:var(--r-sm);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-size:13.5px;font-weight:550;line-height:1;cursor:pointer;white-space:nowrap;text-decoration:none;transition:background var(--t) var(--ease),border-color var(--t) var(--ease),color var(--t) var(--ease),box-shadow var(--t) var(--ease)}
.btn:hover{background:var(--surface-3)}
.btn:active{transform:translateY(.5px)}
.btn-primary{background:var(--primary);border-color:var(--primary);color:var(--primary-ink)}
.btn-primary:hover{background:var(--primary-hover);border-color:var(--primary-hover)}
.btn-ghost{background:transparent;border-color:transparent;color:var(--text-2)}
.btn-ghost:hover{background:var(--surface-3);color:var(--text)}
.btn-danger{color:var(--danger);border-color:var(--border-strong)}
.btn-danger:hover{background:var(--danger-bg);border-color:var(--danger)}
.btn-danger-solid{background:#b91c1c;border-color:#b91c1c;color:#fff}
.btn-danger-solid:hover{background:#991b1b;border-color:#991b1b}
.btn-sm{height:30px;padding:0 10px;font-size:12.5px}
.btn-lg{height:42px;font-size:14px}
.btn-block{width:100%}
.icon-btn{width:36px;padding:0}
.btn-sm.icon-btn{width:30px}
.btn[disabled]{opacity:.55;cursor:not-allowed;transform:none}
.spinner{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite;flex:none}
@keyframes spin{to{transform:rotate(360deg)}}

/* ================= Forms ================= */
.field{display:grid;gap:6px;min-width:0;align-content:start}
.label{font-size:12.5px;font-weight:600;color:var(--text-2)}
.req{color:var(--danger);margin-left:3px}
.input,.select{height:38px;width:100%;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);color:var(--text);padding:0 12px;font-size:14px;transition:border-color var(--t) var(--ease),box-shadow var(--t) var(--ease)}
.select{padding-right:32px;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;cursor:pointer}
.input:hover,.select:hover{border-color:var(--text-3)}
.input:focus,.select:focus{border-color:var(--primary);box-shadow:var(--ring)}
.input[aria-invalid="true"]{border-color:var(--danger)}
.input[aria-invalid="true"]:focus{box-shadow:0 0 0 3px rgba(220,38,38,.25)}
.input:disabled{background:var(--surface-2);color:var(--text-3)}
.input.num{font-variant-numeric:tabular-nums;font-weight:550}
.input-sm,.select-sm{height:32px;font-size:13px}
.help{font-size:12px;color:var(--text-3);margin:8px 0 0}
.err-msg{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--danger);font-weight:500}
.err-msg .ic{width:14px;height:14px}
.adorn{position:relative}
.adorn .pre{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--text-3);font-size:14px;pointer-events:none}
.adorn .input{padding-left:28px}
.adorn .post{position:absolute;right:4px;top:50%;transform:translateY(-50%)}
.adorn.has-post .input{padding-right:42px}
.search{position:relative;min-width:200px;flex:1 1 220px;max-width:320px}
.search .search-ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-3);display:flex}
.search .input{padding-left:32px}
input[type="date"].input{min-width:150px}
@media (max-width:640px){.input,.select{font-size:16px;height:42px}.input-sm,.select-sm{height:38px;font-size:16px}.btn{height:40px}.btn-sm{height:36px}.icon-btn{width:40px}.btn-sm.icon-btn{width:36px}}

/* Radio cards, checks */
.choice-group{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.choice{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border-strong);border-radius:var(--r-md);padding:10px 12px;cursor:pointer;transition:border-color var(--t),background var(--t)}
.choice:hover{border-color:var(--text-3)}
.choice input{margin:3px 0 0;accent-color:var(--primary)}
.choice b{display:block;font-size:13.5px;font-weight:600;color:var(--text)}
.choice span{display:block;font-size:12px;color:var(--text-3)}
.choice.on{border-color:var(--primary);background:var(--primary-soft)}
.chk{display:flex;align-items:center;gap:10px;padding:7px 10px;font-size:13.5px;cursor:pointer;border-radius:var(--r-sm)}
.chk:hover{background:var(--surface-3)}
.chk input{margin:0;width:16px;height:16px;accent-color:var(--primary)}
.picker{border:1px solid var(--border-strong);border-radius:var(--r-md);overflow:hidden}
.picker-head{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:8px 10px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:12.5px;font-weight:600;color:var(--text-2)}
.picker-list{max-height:260px;overflow:auto;padding:4px}
.chk.area{font-weight:600;background:var(--group)}
.chk.st1{padding-left:32px}
.chk.all{font-weight:600}

/* ================= Badges, alerts ================= */
.badge{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:99px;font-size:11.5px;font-weight:600;background:var(--neutral-bg);color:var(--neutral);white-space:nowrap;line-height:1}
.badge .ic{width:12px;height:12px}
.badge .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.badge.success{background:var(--success-bg);color:var(--success)}
.badge.danger{background:var(--danger-bg);color:var(--danger)}
.badge.warning{background:var(--warning-bg);color:var(--warning)}
.badge.info{background:var(--info-bg);color:var(--info)}
.alert{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--border);border-left:3px solid var(--info);background:var(--surface-2);border-radius:var(--r-sm);padding:10px 12px;font-size:13px;color:var(--text-2);margin-bottom:14px}
.alert .ic{width:18px;height:18px;margin-top:1px;color:var(--info)}
.alert b{display:block;color:var(--text);font-weight:600;margin-bottom:1px}
.alert.success{border-left-color:var(--success)}.alert.success .ic{color:var(--success)}
.alert.warning{border-left-color:var(--warning)}.alert.warning .ic{color:var(--warning)}
.alert.danger{border-left-color:var(--danger)}.alert.danger .ic{color:var(--danger)}
.inline-note{display:flex;gap:8px;align-items:center;margin-top:12px;padding:8px 10px;border-radius:var(--r-sm);background:var(--info-bg);color:var(--info);font-size:12.5px;font-weight:500}

/* ================= Tabs ================= */
.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;-ms-overflow-style:none}
.tabs::-webkit-scrollbar{display:none}
.tab{position:relative;display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 12px;border:0;background:none;font-size:13.5px;font-weight:550;color:var(--text-3);cursor:pointer;white-space:nowrap;transition:color var(--t)}
.tab::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:transparent;transition:background var(--t)}
.tab:hover{color:var(--text)}
.tab[aria-selected="true"]{color:var(--text)}
.tab[aria-selected="true"]::after{background:var(--primary)}
.tab .count{font-size:11px;font-weight:700;background:var(--surface-3);color:var(--text-2);border-radius:99px;padding:0 7px;line-height:18px}
.tab[aria-selected="true"] .count{background:var(--primary-soft);color:var(--primary)}
.tabs-bar{padding-top:0;padding-bottom:0}
.tabs-bar .tabs{align-self:stretch}

/* ================= Filter bar ================= */
.filterbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);padding:10px 12px;margin-bottom:16px;box-shadow:var(--shadow-1)}
.fsep{width:1px;height:24px;background:var(--border);margin:0 4px}
.datectl{display:inline-flex;align-items:center;gap:6px}
.fbtn{justify-content:space-between;min-width:150px}
.fbtn b{font-weight:600;color:var(--text)}
.fbtn .lbl{color:var(--text-3);font-weight:500}
@media (max-width:640px){.fsep{display:none}.filterbar{padding:10px}.filterbar>*{flex:1 1 100%}.filterbar .search{max-width:none}.datectl{display:flex}.datectl input{flex:1}}

/* ================= Popover / menu ================= */
.anchor{position:relative;display:inline-flex}
.pop{position:absolute;top:calc(100% + 6px);left:0;min-width:230px;max-width:min(320px,calc(100vw - 24px));background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);box-shadow:var(--shadow-3);padding:6px;z-index:70;animation:pop .16s var(--ease)}
.pop.pop-r{left:auto;right:0}
.pop-scroll{max-height:320px;overflow:auto}
@keyframes pop{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:none}}
.pop-head{display:grid;gap:2px;padding:8px 10px 10px}
.pop-head b{font-size:13.5px}
.pop-head span{font-size:12px;color:var(--text-3)}
.pop-head .badge{justify-self:start;margin-top:6px}
.pop-sep{height:1px;background:var(--border);margin:6px 2px}
.pop-label{font-size:11px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);padding:6px 10px 4px}
.pop-foot{display:flex;justify-content:space-between;gap:6px;padding:6px 4px 2px}
.menu-item{display:flex;align-items:center;gap:10px;width:100%;min-height:34px;padding:0 10px;border:0;background:none;border-radius:var(--r-sm);font-size:13.5px;color:var(--text);cursor:pointer;text-align:left;text-decoration:none}
.menu-item:hover,.menu-item:focus-visible{background:var(--surface-3)}
.menu-item .end{margin-left:auto;color:var(--primary)}
.menu-item.danger{color:var(--danger)}

/* ================= KPI cards ================= */
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md);box-shadow:var(--shadow-1);padding:14px 16px;display:grid;gap:6px;align-content:start;min-width:0;transition:border-color var(--t),box-shadow var(--t)}
.kpi:hover{border-color:var(--border-strong);box-shadow:var(--shadow-2)}
.kpi-label{font-size:11.5px;font-weight:650;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kpi-value{font-size:24px;font-weight:650;letter-spacing:-.015em;line-height:1.15;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.kpi-foot{display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:12.5px;color:var(--text-3);min-height:18px}
.kpi-foot-t{display:flex;gap:6px;flex-wrap:wrap;align-items:center;min-width:0}
.delta{display:inline-flex;align-items:center;gap:3px;font-weight:650;font-size:12.5px}
.delta.up{color:var(--success)}.delta.down{color:var(--danger)}.delta.flat{color:var(--text-3)}
.spark{width:72px;height:22px;flex:none;overflow:visible}
.meter{height:6px;border-radius:99px;background:var(--track);overflow:hidden}
.meter i{display:block;height:100%;background:var(--series);border-radius:99px;transition:width .3s var(--ease)}
.meter.done i{background:var(--good-fill)}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.kpi{padding:12px}.kpi-value{font-size:18px}.spark{display:none}.kpi-label{font-size:10.5px}}

/* ================= Encode ================= */
.encode-grid{display:grid;grid-template-columns:minmax(340px,430px) minmax(0,1fr);gap:16px;align-items:start}
.chart-stack{display:grid;gap:16px;min-width:0}
.chart-stack .card+.card,.grid-charts .card+.card{margin-top:0}
@media (max-width:1180px){.encode-grid{grid-template-columns:minmax(0,1fr)}}
.slots{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
.slot{display:grid;justify-items:center;gap:2px;padding:8px 4px;border:1px solid var(--border-strong);border-radius:var(--r-sm);background:var(--surface);cursor:pointer;transition:border-color var(--t),background var(--t),box-shadow var(--t)}
.slot:hover{border-color:var(--text-3)}
.slot-l{font-size:13px;font-weight:650;color:var(--text)}
.slot-s{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--text-3)}
.slot-s .ic{width:11px;height:11px}
.slot.done{background:var(--success-bg);border-color:transparent}
.slot.done .slot-s{color:var(--success);font-weight:600}
.slot.next .slot-s{color:var(--primary);font-weight:600}
.slot.sel{border-color:var(--primary);box-shadow:inset 0 0 0 1px var(--primary);background:var(--primary-soft)}
.ly-box{display:flex;align-items:center;gap:20px;flex-wrap:wrap;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2)}
.ly-box .sp{flex:1}
.mini-l{display:block;font-size:11.5px;color:var(--text-3);font-weight:600}
.mini-v{display:block;font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
.preview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:14px 0}
.pv{background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px 10px;min-width:0}
.pv small{display:block;font-size:11px;font-weight:600;color:var(--text-3);text-transform:uppercase;letter-spacing:.04em}
.pv b{display:block;font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pos{color:var(--success)}.neg{color:var(--danger)}
@media (max-width:420px){.grid-2{grid-template-columns:minmax(0,1fr)}.preview{grid-template-columns:repeat(2,minmax(0,1fr))}}

/* ================= Charts ================= */
.grid-charts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:16px}
@media (max-width:1100px){.grid-charts{grid-template-columns:minmax(0,1fr)}}
.chart{position:relative}
.plot{min-width:0}
.plot svg{display:block;width:100%;height:auto;overflow:visible;touch-action:pan-y}
.plot-scroll{max-height:360px;overflow:auto}
.ctip{position:absolute;pointer-events:none;background:var(--tip-bg);color:var(--tip-text);font-size:12.5px;padding:8px 10px;border-radius:var(--r-sm);box-shadow:var(--shadow-2);white-space:nowrap;z-index:5;display:none;line-height:1.5;font-variant-numeric:tabular-nums}
.ctip b{display:block;margin-bottom:2px;font-weight:650}

/* ================= Tables ================= */
.table-wrap{overflow:auto;max-height:72vh;-webkit-overflow-scrolling:touch}
table.dt{border-collapse:separate;border-spacing:0;width:100%;font-size:13px;font-variant-numeric:tabular-nums}
.dt caption{text-align:left}
.dt th,.dt td{padding:9px 12px;border-bottom:1px solid var(--border);white-space:nowrap;text-align:right;background:var(--surface)}
.dt.dense th,.dt.dense td{padding:5px 10px;font-size:12.5px}
.dt thead th{position:sticky;top:0;z-index:3;background:var(--surface-2);color:var(--text-2);font-size:12px;font-weight:600;vertical-align:bottom}
.dt thead tr:first-child th{height:36px}
.dt thead tr.r2 th{top:36px}
.dt th.l,.dt td.l{text-align:left}
.dt th.gs,.dt td.gs{border-left:1px solid var(--border)}
.dt thead th[scope="colgroup"]{text-align:center;color:var(--text);font-weight:650;vertical-align:middle}
.dt tbody tr:hover td{background:var(--hover)}
.dt tbody tr.clickable{cursor:pointer}
.dt tbody tr.cur td{background:var(--sel)}
.dt .frz{position:sticky;left:0;z-index:2}
.dt .frz2{position:sticky;left:72px;z-index:2;box-shadow:inset -1px 0 0 var(--border)}
.dt .frz.solo{box-shadow:inset -1px 0 0 var(--border)}
.dt thead .frz,.dt thead .frz2{z-index:4}
.dt .c-id{width:72px;min-width:72px;max-width:72px}
.dt tr.group td{background:var(--group);font-weight:650;color:var(--text);text-align:left;font-size:12.5px}
.dt tr.group .glabel{position:sticky;left:12px;display:inline-flex;gap:8px;align-items:center}
.dt tr.sub td{background:var(--total);font-weight:600;color:var(--text)}
.dt tr.grand td{background:var(--surface-3);font-weight:700;border-top:1px solid var(--border-strong);border-bottom:0}
.dt tr.sub:hover td{background:var(--total)}.dt tr.group:hover td{background:var(--group)}.dt tr.grand:hover td{background:var(--surface-3)}
.dt tr.sub td,.dt tr.group td{background-clip:padding-box}
.sort{all:unset;display:inline-flex;align-items:center;gap:4px;cursor:pointer;border-radius:4px}
.sort:focus-visible{box-shadow:var(--ring)}
.sort .sort-ic{width:13px;height:13px;opacity:.35}
th[aria-sort="ascending"] .sort-ic,th[aria-sort="descending"] .sort-ic{opacity:1;color:var(--primary)}
.cell-user b{display:block;font-weight:600;color:var(--text)}
.cell-user span{font-size:12px;color:var(--text-3)}
td.wrap{white-space:normal;min-width:200px;max-width:340px}
.td-actions{display:flex;gap:6px;justify-content:flex-end}
.table-foot{display:flex;justify-content:space-between;gap:12px;padding:10px 16px;font-size:12.5px;color:var(--text-3);border-top:1px solid var(--border);flex-wrap:wrap}

/* ================= States ================= */
.state{display:grid;justify-items:center;text-align:center;gap:8px;padding:44px 20px;color:var(--text-2)}
.state-ic{width:44px;height:44px;border-radius:50%;background:var(--surface-3);display:grid;place-items:center;color:var(--text-3);margin-bottom:4px}
.state-ic .ic{width:20px;height:20px}
.state h3{font-size:15px;color:var(--text)}
.state p{margin:0;font-size:13px;max-width:380px;color:var(--text-3)}
.state .btn{margin-top:8px}
.skel{background:linear-gradient(90deg,var(--skel) 25%,var(--skel-hi) 37%,var(--skel) 63%);background-size:400% 100%;animation:shimmer 1.4s ease infinite;border-radius:4px}
@keyframes shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
.skel-line{height:12px;margin:6px 0}
.skel-kpi{height:96px}
.boot{display:grid;grid-template-columns:var(--sidebar-w) minmax(0,1fr);min-height:100vh}
.boot-side{background:var(--nav-bg)}
.boot-top{height:var(--header-h);background:var(--surface);border-bottom:1px solid var(--border)}
@media (max-width:1024px){.boot{grid-template-columns:minmax(0,1fr)}.boot-side{display:none}}

/* ================= Dialog & toasts ================= */
.modal-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.5);display:grid;place-items:center;z-index:150;padding:16px;animation:fade .15s var(--ease)}
@keyframes fade{from{opacity:0}}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:var(--r-lg);box-shadow:var(--shadow-3);width:min(440px,100%);padding:22px;animation:pop .18s var(--ease)}
.modal-ic{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;margin-bottom:12px;background:var(--warning-bg);color:var(--warning)}
.modal-ic.danger{background:var(--danger-bg);color:var(--danger)}
.modal-ic.info{background:var(--info-bg);color:var(--info)}
.modal-ic .ic{width:20px;height:20px}
.modal h2{font-size:17px;margin-bottom:6px}
.modal p{margin:0;color:var(--text-2);font-size:14px}
.modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:22px;flex-wrap:wrap}
#toasts{position:fixed;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));display:grid;gap:8px;z-index:160;width:min(380px,calc(100vw - 32px))}
.toast{display:flex;gap:10px;align-items:flex-start;background:var(--surface);color:var(--text);border:1px solid var(--border);border-left:3px solid var(--info);border-radius:var(--r-md);box-shadow:var(--shadow-2);padding:10px 8px 10px 12px;font-size:13.5px;animation:slidein .2s var(--ease)}
.toast.out{opacity:0;transform:translateY(6px);transition:all .18s var(--ease)}
@keyframes slidein{from{opacity:0;transform:translateY(8px)}}
.toast-ic{display:flex;color:var(--info);margin-top:1px}
.toast-ic .ic{width:18px;height:18px}
.toast-msg{flex:1;min-width:0}
.toast-x{border:0;background:none;color:var(--text-3);cursor:pointer;display:flex;padding:2px;border-radius:4px}
.toast.success{border-left-color:var(--success)}.toast.success .toast-ic{color:var(--success)}
.toast.error{border-left-color:var(--danger)}.toast.error .toast-ic{color:var(--danger)}
.toast.warning{border-left-color:var(--warning)}.toast.warning .toast-ic{color:var(--warning)}
@media (max-width:640px){#toasts{left:12px;right:12px;width:auto;bottom:calc(12px + env(safe-area-inset-bottom))}}

/* ================= Auth ================= */
.auth{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);min-height:100vh;min-height:100dvh}
.auth-hero{background:var(--nav-bg);color:#c9d4e4;padding:40px 48px;display:flex;flex-direction:column;justify-content:space-between;gap:32px;padding-top:calc(40px + env(safe-area-inset-top))}
.auth-hero .brand{border:0;padding:0;height:auto}
.hero-copy h1{font-size:30px;line-height:1.25;color:#fff;font-weight:650;letter-spacing:-.02em;max-width:460px}
.hero-list{list-style:none;padding:0;margin:24px 0 0;display:grid;gap:12px;max-width:440px}
.hero-list li{display:flex;gap:10px;align-items:flex-start;font-size:14px}
.hero-list .ic{width:18px;height:18px;color:#60a5fa;margin-top:1px}
.hero-foot{font-size:12px;color:#8a9bb5}
.auth-main{display:grid;place-items:center;padding:32px 20px calc(32px + env(safe-area-inset-bottom));background:var(--surface)}
.auth-card{width:min(420px,100%)}
.auth-mobile-brand{display:none;align-items:center;gap:10px;margin-bottom:24px;font-weight:650;font-size:16px}
.auth-title{font-size:24px;font-weight:650;letter-spacing:-.015em}
.auth-sub{color:var(--text-3);font-size:13.5px;margin:6px 0 18px}
.auth-tabs{border-bottom:1px solid var(--border);margin-bottom:18px}
.auth-form{display:grid;gap:14px}
.auth-foot{font-size:12.5px;color:var(--text-3);text-align:center;margin-top:18px}
@media (max-width:900px){.auth{grid-template-columns:minmax(0,1fr)}.auth-hero{display:none}.auth-mobile-brand{display:flex}.auth-main{place-items:start center;padding-top:calc(28px + env(safe-area-inset-top))}}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
@media print{.sidebar,.topbar,.filterbar,.page-actions,.tools{display:none!important}.shell{display:block}.table-wrap{max-height:none;overflow:visible}}
</style>
</head>
<body>
<div id="app" aria-live="off"></div>
<div id="toasts" aria-live="polite" aria-atomic="false"></div>
<script>
/* ================= Constants ================= */
var WINS=[{k:'10AM',l:'10:00 AM'},{k:'12PM',l:'12:00 PM'},{k:'3PM',l:'3:00 PM'},{k:'4PM',l:'4:00 PM'},{k:'6PM',l:'6:00 PM'},{k:'9PM',l:'9:00 PM'},{k:'FINAL',l:'Final Sales'}];
var SHORT={'10AM':'10 AM','12PM':'12 PM','3PM':'3 PM','4PM':'4 PM','6PM':'6 PM','9PM':'9 PM','FINAL':'Final'};
var METRICS=[{k:'sales',l:'Sales'},{k:'trx',l:'TRX'},{k:'basket',l:'Basket'},{k:'vs',l:'VS LY'}];
var PAGES={encode:{t:'Encode Sales',ic:'edit'},history:{t:'Sales History',ic:'history'},dashboard:{t:'Store Performance',ic:'dashboard'},users:{t:'User Accounts',ic:'users'}};
var STORE_STATUS={none:{l:'Not started',c:''},progress:{l:'In progress',c:'info'},final:{l:'Final',c:'success'}};
var USER_STATUS={pending:{l:'Pending',c:'warning'},approved:{l:'Approved',c:'success'},disabled:{l:'Disabled',c:'danger'}};
var PESO='₱';

/* Lucide icon paths (ISC licence), stroke icons on a 24px grid */
var IC={
  menu:'<path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/>',
  x:'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  chevL:'<path d="m15 18-6-6 6-6"/>',
  chevR:'<path d="m9 18 6-6-6-6"/>',
  chevD:'<path d="m6 9 6 6 6-6"/>',
  sortUp:'<path d="m18 15-6-6-6 6"/>',
  sort:'<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  search:'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  refresh:'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  moon:'<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor:'<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  dashboard:'<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  history:'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  edit:'<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.38 2.62a1 1 0 0 1 3 3l-9.01 9.02a2 2 0 0 1-.86.5l-2.87.84a.5.5 0 0 1-.62-.62l.84-2.87a2 2 0 0 1 .5-.86z"/>',
  alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info:'<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  checkc:'<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  xcircle:'<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
  eye:'<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  eyeoff:'<path d="M10.73 5.08a10.74 10.74 0 0 1 11.2 6.57 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-1.44 2.49"/><path d="M14.08 14.16a3 3 0 0 1-4.24-4.24"/><path d="M17.48 17.5a10.75 10.75 0 0 1-15.42-5.15 1 1 0 0 1 0-.7 10.75 10.75 0 0 1 4.45-5.14"/><path d="m2 2 20 20"/>',
  columns:'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/>',
  rows:'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  panel:'<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="m16 15-3-3 3-3"/>',
  wifioff:'<path d="M12 20h.01"/><path d="M8.5 16.43a5 5 0 0 1 7 0"/><path d="M5 12.86a10 10 0 0 1 5.17-2.69"/><path d="M19 12.86a10 10 0 0 0-2-1.52"/><path d="M2 8.82a15 15 0 0 1 4.18-2.64"/><path d="M22 8.82a15 15 0 0 0-11.29-3.76"/><path d="m2 2 20 20"/>',
  inbox:'<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  trend:'<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
  filter:'<path d="M22 3H2l8 9.46V19l4 2v-8.54z"/>',
  store:'<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-2-.9 2.7 2.7 0 0 1-2 .9 2.7 2.7 0 0 1-2-.9 2.7 2.7 0 0 1-2 .9 2.7 2.7 0 0 1-2-.9 2.7 2.7 0 0 1-2 .9 2.7 2.7 0 0 1-2-.9A2 2 0 0 1 2 10V7"/>'
};
var BRAND='<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#2563eb"/><rect x="7.5" y="17" width="4" height="8" rx="1.2" fill="#bfdbfe"/><rect x="14" y="12" width="4" height="13" rx="1.2" fill="#dbeafe"/><rect x="20.5" y="7" width="4" height="18" rx="1.2" fill="#ffffff"/></svg>';
function icon(n,cls){return '<svg class="ic'+(cls?' '+cls:'')+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(IC[n]||'')+'</svg>'}

/* ================= Preferences & state ================= */
function loadPref(){
  var d={collapsed:false,density:'comfy',wins:WINS.map(function(w){return w.k}),metrics:['sales','trx','basket','vs'],group:true};
  try{var p=JSON.parse(localStorage.getItem('hd-pref')||'{}');for(var k in p)d[k]=p[k]}catch(e){}
  return d;
}
var PREF=loadPref();
function savePref(){try{localStorage.setItem('hd-pref',JSON.stringify(PREF))}catch(e){}}
var S={
  me:null,stores:[],rows:[],users:[],date:todayPH(),store:'',win:null,page:'',
  booting:true,loading:false,loadError:null,busy:false,
  authTab:'login',authNote:null,editLY:false,installEvt:null,
  f:{q:'',areas:[],status:'all'},sort:{key:'',dir:1},
  histQ:'',hsort:{key:'date',dir:-1},
  userTab:'',userQ:'',usort:{key:'',dir:1}
};

/* ================= Helpers ================= */
function $(id){return document.getElementById(id)}
function todayPH(){return new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Manila'})}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function num(v){if(v===''||v==null)return '';var x=parseFloat(String(v).replace(/[,\s₱]/g,''));return isNaN(x)?'':x}
function money(v){return v===''||v==null?'':Number(v).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}
function peso(v){return v===''||v==null?'':(v<0?'-':'')+PESO+money(Math.abs(v))}
function int(v){return v===''||v==null?'':Math.round(Number(v)).toLocaleString('en-PH')}
function pct(x){return x==null?'':(x*100).toFixed(2)+'%'}
function cap(s){return s.charAt(0).toUpperCase()+s.slice(1)}
function compact(n){
  var a=Math.abs(n);
  if(a>=1e6)return (n/1e6).toFixed(a>=1e7?1:2).replace(/\.?0+$/,'')+'M';
  if(a>=1e3)return (n/1e3).toFixed(a>=1e5?0:1).replace(/\.0$/,'')+'K';
  return String(Math.round(n));
}
function cpeso(n){return (n<0?'-':'')+PESO+compact(Math.abs(n))}
function fmtDate(iso){if(!iso)return '';var p=iso.split('-');return new Date(+p[0],+p[1]-1,+p[2]).toLocaleDateString('en-US',{month:'long',day:'2-digit',year:'numeric'})}
function fmtDateShort(iso){if(!iso)return '';var p=iso.split('-');return new Date(+p[0],+p[1]-1,+p[2]).toLocaleDateString('en-US',{month:'short',day:'2-digit',year:'numeric'})}
function shiftDate(iso,days){var p=iso.split('-');return new Date(Date.UTC(+p[0],+p[1]-1,+p[2]+days)).toISOString().slice(0,10)}
function initials(n){var p=String(n||'?').trim().split(/\s+/);return ((p[0]||'?').charAt(0)+(p.length>1?p[p.length-1].charAt(0):'')).toUpperCase()}
function isAdmin(){return !!S.me&&S.me.role==='admin'}
function isViewer(){return !!S.me&&!!S.me.viewer}
function myStores(){var sc=S.me&&S.me.scope;return sc?S.stores.filter(function(s){return sc.indexOf(s.id)>=0}):S.stores}
function defaultStore(){return isViewer()?'':S.me.storeId}
function storeById(id){for(var i=0;i<S.stores.length;i++){if(S.stores[i].id===String(id))return S.stores[i]}return null}
function winLabel(k){for(var i=0;i<WINS.length;i++){if(WINS[i].k===k)return WINS[i].l}return k}
function blankRec(st){var w={};WINS.forEach(function(x){w[x.k]={sales:'',trx:''}});return {date:S.date,storeId:st?st.id:'',storeName:st?st.name:'',area:st?st.area:'',ly:'',trxLy:'',w:w}}
function currentRec(){for(var i=0;i<S.rows.length;i++){var r=S.rows[i];if(r.date===S.date&&r.storeId===String(S.store))return r}return null}
function nextWin(rec){if(!rec)return WINS[0].k;for(var i=0;i<WINS.length;i++){if(rec.w[WINS[i].k].sales==='')return WINS[i].k}return null}
function basket(s,t){return s!==''&&t>0?s/t:null}
function vsly(s,ly){return s!==''&&ly>0?s/ly:null}
// Slots hold each time slot's own sales. latest() returns the latest saved slot (i,k,l)
// together with the DAY TOTAL so far: sales/trx summed over every saved slot.
function latest(rec){if(!rec)return null;var l=null,s=0,t=0,n=0;WINS.forEach(function(w,i){var v=rec.w[w.k];if(v.sales!==''){n++;s+=v.sales;t+=(v.trx===''?0:v.trx);l={i:i,k:w.k,l:w.l}}});if(!l)return null;l.sales=s;l.trx=t;l.n=n;return l}
function cumThrough(rec,k){var s=0,stop=false;WINS.forEach(function(w){if(stop)return;var v=rec.w[w.k];if(v.sales!=='')s+=v.sales;if(w.k===k)stop=true});return s}
function storeStatus(rec){var l=latest(rec);if(!l)return 'none';return rec.w.FINAL.sales!==''?'final':'progress'}
// sales/trx = that slot's own figures; cum/cumTrx = running day total through the slot.
function savedPoints(rec){var pts=[],cs=0,ct=0;if(rec)WINS.forEach(function(w,i){var v=rec.w[w.k];if(v.sales!==''){var t=v.trx===''?0:v.trx;cs+=v.sales;ct+=t;pts.push({i:i,k:w.k,l:w.l,sales:v.sales,trx:t,cum:cs,cumTrx:ct})}});return pts}
// Per-slot cell: slot sales/TRX/basket; VS LY = running total through the slot / LY (matches the sheet).
function recWin(rec,k){var v=rec.w[k];return {sales:v.sales,trx:v.trx,basket:basket(v.sales,v.trx),vs:v.sales!==''&&rec.ly>0?cumThrough(rec,k)/rec.ly:null}}
function byIdMap(){var m={};S.rows.forEach(function(r){if(r.date===S.date)m[r.storeId]=r});return m}
function roleLine(){if(isAdmin())return 'Administrator';if(isViewer())return 'Area manager';return 'Store '+S.me.storeId+' · '+S.me.storeName}
function storeLabel(u){if(u.role==='user')return u.storeId+' · '+u.storeName;if(u.role==='admin')return 'All stores';return u.scope?(u.scope.length+' store'+(u.scope.length===1?'':'s')+': '+u.storeName):'All stores'}
function storeLabelShort(u){if(u.role!=='areamanager'||!u.scope||u.scope.length<=3)return storeLabel(u);var names=String(u.storeName||'').split(', ');return u.scope.length+' stores: '+names.slice(0,3).join(', ')+' +'+(u.scope.length-3)+' more'}
function upsert(rec){for(var i=0;i<S.rows.length;i++){if(S.rows[i].date===rec.date&&S.rows[i].storeId===rec.storeId){S.rows[i]=rec;return}}S.rows.push(rec)}
// Subtotals: VS LY compares only stores that reported that window and have LY.
function agg(recs){
  var o={ly:'',trxLy:'',w:{}};
  recs.forEach(function(r){if(r.ly!=='')o.ly=(o.ly||0)+r.ly;if(r.trxLy!=='')o.trxLy=(o.trxLy||0)+r.trxLy});
  WINS.forEach(function(w){
    var s=0,t=0,sl=0,l=0,n=0;
    recs.forEach(function(r){var v=r.w[w.k];if(v.sales!==''){n++;s+=v.sales;t+=(v.trx||0);if(r.ly>0){sl+=cumThrough(r,w.k);l+=r.ly}}});
    o.w[w.k]={sales:n?s:'',trx:n?t:'',basket:t>0?s/t:null,vs:l>0?sl/l:null};
  });
  return o;
}
function soFar(recs){var s=0,t=0,sl=0,l=0,n=0;recs.forEach(function(r){var x=latest(r);if(x){n++;s+=x.sales;t+=x.trx;if(r.ly>0){sl+=x.sales;l+=r.ly}}});return {sales:n?s:'',trx:n?t:'',vs:l>0?sl/l:null}}

/* ================= API ================= */
async function api(path,body,method){
  if(!navigator.onLine){var off=new Error('You are offline. Check your connection and try again.');off.status=0;throw off}
  var opt={method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json'},credentials:'same-origin'};
  if(body)opt.body=JSON.stringify(body);
  var r;
  try{r=await fetch(path,opt)}catch(e){var ne=new Error('Unable to reach the server. Check your connection and try again.');ne.status=0;throw ne}
  var j={};try{j=await r.json()}catch(e){}
  if(!r.ok){var er=new Error(j.error||('Request failed ('+r.status+').'));er.status=r.status;throw er}
  return j;
}
async function loadData(){var j=await api('/api/data?date='+encodeURIComponent(S.date));S.rows=j.rows||[]}
function pendingCount(){return S.users.filter(function(u){return u.status==='pending'}).length}
async function loadUsers(){if(!isAdmin())return;var j=await api('/api/users');S.users=j.users||[]}

/* ================= Theme ================= */
function getTheme(){try{return localStorage.getItem('hd-theme')||'light'}catch(e){return 'light'}}
function isDark(){var t=getTheme();return t==='dark'||(t==='system'&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)}
function syncThemeColor(){var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',isDark()?'#161c25':'#ffffff')}
function setTheme(t){try{localStorage.setItem('hd-theme',t)}catch(e){}document.documentElement.setAttribute('data-theme',t);syncThemeColor();renderApp()}

/* ================= Feedback: toasts & dialog ================= */
function toast(msg,type){
  if(type===true)type='error';type=type||'success';
  var box=$('toasts'),t=document.createElement('div');
  t.className='toast '+type;t.setAttribute('role',type==='error'?'alert':'status');
  var ic={success:'checkc',error:'xcircle',warning:'alert',info:'info'}[type]||'info';
  t.innerHTML='<span class="toast-ic">'+icon(ic)+'</span><div class="toast-msg">'+esc(msg)+'</div><button class="toast-x" aria-label="Dismiss notification">'+icon('x')+'</button>';
  box.appendChild(t);
  var h=setTimeout(rm,type==='error'?6000:3200);
  function rm(){t.classList.add('out');setTimeout(function(){t.remove()},200)}
  t.querySelector('.toast-x').onclick=function(){clearTimeout(h);rm()};
  while(box.children.length>3)box.firstChild.remove();
}
function confirmDialog(o){
  return new Promise(function(resolve){
    var prev=document.activeElement,tone=o.tone||'warning';
    var w=document.createElement('div');w.className='modal-backdrop';
    w.innerHTML='<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="mdl-t" aria-describedby="mdl-d"><div class="modal-ic '+tone+'">'+icon(tone==='info'?'info':'alert')+'</div><h2 id="mdl-t">'+esc(o.title)+'</h2><p id="mdl-d">'+o.html+'</p><div class="modal-actions"><button class="btn" data-m="0">'+esc(o.cancel||'Cancel')+'</button><button class="btn '+(tone==='danger'?'btn-danger-solid':'btn-primary')+'" data-m="1">'+esc(o.ok||'Confirm')+'</button></div></div>';
    document.body.appendChild(w);
    w.querySelector('[data-m="1"]').focus();
    function close(v){document.removeEventListener('keydown',key,true);w.remove();if(prev&&prev.focus&&document.body.contains(prev))prev.focus();resolve(v)}
    function key(e){
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close(false)}
      else if(e.key==='Tab'){var f=Array.prototype.slice.call(w.querySelectorAll('button'));var i=f.indexOf(document.activeElement);e.preventDefault();f[(i+(e.shiftKey?-1:1)+f.length)%f.length].focus()}
    }
    document.addEventListener('keydown',key,true);
    w.addEventListener('click',function(e){var b=e.target.closest('[data-m]');if(b)close(b.getAttribute('data-m')==='1');else if(e.target===w)close(false)});
  });
}

/* ================= Shared UI pieces ================= */
function stateBlock(ic,title,text,action){return '<div class="state"><div class="state-ic">'+icon(ic)+'</div><h3>'+title+'</h3><p>'+text+'</p>'+(action||'')+'</div>'}
function errorBlock(msg){return stateBlock('alert','Unable to load data',esc(msg),'<button class="btn btn-primary" data-act="retry">'+icon('refresh')+'Try again</button>')}
function skelKpis(n){var h='<div class="kpis">';for(var i=0;i<n;i++)h+='<div class="kpi"><div class="skel skel-line" style="width:45%"></div><div class="skel" style="height:26px;width:70%;margin:4px 0"></div><div class="skel skel-line" style="width:55%"></div></div>';return h+'</div>'}
function skelCard(hgt){return '<div class="card"><div class="card-h"><div style="width:100%"><div class="skel skel-line" style="width:35%"></div><div class="skel skel-line" style="width:55%"></div></div></div><div class="card-b"><div class="skel" style="height:'+hgt+'px"></div></div></div>'}
function skelTable(rows){var h='<div class="card"><div class="card-h"><div class="skel skel-line" style="width:25%"></div></div><div class="card-b">';for(var i=0;i<(rows||6);i++)h+='<div class="skel skel-line" style="height:16px;margin:12px 0;width:'+(92-i*4)+'%"></div>';return h+'</div></div>'}
function pageHead(title,sub,actions){return '<div class="page-head"><div><h1 class="page-title">'+title+'</h1><div class="page-sub">'+sub+'</div></div><div class="page-actions">'+(actions||'')+'</div></div>'}
function dateCtl(){return '<div class="datectl" role="group" aria-label="Hakot Day date"><button class="btn icon-btn has-tip" data-act="day" data-n="-1" aria-label="Previous day" data-tip="Previous day">'+icon('chevL')+'</button><input type="date" class="input" id="fDate" value="'+esc(S.date)+'" aria-label="Hakot Day date"><button class="btn icon-btn has-tip" data-act="day" data-n="1" aria-label="Next day" data-tip="Next day">'+icon('chevR')+'</button><button class="btn" data-act="day" data-n="0">Today</button></div>'}
function searchBox(id,ph,v){return '<div class="search"><span class="search-ic">'+icon('search')+'</span><input class="input input-sm" type="search" id="'+id+'" placeholder="'+esc(ph)+'" aria-label="'+esc(ph)+'" value="'+esc(v||'')+'" autocomplete="off"></div>'}
function densityBtn(){var c=PREF.density==='compact';return '<button class="btn btn-sm" data-act="density" aria-pressed="'+c+'" title="Row density">'+icon('rows')+(c?'Compact':'Comfortable')+'</button>'}
function colsMenu(withGroup){
  var h='<div class="anchor"><button class="btn btn-sm" data-act="menu" data-m="cols" aria-haspopup="true" aria-expanded="false">'+icon('columns')+'Columns</button><div class="pop pop-r pop-scroll" id="pop-cols" hidden><div class="pop-label">Time slots</div>';
  WINS.forEach(function(w){h+='<label class="chk"><input type="checkbox" data-col-win="'+w.k+'"'+(PREF.wins.indexOf(w.k)>=0?' checked':'')+'>'+w.l+'</label>'});
  h+='<div class="pop-sep"></div><div class="pop-label">Metrics per slot</div>';
  METRICS.forEach(function(m){h+='<label class="chk"><input type="checkbox" data-col-met="'+m.k+'"'+(PREF.metrics.indexOf(m.k)>=0?' checked':'')+'>'+m.l+'</label>'});
  if(withGroup)h+='<div class="pop-sep"></div><label class="chk"><input type="checkbox" data-col-group'+(PREF.group?' checked':'')+'>Group by area</label>';
  return h+'</div></div>';
}
function kpi(o){return '<div class="kpi"><div class="kpi-label">'+o.label+'</div><div class="kpi-value"'+(o.title?' title="'+esc(o.title)+'"':'')+'>'+o.value+'</div>'+(o.meter||'')+'<div class="kpi-foot"><span class="kpi-foot-t">'+(o.foot||'')+'</span>'+(o.spark||'')+'</div></div>'}
function meterHtml(p,label){return '<div class="meter'+(p>=1?' done':'')+'" role="meter" aria-label="'+esc(label)+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+Math.round(p*100)+'"><i style="width:'+Math.min(100,Math.max(0,p*100)).toFixed(1)+'%"></i></div>'}
function deltaHtml(d,suffix){if(d==null)return '';var c=d>0.0005?'up':d<-0.0005?'down':'flat';return '<span class="delta '+c+'">'+(c==='up'?'▲':c==='down'?'▼':'▬')+' '+Math.abs(d*100).toFixed(1)+'%</span>'+(suffix?'<span>'+suffix+'</span>':'')}
function sparkline(vals){
  vals=vals.filter(function(v){return v!=null&&v!==''});if(vals.length<2)return '';
  var W=72,H=22,max=Math.max.apply(null,vals),min=Math.min(0,Math.min.apply(null,vals)),n=vals.length,rng=(max-min)||1;
  var p=vals.map(function(v,i){return [2+(W-4)*i/(n-1),H-3-(H-6)*(v-min)/rng]});
  return '<svg class="spark" viewBox="0 0 '+W+' '+H+'" aria-hidden="true"><polyline points="'+p.map(function(q){return q[0].toFixed(1)+','+q[1].toFixed(1)}).join(' ')+'" fill="none" stroke="var(--text-3)" stroke-opacity=".55" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/><circle cx="'+p[n-1][0].toFixed(1)+'" cy="'+p[n-1][1].toFixed(1)+'" r="3" fill="var(--series)" stroke="var(--surface)" stroke-width="1.5"/></svg>';
}
function statusBadge(st){var s=STORE_STATUS[st];return '<span class="badge '+s.c+'"><span class="dot"></span>'+s.l+'</span>'}
function slotBadge(l){return l?'<span class="badge">'+SHORT[l.k]+'</span>':'<span class="muted">—</span>'}
function vsCell(v){return v==null?'':'<span class="'+(v>=1?'pos':'')+'">'+pct(v)+'</span>'}
function setErr(id,msg){var i=$(id),e=$(id+'-err');if(!i||!e)return;if(msg){i.setAttribute('aria-invalid','true');e.innerHTML=icon('alert')+'<span>'+esc(msg)+'</span>';e.hidden=false}else{i.removeAttribute('aria-invalid');e.hidden=true}}
function field(o){ // {id,label,val,req,money,type,name,auto,help,mode,post}
  var inp='<input class="input'+(o.money||o.mode?' num':'')+'" id="'+o.id+'"'+(o.name?' name="'+o.name+'"':'')+' type="'+(o.type||'text')+'"'+(o.mode?' inputmode="'+o.mode+'"':'')+' autocomplete="'+(o.auto||'off')+'" value="'+esc(o.val==null?'':o.val)+'"'+(o.req?' aria-required="true"':'')+' aria-describedby="'+o.id+'-err'+(o.help?' '+o.id+'-help':'')+'">';
  if(o.money)inp='<div class="adorn"><span class="pre" aria-hidden="true">'+PESO+'</span>'+inp+'</div>';
  else if(o.post)inp='<div class="adorn has-post">'+inp+'<span class="post">'+o.post+'</span></div>';
  return '<div class="field"><label class="label" for="'+o.id+'">'+o.label+(o.req?'<span class="req" aria-hidden="true">*</span>':'')+'</label>'+inp+(o.help?'<div class="help" id="'+o.id+'-help" style="margin:0">'+o.help+'</div>':'')+'<div class="err-msg" id="'+o.id+'-err" hidden></div></div>';
}

/* ================= Router & shell ================= */
function allowedPages(){return isViewer()?(isAdmin()?['dashboard','users']:['dashboard']):['encode','history']}
function defaultPage(){return isViewer()?'dashboard':'encode'}
function readRoute(){var p=(location.hash||'').replace(/^#\/?/,'');return allowedPages().indexOf(p)>=0?p:defaultPage()}
function go(p){if(location.hash==='#/'+p){S.page=p;renderApp()}else location.hash='#/'+p}
function setDrawer(open){var sh=document.querySelector('.shell');if(!sh)return;sh.classList.toggle('drawer-open',open);var b=document.querySelector('.menu-btn');if(b)b.setAttribute('aria-expanded',String(open));if(open){var a=document.querySelector('.sidebar .nav-item');if(a)a.focus()}}

function renderApp(){
  if(S.booting){renderBoot();return}
  if(!S.me){renderAuth();return}
  if(!S.page||allowedPages().indexOf(S.page)<0)S.page=readRoute();
  renderShell();renderPage();
}
function renderBoot(){
  $('app').innerHTML='<div class="boot" aria-busy="true" aria-label="Loading Hakot Day"><div class="boot-side"></div><div><div class="boot-top"></div><div class="content"><div class="skel" style="height:28px;width:240px;margin-bottom:8px"></div><div class="skel skel-line" style="width:180px;margin-bottom:20px"></div>'+skelKpis(4)+skelTable(5)+'</div></div></div>';
}
function navItem(p,count){
  var pg=PAGES[p];
  return '<a class="nav-item" href="#/'+p+'"'+(S.page===p?' aria-current="page"':'')+(count?' data-count="'+count+'"':'')+'>'+icon(pg.ic)+'<span class="nav-label">'+pg.t+'</span>'+(count?'<span class="nav-count"><span class="sr-only">, </span>'+count+'<span class="sr-only"> pending</span></span>':'')+'<span class="tipx" aria-hidden="true">'+pg.t+(count?' ('+count+')':'')+'</span></a>';
}
function userMenu(){
  var th=getTheme();
  var h='<div class="pop pop-r" id="pop-user" role="menu" aria-label="Account" hidden><div class="pop-head"><b>'+esc(S.me.name)+'</b><span>'+esc(S.me.email)+'</span><span class="badge info">'+esc(S.me.roleLabel||cap(S.me.role))+'</span></div><div class="pop-sep"></div><div class="pop-label">Appearance</div>';
  [['light','sun','Light'],['dark','moon','Dark'],['system','monitor','Match system']].forEach(function(t){h+='<button class="menu-item" role="menuitemradio" aria-checked="'+(th===t[0])+'" data-act="set-theme" data-t="'+t[0]+'">'+icon(t[1])+t[2]+(th===t[0]?icon('check','end'):'')+'</button>'});
  if(S.installEvt)h+='<div class="pop-sep"></div><button class="menu-item" role="menuitem" data-act="install">'+icon('download')+'Install app</button>';
  return h+'<div class="pop-sep"></div><button class="menu-item danger" role="menuitem" data-act="logout">'+icon('logout')+'Sign out</button></div>';
}
function renderShell(){
  var work=isViewer()?['dashboard']:['encode','history'];
  var sb='<aside class="sidebar" id="sidebar" aria-label="Sidebar"><div class="brand">'+BRAND+'<div class="brand-text"><div class="brand-name">Hakot Day</div><div class="brand-sub">Sales Monitoring</div></div></div>';
  sb+='<nav class="nav" aria-label="Main navigation"><div class="nav-sec">Workspace</div>'+work.map(function(p){return navItem(p)}).join('');
  if(isAdmin())sb+='<div class="nav-sec">Administration</div>'+navItem('users',pendingCount());
  sb+='</nav><div class="sidebar-foot"><button class="nav-item collapse-btn" data-act="collapse" aria-label="'+(PREF.collapsed?'Expand sidebar':'Collapse sidebar')+'" aria-expanded="'+!PREF.collapsed+'">'+icon('panel')+'<span class="nav-label">Collapse sidebar</span><span class="tipx" aria-hidden="true">Expand sidebar</span></button></div></aside>';
  var pg=PAGES[S.page],th=getTheme(),dark=isDark();
  var tb='<header class="topbar"><button class="btn btn-ghost icon-btn menu-btn" data-act="drawer" aria-label="Open navigation" aria-controls="sidebar" aria-expanded="false">'+icon('menu')+'</button>';
  tb+='<div class="crumbs"><span class="crumb-root">Hakot Day</span>'+icon('chevR','sep')+'<span class="crumb-cur">'+pg.t+'</span></div><div class="sp"></div>';
  tb+='<span class="offline-pill" role="status">'+icon('wifioff')+'Offline</span>';
  tb+='<button class="btn btn-ghost icon-btn has-tip" data-act="theme" aria-label="Switch to '+(dark?'light':'dark')+' mode" data-tip="'+(dark?'Light mode':'Dark mode')+'">'+icon(dark?'sun':'moon')+'</button>';
  tb+='<div class="anchor"><button class="user-btn" data-act="menu" data-m="user" aria-haspopup="menu" aria-expanded="false" aria-label="Account menu for '+esc(S.me.name)+'"><span class="avatar" aria-hidden="true">'+esc(initials(S.me.name))+'</span><span class="user-meta"><span class="user-name">'+esc(S.me.name)+'</span><span class="user-role">'+esc(roleLine())+'</span></span>'+icon('chevD','chev')+'</button>'+userMenu()+'</div></header>';
  if(chartRO)chartRO.disconnect();lastW=0;
  $('app').innerHTML='<button class="skip" data-act="skip">Skip to content</button><div class="shell'+(PREF.collapsed?' collapsed':'')+'">'+sb+'<div class="scrim" data-act="drawer-close"></div><div class="main">'+tb+'<main class="content" id="content" tabindex="-1"></main></div></div>';
}
function renderPage(){
  var p=S.page,ct=$('content');if(chartRO&&ct){chartRO.disconnect();lastW=0;chartRO.observe(ct)}document.title=PAGES[p].t+' · Hakot Day';
  if(p==='encode')renderEncode();else if(p==='history')renderHistory();else if(p==='dashboard')renderDashboard();else if(p==='users')renderUsers();
}
function closeMenus(keep){document.querySelectorAll('.pop').forEach(function(p){if(p.id===keep)return;p.hidden=true;var b=document.querySelector('[data-m="'+p.id.slice(4)+'"]');if(b)b.setAttribute('aria-expanded','false')})}
function toggleMenu(m){var p=$('pop-'+m);if(!p)return;var open=p.hidden;closeMenus(open?p.id:null);p.hidden=!open;var b=document.querySelector('[data-m="'+m+'"]');if(b)b.setAttribute('aria-expanded',String(open));if(open){var f=p.querySelector('button,input');if(f)f.focus()}}

/* ================= Auth ================= */
function storeOptions(sel){
  var areas=[],by={};
  S.stores.forEach(function(s){if(!by[s.area]){by[s.area]=[];areas.push(s.area)}by[s.area].push(s)});
  return areas.map(function(a){return '<optgroup label="'+esc(a)+'">'+by[a].map(function(s){return '<option value="'+esc(s.id)+'"'+(String(sel)===s.id?' selected':'')+'>'+esc(s.id+' · '+s.name)+'</option>'}).join('')+'</optgroup>'}).join('');
}
function storePicker(){
  var areas=[],by={};
  S.stores.forEach(function(s){if(!by[s.area]){by[s.area]=[];areas.push(s.area)}by[s.area].push(s)});
  var h='<div id="pickMany" class="field" hidden><span class="label">Stores you manage<span class="req" aria-hidden="true">*</span></span><div class="picker" role="group" aria-label="Stores you manage"><div class="picker-head"><span id="pickCount">0 selected</span></div><div style="padding:8px 8px 0">'+searchBox('pickQ','Filter stores','')+'</div><div class="picker-list" id="pickList">';
  h+='<label class="chk all"><input type="checkbox" data-pick="all"> All stores</label>';
  areas.forEach(function(a){
    h+='<div class="pgroup" data-group="'+esc(a)+'"><label class="chk area"><input type="checkbox" data-pick="area" data-area="'+esc(a)+'"> '+esc(a)+' <span class="muted">('+by[a].length+')</span></label>';
    by[a].forEach(function(s){h+='<label class="chk st1" data-text="'+esc((s.id+' '+s.name+' '+a).toLowerCase())+'"><input type="checkbox" data-pick="store" data-area="'+esc(a)+'" value="'+esc(s.id)+'"> '+esc(s.id+' · '+s.name)+'</label>'});
    h+='</div>';
  });
  return h+'</div></div><div class="err-msg" id="pickMany-err" hidden></div></div>';
}
function syncPicker(){
  var box=$('pickMany');if(!box)return;
  var all=box.querySelectorAll('[data-pick=store]'),n=0;
  all.forEach(function(c){if(c.checked)n++});
  box.querySelectorAll('[data-pick=area]').forEach(function(a){
    var cs=box.querySelectorAll('[data-pick=store][data-area="'+CSS.escape(a.getAttribute('data-area'))+'"]'),k=0;
    cs.forEach(function(c){if(c.checked)k++});
    a.checked=k===cs.length&&k>0;a.indeterminate=k>0&&k<cs.length;
  });
  var top=box.querySelector('[data-pick=all]');top.checked=n===all.length&&n>0;top.indeterminate=n>0&&n<all.length;
  $('pickCount').textContent=(n===all.length&&n>0?'All stores · ':'')+n+' selected';
  if(n)setErrBox('pickMany','');
}
function setErrBox(id,msg){var e=$(id+'-err');if(!e)return;if(msg){e.innerHTML=icon('alert')+'<span>'+esc(msg)+'</span>';e.hidden=false}else e.hidden=true}
function noteHtml(n){var k=n.kind==='ok'?'success':n.kind==='warn'?'warning':n.kind==='error'?'danger':'info';return '<div class="alert '+k+'" role="status">'+icon(k==='success'?'checkc':k==='info'?'info':'alert')+'<div><b>'+esc(n.title)+'</b>'+esc(n.text)+'</div></div>'}
function pwField(id,label,auto,help){return field({id:id,name:'password',label:label,type:'password',auto:auto,req:true,help:help,post:'<button type="button" class="btn btn-ghost btn-sm icon-btn" data-act="togglepw" data-for="'+id+'" aria-label="Show password" aria-pressed="false">'+icon('eye')+'</button>'})}
function renderAuth(){
  var login=S.authTab==='login';
  var h='<div class="auth"><aside class="auth-hero"><div class="brand">'+BRAND+'<div><div class="brand-name">Hakot Day</div><div class="brand-sub">Sales Monitoring</div></div></div>';
  h+='<div class="hero-copy"><h1>Hour-by-hour store sales, measured against last year.</h1><ul class="hero-list"><li>'+icon('checkc')+'<span>Encode sales and transactions for each time slot; the day total adds up automatically</span></li><li>'+icon('checkc')+'<span>See performance against last year as the day unfolds</span></li><li>'+icon('checkc')+'<span>Give area managers and executives a live view of every store</span></li></ul></div><div class="hero-foot">Internal business system · Authorized users only</div></aside>';
  h+='<main class="auth-main"><div class="auth-card"><div class="auth-mobile-brand">'+BRAND+'<span>Hakot Day</span></div>';
  h+='<h1 class="auth-title">'+(login?'Sign in':'Create your account')+'</h1><p class="auth-sub">'+(login?'Use the email and password you registered with.':'New accounts are reviewed by an administrator before first sign-in.')+'</p>';
  h+='<div class="tabs auth-tabs" role="tablist" aria-label="Account"><button class="tab" role="tab" aria-selected="'+login+'" data-act="tab" data-t="login">Sign in</button><button class="tab" role="tab" aria-selected="'+(!login)+'" data-act="tab" data-t="signup">Create account</button></div>';
  if(S.authNote)h+=noteHtml(S.authNote);
  if(login){
    h+='<form class="auth-form" data-form="login" novalidate>'+field({id:'aEmail',name:'email',label:'Email',type:'email',auto:'email',req:true})+pwField('aPass','Password','current-password')+'<button class="btn btn-primary btn-block btn-lg" type="submit">Sign in</button></form>';
  }else{
    h+='<form class="auth-form" data-form="signup" novalidate>'+field({id:'aName',name:'name',label:'Full name',auto:'name',req:true})+field({id:'aEmail',name:'email',label:'Work email',type:'email',auto:'email',req:true})+pwField('aPass','Password','new-password','At least 6 characters.');
    h+='<div class="field"><span class="label" id="posL">Position<span class="req" aria-hidden="true">*</span></span><div class="choice-group" role="radiogroup" aria-labelledby="posL"><label class="choice on"><input type="radio" name="position" value="store" checked><div><b>Store manager / staff</b><span>Encodes sales for one store</span></div></label><label class="choice"><input type="radio" name="position" value="area"><div><b>Area manager</b><span>Views the stores you manage</span></div></label></div></div>';
    h+='<div class="field" id="pickOne"><label class="label" for="aStore">Your store<span class="req" aria-hidden="true">*</span></label><select class="select" id="aStore" name="storeId" aria-describedby="aStore-err"><option value="">Select a store…</option>'+storeOptions('')+'</select><div class="err-msg" id="aStore-err" hidden></div></div>'+storePicker();
    h+='<button class="btn btn-primary btn-block btn-lg" type="submit">Create account</button></form>';
    if(!S.stores.length)h+='<div class="alert danger" style="margin-top:14px">'+icon('alert')+'<div><b>Store list unavailable</b>'+esc(S.storesError||'The store list could not be loaded.')+' <button class="btn btn-sm" data-act="retry-stores" style="margin-top:8px">'+icon('refresh')+'Try again</button></div></div>';
  }
  h+='<p class="auth-foot">'+(login?'Need access? Choose <b>Create account</b> and an administrator will approve it.':'Already approved? Choose <b>Sign in</b>.')+'</p></div></main></div>';
  $('app').innerHTML=h;document.title='Sign in · Hakot Day';
}

/* ================= Store: Encode page ================= */
function renderEncode(){
  var st=storeById(S.store);
  var h=pageHead('Encode Sales',esc(st?st.id+' · '+st.name:S.me.storeId+' · '+S.me.storeName)+' · '+esc(fmtDate(S.date)),dateCtl());
  if(S.loading){$('content').innerHTML=h+skelKpis(4)+'<div class="encode-grid">'+skelCard(420)+'<div class="chart-stack">'+skelCard(200)+skelCard(200)+'</div></div>';return}
  if(S.loadError){$('content').innerHTML=h+'<div class="card">'+errorBlock(S.loadError)+'</div>';return}
  h+='<div class="kpis" id="kpis" role="region" aria-label="Day total versus last year"></div><div class="encode-grid"><section class="card" id="entry" aria-labelledby="entry-t"></section><div class="chart-stack">';
  h+='<section class="card chart" id="chCum" aria-labelledby="chCum-t"><div class="card-h"><div><h2 class="card-t" id="chCum-t">Day total vs LY full day</h2><div class="card-s" id="chCum-s"></div></div></div><div class="card-b"><div class="plot"></div></div><div class="ctip" role="tooltip"></div></section>';
  h+='<section class="card chart" id="chInc" aria-labelledby="chInc-t"><div class="card-h"><div><h2 class="card-t" id="chInc-t">Sales per time slot</h2><div class="card-s" id="chInc-s"></div></div></div><div class="card-b"><div class="plot"></div></div><div class="ctip" role="tooltip"></div></section>';
  h+='</div></div>';
  $('content').innerHTML=h;
  renderStoreKpis();renderEntry();renderStoreCharts();
}
function renderEncodeParts(){renderStoreKpis();renderEntry();renderStoreCharts()}
function renderStoreKpis(){
  var el=$('kpis');if(!el)return;
  var rec=currentRec(),pts=savedPoints(rec),last=pts[pts.length-1];
  var ly=rec&&rec.ly!==''?rec.ly:0,trxLy=rec&&rec.trxLy!==''?rec.trxLy:0;
  if(!last){
    el.innerHTML=kpi({label:'Total sales',value:'—',foot:'No time slot saved yet'})+kpi({label:'VS LY · full day',value:'—',foot:ly>0?'LY '+peso(ly):'Enter last year to compare'})+kpi({label:'Total transactions',value:'—',foot:trxLy>0?'LY '+int(trxLy):'—'})+kpi({label:'Basket size',value:'—',foot:'—'});
    return;
  }
  var tot=latest(rec);
  var h=kpi({label:'Total sales',value:peso(tot.sales),foot:tot.n+' of '+WINS.length+' slots · latest '+esc(SHORT[tot.k]),spark:sparkline(pts.map(function(p){return p.cum}))});
  if(ly>0){var p=tot.sales/ly,gap=ly-tot.sales;h+=kpi({label:'VS LY · full day',value:pct(p),meter:meterHtml(p,'Percent of last year full-day sales'),foot:p>=1?'<span class="badge success">'+icon('check')+'Beat LY</span><span>by '+peso(-gap)+'</span>':'<span>'+peso(gap)+' to match LY</span>'})}
  else h+=kpi({label:'VS LY · full day',value:'—',foot:'Enter last year to compare'});
  h+=kpi({label:'Total transactions',value:int(tot.trx),foot:trxLy>0?'<span>'+pct(tot.trx/trxLy)+' of LY ('+int(trxLy)+')</span>':'LY TRX not set'});
  var bk=tot.trx>0?tot.sales/tot.trx:null,bkLy=ly>0&&trxLy>0?ly/trxLy:null;
  h+=kpi({label:'Basket size',value:bk==null?'—':peso(bk),foot:bk!=null&&bkLy!=null?deltaHtml(bk/bkLy-1,'vs LY '+peso(bkLy)):'LY basket not available'});
  el.innerHTML=h;
}
function renderEntry(){
  var el=$('entry');if(!el)return;
  var rec=currentRec(),lySet=!!rec&&rec.ly!=='',nx=nextWin(rec);
  if(!S.win)S.win=nx||'FINAL';
  var saved=rec?WINS.filter(function(w){return rec.w[w.k].sales!==''}).length:0;
  var cur=rec?rec.w[S.win]:{sales:'',trx:''},editing=cur.sales!=='';
  var h='<div class="card-h"><div><h2 class="card-t" id="entry-t">Encode sales</h2><div class="card-s">Sales per time slot for '+esc(fmtDateShort(S.date))+'</div></div><span class="badge '+(saved===WINS.length?'success':saved?'info':'')+'">'+saved+' of '+WINS.length+' saved</span></div>';
  h+='<div class="sec"><div class="sec-t"><span>Last year · same day</span>'+(lySet?'<span class="badge success">'+icon('check')+'Saved</span>':'<span class="badge warning">Needed for VS LY</span>')+'</div>';
  if(!lySet||S.editLY){
    h+='<div class="grid-2">'+field({id:'fLySales',label:'Sales last year',val:lySet?rec.ly:'',req:true,money:true,mode:'decimal'})+field({id:'fLyTrx',label:'TRX count last year',val:lySet?rec.trxLy:'',req:true,mode:'numeric'})+'</div>';
    h+='<p class="help">Enter 0 for new stores. You can add or change this at any time.</p><div class="row-actions"><button class="btn btn-primary" data-act="saveLY">'+icon('check')+'Save last year</button>'+(S.editLY?'<button class="btn btn-ghost" data-act="cancelLY">Cancel</button>':'')+'</div>';
  }else{
    h+='<div class="ly-box"><div><span class="mini-l">Sales LY</span><span class="mini-v">'+peso(rec.ly)+'</span></div><div><span class="mini-l">TRX LY</span><span class="mini-v">'+int(rec.trxLy)+'</span></div><div class="sp"></div><button class="btn btn-ghost btn-sm" data-act="editLY" aria-label="Edit last year figures">'+icon('edit')+'Edit</button></div>';
  }
  h+='</div><div class="sec"><div class="sec-t"><span id="slotL">Time slot</span><span class="sec-note">Enter each slot’s own sales · select a saved slot to correct it</span></div><div class="slots" role="radiogroup" aria-labelledby="slotL">';
  WINS.forEach(function(w){
    var done=!!rec&&rec.w[w.k].sales!=='',sel=S.win===w.k;
    h+='<button class="slot'+(done?' done':'')+(sel?' sel':'')+(nx===w.k&&!done?' next':'')+'" role="radio" aria-checked="'+sel+'" data-act="win" data-k="'+w.k+'" aria-label="'+w.l+(done?', saved':nx===w.k?', next':'')+'"><span class="slot-l">'+SHORT[w.k]+'</span><span class="slot-s">'+(done?icon('check')+'Saved':nx===w.k?'Next':'Open')+'</span></button>';
  });
  h+='</div>';
  if(editing)h+='<div class="inline-note">'+icon('info')+'<span>Editing the saved '+esc(winLabel(S.win))+' entry.</span></div>';
  h+='<div class="grid-2 mt">'+field({id:'fSales',label:'Sales · '+SHORT[S.win],val:cur.sales,req:true,money:true,mode:'decimal'})+field({id:'fTrx',label:'TRX count · '+SHORT[S.win],val:cur.trx,req:true,mode:'numeric'})+'</div>';
  h+='<div class="preview" id="preview" aria-live="polite"></div><button class="btn btn-primary btn-block btn-lg" data-act="saveWin">'+icon('check')+(editing?'Update ':'Save ')+esc(winLabel(S.win))+'</button></div>';
  el.innerHTML=h;updatePreview();
}
function updatePreview(){
  var el=$('preview');if(!el)return;
  var rec=currentRec(),ly=rec?rec.ly:'';
  var s=num($('fSales')?$('fSales').value:''),t=num($('fTrx')?$('fTrx').value:'');
  // Day total if this slot is saved with the typed figures: other saved slots + this entry.
  var others=0;if(rec)WINS.forEach(function(w){var v=rec.w[w.k];if(w.k!==S.win&&v.sales!=='')others+=v.sales});
  var total=s===''?null:others+s,v=total!=null&&ly>0?total/ly:null,b=basket(s,t);
  var h='<div class="pv"><small>Slot basket</small><b>'+(b==null?'—':peso(b))+'</b></div>';
  h+='<div class="pv"><small>Day total</small><b>'+(total==null?(others?peso(others):'—'):peso(total))+'</b></div>';
  h+='<div class="pv"><small>VS LY (total)</small><b class="'+(v!=null&&v>=1?'pos':'')+'">'+(v==null?'—':pct(v))+'</b></div>';
  el.innerHTML=h;
}
function renderStoreCharts(){
  var a=$('chCum'),b=$('chInc');if(!a||!b)return;
  var rec=currentRec(),pts=savedPoints(rec),ly=rec&&rec.ly!==''?rec.ly:0;
  $('chCum-s').textContent=ly>0?'Running day total (sum of slots) · horizontal line marks LY full-day total':'Running day total (sum of slots)';
  if(!pts.length){
    $('chInc-s').textContent='Each time slot\u2019s own sales';
    [a,b].forEach(function(x){x.querySelector('.plot').innerHTML=stateBlock('trend','No data yet','Charts appear after the first time slot is saved.')});
    return;
  }
  var peak=pts.reduce(function(m,x){return x.sales>m.sales?x:m},pts[0]);
  $('chInc-s').textContent='Peak slot: '+peak.l+' ('+peso(peak.sales)+')';
  drawCum(a,pts,ly);drawInc(b,pts);
}

/* ================= Charts ================= */
function niceStep(max,count){var raw=max/count,mag=Math.pow(10,Math.floor(Math.log10(raw))),n=raw/mag;return (n<=1?1:n<=2?2:n<=2.5?2.5:n<=5?5:10)*mag}
function showTip(box,html,x,y){
  var t=box.querySelector('.ctip');if(!t)return;t.innerHTML=html;t.style.display='block';
  var bw=box.clientWidth,tw=t.offsetWidth;
  t.style.left=Math.max(6,Math.min(bw-tw-6,x-tw/2))+'px';
  var top=y-t.offsetHeight-12;t.style.top=(top<6?y+16:top)+'px';
}
function hideTip(box){var t=box.querySelector('.ctip');if(t)t.style.display='none';var xh=box.querySelector('.xh');if(xh)xh.setAttribute('visibility','hidden')}
function bindHits(box,onHit){
  box.querySelectorAll('[data-hit]').forEach(function(r){var f=function(){onHit(+r.getAttribute('data-hit'))};r.addEventListener('pointerenter',f);r.addEventListener('pointerdown',f)});
  box.onpointerleave=function(){hideTip(box)};
}
function relPos(box,plot,svgX,svgY,W){var k=plot.clientWidth/W,pr=plot.getBoundingClientRect(),br=box.getBoundingClientRect();return [pr.left-br.left+svgX*k-plot.scrollLeft,pr.top-br.top+svgY*k-plot.scrollTop]}
function axisY(L,R,W,y,v,label){return '<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y+'" y2="'+y+'" stroke="var(--grid)" stroke-width="1"/><text x="'+(L-8)+'" y="'+(y+4)+'" text-anchor="end" font-size="11" fill="var(--text-3)">'+label+'</text>'}
function drawCum(box,pts,ly){
  var plot=box.querySelector('.plot'),n=WINS.length;
  var W=Math.max(280,plot.clientWidth),H=220,L=52,R=14,T=22,B=28,pw=W-L-R,ph=H-T-B;
  var maxV=Math.max(ly,pts.reduce(function(m,p){return Math.max(m,p.cum)},0))*1.08||1;
  var st=niceStep(maxV,4),top=Math.ceil(maxV/st)*st;
  function x(i){return L+pw*i/(n-1)}
  function y(v){return T+ph*(1-v/top)}
  var s='<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="Running day total by time slot'+(ly>0?', compared with the last-year full-day total':'')+'">';
  for(var v=st;v<=top+1e-6;v+=st)s+=axisY(L,R,W,y(v),v,compact(v));
  s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--axis)" stroke-width="1"/><text x="'+(L-8)+'" y="'+(y(0)+4)+'" text-anchor="end" font-size="11" fill="var(--text-3)">0</text>';
  WINS.forEach(function(w,i){s+='<text x="'+x(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="11" fill="var(--text-3)">'+SHORT[w.k]+'</text>'});
  if(ly>0)s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(ly)+'" y2="'+y(ly)+'" stroke="var(--text-2)" stroke-opacity=".7" stroke-width="1.5"/><text x="'+(W-R)+'" y="'+(y(ly)-6)+'" text-anchor="end" font-size="11" font-weight="600" fill="var(--text-2)">LY full day '+cpeso(ly)+'</text>';
  s+='<line class="xh" x1="0" x2="0" y1="'+T+'" y2="'+y(0)+'" stroke="var(--text-3)" stroke-width="1" visibility="hidden"/>';
  var line=pts.map(function(p){return x(p.i)+','+y(p.cum)});
  if(pts.length>1)s+='<path d="M'+x(pts[0].i)+','+y(0)+' L'+line.join(' L')+' L'+x(pts[pts.length-1].i)+','+y(0)+' Z" fill="var(--series-wash)"/>';
  s+='<polyline points="'+line.join(' ')+'" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
  pts.forEach(function(p){s+='<circle cx="'+x(p.i)+'" cy="'+y(p.cum)+'" r="4" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>'});
  var e=pts[pts.length-1],ex=x(e.i),ey=y(e.cum),lab=compact(e.cum)+(ly>0?' · '+pct(e.cum/ly):'');
  var anchor=e.i>=n-2?'end':'start',lx=anchor==='end'?ex-8:ex+8,lyPos=ly>0&&Math.abs(ey-y(ly))<18?ey+18:ey-10;
  s+='<text x="'+lx+'" y="'+lyPos+'" text-anchor="'+anchor+'" font-size="12" font-weight="700" fill="var(--text)">'+lab+'</text>';
  var cw=pw/(n-1);
  WINS.forEach(function(w,i){s+='<rect data-hit="'+i+'" x="'+(x(i)-cw/2)+'" y="'+T+'" width="'+cw+'" height="'+ph+'" fill="transparent"/>'});
  plot.innerHTML=s+'</svg>';
  var byI={};pts.forEach(function(p){byI[p.i]=p});
  bindHits(box,function(i){
    var xh=box.querySelector('.xh');xh.setAttribute('x1',x(i));xh.setAttribute('x2',x(i));xh.setAttribute('visibility','visible');
    var p=byI[i],pos=relPos(box,plot,x(i),p?y(p.cum):T+ph/2,W);
    var html=p?'<b>'+esc(p.l)+'</b>Slot sales '+peso(p.sales)+'<br>Slot TRX '+int(p.trx)+'<br>Day total '+peso(p.cum)+(ly>0?'<br>VS LY (total) '+pct(p.cum/ly):''):'<b>'+esc(WINS[i].l)+'</b>Not encoded yet';
    showTip(box,html,pos[0],pos[1]);
  });
}
function roundedBar(x0,y0,yv,bw){var h=Math.abs(y0-yv),r=Math.min(4,h,bw/2);if(yv<=y0)return 'M'+x0+','+y0+' V'+(yv+r)+' Q'+x0+','+yv+' '+(x0+r)+','+yv+' H'+(x0+bw-r)+' Q'+(x0+bw)+','+yv+' '+(x0+bw)+','+(yv+r)+' V'+y0+' Z';return 'M'+x0+','+y0+' V'+(yv-r)+' Q'+x0+','+yv+' '+(x0+r)+','+yv+' H'+(x0+bw-r)+' Q'+(x0+bw)+','+yv+' '+(x0+bw)+','+(yv-r)+' V'+y0+' Z'}
function drawInc(box,pts){
  var plot=box.querySelector('.plot'),n=WINS.length;
  var W=Math.max(280,plot.clientWidth),H=220,L=52,R=14,T=22,B=28,pw=W-L-R,ph=H-T-B;
  var maxV=Math.max(0,pts.reduce(function(m,p){return Math.max(m,p.sales)},0)),minV=Math.min(0,pts.reduce(function(m,p){return Math.min(m,p.sales)},0));
  var st=niceStep(((maxV-minV)*1.12)||1,4),top=Math.ceil(maxV*1.12/st)*st||st,bot=Math.floor(minV/st)*st;
  function y(v){return T+ph*(top-v)/(top-bot)}
  var band=pw/n,bw=Math.min(24,band*0.6);
  function cx(i){return L+band*i+band/2}
  var s='<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="Sales in each time slot">';
  for(var v=bot;v<=top+1e-6;v+=st){if(Math.abs(v)<1e-9)continue;s+=axisY(L,R,W,y(v),v,compact(v))}
  s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--axis)" stroke-width="1"/><text x="'+(L-8)+'" y="'+(y(0)+4)+'" text-anchor="end" font-size="11" fill="var(--text-3)">0</text>';
  WINS.forEach(function(w,i){s+='<text x="'+cx(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="11" fill="var(--text-3)">'+SHORT[w.k]+'</text>'});
  pts.forEach(function(p){if(Math.abs(y(0)-y(p.sales))<0.5)return;s+='<path d="'+roundedBar(cx(p.i)-bw/2,y(0),y(p.sales),bw)+'" fill="var(--series)"/>'});
  var peak=pts.reduce(function(m,x){return x.sales>m.sales?x:m},pts[0]);
  if(peak.sales>0)s+='<text x="'+cx(peak.i)+'" y="'+(y(peak.sales)-6)+'" text-anchor="middle" font-size="12" font-weight="700" fill="var(--text)">'+compact(peak.sales)+'</text>';
  WINS.forEach(function(w,i){s+='<rect data-hit="'+i+'" x="'+(L+band*i)+'" y="'+T+'" width="'+band+'" height="'+ph+'" fill="transparent"/>'});
  plot.innerHTML=s+'</svg>';
  var byI={},total=pts[pts.length-1].cum;pts.forEach(function(p){byI[p.i]=p});
  bindHits(box,function(i){
    var p=byI[i],pos=relPos(box,plot,cx(i),p?Math.min(y(p.sales),y(0)):T+ph/2,W);
    showTip(box,p?'<b>'+esc(p.l)+'</b>Slot sales '+peso(p.sales)+'<br>Slot TRX '+int(p.trx)+(p.trx>0?'<br>Slot basket '+peso(p.sales/p.trx):'')+(total>0?'<br>'+(p.sales/total*100).toFixed(1)+'% of day total':''):'<b>'+esc(WINS[i].l)+'</b>Not encoded yet',pos[0],pos[1]);
  });
}
function drawRank(box,items){
  var plot=box.querySelector('.plot');
  var W=Math.max(300,plot.clientWidth),rowH=26,T=24,B=6,L=Math.round(Math.min(170,Math.max(104,W*0.3))),R=62,pw=W-L-R,H=T+items.length*rowH+B;
  var maxV=Math.max(1,items.reduce(function(m,x){return Math.max(m,x.vs)},0))*1.04,step=maxV>2.2?0.5:0.25;
  function x(v){return L+pw*v/maxV}
  var s='<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="Day total as a percent of last-year full-day sales, by store">';
  for(var v=0;v<=maxV+1e-6;v+=step){var gx=x(v),is100=Math.abs(v-1)<1e-9;s+='<line x1="'+gx+'" x2="'+gx+'" y1="'+(T-4)+'" y2="'+(H-B)+'" stroke="'+(is100?'var(--text-2)':'var(--grid)')+'" stroke-opacity="'+(is100?.7:1)+'" stroke-width="'+(is100?1.5:1)+'"/><text x="'+gx+'" y="'+(T-10)+'" text-anchor="middle" font-size="11" '+(is100?'font-weight="700" fill="var(--text-2)">100% LY':'fill="var(--text-3)">'+Math.round(v*100)+'%')+'</text>'}
  var maxChars=Math.floor((L-14)/6.6);
  items.forEach(function(it,i){
    var cy=T+i*rowH+rowH/2,bh=12,x0=x(0),x1=Math.max(x0+1,x(it.vs)),r=Math.min(4,(x1-x0)/2);
    var nm=it.name.length>maxChars?it.name.slice(0,maxChars-1)+'…':it.name;
    s+='<text x="'+(L-8)+'" y="'+(cy+4)+'" text-anchor="end" font-size="12" fill="var(--text)">'+esc(nm)+'</text>';
    s+='<path d="M'+x0+','+(cy-bh/2)+' H'+(x1-r)+' Q'+x1+','+(cy-bh/2)+' '+x1+','+(cy-bh/2+r)+' V'+(cy+bh/2-r)+' Q'+x1+','+(cy+bh/2)+' '+(x1-r)+','+(cy+bh/2)+' H'+x0+' Z" fill="var(--series)"/>';
    s+='<text x="'+(x1+6)+'" y="'+(cy+4)+'" font-size="11.5" font-weight="600" fill="var(--text)">'+(it.vs*100).toFixed(1)+'%'+(it.vs>=1?' ✓':'')+'</text>';
    s+='<rect data-hit="'+i+'" x="0" y="'+(T+i*rowH)+'" width="'+W+'" height="'+rowH+'" fill="transparent"/>';
  });
  plot.innerHTML=s+'</svg>';
  bindHits(box,function(i){
    var it=items[i],pos=relPos(box,plot,Math.min(x(it.vs),W-R),T+i*rowH+4,W);
    showTip(box,'<b>'+esc(it.name)+' ('+esc(it.id)+')</b>'+esc(it.area)+'<br>Latest slot: '+esc(it.last.l)+'<br>Total sales '+peso(it.sales)+'<br>LY full day '+peso(it.ly)+'<br>VS LY '+pct(it.vs),pos[0],pos[1]);
  });
}
function drawReport(box,counts,total){
  var plot=box.querySelector('.plot'),n=WINS.length;
  var W=Math.max(280,plot.clientWidth),H=220,L=40,R=14,T=24,B=28,pw=W-L-R,ph=H-T-B;
  var top=Math.max(1,total),st=Math.max(1,Math.ceil(niceStep(top,4)));
  function y(v){return T+ph*(1-v/top)}
  var band=pw/n,bw=Math.min(24,band*0.6);
  function cx(i){return L+band*i+band/2}
  var s='<svg viewBox="0 0 '+W+' '+H+'" width="'+W+'" height="'+H+'" role="img" aria-label="Number of stores that encoded each time slot">';
  for(var v=st;v<top;v+=st)s+=axisY(L,R,W,y(v),v,String(v));
  s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(top)+'" y2="'+y(top)+'" stroke="var(--text-2)" stroke-opacity=".7" stroke-width="1.5"/><text x="'+(W-R)+'" y="'+(y(top)-6)+'" text-anchor="end" font-size="11" font-weight="600" fill="var(--text-2)">All '+total+' stores</text>';
  s+='<line x1="'+L+'" x2="'+(W-R)+'" y1="'+y(0)+'" y2="'+y(0)+'" stroke="var(--axis)" stroke-width="1"/><text x="'+(L-8)+'" y="'+(y(0)+4)+'" text-anchor="end" font-size="11" fill="var(--text-3)">0</text>';
  WINS.forEach(function(w,i){
    s+='<text x="'+cx(i)+'" y="'+(H-8)+'" text-anchor="middle" font-size="11" fill="var(--text-3)">'+SHORT[w.k]+'</text>';
    var c=counts[i];if(c>0){s+='<path d="'+roundedBar(cx(i)-bw/2,y(0),y(c),bw)+'" fill="var(--series)"/><text x="'+cx(i)+'" y="'+(y(c)-6)+'" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--text)">'+c+'</text>'}
    s+='<rect data-hit="'+i+'" x="'+(L+band*i)+'" y="'+T+'" width="'+band+'" height="'+ph+'" fill="transparent"/>';
  });
  plot.innerHTML=s+'</svg>';
  bindHits(box,function(i){var c=counts[i],pos=relPos(box,plot,cx(i),y(c),W);showTip(box,'<b>'+esc(WINS[i].l)+'</b>'+c+' of '+total+' stores ('+(total?Math.round(c/total*100):0)+'%)<br>'+(total-c)+' not yet encoded',pos[0],pos[1])});
}

/* ================= Tables (shared) ================= */
function visWins(){return WINS.filter(function(w){return PREF.wins.indexOf(w.k)>=0})}
function visMets(){return METRICS.filter(function(m){return PREF.metrics.indexOf(m.k)>=0})}
function sortTh(key,label,st,act,cls,extra){
  var dir=st.key===key?(st.dir>0?'ascending':'descending'):'none';
  return '<th scope="col" class="'+(cls||'')+'" aria-sort="'+dir+'"'+(extra||'')+'><button class="sort" data-act="'+act+'" data-k="'+key+'">'+label+icon(dir==='ascending'?'sortUp':dir==='descending'?'chevD':'sort','sort-ic')+'</button></th>';
}
function winHeads(st,act){
  var ws=visWins(),ms=visMets(),r1='',r2='';if(!ms.length)return ['',''];
  ws.forEach(function(w){r1+='<th scope="colgroup" colspan="'+ms.length+'" class="gs">'+w.l+'</th>';ms.forEach(function(m,j){r2+=sortTh('w:'+w.k+':'+m.k,m.l,st,act,j===0?'gs':'')})});
  return [r1,r2];
}
function metricCells(o){var ms=visMets();return ms.map(function(m,j){var v=m.k==='sales'?money(o.sales):m.k==='trx'?int(o.trx):m.k==='basket'?(o.basket==null?'':money(o.basket)):vsCell(o.vs);return '<td'+(j===0?' class="gs"':'')+'>'+v+'</td>'}).join('')}
function recWinCells(rec){return visWins().map(function(w){return metricCells(recWin(rec,w.k))}).join('')}
function aggWinCells(a){return visWins().map(function(w){return metricCells(a.w[w.k])}).join('')}
function nextSort(st,key){if(st.key===key)st.dir=-st.dir;else{st.key=key;st.dir=(key==='id'||key==='name'||key==='status')?1:-1}}
function sortVal(row,key){
  var NEG=-Infinity;
  if(key==='id')return isNaN(+row.s.id)?row.s.id:+row.s.id;
  if(key==='name')return row.s.name.toLowerCase();
  if(key==='date')return row.r.date;
  if(key==='status')return {none:0,progress:1,final:2}[row.status];
  if(key==='ly')return row.r.ly===''?NEG:row.r.ly;
  if(key==='trxLy')return row.r.trxLy===''?NEG:row.r.trxLy;
  if(key==='latest')return row.l?row.l.i:NEG;
  if(key==='sofar')return row.l?row.l.sales:NEG;
  if(key==='sotrx')return row.l?row.l.trx:NEG;
  if(key==='vs')return row.vs==null?NEG:row.vs;
  if(key.indexOf('w:')===0){var p=key.split(':'),v=recWin(row.r,p[1])[p[2]];return v===''||v==null?NEG:v}
  return 0;
}
function sortRows(rows,st){if(!st.key)return rows;return rows.slice().sort(function(a,b){var x=sortVal(a,st.key),y=sortVal(b,st.key);return (x<y?-1:x>y?1:0)*st.dir})}
function rowOf(s,r){var rec=r||blankRec(s),l=latest(r);return {s:s,r:rec,has:!!r,l:l,status:storeStatus(r),vs:l&&rec.ly>0?l.sales/rec.ly:null}}
function downloadCsv(name,rows){
  var csv=rows.map(function(r){return r.map(function(v){v=v==null?'':String(v);return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v}).join(',')}).join('\r\n');
  var a=document.createElement('a');a.href=URL.createObjectURL(new Blob(['﻿'+csv],{type:'text/csv;charset=utf-8'}));a.download=name;document.body.appendChild(a);a.click();
  setTimeout(function(){URL.revokeObjectURL(a.href);a.remove()},800);toast('Exported '+name,'success');
}
function csvHead(first){var h=first.slice();WINS.forEach(function(w){METRICS.forEach(function(m){h.push(w.l+' '+m.l)})});return h}
function csvWins(rec){var out=[];WINS.forEach(function(w){var o=recWin(rec,w.k);out.push(o.sales,o.trx,o.basket==null?'':o.basket.toFixed(2),o.vs==null?'':(o.vs*100).toFixed(2))});return out}

/* ================= Store: History page ================= */
function renderHistory(){
  var h=pageHead('Sales History','Every Hakot Day encoded for '+esc(S.me.storeId+' · '+S.me.storeName),'<button class="btn" data-act="refresh">'+icon('refresh')+'Refresh</button><button class="btn" data-act="export-hist">'+icon('download')+'Export CSV</button>');
  if(S.loading){$('content').innerHTML=h+skelTable(6);return}
  if(S.loadError){$('content').innerHTML=h+'<div class="card">'+errorBlock(S.loadError)+'</div>';return}
  h+='<section class="card"><div class="card-h toolbar"><div><h2 class="card-t">Hakot Day records</h2><div class="card-s" id="histCount"></div></div><div class="tools">'+searchBox('histQ','Search by date',S.histQ)+densityBtn()+colsMenu(false)+'</div></div><div id="histBody"></div></section>';
  $('content').innerHTML=h;renderHistTable();
}
function histRows(){
  var q=S.histQ.trim().toLowerCase();
  return S.rows.filter(function(r){return !q||(r.date+' '+fmtDate(r.date)+' '+fmtDateShort(r.date)).toLowerCase().indexOf(q)>=0})
    .map(function(r){return {s:{id:r.storeId,name:r.storeName},r:r,has:true,l:latest(r),status:storeStatus(r),vs:null}})
    .map(function(x){x.vs=x.l&&x.r.ly>0?x.l.sales/x.r.ly:null;return x});
}
function renderHistTable(){
  var el=$('histBody');if(!el)return;
  var rows=sortRows(histRows(),S.hsort),total=S.rows.length;
  $('histCount').textContent=rows.length===total?total+' record'+(total===1?'':'s'):rows.length+' of '+total+' records';
  if(!total){el.innerHTML=stateBlock('inbox','No Hakot Day entries yet','Your encoded Hakot Days will appear here.','<a class="btn btn-primary" href="#/encode">'+icon('edit')+'Encode sales</a>');return}
  if(!rows.length){el.innerHTML=stateBlock('search','No records match your search','Try a different date or clear the search.','<button class="btn" data-act="clear-hist">Clear search</button>');return}
  var st=S.hsort,a='hsort',wh=winHeads(st,a);
  var h='<div class="table-wrap"><table class="dt'+(PREF.density==='compact'?' dense':'')+'"><caption class="sr-only">Hakot Day sales history by date and time slot</caption><thead><tr>';
  h+=sortTh('date','Date',st,a,'l frz solo',' rowspan="2"')+sortTh('status','Status',st,a,'l',' rowspan="2"')+sortTh('ly','Sales LY',st,a,'',' rowspan="2"')+sortTh('trxLy','TRX LY',st,a,'',' rowspan="2"');
  h+='<th scope="colgroup" colspan="4" class="gs">Day total</th>'+wh[0]+'</tr><tr class="r2">'+sortTh('latest','Latest slot',st,a,'gs')+sortTh('sofar','Total sales',st,a)+sortTh('sotrx','Total TRX',st,a)+sortTh('vs','VS LY',st,a)+wh[1]+'</tr></thead><tbody>';
  rows.forEach(function(x){
    h+='<tr class="clickable'+(x.r.date===S.date?' cur':'')+'" data-act="pickDate" data-d="'+esc(x.r.date)+'" tabindex="0" aria-label="Open '+esc(fmtDate(x.r.date))+'"><td class="l frz solo">'+esc(fmtDateShort(x.r.date))+'</td><td class="l">'+statusBadge(x.status)+'</td><td>'+money(x.r.ly)+'</td><td>'+int(x.r.trxLy)+'</td><td class="gs">'+slotBadge(x.l)+'</td><td>'+(x.l?money(x.l.sales):'')+'</td><td>'+(x.l?int(x.l.trx):'')+'</td><td>'+vsCell(x.vs)+'</td>'+recWinCells(x.r)+'</tr>';
  });
  el.innerHTML=h+'</tbody></table></div><div class="table-foot"><span>Select a row to open that date in Encode Sales.</span><span>Showing '+rows.length+' of '+total+'</span></div>';
}
function exportHist(){
  var rows=sortRows(histRows(),S.hsort);if(!rows.length){toast('Nothing to export for the current search.','warning');return}
  var out=[csvHead(['Date','Store ID','Store','Status','Sales LY','TRX LY','Latest slot','Total sales','Total TRX','VS LY total %'])];
  rows.forEach(function(x){out.push([x.r.date,x.r.storeId,x.r.storeName,STORE_STATUS[x.status].l,x.r.ly,x.r.trxLy,x.l?x.l.l:'',x.l?x.l.sales:'',x.l?x.l.trx:'',x.vs==null?'':(x.vs*100).toFixed(2)].concat(csvWins(x.r)))});
  downloadCsv('hakot-day-history-'+S.me.storeId+'.csv',out);
}

/* ================= Viewer: Store Performance ================= */
function scopeAreas(){var a=[];myStores().forEach(function(s){if(a.indexOf(s.area)<0)a.push(s.area)});return a}
function activeFilters(){return (S.f.q.trim()?1:0)+(S.f.areas.length?1:0)+(S.f.status!=='all'?1:0)}
function filteredStores(){
  var q=S.f.q.trim().toLowerCase(),byId=byIdMap();
  return myStores().filter(function(s){
    if(S.f.areas.length&&S.f.areas.indexOf(s.area)<0)return false;
    if(q&&(s.id+' '+s.name).toLowerCase().indexOf(q)<0)return false;
    if(S.f.status!=='all'&&storeStatus(byId[s.id])!==S.f.status)return false;
    return true;
  });
}
function areaFilterHtml(){
  var areas=scopeAreas(),sel=S.f.areas;
  var lbl=!sel.length?'All':sel.length===1?esc(sel[0]):sel.length+' selected';
  var h='<div class="anchor"><button class="btn fbtn" data-act="menu" data-m="areas" aria-haspopup="true" aria-expanded="false"><span class="lbl">Area:</span> <b id="areaLbl">'+lbl+'</b>'+icon('chevD')+'</button><div class="pop pop-scroll" id="pop-areas" hidden role="group" aria-label="Filter by area">';
  areas.forEach(function(a){h+='<label class="chk"><input type="checkbox" data-area-f="'+esc(a)+'"'+(sel.indexOf(a)>=0?' checked':'')+'>'+esc(a)+'</label>'});
  return h+'<div class="pop-sep"></div><div class="pop-foot"><button class="btn btn-ghost btn-sm" data-act="areas-clear">Clear</button><button class="btn btn-sm" data-act="menu-close">Done</button></div></div></div>';
}
function renderDashboard(){
  var scope=S.me.scope?myStores().length+' stores in your scope':'All stores';
  var h=pageHead('Store Performance',esc(scope)+' · '+esc(fmtDate(S.date))+' · <span class="badge">'+icon('eye')+'View only</span>','<button class="btn" data-act="refresh">'+icon('refresh')+'Refresh</button><button class="btn" data-act="export-dash">'+icon('download')+'Export CSV</button>');
  h+='<div class="filterbar" role="search" aria-label="Filters">'+dateCtl()+'<span class="fsep" aria-hidden="true"></span>'+areaFilterHtml();
  h+='<label class="sr-only" for="fStatus">Status</label><select class="select" id="fStatus" style="width:auto;min-width:160px">'+[['all','All statuses'],['none','Not started'],['progress','In progress'],['final','Final submitted']].map(function(o){return '<option value="'+o[0]+'"'+(S.f.status===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select>';
  h+=searchBox('dashQ','Search store or ID',S.f.q)+'<button class="btn btn-ghost" data-act="clear-filters" id="clearF"'+(activeFilters()?'':' hidden')+'>'+icon('x')+'Clear filters <span class="badge info" id="fCount">'+activeFilters()+'</span></button></div><div id="dashBody"></div>';
  $('content').innerHTML=h;renderDashBody();
}
function syncFilterUi(){var n=activeFilters(),b=$('clearF');if(b){b.hidden=!n;$('fCount').textContent=n}var al=$('areaLbl');if(al){var sel=S.f.areas;al.textContent=!sel.length?'All':sel.length===1?sel[0]:sel.length+' selected'}}
function renderDashBody(){
  var el=$('dashBody');if(!el)return;syncFilterUi();
  if(S.loading){el.innerHTML=skelKpis(5)+'<div class="grid-charts">'+skelCard(220)+skelCard(220)+'</div>'+skelTable(7);return}
  if(S.loadError){el.innerHTML='<div class="card">'+errorBlock(S.loadError)+'</div>';return}
  var stores=filteredStores();
  if(!stores.length){el.innerHTML='<div class="card">'+stateBlock('filter','No stores match the selected filters','Try a different area, status, or search term.','<button class="btn" data-act="clear-filters">'+icon('x')+'Clear filters</button>')+'</div>';return}
  var h='<div class="kpis" id="kpis" role="region" aria-label="Key figures"></div><div class="grid-charts">';
  h+='<section class="card chart" id="chRank" aria-labelledby="chRank-t"><div class="card-h"><div><h2 class="card-t" id="chRank-t">VS LY by store</h2><div class="card-s">Day total as a share of LY full-day sales · ranked</div></div></div><div class="card-b"><div class="plot plot-scroll"></div></div><div class="ctip" role="tooltip"></div></section>';
  h+='<section class="card chart" id="chRep" aria-labelledby="chRep-t"><div class="card-h"><div><h2 class="card-t" id="chRep-t">Reporting by time slot</h2><div class="card-s">Stores that have encoded each slot</div></div></div><div class="card-b"><div class="plot"></div></div><div class="ctip" role="tooltip"></div></section></div>';
  h+='<section class="card"><div class="card-h toolbar"><div><h2 class="card-t">Store detail</h2><div class="card-s" id="dashCount"></div></div><div class="tools">'+densityBtn()+colsMenu(true)+'</div></div><div id="dashTable"></div></section>';
  el.innerHTML=h;
  renderDashKpis(stores);renderDashCharts(stores);renderDashTable(stores);
}
function renderDashKpis(stores){
  var el=$('kpis');if(!el)return;var byId=byIdMap(),n=stores.length;
  var started=0,finals=0,sales=0,salesLyBase=0,ly=0,trx=0,trxBase=0,trxLy=0,bLy=0,bTrxLy=0;
  stores.forEach(function(s){var r=byId[s.id],l=latest(r);if(!l)return;started++;if(r.w.FINAL.sales!=='')finals++;sales+=l.sales;trx+=l.trx||0;
    if(r.ly>0){salesLyBase+=l.sales;ly+=r.ly}if(r.trxLy>0){trxBase+=l.trx||0;trxLy+=r.trxLy}if(r.ly>0&&r.trxLy>0){bLy+=r.ly;bTrxLy+=r.trxLy}});
  var vs=ly>0?salesLyBase/ly:null,bk=trx>0?sales/trx:null,bkLy=bTrxLy>0?bLy/bTrxLy:null;
  var h=kpi({label:'Total sales',value:started?cpeso(sales):'—',title:started?peso(sales):'',foot:started?started+' store'+(started===1?'':'s')+' reporting':'No store has encoded yet'});
  h+=kpi({label:'VS LY (total)',value:vs==null?'—':pct(vs),meter:vs==null?'':meterHtml(vs,'Day total as percent of last year full-day sales'),foot:vs==null?'Needs LY and at least one slot':(vs>=1?'<span class="badge success">'+icon('check')+'Ahead of LY</span>':'<span>'+cpeso(ly-salesLyBase)+' to match LY</span>')});
  h+=kpi({label:'Total transactions',value:started?int(trx):'—',foot:trxLy>0?'<span>'+pct(trxBase/trxLy)+' of LY TRX</span>':'LY TRX not available'});
  h+=kpi({label:'Basket size',value:bk==null?'—':peso(bk),foot:bk!=null&&bkLy!=null?deltaHtml(bk/bkLy-1,'vs LY '+peso(bkLy)):'LY basket not available'});
  h+=kpi({label:'Reporting',value:started+' / '+n,meter:meterHtml(n?started/n:0,'Stores reporting'),foot:'<span>'+finals+' final submitted</span>'});
  el.innerHTML=h;
}
function renderDashCharts(stores){
  var a=$('chRank'),b=$('chRep');if(!a||!b)return;var byId=byIdMap();
  var items=[];stores.forEach(function(s){var r=byId[s.id],l=latest(r);if(l&&r.ly>0)items.push({id:s.id,name:s.name,area:s.area,last:l,sales:l.sales,ly:r.ly,vs:l.sales/r.ly})});
  items.sort(function(x,y){return y.vs-x.vs});
  if(items.length)drawRank(a,items);else a.querySelector('.plot').innerHTML=stateBlock('trend','No comparison yet','Stores appear here once they have saved last year and at least one time slot.');
  var counts=WINS.map(function(w){return stores.filter(function(s){var r=byId[s.id];return r&&r.w[w.k].sales!==''}).length});
  if(counts.some(function(c){return c>0}))drawReport(b,counts,stores.length);else b.querySelector('.plot').innerHTML=stateBlock('trend','No slots encoded yet','Bars appear as stores encode their time slots.');
}
function renderDashTable(stores){
  var el=$('dashTable');if(!el)return;
  var byId=byIdMap(),rows=stores.map(function(s){return rowOf(s,byId[s.id])}),st=S.sort,a='sort';
  $('dashCount').textContent=stores.length+' store'+(stores.length===1?'':'s')+' · '+rows.filter(function(x){return x.has}).length+' with entries';
  var ws=visWins(),ms=visMets(),ncols=9+(ms.length?ws.length*ms.length:0),wh=winHeads(st,a);
  var h='<div class="table-wrap"><table class="dt'+(PREF.density==='compact'?' dense':'')+'"><caption class="sr-only">Store sales by time slot for '+esc(fmtDate(S.date))+'</caption><thead><tr>';
  h+=sortTh('id','ID',st,a,'l frz c-id',' rowspan="2"')+sortTh('name','Store',st,a,'l frz2',' rowspan="2"')+sortTh('status','Status',st,a,'l',' rowspan="2"')+sortTh('ly','Sales LY',st,a,'',' rowspan="2"')+sortTh('trxLy','TRX LY',st,a,'',' rowspan="2"');
  h+='<th scope="colgroup" colspan="4" class="gs">Day total</th>'+wh[0]+'</tr><tr class="r2">'+sortTh('latest','Latest slot',st,a,'gs')+sortTh('sofar','Total sales',st,a)+sortTh('sotrx','Total TRX',st,a)+sortTh('vs','VS LY',st,a)+wh[1]+'</tr></thead><tbody>';
  function rowHtml(x){return '<tr><td class="l frz c-id">'+esc(x.s.id)+'</td><td class="l frz2">'+esc(x.s.name)+(x.s.remarks&&x.s.remarks.toLowerCase()==='new'?' <span class="badge info">New</span>':'')+'</td><td class="l">'+statusBadge(x.status)+'</td><td>'+money(x.r.ly)+'</td><td>'+int(x.r.trxLy)+'</td><td class="gs">'+slotBadge(x.l)+'</td><td>'+(x.l?money(x.l.sales):'')+'</td><td>'+(x.l?int(x.l.trx):'')+'</td><td>'+vsCell(x.vs)+'</td>'+recWinCells(x.r)+'</tr>'}
  function totalHtml(label,list,cls){var recs=list.filter(function(x){return x.has}).map(function(x){return x.r}),g=agg(recs),sf=soFar(recs);return '<tr class="'+cls+'"><td class="l frz c-id"></td><td class="l frz2">'+label+'</td><td></td><td>'+money(g.ly)+'</td><td>'+int(g.trxLy)+'</td><td class="gs"></td><td>'+money(sf.sales)+'</td><td>'+int(sf.trx)+'</td><td>'+vsCell(sf.vs)+'</td>'+aggWinCells(g)+'</tr>'}
  if(PREF.group){
    scopeAreas().forEach(function(area){
      var list=sortRows(rows.filter(function(x){return x.s.area===area}),st);if(!list.length)return;
      h+='<tr class="group"><td colspan="'+ncols+'"><span class="glabel">'+esc(area)+'<span class="muted">'+list.length+' store'+(list.length===1?'':'s')+'</span></span></td></tr>';
      list.forEach(function(x){h+=rowHtml(x)});
      h+=totalHtml('Subtotal',list,'sub');
    });
  }else sortRows(rows,st).forEach(function(x){h+=rowHtml(x)});
  h+=totalHtml('Grand total',rows,'grand');
  el.innerHTML=h+'</tbody></table></div><div class="table-foot"><span>Slot columns show each slot’s own sales; VS LY is the running total through that slot. Subtotals compare only stores that reported the slot.</span><span>'+rows.length+' rows</span></div>';
}
function exportDash(){
  var stores=filteredStores(),byId=byIdMap();if(!stores.length){toast('Nothing to export for the current filters.','warning');return}
  var out=[csvHead(['Date','Area','Store ID','Store','Status','Sales LY','TRX LY','Latest slot','Total sales','Total TRX','VS LY total %'])];
  sortRows(stores.map(function(s){return rowOf(s,byId[s.id])}),S.sort).forEach(function(x){out.push([S.date,x.s.area,x.s.id,x.s.name,STORE_STATUS[x.status].l,x.r.ly,x.r.trxLy,x.l?x.l.l:'',x.l?x.l.sales:'',x.l?x.l.trx:'',x.vs==null?'':(x.vs*100).toFixed(2)].concat(csvWins(x.r)))});
  downloadCsv('hakot-day-'+S.date+'.csv',out);
}

/* ================= Admin: Users ================= */
function renderUsers(){
  var c={pending:0,approved:0,disabled:0};S.users.forEach(function(u){c[u.status]=(c[u.status]||0)+1});
  if(!S.userTab)S.userTab=c.pending?'pending':'all';
  function tab(k,l,n){return '<button class="tab" role="tab" aria-selected="'+(S.userTab===k)+'" data-act="utab" data-t="'+k+'">'+l+'<span class="count">'+n+'</span></button>'}
  var h=pageHead('User Accounts','Approve new sign-ups and manage who can access Hakot Day.','<button class="btn" data-act="refreshUsers">'+icon('refresh')+'Refresh</button>');
  h+='<section class="card"><div class="card-h toolbar tabs-bar"><div class="tabs" role="tablist" aria-label="Filter accounts by status">'+tab('pending','Pending approval',c.pending)+tab('approved','Approved',c.approved)+tab('disabled','Disabled',c.disabled)+tab('all','All',S.users.length)+'</div><div class="tools" style="padding:8px 0">'+searchBox('userQ','Search name, email, or store',S.userQ)+'</div></div><div id="usersBody" role="tabpanel"></div></section>';
  $('content').innerHTML=h;renderUsersTable();
}
function userActions(u){
  if(u.email===S.me.email)return '<span class="muted">You</span>';
  if(u.envAdmin)return '<span class="muted">Built-in admin</span>';
  var b='';
  if(u.status!=='approved')b+='<button class="btn btn-primary btn-sm" data-act="setStatus" data-e="'+esc(u.email)+'" data-s="approved">'+icon('check')+(u.status==='disabled'?'Re-enable':'Approve')+'</button>';
  if(u.status!=='disabled')b+='<button class="btn btn-danger btn-sm" data-act="setStatus" data-e="'+esc(u.email)+'" data-s="disabled">'+(u.status==='pending'?'Reject':'Disable')+'</button>';
  return '<div class="td-actions">'+b+'</div>';
}
function renderUsersTable(){
  var el=$('usersBody');if(!el)return;
  var q=S.userQ.trim().toLowerCase(),st=S.usort;
  var list=S.users.filter(function(u){return (S.userTab==='all'||u.status===S.userTab)&&(!q||(u.name+' '+u.email+' '+storeLabel(u)+' '+(u.roleLabel||'')).toLowerCase().indexOf(q)>=0)});
  var order={pending:0,approved:1,disabled:2};
  list.sort(function(a,b){
    var k=st.key,x,y;
    if(k==='name'){x=a.name.toLowerCase();y=b.name.toLowerCase()}else if(k==='role'){x=a.roleLabel;y=b.roleLabel}else if(k==='status'){x=order[a.status];y=order[b.status]}else if(k==='created'){x=a.createdAt;y=b.createdAt}
    else{return (order[a.status]-order[b.status])||a.name.localeCompare(b.name)}
    return (x<y?-1:x>y?1:0)*st.dir;
  });
  if(!list.length){
    var msg=q?['No accounts match your search','Try a different name, email, or store.']:S.userTab==='pending'?['No pending sign-ups','New accounts will appear here for your approval.']:['No accounts in this view','Accounts with this status will appear here.'];
    el.innerHTML=stateBlock(q?'search':'users',msg[0],msg[1],q?'<button class="btn" data-act="clear-userq">Clear search</button>':'');return;
  }
  var h='<div class="table-wrap"><table class="dt'+(PREF.density==='compact'?' dense':'')+'"><caption class="sr-only">User accounts</caption><thead><tr>'+sortTh('name','User',st,'usort','l')+sortTh('role','Role',st,'usort','l')+'<th scope="col" class="l">Stores</th>'+sortTh('status','Status',st,'usort','l')+sortTh('created','Signed up',st,'usort','l')+'<th scope="col" class="l">Reviewed</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead><tbody>';
  list.forEach(function(u){
    var us=USER_STATUS[u.status]||USER_STATUS.pending;
    h+='<tr><td class="l cell-user"><b>'+esc(u.name)+'</b><span>'+esc(u.email)+'</span></td><td class="l"><span class="badge'+(u.role==='admin'?' info':'')+'">'+esc(u.roleLabel)+'</span></td><td class="l wrap"'+(u.scope&&u.scope.length>3?' title="'+esc(u.storeName)+'"':'')+'>'+esc(storeLabelShort(u))+'</td><td class="l"><span class="badge '+us.c+'"><span class="dot"></span>'+us.l+'</span></td><td class="l muted">'+esc(u.createdAt)+'</td><td class="l muted">'+esc(u.reviewedBy?u.reviewedBy+' · '+u.reviewedAt:'—')+'</td><td>'+userActions(u)+'</td></tr>';
  });
  el.innerHTML=h+'</tbody></table></div><div class="table-foot"><span>'+list.length+' account'+(list.length===1?'':'s')+'</span></div>';
}
async function setStatus(btn){
  var email=btn.getAttribute('data-e'),st=btn.getAttribute('data-s'),label=btn.textContent.trim();
  if(st==='disabled'&&!(await confirmDialog({title:label+' '+email+'?',html:'This person will not be able to sign in until an administrator approves the account again.',ok:label,tone:'danger'})))return;
  if(S.busy)return;S.busy=true;btn.disabled=true;
  try{
    await api('/api/users/status',{email:email,status:st});
    S.users.forEach(function(u){if(u.email===email){u.status=st;u.reviewedBy=S.me.email;u.reviewedAt='just now'}});
    toast(st==='approved'?'Access approved for '+email:'Access removed for '+email,'success');
    renderApp();
  }catch(e){toast(e.message,'error');btn.disabled=false}
  finally{S.busy=false}
}

/* ================= Actions ================= */
async function withBusy(btn,fn){
  if(S.busy)return;S.busy=true;var old=btn?btn.innerHTML:'';
  if(btn){btn.disabled=true;btn.innerHTML='<span class="spinner" aria-hidden="true"></span>Saving…'}
  try{await fn()}
  catch(e){toast(e.message,'error');if(e.status===401){S.me=null;S.authNote={kind:'warn',title:'Signed out',text:e.message};renderApp()}}
  finally{S.busy=false;if(btn&&document.body.contains(btn)){btn.disabled=false;btn.innerHTML=old}}
}
async function saveLY(btn){
  var s=num($('fLySales').value),t=num($('fLyTrx').value);
  setErr('fLySales',s===''?'Enter last year sales.':s<0?'Must be 0 or more.':'');
  setErr('fLyTrx',t===''?'Enter last year TRX count.':t<0?'Must be 0 or more.':'');
  if(s===''||s<0){$('fLySales').focus();return}
  if(t===''||t<0){$('fLyTrx').focus();return}
  if(s===0&&!(await confirmDialog({title:'Save zero last-year sales?',html:'Sales last year is '+PESO+'0.00. Use this only for new stores without last-year data.',ok:'Save anyway'})))return;
  await withBusy(btn,async function(){
    var j=await api('/api/save',{date:S.date,storeId:S.store,ly:{sales:s,trx:t}});
    upsert(j.rec);S.editLY=false;S.win=nextWin(j.rec)||'FINAL';
    toast('Last year figures saved','success');renderEncodeParts();
  });
}
async function saveWin(btn){
  var rec=currentRec(),s=num($('fSales').value),t=num($('fTrx').value),k=S.win;
  setErr('fSales',s===''?'Enter the sales amount.':s<0?'Must be 0 or more.':'');
  setErr('fTrx',t===''?'Enter the TRX count.':t<0?'Must be 0 or more.':'');
  if(s===''||s<0){$('fSales').focus();return}
  if(t===''||t<0){$('fTrx').focus();return}
  if(rec&&rec.w[k].sales!==''&&!(await confirmDialog({title:'Update the '+winLabel(k)+' entry?',html:'This replaces the saved entry of <b>'+peso(rec.w[k].sales)+'</b> and <b>'+int(rec.w[k].trx)+'</b> transactions.',ok:'Update entry',tone:'info'})))return;
  await withBusy(btn,async function(){
    var j=await api('/api/save',{date:S.date,storeId:S.store,window:{key:k,sales:s,trx:t}});
    upsert(j.rec);toast(winLabel(k)+' saved','success');
    S.win=nextWin(j.rec)||k;renderEncodeParts();
    var f=$('fSales');if(f&&window.matchMedia('(min-width: 900px)').matches)f.focus();
  });
}
async function reload(msg){
  S.loading=true;S.loadError=null;if(S.page==='dashboard')renderDashBody();
  try{await loadData();if(isAdmin())await loadUsers().catch(function(){});S.loadError=null;if(msg)toast(msg,'info')}
  catch(e){S.loadError=e.message}
  S.loading=false;renderApp();
}
async function setDate(iso){
  if(!iso)return;S.date=iso;S.win=null;S.editLY=false;
  if(isViewer()){
    S.loading=true;renderDashboard();
    try{await loadData();S.loadError=null}catch(er){S.loadError=er.message}
    S.loading=false;renderDashboard();
  }else renderPage();
}
function signOut(){api('/api/logout',{}).catch(function(){}).then(function(){S.me=null;S.rows=[];S.users=[];S.page='';S.authTab='login';S.authNote=null;S.loadError=null;history.replaceState(null,'',location.pathname);renderApp()})}

/* ================= Events ================= */
var qTimer;
document.addEventListener('click',function(e){
  var inAnchor=e.target.closest('.anchor');if(!inAnchor)closeMenus();
  var el=e.target.closest('[data-act]');if(!el||el.disabled)return;
  var a=el.getAttribute('data-act');
  if(a==='tab'){S.authTab=el.getAttribute('data-t');S.authNote=null;renderAuth();var f=document.querySelector('.auth-form input');if(f)f.focus()}
  else if(a==='togglepw'){var i=$(el.getAttribute('data-for')),show=i.type==='password';i.type=show?'text':'password';el.setAttribute('aria-pressed',String(show));el.setAttribute('aria-label',show?'Hide password':'Show password');el.innerHTML=icon(show?'eyeoff':'eye')}
  else if(a==='retry-stores'){api('/api/stores').then(function(j){S.stores=j.stores||[];S.storesError=null;renderAuth()}).catch(function(er){S.storesError=er.message;renderAuth();toast(er.message,'error')})}
  else if(a==='logout'){signOut()}
  else if(a==='skip'){var c=$('content');if(c)c.focus()}
  else if(a==='drawer'){setDrawer(true)}
  else if(a==='drawer-close'){setDrawer(false)}
  else if(a==='collapse'){PREF.collapsed=!PREF.collapsed;savePref();renderShell();renderPage()}
  else if(a==='theme'){setTheme(isDark()?'light':'dark')}
  else if(a==='set-theme'){setTheme(el.getAttribute('data-t'))}
  else if(a==='menu'){e.stopPropagation();toggleMenu(el.getAttribute('data-m'))}
  else if(a==='menu-close'){closeMenus()}
  else if(a==='install'){closeMenus();if(S.installEvt){S.installEvt.prompt();S.installEvt.userChoice.finally(function(){S.installEvt=null})}}
  else if(a==='saveLY'){saveLY(el)}
  else if(a==='editLY'){S.editLY=true;renderEntry();var ly=$('fLySales');if(ly)ly.focus()}
  else if(a==='cancelLY'){S.editLY=false;renderEntry()}
  else if(a==='win'){S.win=el.getAttribute('data-k');renderEntry();var fs=$('fSales');if(fs)fs.focus()}
  else if(a==='saveWin'){saveWin(el)}
  else if(a==='refresh'){reload('Data refreshed')}
  else if(a==='retry'){reload()}
  else if(a==='refreshUsers'){loadUsers().then(function(){renderApp();toast('Accounts refreshed','info')}).catch(function(er){toast(er.message,'error')})}
  else if(a==='setStatus'){setStatus(el)}
  else if(a==='utab'){S.userTab=el.getAttribute('data-t');renderUsers()}
  else if(a==='day'){var n=+el.getAttribute('data-n');setDate(n===0?todayPH():shiftDate(S.date,n))}
  else if(a==='pickDate'){S.date=el.getAttribute('data-d');S.win=null;S.editLY=false;go('encode')}
  else if(a==='sort'){nextSort(S.sort,el.getAttribute('data-k'));renderDashTable(filteredStores())}
  else if(a==='hsort'){nextSort(S.hsort,el.getAttribute('data-k'));renderHistTable()}
  else if(a==='usort'){nextSort(S.usort,el.getAttribute('data-k'));renderUsersTable()}
  else if(a==='density'){PREF.density=PREF.density==='compact'?'comfy':'compact';savePref();renderPage()}
  else if(a==='export-dash'){exportDash()}
  else if(a==='export-hist'){exportHist()}
  else if(a==='clear-filters'){S.f={q:'',areas:[],status:'all'};renderDashboard()}
  else if(a==='areas-clear'){S.f.areas=[];document.querySelectorAll('[data-area-f]').forEach(function(c){c.checked=false});renderDashBody()}
  else if(a==='clear-hist'){S.histQ='';renderHistory()}
  else if(a==='clear-userq'){S.userQ='';renderUsers()}
});
document.addEventListener('change',function(e){
  var t=e.target;
  if(t.id==='fDate'&&t.value)setDate(t.value);
  else if(t.id==='fStatus'){S.f.status=t.value;renderDashBody()}
  else if(t.name==='position'){
    var area=t.value==='area';$('pickOne').hidden=area;$('pickMany').hidden=!area;
    document.querySelectorAll('.choice').forEach(function(c){c.classList.toggle('on',c.querySelector('input').checked)});
  }
  else if(t.hasAttribute&&t.hasAttribute('data-area-f')){var v=t.getAttribute('data-area-f');S.f.areas=S.f.areas.filter(function(x){return x!==v});if(t.checked)S.f.areas.push(v);renderDashBody()}
  else if(t.hasAttribute&&t.hasAttribute('data-col-win')){var k=t.getAttribute('data-col-win');PREF.wins=PREF.wins.filter(function(x){return x!==k});if(t.checked)PREF.wins.push(k);PREF.wins=WINS.map(function(w){return w.k}).filter(function(x){return PREF.wins.indexOf(x)>=0});savePref();rerenderTable()}
  else if(t.hasAttribute&&t.hasAttribute('data-col-met')){var m=t.getAttribute('data-col-met');PREF.metrics=PREF.metrics.filter(function(x){return x!==m});if(t.checked)PREF.metrics.push(m);PREF.metrics=METRICS.map(function(x){return x.k}).filter(function(x){return PREF.metrics.indexOf(x)>=0});savePref();rerenderTable()}
  else if(t.hasAttribute&&t.hasAttribute('data-col-group')){PREF.group=t.checked;savePref();rerenderTable()}
  var pk=t.getAttribute&&t.getAttribute('data-pick');
  if(pk==='all')$('pickMany').querySelectorAll('[data-pick=store]').forEach(function(c){c.checked=t.checked});
  else if(pk==='area')$('pickMany').querySelectorAll('[data-pick=store][data-area="'+CSS.escape(t.getAttribute('data-area'))+'"]').forEach(function(c){c.checked=t.checked});
  if(pk)syncPicker();
  if(t.id==='aStore'&&t.value)setErr('aStore','');
});
function rerenderTable(){if(S.page==='dashboard')renderDashTable(filteredStores());else if(S.page==='history')renderHistTable()}
document.addEventListener('input',function(e){
  var t=e.target;
  if(t.getAttribute('aria-invalid')==='true'&&t.value)setErr(t.id,'');
  if(t.id==='fSales'||t.id==='fTrx')updatePreview();
  else if(t.id==='dashQ'){S.f.q=t.value;clearTimeout(qTimer);qTimer=setTimeout(renderDashBody,160)}
  else if(t.id==='histQ'){S.histQ=t.value;clearTimeout(qTimer);qTimer=setTimeout(renderHistTable,160)}
  else if(t.id==='userQ'){S.userQ=t.value;clearTimeout(qTimer);qTimer=setTimeout(renderUsersTable,160)}
  else if(t.id==='pickQ'){
    var q=t.value.trim().toLowerCase();
    document.querySelectorAll('#pickList .pgroup').forEach(function(g){var any=false;g.querySelectorAll('.st1').forEach(function(l){var m=!q||l.getAttribute('data-text').indexOf(q)>=0||g.getAttribute('data-group').toLowerCase().indexOf(q)>=0;l.hidden=!m;if(m)any=true});g.hidden=!any});
  }
});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'){closeMenus();setDrawer(false);return}
  if(e.key==='Enter'||e.key===' '){var row=e.target.closest&&e.target.closest('tr[data-act="pickDate"]');if(row&&e.target===row){e.preventDefault();row.click();return}}
  if(e.key!=='Enter')return;var id=e.target.id;
  if(id==='fSales'){e.preventDefault();$('fTrx').focus()}
  else if(id==='fTrx'){e.preventDefault();var b=document.querySelector('[data-act=saveWin]');if(b)saveWin(b)}
  else if(id==='fLySales'){e.preventDefault();$('fLyTrx').focus()}
  else if(id==='fLyTrx'){e.preventDefault();var c=document.querySelector('[data-act=saveLY]');if(c)saveLY(c)}
});
document.addEventListener('submit',async function(e){
  var f=e.target,kind=f.getAttribute('data-form');if(!kind)return;e.preventDefault();
  var data={};new FormData(f).forEach(function(v,k){data[k]=v});
  var bad=null;function need(id,ok,msg){setErr(id,ok?'':msg);if(!ok&&!bad)bad=id}
  if(kind==='signup')need('aName',!!(data.name||'').trim(),'Enter your full name.');
  need('aEmail',/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((data.email||'').trim()),'Enter a valid email address.');
  need('aPass',kind==='login'?!!data.password:(data.password||'').length>=6,kind==='login'?'Enter your password.':'Use at least 6 characters.');
  if(kind==='signup'){
    if(data.position==='area'){
      var boxes=f.querySelectorAll('[data-pick=store]'),ids=[];boxes.forEach(function(c){if(c.checked)ids.push(c.value)});
      if(!ids.length){setErrBox('pickMany','Select at least one store.');if(!bad)bad='pickQ'}
      data.storeIds=ids.length===boxes.length?'ALL':ids;delete data.storeId;
    }else need('aStore',!!data.storeId,'Select your store.');
  }
  if(bad){var bf=$(bad);if(bf)bf.focus();return}
  var btn=f.querySelector('button[type=submit]'),old=btn.innerHTML;btn.disabled=true;btn.innerHTML='<span class="spinner" aria-hidden="true"></span>Please wait…';
  try{
    var j=await api('/api/'+kind,data);
    if(j.pending){S.authTab='login';S.authNote={kind:'ok',title:'Account submitted',text:'Thanks, '+data.name+'. An administrator needs to approve your account before you can sign in.'};renderAuth();return}
    S.me=j.user;S.store=defaultStore();S.date=todayPH();S.win=null;S.authNote=null;S.loadError=null;
    S.page=defaultPage();history.replaceState(null,'','#/'+S.page);
    S.loading=true;renderApp();
    try{await loadData()}catch(e2){S.loadError=e2.message}
    if(isAdmin()){try{await loadUsers()}catch(e3){}}
    S.loading=false;renderApp();toast('Welcome, '+S.me.name,'success');
  }catch(er){
    if(er.status===403){S.authNote={kind:'warn',title:'Cannot sign in yet',text:er.message};renderAuth();return}
    btn.disabled=false;btn.innerHTML=old;
    if(er.status===401&&kind==='login'){setErr('aPass',er.message);$('aPass').focus()}
    else if(er.status===409){setErr('aEmail',er.message);$('aEmail').focus()}
    else toast(er.message,'error');
  }
});
window.addEventListener('hashchange',function(){
  if(!S.me)return;S.page=readRoute();renderApp();
  var c=$('content');if(c)c.focus({preventScroll:true});window.scrollTo(0,0);
});
var rT,lastW=0;
function redrawCharts(){if(S.page==='encode')renderStoreCharts();else if(S.page==='dashboard'&&$('chRank'))renderDashCharts(filteredStores())}
var chartRO=window.ResizeObserver?new ResizeObserver(function(en){var w=Math.round(en[0].contentRect.width);if(Math.abs(w-lastW)<2)return;var first=!lastW;lastW=w;if(first)return;clearTimeout(rT);rT=setTimeout(redrawCharts,120)}):null;
if(!chartRO)window.addEventListener('resize',function(){clearTimeout(rT);rT=setTimeout(redrawCharts,150)});
function netStatus(){document.body.classList.toggle('is-offline',!navigator.onLine)}
window.addEventListener('offline',function(){netStatus();toast('Connection lost. Changes cannot be saved until you are back online.','warning')});
window.addEventListener('online',function(){netStatus();toast('Back online','success')});
window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();S.installEvt=e;if(S.me)renderShell(),renderPage()});
window.addEventListener('appinstalled',function(){S.installEvt=null;toast('Hakot Day was installed on this device','success')});
if(window.matchMedia)matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(){if(getTheme()==='system'){syncThemeColor();if(S.me)renderApp()}});

/* ================= Boot ================= */
(async function boot(){
  syncThemeColor();netStatus();renderApp();
  if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(function(){});
  try{S.stores=(await api('/api/stores')).stores||[]}catch(e){S.storesError=e.message}
  try{S.me=(await api('/api/me')).user}
  catch(e){S.me=null;if(e.status===401&&e.message!=='Please log in.')S.authNote={kind:'warn',title:'Signed out',text:e.message}}
  if(S.me){
    S.page=readRoute();S.store=defaultStore();
    try{await loadData()}catch(e){S.loadError=e.message}
    if(isAdmin()){try{await loadUsers()}catch(e){}}
  }
  S.booting=false;renderApp();
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
