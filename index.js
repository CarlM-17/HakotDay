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

// Wines & Liquor: product list lives in the 'Wines&Liquor' tab (column B from row 3);
// store entries go to 'WLData', one row per Date + Store + Item. Quantities are whole cases.
// Slots hold the cases sold in that slot only; Total Sold = sum of slots.
const WL_ITEMS_SHEET = 'Wines&Liquor';
const WL_SHEET = 'WLData';
const WL_HEADERS = ['Date', 'Area', 'StoreID', 'StoreName', 'Item', 'Allocation (cs)']
  .concat(WINDOWS.map(w => (w.key === 'FINAL' ? 'FINAL' : w.label) + ' (cs)'), ['Total Sold (cs)', 'Sell-through %']);
const WL_NCOLS = WL_HEADERS.length; // 15 -> A..O

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
function batchPutValues(data) {
  return sheets('POST', '/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data });
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
  const needed = [[USERS_SHEET, USER_HEADERS], [LOG_SHEET, LOG_HEADERS], [WL_SHEET, WL_HEADERS]].filter(([t]) => !titles.includes(t));
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

// ---------- Wines & Liquor ----------
async function loadWlItems() {
  let grid;
  try { grid = await getValues("'" + WL_ITEMS_SHEET + "'!A1:Z"); }
  catch (e) { throw new Error('The ' + WL_ITEMS_SHEET + ' tab was not found. Add it with a "Description" header and the items below it.'); }
  // Items sit under the "Description" header wherever it is (column A today); fallback: first non-empty column.
  let hr = -1, hc = -1;
  for (let r = 0; r < Math.min(grid.length, 10) && hr < 0; r++) {
    const c = (grid[r] || []).findIndex(v => idStr(v).toLowerCase() === 'description');
    if (c >= 0) { hr = r; hc = c; }
  }
  if (hc < 0) { hr = -1; hc = 0; while (hc < 26 && !grid.some(row => idStr((row || [])[hc]))) hc++; }
  const seen = new Set();
  return grid.slice(hr + 1).map(r => idStr((r || [])[hc]))
    .filter(n => n && n.toLowerCase() !== 'description' && !seen.has(n) && seen.add(n));
}
async function loadWlRows() {
  await ensureSheets();
  const rows = await getValues(WL_SHEET + '!A2:O');
  const out = [];
  rows.forEach((r, i) => {
    const c = r.slice();
    while (c.length < WL_NCOLS) c.push('');
    const rec = {
      row: i + 2, date: isoDate(c[0]), area: idStr(c[1]), storeId: idStr(c[2]),
      storeName: idStr(c[3]), item: idStr(c[4]), alloc: num(c[5]), q: {},
    };
    WINDOWS.forEach((w, j) => { rec.q[w.key] = num(c[6 + j]); });
    if (rec.date && rec.storeId && rec.item) out.push(rec);
  });
  return out;
}
function wlCells(r) {
  const id = /^\d+$/.test(r.storeId) ? Number(r.storeId) : safeText(r.storeId);
  let sold = 0, any = false;
  const qs = WINDOWS.map(w => { const v = r.q[w.key]; if (v !== '') { sold += v; any = true; } return v; });
  return [r.date, safeText(r.area), id, safeText(r.storeName), safeText(r.item), r.alloc]
    .concat(qs, [any ? sold : '', any && r.alloc > 0 ? pctText(sold, r.alloc) : '']);
}
const wlPublic = r => ({ date: r.date, area: r.area, storeId: r.storeId, storeName: r.storeName, item: r.item, alloc: r.alloc, q: r.q });
// '' = not entered; null = invalid; otherwise a whole number of cases >= 0
function caseQty(v) {
  if (v === '' || v === null || v === undefined) return '';
  const n = num(v);
  return n === '' || n < 0 || Math.round(n) !== n ? null : n;
}

// Store: its own rows for the date. Admin / area manager: every store in scope for the date.
app.get('/api/wl', requireUser, wrap(async (req, res) => {
  const date = idStr(req.query.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date.' });
  const [items, all] = await Promise.all([loadWlItems(), loadWlRows()]);
  const scope = req.user.scope;
  const rows = all.filter(r => r.date === date && (!scope || scope.includes(r.storeId)));
  res.json({ items, rows: rows.map(wlPublic) });
}));

// Body: { date, alloc: {item: cases} }  or  { date, window: { key, qty: {item: cases} } }
app.post('/api/wl/save', requireUser, wrap(async (req, res) => {
  if (req.user.viewer) {
    return res.status(403).json({ error: 'Admin and area manager accounts are view-only. Only store accounts can encode.' });
  }
  const date = idStr(req.body.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date.' });
  const store = (await loadStores()).find(s => s.id === req.user.storeId);
  if (!store) return res.status(400).json({ error: 'Your store is not in ListOfStores.' });
  const [items, all] = await Promise.all([loadWlItems(), loadWlRows()]);
  const byItem = new Map(all.filter(r => r.date === date && r.storeId === store.id).map(r => [r.item, r]));
  const blank = item => ({ date, storeId: store.id, item, alloc: '', q: Object.fromEntries(WINDOWS.map(w => [w.key, ''])) });
  const touched = [];
  let logEntry;

  if (req.body.alloc) {
    let total = 0;
    for (const item of items) {
      const v = caseQty(req.body.alloc[item]);
      if (v === '' || v === null) return res.status(400).json({ error: 'Enter the allocation for every item in whole cases (use 0 if none): ' + item });
      const rec = byItem.get(item) || blank(item);
      rec.alloc = v; total += v; touched.push(rec);
    }
    logEntry = ['W&L Allocation', total];
  } else if (req.body.window) {
    const w = WINDOWS.find(x => x.key === idStr(req.body.window.key));
    if (!w) return res.status(400).json({ error: 'Unknown time slot.' });
    const qty = req.body.window.qty || {};
    let total = 0;
    for (const item of items) {
      if (!(item in qty)) continue;
      const v = caseQty(qty[item]);
      if (v === null) return res.status(400).json({ error: 'Use whole cases (0 or more) for ' + item + '.' });
      const rec = byItem.get(item);
      if (!rec || rec.alloc === '') return res.status(400).json({ error: 'Save the allocation before encoding time slots.' });
      rec.q[w.key] = v; if (v !== '') total += v; touched.push(rec);
    }
    if (!touched.length) return res.status(400).json({ error: 'Nothing to save.' });
    logEntry = ['W&L ' + w.label, total];
  } else {
    return res.status(400).json({ error: 'Nothing to save.' });
  }

  touched.forEach(r => { r.area = store.area; r.storeName = store.name; });
  const updates = touched.filter(r => r.row).map(r => ({ range: WL_SHEET + '!A' + r.row + ':O' + r.row, values: [wlCells(r)] }));
  const inserts = touched.filter(r => !r.row).map(wlCells);
  if (updates.length) await batchPutValues(updates);
  if (inserts.length) await appendValues(WL_SHEET + '!A:O', inserts);
  await appendValues(LOG_SHEET + '!A:I', [[
    nowPH(), safeText(req.user.email), safeText(req.user.name), date, Number(store.id) || store.id,
    safeText(store.name), logEntry[0], logEntry[1], '',
  ]]);
  const mine = items.map(i => byItem.get(i) || touched.find(t => t.item === i)).filter(Boolean);
  res.json({ rows: mine.map(wlPublic) });
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
// App icons generated from Hakot_icon.jpg (CMNVA - HAKOT badge), embedded so the app stays two files.
// any = transparent round badge; maskable = badge at 80 percent on solid green (Android safe zone); apple = solid bg (iOS).
const ICONS = {
  '/icon-192.png': 'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAMAAABlApw1AAADAFBMVEXFkxuwkiPq0GuZaCPq3pTXs1CzpWfoymHrzWjr56WhcRzToi3YtWHy55t7YCXWpTamdh7t2WlSXWSZe1UAAGritkbhsUK5iiO+pzc+UEG8kCS8sF6HfmIAf3/AjiMAAP//qqrU//9//399hldVVapOT0LMZgBZZRwzAABVKlUAAAABJRcCGQwBMyQDCAIBLSHWpzbIly3uxlDmuka1iCn2126TZxWmdxr85pDOqErjtDsvJwzYtE+Tdy3qymsnGANNOA9qSQ65lDSzl0t2ZSsyNRR1VRVTRRcHNBvy2oz401moeyWJaibQt2t3dk5uWSZPSir943ZTVTF/fwDdsTu1gxydcRmFXBAzRiz//wCRhVHBjib+9axFKwj56qm1p22qVQArOSamikiZgzfEnEW5fQi9fj3/8pjZw3K7olKFekuqqgDgrTZqZ0ipmWXFqmb/AAC/vz+qqVQuRRpTWEPTxov/fwD9/392czb++Mb9qlOTaBaSaRiWaReTimLCjh6oeRsVQiKmdhpYVRtZZUamdhqVaRXKlyy4iSWZlGThvWe4iCW5iiR8PQCVaRj9/ay4iCWVaRjIu4XXqDk5US7YpzXWpjR/f3/JlyygbhFXYzP6vT61hSd6Yhq8snXm3KfXpjT////aqjqWaQ+UaSWYkVvizYioeRqteRqcchhKPSLYqDTGlSvQpzDKmDC9kCjImRH95ZaMaSX25JCoeRdjPQT//1XXtlT144/jtTvGly7r24nktzj/v3/xwT/59LTIly7ZtE6peyO9u3pjTSbHlCq0hyfe0pLjy22zgh6ymk61o06yiBboxUkZQx68uIaVeDDAjiidcRaccRj//MnkuUHiuUb56pydeAySaCGBXyH77aX866VVVQDQrU3csy3btUsmLSMhDwH/f3/buVPUw3LZyoO7iii3hR/77aRmZmbex3LXwWr456KRaSb044/244zOuW3755KecxyZcRn/qgDkpjnq3IqccBSbom/r1HLHp0q1hA8A/wC4hB2yghzOvivMAAABAHRSTlMWHhscYywjbqcYVuZTjg2kkf8JCgKl4Jr//0VB/wJ6AQMGAv8D/wX/BQYA///////+/v7+/v79/f7+/v/+//7////+/////////v/+////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',
  '/icon-512.png': 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAADAFBMVEXhtFfx4ZjQnyDaskn36qGhdR7x4ZmskxTTsVPPniibaVD26J+1jSWhdSDVoy6tomPkympralTPrVl2XSuxkCnqzmWPYBDm0GrmymmplSyXZxj79M+SckVhZyjYpS/pzDyopJuxmUu5qVCmoonhrp7VuI17Egy3p14nUR7Ouo1lZFq3PAzMuocfIyHl3ct8gFoA/wAAfwAAAP/CfCHg0jsAAFX798E/f7/XsMQ/P7//AP+RbZF///9VqgB9Xit/AH9kPSQfHwAAAAAAJRcCGgwBMyQEBwIBLSHWpzXIly3txlDmuka2iCiTZxT1122mdxn65pHjtTvYtU3QqUgrGARQNwwzJgrpyWkGNBr101i5ky9rSAyqeiTbsjm0hRqcchf99rL36azu2IuSdi7CjCj9+M1tWChHKQd0VRLRuGyHWgyyl0xWRBOLaSr643f8+ul2ZS/axW81NRBSRyfhrDjVx464pE1/fwCpiUdkOwUkDAGVhk3q2qn//wCjbBOqVQDGm0bbw1Szpm6MeUhXVS7ky4rHqmeZhDXqxDuqqgDGlhv16sbKuoltaEgVQiPirET98pf+qlX/fwD/AABnSiSsmmqqqVSPiWrDihq7kxovRxhKOyQEHCH///54dVCalXEzOCT//3/kvGYsRyW3pDq5tYt1ZRmvqIYUQxzZ1Kn//628fjzc0ZS4fQZDHQJTVRZ5cjSVaxiTaRiak1R9PgAsUybJlymndhm3iCTGmCrRyqf/qgB/f3+6snX/f3+ibCPXpza0iCeTaRfHlyxXV0WDXCaUaRXRpBrJlyrUqDGPaiuoeBildxaVahioeRmneRbSqDTxujz//1XWpzR/fz2neBjVpjPKlym0hhaTdCzWpzXQqTKPaSO+vj2Say/Mt2+6lSSTaSWTcxSwhRaOaCe2hyX+4VrHly2zhBqxiCa3hiaSahiRayWoeCK1hyWReDCRayuYdCzkzKWbchZVVQCviCiEfGSQZhXVtTHMlzC1hRydcRi2liireyPjuEjLuG13S+IfAAABAHRSTlMaWR6fo1klFGKeD8+clloTpv/YEV0f5eFi7x8X///Y/wmm4v8V/wNX/1gHBJr///8BAgH/CAOBBA0EAQcCA0EC/wgA///////+/v7+/v7+/v7+/v7////+//7+//7+/v7+/v7+/v/////+/v///v7///7///7//gL//////wH+A/7+//////7//wP///////7/AwIB//8D//7+////Av///wL+/////////wQG/gn////QUP8E/7TN0S//AwL/Av7NkI3R//9w/1BNLk6Ps7IxLg4DcgR0kG5yMqwSzQQRsDGxFDFvb/+MszGxLJbKTRRPSf9rAxj/ERMSz7EWLtCSGm0n7gAAyX5JREFUeNrs/QdgHNl1JgrD8soKqyxZsizJOex649t9f46vu1io6q4OqNRE5wB0QHdj0GgABAGQg0SCw2ByhqRIijMcDid5pNHMSPKzZFmyJEuyHCTZ6yiHddI6p13HdXp+59x7q+pWdXUCujHkaK40JAiCQHed757wnTQR+Fo5jzzy2CPvf/9j78fziU9c9vv797/xscfgCx577BOPnPhaeSwTXwOCJzL3SvSRQOD93/D+97/rXfB373qk858RpDz42ImXAXCvnhOPoAwd0T7yrne96+vg/F//BZ5/iSdfICcexz+QT/8L/IpvgOP8u8feOPFSxsFLEgCPfJcj+ce+4RtApihxEHXefeATFAD0XMJDPyR4IFCwvufPvUTVwUsMACc+8f7HmOj/J0oeBG9J+1J8uEO/vvgvCRC+kX7PH/25iZcaCl5CAHjkvRPvpx+B6FHyBXbNnTs+xJnHE4X/8A/R6Dve9E3f9I1UHZx4SZmElwgAPvH+R8jF/w289f+yQAUfP8hB0c9H7YNoABS86Zu+kSqDB3/uvSdeBsBdIvyfoxf/vSh7cunjIzrzHAIYDuA/GwWP/JeXAAjucQCceJAKf8Jz7wuWf39ABBThRDvP9DssEDz2c49dfhkAL865/Ngbidr/2W/6F/8yjrKPj/rMU0eg8yQQBCF0C4g5ePDEywA49Kv/XnL1//rVbxqr8P2kj7IPJRKJEP7ONMEjP/ejLwPgEKVPrP7/9sZv+hfxSwf29vrgwA8AKH12pqdD73jTq8lTfPC9l18GwKGY/cfg19/5Xrj6s4Pd/P0jpFjsBwB6wl//TeRB/td7zyGYuNekj2b/VW97U7EwDr3vNQLU7e8LgDD+9398/cQE0QMvA2B8dh/v/qu+903FfVt9DxtccA73WcoBUlkXo0V/CLgAEA6rKsXAg/AKP/DQywAYw3kvPtvXfi93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',
  '/icon-maskable-512.png': 'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAADAFBMVEUBNSUAJRcCGQwDBwIBLSHWpzXIly3txk/muka1iCiTZxT1122ndxn65pHjtTvWtU0zJgvOqUkpGAVQNw3pyWkGNBq5lDD101lrSAzQuGu0hBqpeySSdi7csjnu2Iz16K1GKgecchj99rF0VRKxl0zCjSiKaSlVRBNtWCj8+c+GWg1zZS3743c0NRRRViq4pE1PSCgsSCbaxHD+/erVx42mikuVhkwXQifhrDeibBKYgzK0pm3p2qdkPAfFm0eMekjGqmjLuoh0dlB2YxlUVRoyNyXky4lsaEo0VC1lSyTqwjzbwVaMh2nGlhupmWsvRxl4dDH+8pf168dVZDDDihnjvGQjDALa0pZJOiLirUa5tIyWlXCwqodUVkW7ozuWk1MVQh1RZkjb06S7kRq7snBYdE/VyqV2hFFEHQQBHSGEXCN5eGIpLCPizKBMTUOao280WkFmXUSakzvcwzwyUBv/4VuHa0eDTRHPphvFrImhbSKjm4Dc0Xf50jw6YkZ6cByGeGX/8XsyTECehxzVsx2bpIe/wIu7slGjfUCZmYPx7+PnvofkrRPZ0cHBuKDEmWLDehqgXxOcoFnt38pqhmNbcDtRYh5BLyIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVx1XnAAABAHRSTlP//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////wAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzE9VMwAAhdpJREFUeNrtvQdj29ayLioAAkiwASAoiAVsIkRSoihSDCWrF9e4xnYcOy5JdsrObqefe8497fb6en/v776ZtRYqQYoSaUu2MYmbGst8a8o3s2YWFiKJJJJIIokkkkgiiSSSSCKJJJJIIokkkkgiiSSSSCKJJJJIIokkkkgiiSSSSCKJJJJIIokkkkgiiSSSSCKJJJJIIokkkkgiiSSSSCKJJJJIIokkkkgiiSSSSCKJJJJIIokkkkgiiSSSSCKJJJJIIokkkkgiiSSSSCKJJJJIIokkkkjej9y48eVf/dt/++OPv7Xlxx9//Ksvv7xxI3prPmWtf/lvf/t/v/0vb4bDV4dVkBWPPHuWBqlUhoPCLwc//O63P34ZYeFT0vxvf/eXb155VJ6eIM9Q0unkoHCw89sft6K376NW/V/99u2bIdN8tZqeUirJjY00/J9GHPzyw82vIxh8jLr/3V8OK6j6Z+kLCyg/acvGxkYyV+j9LkLBxyNbP759UznP1J+HgWSlkkx6YJDMKT88jUKD66/83/7lsDqb7pkRSIbIstL7XQSC62v2v/5hmJ6D8kH7KEHtx2K5XA7+UKynX0Zv9rWTL28Ss19Nz0kqIwDI5WJUlpdj2s7XkSG4Ttr/XaE6R+WfAwAqyt9EGLgm2v9heBHtexigql88nFBoBOBBQDyuIAasTpQbXLX2306rfVvnPw3fvHuyc/PevXa/3//WFvh7v33v3snO24M3QBXaqYAfAK7+AQFxRYkjBiI7cIUh/+8G6SliPqb4N08egdJVNZsVULKj8lKgn1HVb/v3TqyDQcUPA8cExJkoAIK4tv91pIqriPl/e1B5tjKN7ocHj+71u1leEF5SRaseGfkA+xCBiNpvnzwpVAgIiPbtX3EPBAADohnlBR/c8Q/O0T7q/vDsyb2+isrksx7t8iBCqPC8FyLUKGTVb9s7hRxE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',
  '/apple-touch-icon.png': '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',
  '/favicon-64.png': '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',
};

const MANIFEST = {
  name: 'Hakot Day Sales',
  short_name: 'Hakot Day',
  start_url: '/',
  display: 'standalone',
  background_color: '#f3f6f4',
  theme_color: '#0e2a1b',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

const SW_JS = String.raw`
const CACHE = 'hakot-day-v4';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/favicon-64.png'];
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

Object.keys(ICONS).forEach(path => {
  const buf = Buffer.from(ICONS[path], 'base64');
  app.get(path, (req, res) => res.type('image/png').set('Cache-Control', 'public, max-age=604800').send(buf));
});
app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon-64.png'));
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
<link rel="icon" href="/favicon-64.png" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
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
  --bg:#f3f6f4;--surface:#ffffff;--surface-2:#f7faf8;--surface-3:#edf2ee;
  --border:#e1e8e3;--border-strong:#cad6ce;
  --text:#1f2937;--text-2:#4b5563;--text-3:#6b7280;
  --primary:#166534;--primary-hover:#14532d;--primary-soft:#e7f3eb;--primary-ink:#ffffff;
  --nav-bg:#0e2a1b;--nav-text:#cfe1d5;--nav-muted:#8eab99;--nav-hover:rgba(255,255,255,.06);--nav-active:rgba(255,255,255,.11);--nav-accent:#4ade80;--nav-line:rgba(255,255,255,.07);
  --success:#15803d;--success-bg:#e7f5ec;--danger:#b91c1c;--danger-bg:#fdecec;--warning:#a16207;--warning-bg:#fdf4e1;--info:#1d4ed8;--info-bg:#eaf0fd;--neutral:#4b5563;--neutral-bg:#eef1f5;
  --series:#15803d;--series-wash:rgba(21,128,61,.10);--track:#d5ebdc;--grid:#e7ede9;--axis:#c2ccc5;--good-fill:#15803d;
  --group:#f1f5f2;--total:#f7faf8;--hover:#f4f8f5;--sel:#eaf5ee;
  --shadow-1:0 1px 2px rgba(16,24,40,.05);--shadow-2:0 4px 12px rgba(16,24,40,.08),0 1px 3px rgba(16,24,40,.06);--shadow-3:0 18px 44px rgba(16,24,40,.20);
  --ring:0 0 0 3px rgba(22,101,52,.30);
  --skel:#e6ece8;--skel-hi:#f3f7f4;
  --tip-bg:#0e2a1b;--tip-text:#f5faf7;
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0b110e;--surface:#141b17;--surface-2:#18211c;--surface-3:#1f2a24;
  --border:#25332b;--border-strong:#33463b;
  --text:#e4ece7;--text-2:#b1c2b7;--text-3:#8da094;
  --primary:#15803d;--primary-hover:#166534;--primary-soft:rgba(34,197,94,.14);--primary-ink:#ffffff;
  --nav-bg:#07130c;--nav-text:#c3d6c9;--nav-muted:#7f9a89;--nav-hover:rgba(255,255,255,.05);--nav-active:rgba(255,255,255,.09);--nav-accent:#4ade80;--nav-line:rgba(255,255,255,.06);
  --success:#4ade80;--success-bg:rgba(34,197,94,.14);--danger:#f87171;--danger-bg:rgba(239,68,68,.14);--warning:#fbbf24;--warning-bg:rgba(245,158,11,.14);--info:#60a5fa;--info-bg:rgba(59,130,246,.15);--neutral:#b3bfcd;--neutral-bg:rgba(148,163,184,.13);
  --series:#22a05a;--series-wash:rgba(34,160,90,.16);--track:#1c3526;--grid:#212c26;--axis:#384a3f;--good-fill:#22a05a;
  --group:#19221d;--total:#171f1a;--hover:#1b2520;--sel:#1a2b21;
  --shadow-1:0 1px 2px rgba(0,0,0,.3);--shadow-2:0 4px 14px rgba(0,0,0,.35);--shadow-3:0 18px 44px rgba(0,0,0,.55);
  --ring:0 0 0 3px rgba(74,222,128,.40);
  --skel:#1d2621;--skel-hi:#27322b;
  --tip-bg:#e4ece7;--tip-text:#0e2a1b;
}
@media (prefers-color-scheme:dark){
  :root[data-theme="system"]{
    color-scheme:dark;
    --bg:#0b110e;--surface:#141b17;--surface-2:#18211c;--surface-3:#1f2a24;
    --border:#25332b;--border-strong:#33463b;
    --text:#e4ece7;--text-2:#b1c2b7;--text-3:#8da094;
    --primary:#15803d;--primary-hover:#166534;--primary-soft:rgba(34,197,94,.14);--primary-ink:#ffffff;
    --nav-bg:#07130c;--nav-text:#c3d6c9;--nav-muted:#7f9a89;--nav-hover:rgba(255,255,255,.05);--nav-active:rgba(255,255,255,.09);--nav-accent:#4ade80;--nav-line:rgba(255,255,255,.06);
    --success:#4ade80;--success-bg:rgba(34,197,94,.14);--danger:#f87171;--danger-bg:rgba(239,68,68,.14);--warning:#fbbf24;--warning-bg:rgba(245,158,11,.14);--info:#60a5fa;--info-bg:rgba(59,130,246,.15);--neutral:#b3bfcd;--neutral-bg:rgba(148,163,184,.13);
    --series:#22a05a;--series-wash:rgba(34,160,90,.16);--track:#1c3526;--grid:#212c26;--axis:#384a3f;--good-fill:#22a05a;
    --group:#19221d;--total:#171f1a;--hover:#1b2520;--sel:#1a2b21;
    --shadow-1:0 1px 2px rgba(0,0,0,.3);--shadow-2:0 4px 14px rgba(0,0,0,.35);--shadow-3:0 18px 44px rgba(0,0,0,.55);
    --ring:0 0 0 3px rgba(74,222,128,.40);
    --skel:#1d2621;--skel-hi:#27322b;
    --tip-bg:#e4ece7;--tip-text:#0e2a1b;
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
.brand-mark{width:32px;height:32px;flex:none;display:block;border-radius:50%}
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
.select{padding-right:32px;appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%235f7266' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;cursor:pointer}
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
.st-cell{display:inline-flex;align-items:center;gap:10px;justify-content:flex-end}
.st-bar{width:88px;height:6px;border-radius:99px;background:var(--track);overflow:hidden;flex:none}
.st-bar i{display:block;height:100%;background:var(--series);border-radius:99px}
.st-bar.full i{background:var(--good-fill)}
.dt td.item{white-space:normal;min-width:220px;font-weight:500;color:var(--text)}
.qty-in{width:92px;height:34px;text-align:right;padding:0 10px}
.dt td .err-msg{justify-content:flex-end;margin-top:4px}
.wl-stack{display:grid;gap:16px}
.wl-stack .card+.card{margin-top:0}
.lock-note{display:flex;gap:10px;align-items:center;padding:14px 16px;color:var(--text-2);font-size:13.5px}
.lock-note .ic{width:18px;height:18px;color:var(--text-3)}
.over{color:var(--danger);font-weight:600}
@media (max-width:640px){.qty-in{width:76px;height:40px}}
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
.auth-hero{background:var(--nav-bg);color:#cfe1d5;padding:40px 48px;display:flex;flex-direction:column;justify-content:space-between;gap:32px;padding-top:calc(40px + env(safe-area-inset-top))}
.auth-hero .brand{border:0;padding:0;height:auto}
.hero-copy h1{font-size:30px;line-height:1.25;color:#fff;font-weight:650;letter-spacing:-.02em;max-width:460px}
.hero-list{list-style:none;padding:0;margin:24px 0 0;display:grid;gap:12px;max-width:440px}
.hero-list li{display:flex;gap:10px;align-items:flex-start;font-size:14px}
.hero-list .ic{width:18px;height:18px;color:#4ade80;margin-top:1px}
.hero-foot{font-size:12px;color:#8eab99}
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
var PAGES={encode:{t:'Encode Sales',ic:'edit'},wl:{t:'Wines & Liquor',ic:'wine'},history:{t:'Sales History',ic:'history'},dashboard:{t:'Store Performance',ic:'dashboard'},users:{t:'User Accounts',ic:'users'}};
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
  wine:'<path d="M8 22h8"/><path d="M7 10h10"/><path d="M12 15v7"/><path d="M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z"/>',
  lock:'<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  store:'<path d="m2 7 4.41-4.41A2 2 0 0 1 7.83 2h8.34a2 2 0 0 1 1.42.59L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M2 7h20"/><path d="M22 7v3a2 2 0 0 1-2 2 2.7 2.7 0 0 1-2-.9 2.7 2.7 0 0 1-2 .9 2.7 2.7 0 0 1-2-.9 2.7 2.7 0 0 1-2 .9 2.7 2.7 0 0 1-2-.9 2.7 2.7 0 0 1-2 .9 2.7 2.7 0 0 1-2-.9A2 2 0 0 1 2 10V7"/>'
};
var BRAND='<img class="brand-mark" src="/favicon-64.png" width="32" height="32" alt="" aria-hidden="true">';
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
  userTab:'',userQ:'',usort:{key:'',dir:1},
  wl:{date:null,items:[],rows:[],loading:false,error:null},wlWin:null,wlEdit:false,wlTab:'item',wlSort:{key:'',dir:1}
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
function syncThemeColor(){var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',isDark()?'#141b17':'#ffffff')}
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
function allowedPages(){return isViewer()?(isAdmin()?['dashboard','wl','users']:['dashboard','wl']):['encode','wl','history']}
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
  var work=isViewer()?['dashboard','wl']:['encode','wl','history'];
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
  if(p==='encode')renderEncode();else if(p==='history')renderHistory();else if(p==='dashboard')renderDashboard();else if(p==='users')renderUsers();else if(p==='wl')renderWl();
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
  if(ly>0){var p=tot.sales/ly,gap=ly-tot.sales;h+=kpi({label:'VS LY · full day',value:pct(p),meter:meterHtml(p,'Percent of last year full-day sales'),foot:'<span>LY '+cpeso(ly)+'</span>'+(p>=1?'<span class="badge success">'+icon('check')+'Beat LY</span><span>by '+peso(-gap)+'</span>':'<span>· '+peso(gap)+' to go</span>')})}
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
  // Value label on every bar (above the cap; below for a negative correction); peak stays bold.
  pts.forEach(function(p){var isPeak=p===peak,neg=p.sales<0;s+='<text x="'+cx(p.i)+'" y="'+(neg?y(p.sales)+14:y(p.sales)-6)+'" text-anchor="middle" font-size="'+(isPeak?12:11.5)+'" font-weight="'+(isPeak?700:600)+'" fill="'+(isPeak?'var(--text)':'var(--text-2)')+'">'+compact(p.sales)+'</text>'});
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
  h+=kpi({label:'VS LY (total)',value:vs==null?'—':pct(vs),meter:vs==null?'':meterHtml(vs,'Day total as percent of last year full-day sales'),title:vs==null?'':peso(salesLyBase)+' of LY '+peso(ly),foot:vs==null?'Needs LY and at least one slot':'<span>'+cpeso(salesLyBase)+' of LY '+cpeso(ly)+'</span>'+(vs>=1?'<span class="badge success">'+icon('check')+'Ahead of LY</span>':'<span>· '+cpeso(ly-salesLyBase)+' to go</span>')});
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

/* ================= Wines & Liquor ================= */
function refreshFiltered(){if(S.page==='wl')renderWlViewerBody();else renderDashBody()}
async function loadWl(){
  S.wl.loading=true;S.wl.error=null;
  try{var j=await api('/api/wl?date='+encodeURIComponent(S.date));S.wl.items=j.items||[];S.wl.rows=j.rows||[];S.wl.date=S.date}
  catch(e){S.wl.error=e.message;S.wl.date=S.date}
  S.wl.loading=false;
}
function renderWl(){
  if(S.wl.date!==S.date&&!S.wl.loading)loadWl().then(function(){if(S.page==='wl')renderWl()});
  if(isViewer())renderWlViewer();else renderWlStore();
}
function cs(v){return v===''||v==null?'—':int(v)+' cs'}
function wlSold(r){var s=0;if(r)WINS.forEach(function(w){var v=r.q[w.k];if(v!==''&&v!=null)s+=v});return s}
function wlHas(r,k){return !!r&&r.q[k]!==''&&r.q[k]!=null}
function stCell(sold,alloc){if(!(alloc>0))return '<span class="muted">—</span>';var p=sold/alloc;return '<span class="st-cell"><span class="st-bar'+(p>=1?' full':'')+'" aria-hidden="true"><i style="width:'+Math.min(100,p*100).toFixed(1)+'%"></i></span><span>'+pct(p)+'</span></span>'}
function wlStateBlock(){
  if(S.wl.loading||S.wl.date!==S.date)return skelKpis(3)+skelTable(8);
  if(S.wl.error)return '<div class="card">'+stateBlock('alert','Unable to load Wines & Liquor',esc(S.wl.error),'<button class="btn btn-primary" data-act="wl-retry">'+icon('refresh')+'Try again</button>')+'</div>';
  if(!S.wl.items.length)return '<div class="card">'+stateBlock('wine','No items listed yet','Add the product descriptions under the Description header in the Wines&Liquor tab, then refresh.','<button class="btn" data-act="wl-retry">'+icon('refresh')+'Refresh</button>')+'</div>';
  return '';
}
function wlMine(){var m={};S.wl.rows.forEach(function(r){if(r.storeId===String(S.me.storeId))m[r.item]=r});return m}

/* ---- Store: allocation first, then cases sold per slot ---- */
function renderWlStore(){
  var st=storeById(S.me.storeId);
  var h=pageHead('Wines & Liquor',esc(st?st.id+' · '+st.name:S.me.storeId)+' · '+esc(fmtDate(S.date))+' · quantities in cases',dateCtl()+'<button class="btn" data-act="wl-export">'+icon('download')+'Export CSV</button>');
  var blk=wlStateBlock();if(blk){$('content').innerHTML=h+blk;return}
  var items=S.wl.items,mine=wlMine();
  var allocDone=items.every(function(it){return mine[it]&&mine[it].alloc!==''});
  var totA=0,totS=0;items.forEach(function(it){var r=mine[it];if(r&&r.alloc!=='')totA+=r.alloc;totS+=wlSold(r)});
  h+='<div class="kpis">'+kpi({label:'Allocation',value:allocDone?cs(totA):'—',foot:allocDone?items.length+' items':'Not yet encoded'})+kpi({label:'Sold',value:cs(totS),foot:allocDone&&totA>0?'<span>'+cs(Math.max(0,totA-totS))+' remaining</span>':'—'})+kpi({label:'Sell-through',value:totA>0?pct(totS/totA):'—',meter:totA>0?meterHtml(totS/totA,'Cases sold as percent of allocation'):'',foot:'Sold ÷ allocation'})+'</div>';
  h+='<div class="wl-stack">'+wlAllocCard(items,mine,allocDone)+wlSlotCard(items,mine,allocDone)+wlSummaryCard(items,mine)+'</div>';
  $('content').innerHTML=h;
}
function wlAllocCard(items,mine,done){
  var edit=!done||S.wlEdit;
  var h='<section class="card" aria-labelledby="wa-t"><div class="card-h"><div><h2 class="card-t" id="wa-t">Step 1 · Allocation</h2><div class="card-s">Cases allocated to your store for this Hakot Day. Required before encoding time slots.</div></div>'+(done?'<span class="badge success">'+icon('check')+'Saved</span>':'<span class="badge warning">Required first</span>')+'</div>';
  if(!edit){
    var tot=0;items.forEach(function(it){tot+=mine[it].alloc});
    return h+'<div class="card-b"><div class="ly-box"><div><span class="mini-l">Items</span><span class="mini-v">'+items.length+'</span></div><div><span class="mini-l">Total allocation</span><span class="mini-v">'+cs(tot)+'</span></div><div class="sp"></div><button class="btn btn-ghost btn-sm" data-act="wl-edit-alloc">'+icon('edit')+'Edit</button></div></div></section>';
  }
  h+='<div class="table-wrap" style="max-height:none"><table class="dt'+(PREF.density==='compact'?' dense':'')+'"><caption class="sr-only">Allocation per item in cases</caption><thead><tr><th scope="col" class="l">Item</th><th scope="col">Allocation (cases)<span class="req" aria-hidden="true">*</span></th></tr></thead><tbody>';
  items.forEach(function(it,i){var r=mine[it];h+='<tr><td class="l item"><label for="wa-'+i+'">'+esc(it)+'</label></td><td><input class="input num qty-in" id="wa-'+i+'" inputmode="numeric" autocomplete="off" value="'+esc(r&&r.alloc!==''?r.alloc:'')+'" aria-required="true" aria-describedby="wa-'+i+'-err"><div class="err-msg" id="wa-'+i+'-err" hidden></div></td></tr>'});
  return h+'</tbody></table></div><div class="card-b"><p class="help" style="margin:0 0 12px">Enter 0 for items you did not receive.</p><div class="row-actions" style="margin:0"><button class="btn btn-primary" data-act="wl-save-alloc">'+icon('check')+'Save allocation</button>'+(S.wlEdit?'<button class="btn btn-ghost" data-act="wl-cancel-alloc">Cancel</button>':'')+'</div></div></section>';
}
function wlNextWin(mine){for(var i=0;i<WINS.length;i++){var k=WINS[i].k;if(!S.wl.items.some(function(it){return wlHas(mine[it],k)}))return k}return null}
function wlSlotCard(items,mine,done){
  var h='<section class="card" aria-labelledby="wq-t"><div class="card-h"><div><h2 class="card-t" id="wq-t">Step 2 · Cases sold per time slot</h2><div class="card-s">Enter only the cases sold during the selected slot · blank = none</div></div></div>';
  if(!done)return h+'<div class="lock-note">'+icon('lock')+'<span>Save the allocation first to unlock the time slots.</span></div></section>';
  var nx=wlNextWin(mine);if(!S.wlWin)S.wlWin=nx||'FINAL';var k=S.wlWin;
  h+='<div class="sec"><div class="slots" role="radiogroup" aria-label="Time slot">';
  WINS.forEach(function(w){var d=items.some(function(it){return wlHas(mine[it],w.k)}),sel=k===w.k;h+='<button class="slot'+(d?' done':'')+(sel?' sel':'')+(nx===w.k&&!d?' next':'')+'" role="radio" aria-checked="'+sel+'" data-act="wl-win" data-k="'+w.k+'"><span class="slot-l">'+SHORT[w.k]+'</span><span class="slot-s">'+(d?icon('check')+'Saved':nx===w.k?'Next':'Open')+'</span></button>'});
  h+='</div></div><div class="table-wrap" style="max-height:none"><table class="dt'+(PREF.density==='compact'?' dense':'')+'"><caption class="sr-only">Cases sold in the '+esc(winLabel(k))+' slot</caption><thead><tr><th scope="col" class="l">Item</th><th scope="col">Allocation</th><th scope="col">Sold before</th><th scope="col">'+esc(SHORT[k])+' (cases)</th><th scope="col">Total sold</th><th scope="col">Sell-through</th></tr></thead><tbody>';
  items.forEach(function(it,i){
    var r=mine[it],cur=wlHas(r,k)?r.q[k]:'',before=wlSold(r)-(cur===''?0:cur);
    h+='<tr><td class="l item"><label for="wq-'+i+'">'+esc(it)+'</label></td><td>'+int(r.alloc)+'</td><td>'+int(before)+'</td><td><input class="input num qty-in" id="wq-'+i+'" data-before="'+before+'" data-alloc="'+r.alloc+'" inputmode="numeric" autocomplete="off" value="'+esc(cur)+'" aria-describedby="wq-'+i+'-err"><div class="err-msg" id="wq-'+i+'-err" hidden></div></td><td id="wt-'+i+'">'+int(before+(cur===''?0:cur))+'</td><td id="wp-'+i+'">'+stCell(before+(cur===''?0:cur),r.alloc)+'</td></tr>';
  });
  return h+'</tbody></table></div><div class="card-b"><button class="btn btn-primary btn-block btn-lg" data-act="wl-save-slot">'+icon('check')+'Save '+esc(winLabel(k))+'</button></div></section>';
}
function updateWlRow(i){
  var el=$('wq-'+i);if(!el)return;var v=num(el.value),before=+el.getAttribute('data-before'),alloc=+el.getAttribute('data-alloc');
  var tot=before+(v===''?0:v);$('wt-'+i).innerHTML='<span class="'+(alloc>=0&&tot>alloc?'over':'')+'">'+int(tot)+'</span>';$('wp-'+i).innerHTML=stCell(tot,alloc);
}
function wlSummaryCard(items,mine){
  var h='<section class="card" aria-labelledby="wsum-t"><div class="card-h"><div><h2 class="card-t" id="wsum-t">Summary · '+esc(fmtDateShort(S.date))+'</h2><div class="card-s">Cases sold per slot, total sold and sell-through vs allocation</div></div></div><div class="table-wrap"><table class="dt'+(PREF.density==='compact'?' dense':'')+'"><caption class="sr-only">Wines and liquor summary</caption><thead><tr><th scope="col" class="l frz solo">Item</th><th scope="col">Allocation</th>';
  WINS.forEach(function(w,j){h+='<th scope="col"'+(j===0?' class="gs"':'')+'>'+SHORT[w.k]+'</th>'});
  h+='<th scope="col" class="gs">Total sold</th><th scope="col">Sell-through</th></tr></thead><tbody>';
  var tA=0,tS=0,tW={};
  items.forEach(function(it){var r=mine[it],a=r&&r.alloc!==''?r.alloc:'',sold=wlSold(r);if(a!=='')tA+=a;tS+=sold;
    h+='<tr><td class="l frz solo item">'+esc(it)+'</td><td>'+int(a)+'</td>'+WINS.map(function(w,j){var v=wlHas(r,w.k)?r.q[w.k]:'';if(v!=='')tW[w.k]=(tW[w.k]||0)+v;return '<td'+(j===0?' class="gs"':'')+'>'+int(v)+'</td>'}).join('')+'<td class="gs"><span class="'+(a!==''&&sold>a?'over':'')+'">'+int(sold)+'</span></td><td>'+stCell(sold,a)+'</td></tr>'});
  h+='<tr class="grand"><td class="l frz solo">Total</td><td>'+int(tA)+'</td>'+WINS.map(function(w,j){return '<td'+(j===0?' class="gs"':'')+'>'+int(tW[w.k]==null?'':tW[w.k])+'</td>'}).join('')+'<td class="gs">'+int(tS)+'</td><td>'+stCell(tS,tA)+'</td></tr>';
  return h+'</tbody></table></div></section>';
}
async function saveWlAlloc(btn){
  var items=S.wl.items,alloc={},bad=null;
  items.forEach(function(it,i){var raw=$('wa-'+i).value.trim(),n=num(raw),ok=raw!==''&&n!==''&&n>=0&&Math.round(n)===n;setErr('wa-'+i,ok?'':raw===''?'Required':'Whole cases, 0 or more');if(!ok&&bad==null)bad=i;alloc[it]=n});
  if(bad!=null){$('wa-'+bad).focus();return}
  await withBusy(btn,async function(){
    var j=await api('/api/wl/save',{date:S.date,alloc:alloc});
    S.wl.rows=S.wl.rows.filter(function(r){return r.storeId!==String(S.me.storeId)}).concat(j.rows||[]);
    S.wlEdit=false;toast('Allocation saved','success');renderWl();
  });
}
async function saveWlSlot(btn){
  var items=S.wl.items,qty={},bad=null,over=[],k=S.wlWin;
  items.forEach(function(it,i){
    var el=$('wq-'+i),raw=el.value.trim(),n=raw===''?'':num(raw),ok=raw===''||(n!==''&&n>=0&&Math.round(n)===n);
    setErr('wq-'+i,ok?'':'Whole cases, 0 or more');if(!ok&&bad==null)bad=i;qty[it]=n;
    var tot=+el.getAttribute('data-before')+(n===''?0:n),a=+el.getAttribute('data-alloc');if(ok&&tot>a)over.push(esc(it)+': <b>'+tot+'</b> of '+a+' cs');
  });
  if(bad!=null){$('wq-'+bad).focus();return}
  if(over.length&&!(await confirmDialog({title:'Sold more than allocated?',html:'These items would go over their allocation:<br>'+over.join('<br>'),ok:'Save anyway'})))return;
  await withBusy(btn,async function(){
    var j=await api('/api/wl/save',{date:S.date,window:{key:k,qty:qty}});
    S.wl.rows=S.wl.rows.filter(function(r){return r.storeId!==String(S.me.storeId)}).concat(j.rows||[]);
    toast(winLabel(k)+' saved','success');S.wlWin=wlNextWin(wlMine())||k;renderWl();
  });
}

/* ---- Admin / area manager: allocation vs sold totals ---- */
function renderWlViewer(){
  var scope=S.me.scope?myStores().length+' stores in your scope':'All stores';
  var h=pageHead('Wines & Liquor',esc(scope)+' · '+esc(fmtDate(S.date))+' · cases · <span class="badge">'+icon('eye')+'View only</span>','<button class="btn" data-act="wl-refresh">'+icon('refresh')+'Refresh</button><button class="btn" data-act="wl-export">'+icon('download')+'Export CSV</button>');
  h+='<div class="filterbar" role="search" aria-label="Filters">'+dateCtl()+'<span class="fsep" aria-hidden="true"></span>'+areaFilterHtml()+searchBox('wlQ','Search store or ID',S.f.q)+'<button class="btn btn-ghost" data-act="clear-filters" id="clearF"'+(activeFilters()?'':' hidden')+'>'+icon('x')+'Clear filters <span class="badge info" id="fCount">'+activeFilters()+'</span></button></div><div id="wlBody"></div>';
  $('content').innerHTML=h;renderWlViewerBody();
}
function wlScopeStores(){var q=S.f.q.trim().toLowerCase();return myStores().filter(function(s){return (!S.f.areas.length||S.f.areas.indexOf(s.area)>=0)&&(!q||(s.id+' '+s.name).toLowerCase().indexOf(q)>=0)})}
function renderWlViewerBody(){
  var el=$('wlBody');if(!el)return;syncFilterUi();
  var blk=wlStateBlock();if(blk){el.innerHTML=blk;return}
  var stores=wlScopeStores(),ids={};stores.forEach(function(s){ids[s.id]=s});
  if(!stores.length){el.innerHTML='<div class="card">'+stateBlock('filter','No stores match the selected filters','Try a different area or search term.','<button class="btn" data-act="clear-filters">'+icon('x')+'Clear filters</button>')+'</div>';return}
  var rows=S.wl.rows.filter(function(r){return ids[r.storeId]&&S.wl.items.indexOf(r.item)>=0});
  var byItem={},byStore={},tA=0,tS=0;
  S.wl.items.forEach(function(it){byItem[it]={name:it,a:0,s:0,n:0}});
  rows.forEach(function(r){var a=r.alloc===''?0:r.alloc,sd=wlSold(r),bi=byItem[r.item];bi.a+=a;bi.s+=sd;if(r.alloc!=='')bi.n++;
    var bs=byStore[r.storeId]||(byStore[r.storeId]={s:ids[r.storeId],a:0,sd:0});bs.a+=a;bs.sd+=sd;tA+=a;tS+=sd});
  var reporting=Object.keys(byStore).length;
  var h='<div class="kpis">'+kpi({label:'Total allocation',value:cs(tA),foot:S.wl.items.length+' items'})+kpi({label:'Total sold',value:cs(tS),foot:tA>0?'<span>'+cs(Math.max(0,tA-tS))+' remaining</span>':'—'})+kpi({label:'Sell-through',value:tA>0?pct(tS/tA):'—',meter:tA>0?meterHtml(tS/tA,'Cases sold as percent of allocation'):'',foot:'Sold ÷ allocation'})+kpi({label:'Stores reporting',value:reporting+' / '+stores.length,meter:meterHtml(stores.length?reporting/stores.length:0,'Stores with allocation encoded'),foot:'Allocation encoded'})+'</div>';
  function tab(k,l){return '<button class="tab" role="tab" aria-selected="'+(S.wlTab===k)+'" data-act="wl-tab" data-t="'+k+'">'+l+'</button>'}
  h+='<section class="card"><div class="card-h toolbar tabs-bar"><div class="tabs" role="tablist" aria-label="Totals view">'+tab('item','By item')+tab('store','By store')+'</div><div class="tools" style="padding:8px 0">'+densityBtn()+'</div></div>';
  var st=S.wlSort,a='wl-sort',d=PREF.density==='compact'?' dense':'';
  function sortList(list,get){if(!st.key)return list;return list.slice().sort(function(x,y){var p=get(x,st.key),q=get(y,st.key);return (p<q?-1:p>q?1:0)*st.dir})}
  function val(o,k){return k==='name'?o.name.toLowerCase():k==='a'?o.a:k==='s'?o.s:k==='p'?(o.a>0?o.s/o.a:-1):0}
  if(S.wlTab==='item'){
    var list=sortList(S.wl.items.map(function(it){return byItem[it]}),val);
    h+='<div class="table-wrap"><table class="dt'+d+'"><caption class="sr-only">Allocation vs sold by item</caption><thead><tr>'+sortTh('name','Item',st,a,'l')+'<th scope="col">Stores</th>'+sortTh('a','Allocation (cs)',st,a)+sortTh('s','Sold (cs)',st,a)+sortTh('p','Sell-through',st,a)+'</tr></thead><tbody>';
    list.forEach(function(o){h+='<tr><td class="l item">'+esc(o.name)+'</td><td>'+o.n+'</td><td>'+int(o.a)+'</td><td>'+int(o.s)+'</td><td>'+stCell(o.s,o.a)+'</td></tr>'});
    h+='<tr class="grand"><td class="l">Total</td><td>'+reporting+'</td><td>'+int(tA)+'</td><td>'+int(tS)+'</td><td>'+stCell(tS,tA)+'</td></tr></tbody></table></div>';
  }else{
    var sl=stores.map(function(s){var b=byStore[s.id];return {store:s,name:s.name,a:b?b.a:0,s:b?b.sd:0,has:!!b}});
    h+='<div class="table-wrap"><table class="dt'+d+'"><caption class="sr-only">Allocation vs sold by store</caption><thead><tr><th scope="col" class="l c-id">ID</th>'+sortTh('name','Store',st,a,'l')+sortTh('a','Allocation (cs)',st,a)+sortTh('s','Sold (cs)',st,a)+sortTh('p','Sell-through',st,a)+'</tr></thead><tbody>';
    scopeAreas().forEach(function(area){
      var grp=sortList(sl.filter(function(o){return o.store.area===area}),val);if(!grp.length)return;
      var ga=0,gs=0;grp.forEach(function(o){ga+=o.a;gs+=o.s});
      h+='<tr class="group"><td colspan="5"><span class="glabel">'+esc(area)+'<span class="muted">'+grp.length+' store'+(grp.length===1?'':'s')+'</span></span></td></tr>';
      grp.forEach(function(o){h+='<tr><td class="l c-id">'+esc(o.store.id)+'</td><td class="l">'+esc(o.name)+(o.has?'':' <span class="badge">No allocation</span>')+'</td><td>'+(o.has?int(o.a):'')+'</td><td>'+(o.has?int(o.s):'')+'</td><td>'+(o.has?stCell(o.s,o.a):'<span class="muted">—</span>')+'</td></tr>'});
      var gHas=grp.some(function(o){return o.has});
      h+='<tr class="sub"><td class="l"></td><td class="l">Subtotal</td><td>'+(gHas?int(ga):'')+'</td><td>'+(gHas?int(gs):'')+'</td><td>'+(gHas?stCell(gs,ga):'<span class="muted">—</span>')+'</td></tr>';
    });
    h+='<tr class="grand"><td class="l"></td><td class="l">Grand total</td><td>'+int(tA)+'</td><td>'+int(tS)+'</td><td>'+stCell(tS,tA)+'</td></tr></tbody></table></div>';
  }
  el.innerHTML=h+'<div class="table-foot"><span>Sell-through = cases sold ÷ cases allocated · '+esc(fmtDate(S.date))+'</span></div></section>';
}
function exportWl(){
  var ids={};(isViewer()?wlScopeStores():[storeById(S.me.storeId)]).forEach(function(s){if(s)ids[s.id]=s});
  var rows=S.wl.rows.filter(function(r){return ids[r.storeId]});
  if(!rows.length){toast('Nothing to export for this date.','warning');return}
  var out=[['Date','Area','Store ID','Store','Item','Allocation (cs)'].concat(WINS.map(function(w){return (w.k==='FINAL'?'Final':w.l)+' (cs)'}),['Total sold (cs)','Sell-through %'])];
  rows.forEach(function(r){var sd=wlSold(r);out.push([r.date,r.area,r.storeId,r.storeName,r.item,r.alloc].concat(WINS.map(function(w){return r.q[w.k]}),[sd,r.alloc>0?(sd/r.alloc*100).toFixed(2):'']))});
  downloadCsv('wines-liquor-'+S.date+(isViewer()?'':'-'+S.me.storeId)+'.csv',out);
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
  if(S.page==='wl'){S.wlWin=null;S.wlEdit=false;renderPage();return}
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
  else if(a==='clear-filters'){S.f={q:'',areas:[],status:'all'};renderPage()}
  else if(a==='areas-clear'){S.f.areas=[];document.querySelectorAll('[data-area-f]').forEach(function(c){c.checked=false});refreshFiltered()}
  else if(a==='wl-retry'){loadWl().then(renderWl)}
  else if(a==='wl-refresh'){loadWl().then(function(){renderWl();toast('Data refreshed','info')})}
  else if(a==='wl-save-alloc'){saveWlAlloc(el)}
  else if(a==='wl-edit-alloc'){S.wlEdit=true;renderWl();var fa=$('wa-0');if(fa)fa.focus()}
  else if(a==='wl-cancel-alloc'){S.wlEdit=false;renderWl()}
  else if(a==='wl-win'){S.wlWin=el.getAttribute('data-k');renderWl();var fq=$('wq-0');if(fq)fq.focus()}
  else if(a==='wl-save-slot'){saveWlSlot(el)}
  else if(a==='wl-tab'){S.wlTab=el.getAttribute('data-t');renderWlViewerBody()}
  else if(a==='wl-sort'){nextSort(S.wlSort,el.getAttribute('data-k'));renderWlViewerBody()}
  else if(a==='wl-export'){exportWl()}
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
  else if(t.hasAttribute&&t.hasAttribute('data-area-f')){var v=t.getAttribute('data-area-f');S.f.areas=S.f.areas.filter(function(x){return x!==v});if(t.checked)S.f.areas.push(v);refreshFiltered()}
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
  else if(t.id==='wlQ'){S.f.q=t.value;clearTimeout(qTimer);qTimer=setTimeout(renderWlViewerBody,160)}
  else if(t.id&&t.id.indexOf('wq-')===0)updateWlRow(+t.id.slice(3));
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
  if(id&&/^w[aq]-\d+$/.test(id)){e.preventDefault();var nxt=$(id.slice(0,3)+(+id.slice(3)+1));if(nxt)nxt.focus();else{var sb=document.querySelector(id.charAt(1)==='a'?'[data-act=wl-save-alloc]':'[data-act=wl-save-slot]');if(sb)sb.click()}return}
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
