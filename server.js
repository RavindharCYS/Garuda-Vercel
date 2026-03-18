// ============================================================
//   Garuda Express v5 — Production Server
//   TRACKING CHAIN:
//     DHL   → DHL Official API  → 17track fallback
//     FedEx → FedEx OAuth2 API  → 17track fallback
//     UPS   → UPS OAuth2 API    → 17track fallback
//   WAYBILL: OCR + regex parser → Garuda branded waybill
//   SECURITY: helmet, rate-limit, compression, morgan, winston
// ============================================================

require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const crypto       = require('crypto');
const fs           = require('fs');
const multer       = require('multer');
const Database     = require('better-sqlite3');
const https        = require('https');
const http         = require('http');

// ── Production packages (graceful fallback if not yet installed) ──────────
let helmet, compression, rateLimit, morgan, winston, cron;
try { helmet      = require('helmet');           } catch(e) { helmet      = null; }
try { compression = require('compression');      } catch(e) { compression = null; }
try { rateLimit   = require('express-rate-limit');} catch(e) { rateLimit  = null; }
try { morgan      = require('morgan');           } catch(e) { morgan      = null; }
try { winston     = require('winston');          } catch(e) { winston     = null; }
try { cron        = require('node-cron');        } catch(e) { cron        = null; }

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Logger ─────────────────────────────────────────────────────────────────
const logger = winston ? winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) => `[${timestamp}] ${level.toUpperCase()}: ${message}`)
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error', maxsize: 5242880, maxFiles: 3 }),
    new winston.transports.File({ filename: 'logs/combined.log', maxsize: 5242880, maxFiles: 5 })
  ]
}) : { info: console.log, error: console.error, warn: console.warn, debug: ()=>{} };

fs.mkdirSync('logs', { recursive: true });

// ── Security & performance middleware ─────────────────────────────────────
if (helmet) {
  app.use(helmet({
    contentSecurityPolicy: false, // disabled — allows CDN fonts/icons
    crossOriginEmbedderPolicy: false
  }));
}
if (compression) app.use(compression());
if (morgan) app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));

// ── Rate limiting ──────────────────────────────────────────────────────────
if (rateLimit) {
  // Public tracking: 60 req/min
  app.use('/api/track', rateLimit({ windowMs: 60*1000, max: 60, standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many requests, please slow down.' } }));
  // Admin/portal: 30 req/min
  app.use(['/api/admin', '/api/portal', '/api/shipments'], rateLimit({ windowMs: 60*1000, max: 30,
    standardHeaders: true, legacyHeaders: false }));
}

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '.'), { maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0 }));
app.use('/Admin',     express.static(path.join(__dirname, 'Admin')));
app.use('/portal',    express.static(path.join(__dirname, 'portal')));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.get('/Admin',      (req, res) => res.sendFile(path.join(__dirname, 'Admin',     'index.html')));
app.get('/Admin/',     (req, res) => res.sendFile(path.join(__dirname, 'Admin',     'index.html')));
// Portal is protected — serve login wall unless token is valid via query param
app.get('/portal',    (req, res) => res.sendFile(path.join(__dirname, 'portal',    'index.html')));
app.get('/portal/',   (req, res) => res.sendFile(path.join(__dirname, 'portal',    'index.html')));
app.get('/dashboard',  (req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'index.html')));
app.get('/dashboard/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard', 'index.html')));

// ═══════════════════════════════════════════
//   DATABASE
// ═══════════════════════════════════════════
const DB_PATH = path.join(__dirname, 'db', 'garuda.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS shipments (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    ge_tracking_number      TEXT UNIQUE NOT NULL,
    carrier_tracking_number TEXT NOT NULL,
    carrier                 TEXT NOT NULL,
    customer_name           TEXT NOT NULL,
    from_name               TEXT DEFAULT '',
    from_address            TEXT DEFAULT '',
    to_name                 TEXT DEFAULT '',
    to_address              TEXT DEFAULT '',
    service_type            TEXT DEFAULT '',
    weight                  TEXT DEFAULT '',
    dimensions              TEXT DEFAULT '',
    pieces                  TEXT DEFAULT '',
    description             TEXT DEFAULT '',
    ship_date               TEXT DEFAULT '',
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS waybills (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ge_tracking_number TEXT NOT NULL,
    original_filename  TEXT NOT NULL,
    carrier            TEXT NOT NULL,
    parsed_data        TEXT DEFAULT '{}',
    created_at         TEXT NOT NULL,
    FOREIGN KEY (ge_tracking_number) REFERENCES shipments(ge_tracking_number)
  );
  CREATE TABLE IF NOT EXISTS tracking_cache (
    ge_tracking_number TEXT PRIMARY KEY,
    cache_data         TEXT NOT NULL,
    cached_at          TEXT NOT NULL
  );
`);
// Migrations
['from_name','to_name','description','ship_date','pieces'].forEach(col => {
  try { db.exec(`ALTER TABLE shipments ADD COLUMN ${col} TEXT DEFAULT ''`); } catch {}
});

const CACHE_TTL_MS = 5 * 60 * 1000;

// ═══════════════════════════════════════════
//   AUTH
// ═══════════════════════════════════════════
const sessionStore = new Map();
const SESSION_TTL  = 8 * 60 * 60 * 1000;
const ADMIN_USER   = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASS || 'garuda2024';
const PORTAL_USER  = process.env.PORTAL_USER || 'portal';
const PORTAL_PASS  = process.env.PORTAL_PASS || 'garuda2024';

function requireAuth(req, res, next) {
  const token   = req.headers['x-admin-token'];
  const session = token && sessionStore.get(token);
  if (!session || Date.now() > session.expiry)
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  req.admin = session.username;
  next();
}
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  const token = crypto.randomBytes(32).toString('hex');
  sessionStore.set(token, { username, expiry: Date.now() + SESSION_TTL });
  res.json({ success: true, token });
});
app.post('/api/admin/logout', requireAuth, (req, res) => {
  sessionStore.delete(req.headers['x-admin-token']);
  res.json({ success: true });
});
app.get('/api/admin/me', requireAuth, (req, res) => {
  res.json({ success: true, username: req.admin });
});

// Portal auth
function requirePortalAuth(req, res, next) {
  const token   = req.headers['x-admin-token'] || req.query.token;
  const session = token && sessionStore.get(token);
  if (!session || Date.now() > session.expiry)
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}
app.post('/api/portal/login', (req, res) => {
  const { username, password } = req.body || {};
  // Accept portal creds OR admin creds
  const ok = (username === PORTAL_USER && password === PORTAL_PASS) ||
             (username === ADMIN_USER  && password === ADMIN_PASS);
  if (!ok) return res.status(401).json({ success: false, error: 'Invalid credentials' });
  const token = crypto.randomBytes(32).toString('hex');
  sessionStore.set(token, { username, expiry: Date.now() + SESSION_TTL });
  res.json({ success: true, token });
});

// ═══════════════════════════════════════════
//   FILE UPLOAD
// ═══════════════════════════════════════════
const UPLOAD_BASE = path.join(__dirname, 'portal', 'uploads');
const waybillStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const carrier = (req.body.carrier || 'UNKNOWN').toUpperCase();
    const dir = path.join(UPLOAD_BASE, ['DHL','UPS','FEDEX'].includes(carrier) ? carrier : 'UNKNOWN');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e6) + path.extname(file.originalname))
});
const uploadWaybill = multer({ storage: waybillStorage, limits: { fileSize: 20 * 1024 * 1024 } });

// ═══════════════════════════════════════════
//   HTTP HELPER
// ═══════════════════════════════════════════
function httpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const mod = options.protocol === 'http:' ? http : https;
    const req = mod.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(options.timeout || 20000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (postData) req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    req.end();
  });
}

// OAuth token cache
const tokenCache = {};
async function getCachedToken(key, fetchFn) {
  const c = tokenCache[key];
  if (c && Date.now() < c.expiry - 60000) return c.token;
  const r = await fetchFn();
  tokenCache[key] = { token: r.token, expiry: Date.now() + r.expiresIn * 1000 };
  return r.token;
}

// ═══════════════════════════════════════════
//   UTILS
// ═══════════════════════════════════════════
const clean = s => s ? s.replace(/\s+/g, ' ').trim().substring(0, 120) : '';
function normalizeStatus(s) {
  if (!s) return 'Pending';
  const l = s.toLowerCase();
  if (l.includes('delivered'))                                               return 'Delivered';
  if (l.includes('out for delivery'))                                        return 'Out for Delivery';
  if (l.includes('transit')||l.includes('departed')||l.includes('arrived')) return 'In Transit';
  if (l.includes('picked up')||l.includes('picked-up'))                     return 'Picked Up';
  if (l.includes('customs')||l.includes('clearance'))                       return 'Customs Clearance';
  if (l.includes('exception')||l.includes('failed')||l.includes('attempt')) return 'Exception';
  if (l.includes('label created')||l.includes('information sent'))          return 'Label Created';
  return s.length > 60 ? s.substring(0, 60) : s;
}
const dedup = evts => {
  const seen = new Set();
  return evts.filter(e => { const k = `${e.status}|${e.location}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
};
const errResult = (c, cn, tn, msg) => ({ carrier: c, carrierName: cn, trackingNumber: tn, currentStatus: 'Unavailable', origin: '', destination: '', serviceType: '', events: [], fetchedAt: new Date().toISOString(), isValid: false, error: msg });

// ═══════════════════════════════════════════
//   17TRACK FALLBACK (free universal)
// ═══════════════════════════════════════════
const TRACK17_CARRIER_CODES = { DHL: 2, FEDEX: 100002, UPS: 100003, TNT: 6 };

async function track17track(trackingNumber, carrier, carrierName) {
  const API_KEY = process.env.TRACK17_API_KEY;
  if (API_KEY && API_KEY !== 'your_17track_api_key_here') {
    try {
      const regBody = JSON.stringify([{ number: trackingNumber, carrier: TRACK17_CARRIER_CODES[carrier] || 0 }]);
      await httpRequest({ hostname: 'api.17track.net', path: '/track/v2.2/register', method: 'POST', timeout: 10000, headers: { '17token': API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(regBody) } }, regBody);
      await new Promise(r => setTimeout(r, 1500));
      const getBody = JSON.stringify([{ number: trackingNumber }]);
      const getRes = await httpRequest({ hostname: 'api.17track.net', path: '/track/v2.2/gettrackinfo', method: 'POST', timeout: 15000, headers: { '17token': API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(getBody) } }, getBody);
      if (getRes.status === 200) {
        const track = JSON.parse(getRes.body)?.data?.accepted?.[0]?.track;
        if (track?.z2?.length > 0) {
          const events = track.z2.map(e => ({ timestamp: e.a ? new Date(e.a).toISOString() : new Date().toISOString(), status: clean(e.z || e.d || ''), location: clean(e.c || '') })).filter(e => e.status);
          if (events.length > 0) {
            console.log(`[17track] API success — ${events.length} events`);
            return { carrier, carrierName, trackingNumber, currentStatus: normalizeStatus(track.e || events[0].status), origin: clean(track.o || ''), destination: clean(track.d || ''), serviceType: carrierName, events: dedup(events), fetchedAt: new Date().toISOString(), isValid: true, source: '17track' };
          }
        }
      }
    } catch (e) { console.log('[17track] API error:', e.message); }
  }
  // Public free endpoint
  try {
    console.log(`[17track] Public fallback → ${trackingNumber}`);
    const body = JSON.stringify([{ number: trackingNumber, carrier: TRACK17_CARRIER_CODES[carrier] || 0 }]);
    const res = await httpRequest({ hostname: 'api.17track.net', path: '/track/v2.2/register', method: 'POST', timeout: 12000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (res.status === 200) {
      const d = JSON.parse(res.body);
      if (d?.data?.accepted?.length > 0) {
        return { carrier, carrierName, trackingNumber, currentStatus: 'Registered', origin: '', destination: '', serviceType: carrierName, events: [{ timestamp: new Date().toISOString(), status: 'Tracking registered with 17track — check back in a few minutes', location: '' }], fetchedAt: new Date().toISOString(), isValid: true, source: '17track-registered' };
      }
    }
  } catch (e) { console.log('[17track] Public error:', e.message); }
  return errResult(carrier, carrierName, trackingNumber, 'Tracking unavailable. Configure API keys in .env for better coverage.');
}

// ═══════════════════════════════════════════
//   DHL — Official API → 17track
// ═══════════════════════════════════════════
async function trackDHL(tn) {
  const key = process.env.DHL_API_KEY;
  if (key && !['demo-key','your_dhl_api_key_here'].includes(key)) {
    try {
      const res = await httpRequest({ hostname: 'api-eu.dhl.com', path: `/track/shipments?trackingNumber=${encodeURIComponent(tn)}`, method: 'GET', timeout: 15000, headers: { 'DHL-API-Key': key, 'Accept': 'application/json' } });
      if (res.status === 200) {
        const s = JSON.parse(res.body)?.shipments?.[0];
        if (s?.events?.length > 0) {
          const events = s.events.map(e => ({ timestamp: e.timestamp || new Date().toISOString(), status: clean(e.description || ''), location: clean([e.location?.address?.addressLocality, e.location?.address?.countryCode].filter(Boolean).join(', ')) })).filter(e => e.status);
          if (events.length > 0) return { carrier: 'DHL', carrierName: 'DHL Express', trackingNumber: tn, currentStatus: normalizeStatus(s.status?.description || events[0].status), origin: clean(s.origin?.address?.addressLocality || ''), destination: clean(s.destination?.address?.addressLocality || ''), serviceType: 'DHL Express', events: dedup(events), fetchedAt: new Date().toISOString(), isValid: true, source: 'dhl-api' };
        }
      }
    } catch (e) { console.log('[DHL]', e.message); }
  }
  return track17track(tn, 'DHL', 'DHL Express');
}

// ═══════════════════════════════════════════
//   FEDEX — Official OAuth2 → 17track
// ═══════════════════════════════════════════
async function getFedExToken() {
  const k = process.env.FEDEX_API_KEY, s = process.env.FEDEX_API_SECRET;
  if (!k || k === 'your_fedex_api_key_here') throw new Error('FedEx keys missing');
  return getCachedToken('fedex', async () => {
    const body = `grant_type=client_credentials&client_id=${encodeURIComponent(k)}&client_secret=${encodeURIComponent(s)}`;
    const res = await httpRequest({ hostname: 'apis.fedex.com', path: '/oauth/token', method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (res.status !== 200) throw new Error(`FedEx OAuth ${res.status}`);
    const d = JSON.parse(res.body);
    return { token: d.access_token, expiresIn: d.expires_in || 3600 };
  });
}
async function trackFedEx(tn) {
  const k = process.env.FEDEX_API_KEY;
  if (k && k !== 'your_fedex_api_key_here') {
    try {
      const token = await getFedExToken();
      const payload = JSON.stringify({ trackingInfo: [{ trackingNumberInfo: { trackingNumber: tn } }], includeDetailedScans: true });
      const res = await httpRequest({ hostname: 'apis.fedex.com', path: '/track/v1/trackingnumbers', method: 'POST', timeout: 20000, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(payload), 'x-locale': 'en_US' } }, payload);
      if (res.status === 200) {
        const result = JSON.parse(res.body)?.output?.completeTrackResults?.[0]?.trackResults?.[0];
        if (result && !result.error) {
          const events = (result.scanEvents || []).map(e => ({ timestamp: e.date ? new Date(e.date).toISOString() : new Date().toISOString(), status: clean(e.eventDescription || ''), location: clean([e.scanLocation?.city, e.scanLocation?.stateOrProvinceCode, e.scanLocation?.countryCode].filter(Boolean).join(', ')) })).filter(e => e.status);
          if (events.length > 0) {
            const sh = result.shipperInformation?.address, re = result.recipientInformation?.address;
            return { carrier: 'FEDEX', carrierName: 'FedEx', trackingNumber: tn, currentStatus: normalizeStatus(result.latestStatusDetail?.description || events[0].status), origin: clean([sh?.city, sh?.countryCode].filter(Boolean).join(', ')), destination: clean([re?.city, re?.countryCode].filter(Boolean).join(', ')), serviceType: clean(result.serviceDetail?.description || 'FedEx Express'), events: dedup(events), fetchedAt: new Date().toISOString(), isValid: true, source: 'fedex-api' };
          }
        }
      }
    } catch (e) { console.log('[FedEx]', e.message); }
  }
  return track17track(tn, 'FEDEX', 'FedEx');
}

// ═══════════════════════════════════════════
//   UPS — Official OAuth2 → 17track
// ═══════════════════════════════════════════
async function getUPSToken() {
  const id = process.env.UPS_CLIENT_ID, s = process.env.UPS_CLIENT_SECRET;
  if (!id || id === 'your_ups_client_id_here') throw new Error('UPS keys missing');
  return getCachedToken('ups', async () => {
    const creds = Buffer.from(`${id}:${s}`).toString('base64');
    const body = 'grant_type=client_credentials';
    const res = await httpRequest({ hostname: 'onlinetools.ups.com', path: '/security/v1/oauth/token', method: 'POST', timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}`, 'x-merchant-id': 'string', 'Content-Length': Buffer.byteLength(body) } }, body);
    if (res.status !== 200) throw new Error(`UPS OAuth ${res.status}`);
    const d = JSON.parse(res.body);
    return { token: d.access_token, expiresIn: d.expires_in || 14399 };
  });
}
async function trackUPS(tn) {
  const id = process.env.UPS_CLIENT_ID;
  if (id && id !== 'your_ups_client_id_here') {
    try {
      const token = await getUPSToken();
      const res = await httpRequest({ hostname: 'onlinetools.ups.com', path: `/api/track/v1/details/${encodeURIComponent(tn)}?locale=en_US&returnSignature=false`, method: 'GET', timeout: 20000, headers: { 'Authorization': `Bearer ${token}`, 'transId': String(Date.now()), 'transactionSrc': 'garuda-express', 'Accept': 'application/json' } });
      if (res.status === 200) {
        const j = JSON.parse(res.body), shipment = j?.trackResponse?.shipment?.[0], pkg = shipment?.package?.[0];
        if (pkg) {
          const events = (pkg.activity || []).map(a => { const d = a.date || '', t = a.time || ''; let ts; try { ts = d && t ? new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}Z`).toISOString() : new Date().toISOString(); } catch { ts = new Date().toISOString(); } return { timestamp: ts, status: clean(a.status?.description || ''), location: clean([a.location?.address?.city, a.location?.address?.country].filter(Boolean).join(', ')) }; }).filter(e => e.status);
          if (events.length > 0) return { carrier: 'UPS', carrierName: 'UPS', trackingNumber: tn, currentStatus: normalizeStatus(pkg.currentStatus?.description || events[0].status), origin: clean([shipment.shipFrom?.address?.city].filter(Boolean).join(', ')), destination: clean([shipment.shipTo?.address?.city].filter(Boolean).join(', ')), serviceType: clean(shipment.service?.description || 'UPS'), events: dedup(events), fetchedAt: new Date().toISOString(), isValid: true, source: 'ups-api' };
        }
      }
    } catch (e) { console.log('[UPS]', e.message); }
  }
  return track17track(tn, 'UPS', 'UPS');
}

// ═══════════════════════════════════════════
//   CARRIER ROUTER
//   DHL    → DHL Official API only   → 17track fallback
//   FedEx  → FedEx OAuth2 API only   → 17track fallback
//   UPS    → UPS OAuth2 API only     → 17track fallback
//   Other  → 17track directly
// ═══════════════════════════════════════════
let activeCount = 0; const waitQueue = [];
function acquireSlot() { return new Promise(r => activeCount < 5 ? (activeCount++, r()) : waitQueue.push(r)); }
function releaseSlot() { waitQueue.length > 0 ? waitQueue.shift()() : activeCount--; }

async function scrapeCarrier(carrier, tn) {
  const c = (carrier || '').toUpperCase().trim();
  await acquireSlot();
  const t0 = Date.now();
  try {
    let result;
    if (c === 'DHL')   result = await trackDHL(tn);
    else if (c === 'UPS')   result = await trackUPS(tn);
    else if (c === 'FEDEX') result = await trackFedEx(tn);
    else result = await track17track(tn, c, c);
    logger.info(`[TRACK] ${c} ${tn} → ${result.currentStatus} (${result.source||'unknown'}) ${Date.now()-t0}ms`);
    return result;
  } catch(e) {
    logger.error(`[TRACK] ${c} ${tn} failed: ${e.message}`);
    return errResult(c, c, tn, e.message);
  } finally { releaseSlot(); }
}

// ═══════════════════════════════════════════
//   GE NUMBER & STATS
// ═══════════════════════════════════════════
function generateGENumber() {
  const y = new Date().getFullYear();
  const row = db.prepare(`SELECT ge_tracking_number FROM shipments WHERE ge_tracking_number LIKE 'GE-${y}-%' ORDER BY id DESC LIMIT 1`).get();
  let max = 0; if (row) { const m = row.ge_tracking_number.match(/GE-\d{4}-(\d+)/); if (m) max = parseInt(m[1]); }
  return `GE-${y}-${String(max + 1).padStart(5, '0')}`;
}
function getStats() {
  return {
    total: db.prepare('SELECT COUNT(*) as n FROM shipments').get().n,
    dhl:   db.prepare("SELECT COUNT(*) as n FROM shipments WHERE carrier='DHL'").get().n,
    ups:   db.prepare("SELECT COUNT(*) as n FROM shipments WHERE carrier='UPS'").get().n,
    fedex: db.prepare("SELECT COUNT(*) as n FROM shipments WHERE carrier='FEDEX'").get().n,
    today: db.prepare("SELECT COUNT(*) as n FROM shipments WHERE date(created_at)=date('now')").get().n
  };
}

// ═══════════════════════════════════════════
//   CACHE
// ═══════════════════════════════════════════
function getCached(ge) {
  const row = db.prepare('SELECT cache_data,cached_at FROM tracking_cache WHERE ge_tracking_number=?').get(ge);
  if (!row) return null;
  if (Date.now() - new Date(row.cached_at).getTime() > CACHE_TTL_MS) { db.prepare('DELETE FROM tracking_cache WHERE ge_tracking_number=?').run(ge); return null; }
  try { return JSON.parse(row.cache_data); } catch { return null; }
}
function setCache(ge, data) {
  db.prepare(`INSERT INTO tracking_cache (ge_tracking_number,cache_data,cached_at) VALUES(?,?,?) ON CONFLICT(ge_tracking_number) DO UPDATE SET cache_data=excluded.cache_data,cached_at=excluded.cached_at`).run(ge, JSON.stringify(data), new Date().toISOString());
}

// ═══════════════════════════════════════════
//   PUBLIC TRACKING
// ═══════════════════════════════════════════
app.get('/api/track/:geNumber', async (req, res) => {
  const ge = req.params.geNumber.toUpperCase();
  const row = db.prepare('SELECT * FROM shipments WHERE ge_tracking_number=?').get(ge);
  if (!row) return res.json({ success: false, error: `No shipment found for: ${ge}` });
  const cached = getCached(ge);
  if (cached) return res.json({ success: true, shipment: cached, cached: true });
  try {
    const td = await scrapeCarrier(row.carrier, row.carrier_tracking_number);
    if (!td.isValid) return res.json({ success: false, error: td.error, carrier: row.carrier, carrierTrackingNumber: row.carrier_tracking_number });
    const shipment = { geTrackingNumber: row.ge_tracking_number, carrierTrackingNumber: row.carrier_tracking_number, carrier: row.carrier, carrierName: td.carrierName, customerName: row.customer_name, fromAddress: row.from_address, toAddress: row.to_address, currentStatus: td.currentStatus, origin: td.origin || row.from_address, destination: td.destination || row.to_address, serviceType: td.serviceType || row.service_type, trackingData: td, createdAt: row.created_at, fetchedAt: td.fetchedAt, source: td.source };
    setCache(ge, shipment);
    res.json({ success: true, shipment });
  } catch (e) { res.json({ success: false, error: 'Tracking failed. Try again.' }); }
});

// ═══════════════════════════════════════════
//   API KEYS STATUS
// ═══════════════════════════════════════════
app.get('/api/admin/api-keys-status', requireAuth, (req, res) => {
  const isSet = (k, ph) => !!(process.env[k] && process.env[k] !== ph);
  res.json({ success: true, status: {
    DHL:     { configured: isSet('DHL_API_KEY','your_dhl_api_key_here'), envVars: 'DHL_API_KEY', getKeyUrl: 'https://developer.dhl.com' },
    UPS:     { configured: isSet('UPS_CLIENT_ID','your_ups_client_id_here'), envVars: 'UPS_CLIENT_ID, UPS_CLIENT_SECRET', getKeyUrl: 'https://developer.ups.com' },
    FEDEX:   { configured: isSet('FEDEX_API_KEY','your_fedex_api_key_here'), envVars: 'FEDEX_API_KEY, FEDEX_API_SECRET', getKeyUrl: 'https://developer.fedex.com' },
    TRACK17: { configured: isSet('TRACK17_API_KEY','your_17track_api_key_here'), note: 'Free universal fallback — always active', envVars: 'TRACK17_API_KEY', getKeyUrl: 'https://www.17track.net/en/api' }
  }, chain: 'Carrier API → 17track (free) → error message' });
});

// ═══════════════════════════════════════════
//   SHIPMENTS CRUD
// ═══════════════════════════════════════════
const rowToShipment = r => ({ geTrackingNumber: r.ge_tracking_number, carrierTrackingNumber: r.carrier_tracking_number, carrier: r.carrier, customerName: r.customer_name, fromName: r.from_name||'', fromAddress: r.from_address, toName: r.to_name||'', toAddress: r.to_address, serviceType: r.service_type, weight: r.weight, dimensions: r.dimensions, pieces: r.pieces||'', description: r.description||'', shipDate: r.ship_date||'', createdAt: r.created_at, updatedAt: r.updated_at });

app.get('/api/shipments', requireAuth, (req, res) => {
  const c = (req.query.carrier || '').toUpperCase();
  const list = c && c !== 'ALL' ? db.prepare('SELECT * FROM shipments WHERE carrier=? ORDER BY id DESC').all(c) : db.prepare('SELECT * FROM shipments ORDER BY id DESC').all();
  res.json({ success: true, shipments: list.map(rowToShipment), stats: getStats() });
});

app.post('/api/shipments', requireAuth, (req, res) => {
  const { carrier, carrierTrackingNumber, geTrackingNumber, customerName, fromName, fromAddress, toName, toAddress, serviceType, weight, dimensions, pieces, description, shipDate } = req.body || {};
  if (!carrier || !carrierTrackingNumber || !customerName) return res.json({ success: false, error: 'Missing required fields' });
  const c = carrier.toUpperCase();
  if (!['DHL','UPS','FEDEX'].includes(c)) return res.json({ success: false, error: 'Invalid carrier' });
  const ge = (geTrackingNumber || generateGENumber()).toUpperCase();
  if (db.prepare('SELECT id FROM shipments WHERE ge_tracking_number=?').get(ge)) return res.json({ success: false, error: `${ge} already exists` });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO shipments (ge_tracking_number,carrier_tracking_number,carrier,customer_name,from_name,from_address,to_name,to_address,service_type,weight,dimensions,pieces,description,ship_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ge, carrierTrackingNumber.trim(), c, customerName.trim(), fromName||'', fromAddress||'', toName||'', toAddress||'', serviceType||'', weight||'', dimensions||'', pieces||'', description||'', shipDate||'', now, now);
  res.json({ success: true, shipment: rowToShipment(db.prepare('SELECT * FROM shipments WHERE ge_tracking_number=?').get(ge)) });
});

app.get('/api/shipments/:ge', requireAuth, (req, res) => {
  const ge = req.params.ge.toUpperCase();
  const row = db.prepare('SELECT * FROM shipments WHERE ge_tracking_number=?').get(ge);
  if (!row) return res.json({ success: false, error: 'Not found' });
  res.json({ success: true, shipment: rowToShipment(row) });
});

app.put('/api/shipments/:ge', requireAuth, (req, res) => {
  const ge = req.params.ge.toUpperCase(), row = db.prepare('SELECT * FROM shipments WHERE ge_tracking_number=?').get(ge);
  if (!row) return res.json({ success: false, error: 'Not found' });
  const { customerName, fromName, fromAddress, toName, toAddress, serviceType, weight, dimensions, pieces, description, shipDate, carrierTrackingNumber: ctn } = req.body || {};
  db.prepare(`UPDATE shipments SET customer_name=?,carrier_tracking_number=?,from_name=?,from_address=?,to_name=?,to_address=?,service_type=?,weight=?,dimensions=?,pieces=?,description=?,ship_date=?,updated_at=? WHERE ge_tracking_number=?`)
    .run(customerName||row.customer_name, ctn||row.carrier_tracking_number, fromName||row.from_name, fromAddress||row.from_address, toName||row.to_name, toAddress||row.to_address, serviceType||row.service_type, weight||row.weight, dimensions||row.dimensions, pieces!==undefined?pieces:row.pieces||'', description||row.description, shipDate||row.ship_date, new Date().toISOString(), ge);
  db.prepare('DELETE FROM tracking_cache WHERE ge_tracking_number=?').run(ge);
  res.json({ success: true, shipment: rowToShipment(db.prepare('SELECT * FROM shipments WHERE ge_tracking_number=?').get(ge)) });
});

app.delete('/api/shipments/:ge', requireAuth, (req, res) => {
  const ge = req.params.ge.toUpperCase();
  if (!db.prepare('SELECT id FROM shipments WHERE ge_tracking_number=?').get(ge)) return res.json({ success: false, error: 'Not found' });
  db.prepare('DELETE FROM shipments WHERE ge_tracking_number=?').run(ge);
  db.prepare('DELETE FROM waybills WHERE ge_tracking_number=?').run(ge);
  db.prepare('DELETE FROM tracking_cache WHERE ge_tracking_number=?').run(ge);
  res.json({ success: true });
});

app.get('/api/generate-ge-number', requireAuth, (req, res) => res.json({ success: true, geNumber: generateGENumber() }));
app.post('/api/shipments/:ge/refresh', requireAuth, (req, res) => { db.prepare('DELETE FROM tracking_cache WHERE ge_tracking_number=?').run(req.params.ge.toUpperCase()); res.json({ success: true }); });
app.post('/api/clear-all', requireAuth, (req, res) => { const n = db.prepare('SELECT COUNT(*) as n FROM shipments').get().n; db.prepare('DELETE FROM shipments').run(); db.prepare('DELETE FROM waybills').run(); db.prepare('DELETE FROM tracking_cache').run(); res.json({ success: true, message: `Cleared ${n} shipments` }); });
app.post('/api/test-carrier', requireAuth, async (req, res) => {
  const { carrier, trackingNumber } = req.body || {};
  if (!carrier || !trackingNumber) return res.json({ success: false, error: 'carrier and trackingNumber required' });
  const t0 = Date.now();
  try { const d = await scrapeCarrier(carrier.toUpperCase(), trackingNumber); res.json({ success: d.isValid, data: d, eventsFound: d.events?.length||0, duration: `${Date.now()-t0}ms`, source: d.source||'unknown' }); }
  catch (e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/detect-carrier', (req, res) => {
  const { trackingNumber } = req.body || {}, n = (trackingNumber||'').trim().toUpperCase();
  let carrier = null;
  if (/^1Z[A-Z0-9]{16}$/i.test(n)) carrier = 'UPS';
  else if (/^\d{12,15}$/.test(n))  carrier = 'FEDEX';
  else if (/^(\d{10,12}|[A-Z]{4}\d+|GM\d+|JD\d+)$/i.test(n)) carrier = 'DHL';
  res.json({ success: !!carrier, carrier });
});

// ═══════════════════════════════════════════
//   WAYBILL PORTAL
// ═══════════════════════════════════════════
// ═══════════════════════════════════════════
//   WAYBILL PORTAL — UPLOAD (single or bulk)
// ═══════════════════════════════════════════
app.post('/api/portal/upload', requirePortalAuth, (req, res) => {
  uploadWaybill.single('waybill')(req, res, async err => {
    if (err) return res.json({ success: false, error: err.message });
    if (!req.file) return res.json({ success: false, error: 'No file uploaded' });
    try {
      const parsed = await parseWaybillPDF(req.file.path);
      const carrier = parsed.carrier || (req.body.carrier||'DHL').toUpperCase();
      const ge = generateGENumber(), now = new Date().toISOString();
      db.prepare(`INSERT INTO shipments (ge_tracking_number,carrier_tracking_number,carrier,customer_name,from_name,from_address,to_name,to_address,service_type,weight,dimensions,pieces,description,ship_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(ge, parsed.trackingNumber||'PENDING', carrier, parsed.toName||parsed.customerName||'Unknown', parsed.fromName||'', parsed.fromAddress||'', parsed.toName||'', parsed.toAddress||'', parsed.serviceType||'Garuda Express', parsed.weight||'', parsed.dimensions||'', parsed.pieces||'', parsed.description||'', parsed.shipDate||'', now, now);
      db.prepare(`INSERT INTO waybills (ge_tracking_number,original_filename,carrier,parsed_data,created_at) VALUES(?,?,?,?,?)`)
        .run(ge, req.file.originalname, carrier, JSON.stringify(parsed), now);
      fs.unlink(req.file.path, ()=>{});
      res.json({ success: true, geNumber: ge, parsed, message: 'Garuda tracking number assigned: ' + ge });
    } catch (e) { fs.unlink(req.file.path, ()=>{}); res.json({ success: false, error: e.message }); }
  });
});

// Bulk upload: multiple files at once
app.post('/api/portal/upload-bulk', requirePortalAuth, (req, res) => {
  uploadWaybill.array('waybills', 20)(req, res, async err => {
    if (err) return res.json({ success: false, error: err.message });
    if (!req.files || !req.files.length) return res.json({ success: false, error: 'No files uploaded' });
    const results = [];
    for (const file of req.files) {
      try {
        const parsed = await parseWaybillPDF(file.path);
        const carrier = parsed.carrier || (req.body.carrier||'DHL').toUpperCase();
        const ge = generateGENumber(), now = new Date().toISOString();
        db.prepare(`INSERT INTO shipments (ge_tracking_number,carrier_tracking_number,carrier,customer_name,from_name,from_address,to_name,to_address,service_type,weight,dimensions,pieces,description,ship_date,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(ge, parsed.trackingNumber||'PENDING', carrier, parsed.toName||parsed.customerName||'Unknown', parsed.fromName||'', parsed.fromAddress||'', parsed.toName||'', parsed.toAddress||'', parsed.serviceType||'Garuda Express', parsed.weight||'', parsed.dimensions||'', parsed.pieces||'', parsed.description||'', parsed.shipDate||'', now, now);
        db.prepare(`INSERT INTO waybills (ge_tracking_number,original_filename,carrier,parsed_data,created_at) VALUES(?,?,?,?,?)`)
          .run(ge, file.originalname, carrier, JSON.stringify(parsed), now);
        results.push({ success: true, filename: file.originalname, geNumber: ge, parsed });
      } catch(e) {
        results.push({ success: false, filename: file.originalname, error: e.message });
      } finally {
        fs.unlink(file.path, ()=>{});
      }
    }
    res.json({ success: true, results, total: results.length, succeeded: results.filter(r=>r.success).length });
  });
});

// ═══════════════════════════════════════════════════════
//  WAYBILL PDF PARSER  (FedEx · DHL · UPS — no AI)
//
//  Patterns derived from real Garuda Express waybills:
//  FedEx: ORIGIN ID block, TO block, TRK# nnnn nnnn nnnn
//  DHL  : From : / To : blocks, WAYBILL nn nnnn nnnn
//  UPS  : SHIP TO: block, TRACKING #: 1Z…
// ═══════════════════════════════════════════════════════
async function parseWaybillPDF(filePath) {
  const { execSync } = require('child_process');
  const os = require('os');
  const pathMod = require('path');

  // ── Step 1: try pdf-parse (works for text-based PDFs) ──────────────────────
  let text = '';
  try {
    const pp = require('pdf-parse');
    const data = await pp(fs.readFileSync(filePath));
    text = data.text || '';
  } catch(e) { console.log('[PDF] pdf-parse error:', e.message); }

  // ── Step 2: if text is empty/tiny, use OCR via pdftoppm + tesseract ─────────
  if (!text || text.trim().length < 30) {
    console.log('[PDF] Falling back to OCR...');
    try {
      const tmpBase = pathMod.join(os.tmpdir(), 'ge_ocr_' + Date.now());
      // Render first 2 pages at 200 DPI
      execSync(`pdftoppm -r 200 -l 2 "${filePath}" "${tmpBase}" -png 2>/dev/null`, { timeout: 20000 });
      const pages = fs.readdirSync(os.tmpdir())
        .filter(f => f.startsWith(pathMod.basename(tmpBase)) && f.endsWith('.png'))
        .sort()
        .slice(0, 2);
      const ocrParts = [];
      for (const pg of pages) {
        const pgPath = pathMod.join(os.tmpdir(), pg);
        try {
          const out = execSync(`tesseract "${pgPath}" stdout 2>/dev/null`, { timeout: 15000 }).toString();
          ocrParts.push(out);
          fs.unlink(pgPath, () => {});
        } catch(e2) { console.log('[OCR] page error:', e2.message); }
      }
      text = ocrParts.join('\n');
      console.log('[OCR] extracted', text.trim().length, 'chars');
    } catch(e) { console.log('[OCR] error:', e.message); }
  }

  const p = {
    carrier:'', trackingNumber:'', pieces:'1',
    fromName:'', fromAddress:'',
    toName:'', toAddress:'',
    serviceType:'', weight:'', dimensions:'',
    description:'', shipDate:'', customerName:''
  };

  if (!text || text.trim().length < 20) {
    console.log('[PDF] No text after all extraction attempts');
    return p;
  }

  const norm = text.replace(/[ \t]+/g, ' ').trim();
  const lines = norm.split('\n').map(l => l.trim()).filter(Boolean);

  // ─── 1. CARRIER ──────────────────────────────────────
  if (/FedEx|FEDEX|FEDEX AWB|TRK#/i.test(norm))   p.carrier = 'FEDEX';
  else if (/\bDHL\b/i.test(norm))                  p.carrier = 'DHL';
  else if (/\bUPS\b|\bUPS SAVER\b/i.test(norm))    p.carrier = 'UPS';

  // ─── 2. TRACKING NUMBER ──────────────────────────────
  // UPS: 1Z... format
  const upsM = norm.match(/\b(1Z\s?[A-Z0-9]{3}\s?[A-Z0-9]{3}\s?[A-Z0-9]{2}\s?[A-Z0-9]{4}\s?[A-Z0-9]{4})\b/i)
            || norm.match(/TRACKING\s+#[:\s]+(1Z[\w\s]{10,24})/i);
  // FedEx: TRK# on same line or next line
  const trkInline = norm.match(/TRK#\s+([\d][\d ]{10,16}[\d])/i);
  // FedEx TRK# alone then number on next non-junk line
  const fxSplit = (() => {
    if (!/FedEx|FEDEX|TRK#/i.test(norm)) return null;
    const ti = lines.findIndex(l => /^TRK#(\s*Form)?$/i.test(l));
    if (ti < 0) return null;
    for (let i = ti+1; i < Math.min(ti+30, lines.length); i++) {
      const m = lines[i].match(/^(\d[\d ]{10,16}\d)$/);
      if (m) return m[1];
    }
    return null;
  })();
  // DHL WAYBILL
  const wbM = norm.match(/WAYBILL\s+([\d][\d\s]{6,14}[\d])/i);

  if (upsM) {
    p.trackingNumber = (upsM[1]||upsM[2]||'').replace(/\s/g,'').toUpperCase();
    if (!p.carrier) p.carrier = 'UPS';
  } else if (trkInline) {
    p.trackingNumber = trkInline[1].replace(/\s/g,'');
    if (!p.carrier) p.carrier = 'FEDEX';
  } else if (fxSplit) {
    p.trackingNumber = fxSplit.replace(/\s/g,'');
    if (!p.carrier) p.carrier = 'FEDEX';
  } else if (wbM) {
    p.trackingNumber = wbM[1].replace(/\s/g,'');
    if (!p.carrier) p.carrier = 'DHL';
  }

  // ─── 3. WEIGHT ───────────────────────────────────────
  const wtM = norm.match(/(?:ACTWGT|SHP\s*WT|Pce\/Shpt\s+Weight)[:\s]*([\d.]+\s*KG)/i)
           || norm.match(/\b([\d.]+)\s*KG\b/i);
  if (wtM) {
    const raw = wtM[1].trim();
    p.weight = raw.toUpperCase().includes('KG') ? raw : raw + ' KG';
  }

  // ─── 4. DIMENSIONS ───────────────────────────────────
  const dmM = norm.match(/DIMS[:\s]*([\d]+\s*[xX]\s*[\d]+\s*[xX]\s*[\d]+\s*CM)/i)
           || norm.match(/DWT[:\s]*([\d]+[\s,]+[\d]+[\s,]+[\d]+)/i);
  if (dmM) p.dimensions = dmM[1].replace(/\s/g,'').replace(/,/g,'x').toUpperCase();

  // ─── 5. SHIP DATE ────────────────────────────────────
  const dtM = norm.match(/(?:SHIP\s*DATE|DATE)[:\s]*(\d{1,2}\s*[A-Z]{3}\s*\d{2,4})/i)
           || norm.match(/DATE:\s*(\d{1,2}\s+[A-Z]{3}\s+\d{4})/i);
  if (dtM) p.shipDate = dtM[1].trim();

  // ─── 6. PIECES ───────────────────────────────────────
  const pcM = norm.match(/(\d+)\s+OF\s+(\d+)/i)          // UPS: "1 OF 1"
           || norm.match(/Piece[\s\S]{0,20}?(\d+)\/(\d+)/i) // DHL: "Piece 1/1"
           || norm.match(/\b(\d+)P\b/);                    // UPS: "1P"
  if (pcM) p.pieces = pcM[1];

  // ─── 7. SERVICE TYPE ─────────────────────────────────
  if (/UPS\s+SAVER/i.test(norm))                     p.serviceType = 'UPS Saver';
  else if (/UPS\s+WORLDWIDE\s+EXPEDITED/i.test(norm)) p.serviceType = 'UPS Worldwide Expedited';
  else if (/EXPRESS\s+WORLDWIDE.*WPX/i.test(norm))   p.serviceType = 'DHL Express Worldwide (WPX)';
  else if (/EXPRESS\s+WORLDWIDE.*DOX/i.test(norm))   p.serviceType = 'DHL Express Worldwide (DOX)';
  else if (/EXPRESS\s+WORLDWIDE/i.test(norm))        p.serviceType = 'DHL Express Worldwide';
  else if (/IP\s+EOD/i.test(norm))                   p.serviceType = 'FedEx IP EOD';
  else if (/FedEx.*EXPRESS/i.test(norm))             p.serviceType = 'FedEx Express';

  // ─── 8. DESCRIPTION ──────────────────────────────────
  const descM = norm.match(/DESC1?[:\s]+([^\n\r]{3,100})/i)
             || norm.match(/Content\s+Description[:\s]+([^\n\r]{3,100})/i)
             || norm.match(/\bDESC[:\s]+([^\n\r]{3,100})/i);
  if (descM) {
    p.description = descM[1].replace(/\s*DESC[234].*$/i,'').trim();
  }

  // ─── 9. FROM / SENDER ────────────────────────────────
  // DHL: "From :\n NAME \n NAME \n ADDR..."
  const fromDHL = norm.match(/From\s*:\s*\n([\s\S]+?)(?=\nTo\s*:|\nOrigin:|$)/i);
  if (fromDHL) {
    const fl = fromDHL[0].replace(/From\s*:/i,'').trim().split('\n').map(s=>s.trim()).filter(s=>s&&!/^From/i.test(s)&&!/^Contact/i.test(s));
    p.fromName = fl[0]||'';
    const skip = (fl[1]&&fl[1].toUpperCase()===fl[0].toUpperCase()) ? 2 : 1;
    p.fromAddress = fl.slice(skip, skip+5).filter(s=>/[A-Z0-9]/i.test(s)).join(', ');
  }
  // FedEx: "ORIGIN ID:..." block
  if (!p.fromName) {
    const oidx = lines.findIndex(l => /^ORIGIN\s+ID/i.test(l));
    if (oidx >= 0) {
      p.fromName = lines[oidx+1]||'';
      const skip2 = (lines[oidx+2]&&lines[oidx+2].toUpperCase()===(lines[oidx+1]||'').toUpperCase()) ? oidx+3 : oidx+2;
      const al = [];
      for (let i=skip2; i<Math.min(skip2+6,lines.length); i++) {
        if (/^SHIP\s+DATE|^ACTWGT|^CAD:|^DIMS|^BILL\s+SENDER|^TO\s*$|^TO\s+[A-Z]/i.test(lines[i])) break;
        if (/[A-Z0-9]/i.test(lines[i])) al.push(lines[i]);
      }
      p.fromAddress = al.join(', ');
    }
  }
  // UPS: lines before "SHIP TO:"
  if (!p.fromName) {
    const stidx = lines.findIndex(l => /^SHIP\s+TO[:\s]/i.test(l));
    if (stidx > 0) {
      p.fromName = lines[0]||'';
      p.fromAddress = lines.slice(1,stidx).filter(l=>/[A-Z0-9]/i.test(l)&&!/^\d{7,}$/.test(l)).join(', ');
    }
  }
  // DHL Shipper block (waybill doc page)
  if (!p.fromName) {
    const shi = lines.findIndex(l => /^Shipper\s*:/i.test(l));
    if (shi >= 0) {
      let si = shi+1;
      if (/^Contact:/i.test(lines[si]||'')) si++;
      if (/^\d{7,}/.test(lines[si]||'')) si++;
      p.fromName = lines[si]||'';
      const skip3 = (lines[si+1]&&lines[si+1].toUpperCase()===p.fromName.toUpperCase()) ? si+2 : si+1;
      p.fromAddress = lines.slice(skip3,skip3+5).filter(l=>/[A-Z0-9]/.test(l)&&!/^Contact|^CVGH|^HKGO|^SINO/i.test(l)).join(', ');
    }
  }

  // ─── 10. TO / RECIPIENT ──────────────────────────────
  // DHL: "To :\n NAME \n ADDR..."
  const toDHL = norm.match(/To\s*:\s*\n([\s\S]+?)(?=\nContact:|\nCVGH|\nHKGO|\nSINO|$)/i);
  if (toDHL) {
    const tl = toDHL[0].replace(/To\s*:/i,'').trim().split('\n').map(s=>s.trim()).filter(s=>s&&!/^To\s*:/i.test(s)&&!/^Contact/i.test(s));
    p.toName = tl[0]||'';
    const skip4 = (tl[1]&&tl[1].toUpperCase()===tl[0].toUpperCase()) ? 2 : 1;
    p.toAddress = tl.slice(skip4,skip4+5).filter(s=>/[A-Z0-9]/i.test(s)&&!/^\(/.test(s)).join(', ');
  }
  // FedEx "TO NAME" on same line: "TOEMILY GERRARD" or "TO EMILY GERRARD" or "TOHUORIGIN..."
  if (!p.toName) {
    // handle "TONAME" (no space) from OCR
    const toMerged = lines.findIndex(l => /^TO[A-Z]/i.test(l) && !/^TO\s*$/i.test(l));
    if (toMerged >= 0) {
      p.toName = lines[toMerged].replace(/^TO\s*/i,'').replace(/\d{7,}$/,'').trim();
      const ta = [];
      for (let i=toMerged+1; i<Math.min(toMerged+8,lines.length); i++) {
        if (/^\(|^REF:|^INV:|^PO:|^DEPT:|^6\d{9}|^SIGN:|^CTRY|^TRK#|^AWB/i.test(lines[i])) break;
        if (/^[A-Z0-9#]/.test(lines[i]) && !/FedEx|FEDEX|MA\s+[A-Z]{3,}|\bEWO\b|\bAWB\b/i.test(lines[i])) ta.push(lines[i]);
      }
      p.toAddress = ta.join(', ');
    }
  }
  // FedEx standalone "TO" line then name next line
  if (!p.toName) {
    const toAlone = lines.findIndex(l => /^TO$/.test(l.trim()));
    if (toAlone >= 0) {
      const cand = lines[toAlone+1]||'';
      if (/^[A-Z][A-Z\s.,-]{2,}/.test(cand) && !/^\(/.test(cand)) {
        p.toName = cand;
        const ta = [];
        for (let i=toAlone+2; i<Math.min(toAlone+9,lines.length); i++) {
          if (/^\(|^REF:|^INV:|^PO:|^DEPT:|^6\d{9}|^SIGN:|^CTRY|^TRK#|^AWB|\bMA\b|\bEWO\b|\bSIN\b/i.test(lines[i])) break;
          if (/^[A-Z0-9]/.test(lines[i]) && !/FedEx|FEDEX/i.test(lines[i])) ta.push(lines[i]);
        }
        p.toAddress = ta.join(', ');
      }
    }
  }
  // UPS SHIP TO:
  if (!p.toName) {
    const sti = lines.findIndex(l => /^SHIP\s+TO[:\s]/i.test(l));
    if (sti >= 0) {
      p.toName = lines[sti+1]||'';
      const ta = []; let skip5 = true;
      for (let i=sti+2; i<Math.min(sti+10,lines.length); i++) {
        const ln = lines[i];
        if (/^\d{7,}$/.test(ln)) continue;
        if (/^UPS|^TRACKING|^BILLING|^SHIP\s+DWT|^REF|^DESC|^AUS\s+|^D22|^\d+INR/i.test(ln)) break;
        if (skip5 && ln.toUpperCase()===(lines[sti+1]||'').toUpperCase()) { skip5=false; continue; }
        ta.push(ln);
      }
      p.toAddress = ta.join(', ');
    }
  }
  // DHL Receiver block
  if (!p.toName) {
    const rxi = lines.findIndex(l => /^Receiver\s*:/i.test(l));
    if (rxi >= 0) {
      let ri = rxi+1;
      if (/^Contact:/i.test(lines[ri]||'')) ri++;
      p.toName = lines[ri]||'';
      const skip6 = (lines[ri+1]&&lines[ri+1].toUpperCase()===p.toName.toUpperCase()) ? ri+2 : ri+1;
      p.toAddress = lines.slice(skip6,skip6+5).filter(l=>/[A-Z0-9]/.test(l)&&!/^Contact|^CVGH|^HKGO/i.test(l)).join(', ');
    }
  }

  // ─── 11. CLEAN UP ────────────────────────────────────
  const trim120 = s => (s||'').trim().substring(0,120);
  p.fromName    = trim120(p.fromName).replace(/\s*(?:ACTWGT|SHIP\s*DATE|CAD:).*$/i,'').trim();
  p.fromAddress = trim120(p.fromAddress).replace(/,\s*Origin:\s*$/i,'').replace(/,\s*,/g,',').replace(/^,|,$/g,'').trim();
  p.toName      = trim120(p.toName);
  p.toAddress   = trim120(p.toAddress).replace(/,\s*,/g,',').replace(/^,|,$/g,'').trim();
  p.description = trim120(p.description).replace(/\s+[A-Z]{1,3}\s+[A-Z]{1,3}\s*$/,'').trim();
  p.weight      = trim120(p.weight);
  p.dimensions  = trim120(p.dimensions);
  p.shipDate    = trim120(p.shipDate);
  p.pieces      = p.pieces || '1';
  p.customerName = p.toName || p.fromName || 'Unknown';

  console.log(`[PDF] carrier=${p.carrier} tn=${p.trackingNumber} from="${p.fromName}" to="${p.toName}" wt=${p.weight} pcs=${p.pieces} desc="${p.description}"`);
  return p;
}


//   GARUDA WAYBILL HTML
// ═══════════════════════════════════════════
const GARUDA_LOGO_B64 = 'data:image/jpeg;base64,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';

function barcodesvg(text) {
  // Code 128-style barcode (realistic alternating bars)
  const widths = [2,1,2,3,1,3,1,1,2,2,3,2,1,1,3,1,2,3,2,1,1,3,3,1,1,2,1,3,2,3];
  let x=8, bars=[], isBar=true;
  // Start code
  for(let i=0;i<text.length;i++){
    const c = text.charCodeAt(i);
    const pat = [widths[c%10], widths[(c>>2)%10], widths[(c>>4)%8+2], widths[(c>>6)%10]];
    for(const w of pat){
      if(isBar) bars.push(`<rect x="${x}" y="4" width="${w*2}" height="48" fill="#000"/>`);
      x+=w*2+1; isBar=!isBar;
    }
    isBar=true; x+=1;
  }
  // Stop bar
  bars.push(`<rect x="${x}" y="4" width="3" height="48" fill="#000"/>`); x+=4;
  bars.push(`<rect x="${x}" y="4" width="1" height="48" fill="#000"/>`); x+=4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x+8} 68" style="width:100%;max-width:280px;height:auto"><rect width="100%" height="100%" fill="white"/>${bars.join('')}<text x="${(x+16)/2}" y="66" text-anchor="middle" font-family="Courier New,monospace" font-size="9" fill="#000">${text}</text></svg>`;
}

app.get('/api/waybill/:ge/html', (req, res) => {
  // Accept token via header or query param (query needed for iframe src)
  const token = req.headers['x-admin-token'] || req.query.token;
  const session = token && sessionStore.get(token);
  if (!session || Date.now() > session.expiry)
    return res.status(401).send('<html><body style="font-family:sans-serif;padding:2rem;background:#1a0820;color:#fff"><h2>🔒 Session expired — please re-login via <a href="/Admin" style="color:#C9A0F0">/Admin</a></h2></body></html>');
  const row = db.prepare('SELECT * FROM shipments WHERE ge_tracking_number=?').get(req.params.ge.toUpperCase());
  if (!row) return res.status(404).send('<html><body style="font-family:sans-serif;padding:2rem;background:#1a0820;color:#fff"><h2>❌ Shipment not found</h2></body></html>');
  res.set('Content-Type','text/html'); res.send(garudaWaybillHTML(row));
});

function garudaWaybillHTML(row) {
  const date = row.ship_date || new Date(row.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  const pieces = row.pieces || '1';
  const svcDisplay = (row.service_type || '').replace(/\b(DHL|UPS|FEDEX|FedEx)\b/gi,'Garuda Express') || 'Garuda Express International';
  const bc = row.ge_tracking_number.replace(/-/g,'');
  const fromAddrFmt = (row.from_address||'—').replace(/,\s*/g,'\n');
  const toAddrFmt   = (row.to_address||'—').replace(/,\s*/g,'\n');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Garuda Express Waybill — ${row.ge_tracking_number}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Helvetica Neue',Arial,sans-serif;background:#e8e8e8;min-height:100vh;padding:24px;display:flex;justify-content:center;}
.wb{width:148mm;background:#fff;border:2px solid #1a0820;box-shadow:0 8px 32px rgba(0,0,0,0.25);page-break-inside:avoid;}
.wb-hdr{background:#1a0820;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;}
.wb-logo{height:42px;width:auto;object-fit:contain;filter:brightness(0) invert(1);}
.wb-hdr-right{text-align:right;}
.ge-lbl{font-size:6px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,0.45);}
.ge-val{font-family:monospace;font-size:14px;font-weight:800;letter-spacing:2.5px;color:#C9A0F0;}
.svc-band{background:#5B2D8B;padding:6px 14px;display:flex;justify-content:space-between;align-items:center;}
.svc-name{font-weight:900;font-size:11px;letter-spacing:0.5px;color:#fff;}
.svc-meta{font-size:9px;font-weight:600;color:rgba(255,255,255,0.7);display:flex;gap:12px;}
.ag{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #ddd;}
.ab{padding:9px 12px;}.ab:first-child{border-right:1px solid #ddd;}
.ab-lbl{font-size:6.5px;text-transform:uppercase;letter-spacing:1.5px;color:#5B2D8B;font-weight:700;margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid #EDD5FF;}
.ab-name{font-size:10.5px;font-weight:700;color:#1a0820;margin-bottom:3px;}
.ab-addr{font-size:8.5px;color:#444;line-height:1.5;white-space:pre-line;}
.dg{display:grid;grid-template-columns:1fr 1fr 0.6fr 1fr;border-bottom:1px solid #ddd;}
.dc{padding:6px 10px;border-right:1px solid #f0f0f0;}
.dc:last-child{border-right:none;}
.dc span:first-child{display:block;font-size:6px;text-transform:uppercase;letter-spacing:1.5px;color:#999;margin-bottom:2px;}
.dc span:last-child{font-size:9.5px;font-weight:700;color:#1a0820;}
.dr{padding:5px 12px;border-bottom:1px solid #ddd;display:flex;gap:8px;align-items:baseline;}
.dr-lbl{font-size:6.5px;text-transform:uppercase;letter-spacing:1.5px;color:#999;white-space:nowrap;}
.dr-val{font-size:9px;font-weight:600;color:#1a0820;}
.bcs{padding:12px;border-bottom:1px solid #ddd;text-align:center;background:#fafafa;}
.bcs svg{max-width:100%;}
.ge-bc{font-family:monospace;font-size:15px;font-weight:800;letter-spacing:4px;color:#1a0820;margin-top:3px;display:block;}
.ct{padding:7px 12px;background:#f7f4ff;border-bottom:1px solid #ddd;}
.ct-lbl{font-size:6.5px;text-transform:uppercase;letter-spacing:1.5px;color:#888;}
.ct-val{font-family:monospace;font-size:10px;font-weight:700;color:#1a0820;}
.wf{background:#f9f9f9;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;}
.wf-c{font-size:7.5px;color:#555;line-height:1.5;}
.wf-c b{color:#1a0820;}
.wf-w{font-size:8px;font-weight:800;color:#5B2D8B;}
.no-print{position:fixed;top:16px;right:16px;display:flex;gap:10px;z-index:999;}
.no-print button{padding:10px 20px;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px;}
.btn-print{background:#5B2D8B;color:#fff;}
.btn-close{background:#333;color:#fff;}
@media print{body{background:#fff;padding:0;}.wb{box-shadow:none;border:1px solid #000;}.no-print{display:none!important;}}
</style></head><body>
<div class="no-print">
  <button class="btn-print" onclick="window.print()">&#128424; Print / PDF</button>
  <button class="btn-close" onclick="window.close()">&#10005; Close</button>
</div>
<div class="wb">
  <div class="wb-hdr">
    <img src="${GARUDA_LOGO_B64}" alt="Garuda Express" class="wb-logo"/>
    <div class="wb-hdr-right">
      <div class="ge-lbl">Garuda Tracking ID</div>
      <div class="ge-val">${row.ge_tracking_number}</div>
    </div>
  </div>
  <div class="svc-band">
    <span class="svc-name">Garuda Express International</span>
    <span class="svc-meta"><span>${svcDisplay}</span><span>${date}</span></span>
  </div>
  <div class="ag">
    <div class="ab">
      <div class="ab-lbl">&#128230; Sender / From</div>
      <div class="ab-name">${row.from_name||row.customer_name||'&#8212;'}</div>
      <div class="ab-addr">${fromAddrFmt}</div>
    </div>
    <div class="ab">
      <div class="ab-lbl">&#127968; Recipient / To</div>
      <div class="ab-name">${row.to_name||'&#8212;'}</div>
      <div class="ab-addr">${toAddrFmt}</div>
    </div>
  </div>
  <div class="dg">
    <div class="dc"><span>Weight</span><span>${row.weight||'&#8212;'}</span></div>
    <div class="dc"><span>Dimensions</span><span>${row.dimensions||'&#8212;'}</span></div>
    <div class="dc"><span>Pieces</span><span>${pieces}</span></div>
    <div class="dc"><span>Ship Date</span><span>${date}</span></div>
  </div>
  ${row.description?`<div class="dr"><span class="dr-lbl">Contents:</span><span class="dr-val">${row.description}</span></div>`:''}
  <div class="bcs">${barcodesvg(bc)}<span class="ge-bc">${row.ge_tracking_number}</span></div>
  <div class="ct">
    <div class="ct-lbl">Carrier Tracking Reference</div>
    <div class="ct-val">${row.carrier_tracking_number}</div>
  </div>
  <div class="wf">
    <div class="wf-c"><b>Garuda Express International</b> &#183; Anna Nagar, Chennai, India<br>Tel: +91 81222 57307 | +91 95661 22447 | info@garudaexpresscourier.com</div>
    <div class="wf-w">garudaexpresscourier.com</div>
  </div>
</div></body></html>`;
}

// ═══════════════════════════════════════════
//   DASHBOARD
// ═══════════════════════════════════════════
app.get('/api/dashboard/shipments', requireAuth, (req, res) => {
  const { from, to, carrier, search } = req.query;
  let q = 'SELECT * FROM shipments WHERE 1=1'; const p = [];
  if (from) { q += ' AND date(created_at) >= ?'; p.push(from); }
  if (to)   { q += ' AND date(created_at) <= ?'; p.push(to); }
  if (carrier && carrier !== 'ALL') { q += ' AND carrier = ?'; p.push(carrier.toUpperCase()); }
  if (search) { q += ' AND (ge_tracking_number LIKE ? OR carrier_tracking_number LIKE ? OR customer_name LIKE ? OR to_name LIKE ?)'; const s=`%${search}%`; p.push(s,s,s,s); }
  q += ' ORDER BY id DESC';
  const rows = db.prepare(q).all(...p);
  res.json({ success: true, shipments: rows.map((r,i) => ({ sNo:i+1,id:r.id,date:r.created_at,geTrackingNumber:r.ge_tracking_number,carrierTrackingNumber:r.carrier_tracking_number,carrier:r.carrier,customerName:r.customer_name,fromName:r.from_name,fromAddress:r.from_address,toName:r.to_name,toAddress:r.to_address,serviceType:r.service_type,weight:r.weight,dimensions:r.dimensions,description:r.description,updatedAt:r.updated_at })), total: rows.length, stats: getStats() });
});
app.put('/api/dashboard/shipments/:id', requireAuth, (req, res) => {
  const id = parseInt(req.params.id), row = db.prepare('SELECT * FROM shipments WHERE id=?').get(id);
  if (!row) return res.json({ success: false, error: 'Not found' });
  const { customerName, fromName, fromAddress, toName, toAddress, serviceType, weight, dimensions, carrierTrackingNumber, description } = req.body || {};
  db.prepare(`UPDATE shipments SET customer_name=?,from_name=?,from_address=?,to_name=?,to_address=?,service_type=?,weight=?,dimensions=?,carrier_tracking_number=?,description=?,updated_at=? WHERE id=?`)
    .run(customerName||row.customer_name, fromName||row.from_name, fromAddress||row.from_address, toName||row.to_name, toAddress||row.to_address, serviceType||row.service_type, weight||row.weight, dimensions||row.dimensions, carrierTrackingNumber||row.carrier_tracking_number, description||row.description, new Date().toISOString(), id);
  db.prepare('DELETE FROM tracking_cache WHERE ge_tracking_number=?').run(row.ge_tracking_number);
  res.json({ success: true });
});

// ═══════════════════════════════════════════
//   CATCH-ALL
// ═══════════════════════════════════════════
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Health check endpoint ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const stats = getStats();
  res.json({ status: 'ok', uptime: Math.floor(process.uptime()), shipments: stats.total, memory: Math.round(process.memoryUsage().heapUsed/1024/1024) + 'MB', version: '5.0.0' });
});

// ── Cron: clear expired tracking cache every 10 minutes ───────────────────
if (cron) {
  cron.schedule('*/10 * * * *', () => {
    try {
      const cutoff = new Date(Date.now() - CACHE_TTL_MS).toISOString();
      const r = db.prepare('DELETE FROM tracking_cache WHERE cached_at < ?').run(cutoff);
      if (r.changes > 0) logger.info(`[CRON] Cleared ${r.changes} expired cache entries`);
    } catch(e) { logger.error('[CRON] Cache cleanup error: ' + e.message); }
  });
  // Cron: clear old session tokens every hour
  cron.schedule('0 * * * *', () => {
    const now = Date.now();
    let cleared = 0;
    for (const [k, v] of sessionStore.entries()) {
      if (now > v.expiry) { sessionStore.delete(k); cleared++; }
    }
    if (cleared > 0) logger.info(`[CRON] Cleared ${cleared} expired sessions`);
  });
  logger.info('[CRON] Scheduled jobs started');
}

app.listen(PORT, () => {
  const env = k => !!(process.env[k] && !process.env[k].includes('your_'));
  const banner = [
    '',
    '🦅  Garuda Express v5  —  http://localhost:' + PORT,
    '─'.repeat(52),
    '  Tracking APIs:',
    `    DHL   : ${env('DHL_API_KEY')   ? '✓ Official API'  : '→ 17track fallback'}`,
    `    FedEx : ${env('FEDEX_API_KEY') ? '✓ OAuth2 API'    : '→ 17track fallback'}`,
    `    UPS   : ${env('UPS_CLIENT_ID') ? '✓ OAuth2 API'    : '→ 17track fallback'}`,
    `    17trk : ${env('TRACK17_API_KEY')? '✓ API key'       : '✓ free public'}`,
    '  Security  : ' + (helmet ? 'helmet ✓' : 'npm install for helmet') + ' | ' + (rateLimit ? 'rate-limit ✓' : ''),
    '  Perf      : ' + (compression ? 'compression ✓' : '') + ' | ' + (cron ? 'cron ✓' : ''),
    '  Logging   : ' + (winston ? 'winston → logs/' : 'console'),
    '─'.repeat(52),
    ''
  ].join('\n');
  logger.info(banner);
});

process.on('SIGTERM', () => { logger.info('SIGTERM received — shutting down'); db.close(); process.exit(0); });
process.on('SIGINT',  () => { logger.info('SIGINT received — shutting down');  db.close(); process.exit(0); });
process.on('uncaughtException',  e => logger.error('Uncaught exception: ' + e.message));
process.on('unhandledRejection', e => logger.error('Unhandled rejection: ' + (e && e.message || e)));
