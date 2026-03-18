// ============================================================
//   Garuda Express v5 — Vercel Serverless API
//   All API routes handled here via vercel.json rewrites
//   DB: in-memory store (use Vercel KV / PlanetScale for prod)
//   TRACKING CHAIN:
//     DHL   → DHL Official API  → 17track fallback
//     FedEx → FedEx OAuth2 API  → 17track fallback
//     UPS   → UPS OAuth2 API    → 17track fallback
// ============================================================

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const https   = require('https');
const http    = require('http');
const multer  = require('multer');
const path    = require('path');

const app = express();

// ── In-memory store (survives within a single serverless instance)
// For production persistence, swap this with Vercel KV / Neon / PlanetScale
let shipments     = {};   // { [geNumber]: rowObject }
let waybills      = [];
let trackingCache = {};   // { [geNumber]: { data, cachedAt } }
let sessionStore  = {};   // { [token]: { username, expiry } }
let idCounter     = 1;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── Auth config
const ADMIN_USER  = process.env.ADMIN_USER  || 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASS  || 'garuda2024';
const PORTAL_USER = process.env.PORTAL_USER || 'portal';
const PORTAL_PASS = process.env.PORTAL_PASS || 'garuda2024';
const SESSION_TTL = 8 * 60 * 60 * 1000;

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json({ limit: '10mb' }));

// ── Multer — memory storage (no filesystem on Vercel)
const uploadWaybill = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ═══════════════════════════════════════════
//   AUTH
// ═══════════════════════════════════════════
function requireAuth(req, res, next) {
  const token   = req.headers['x-admin-token'];
  const session = token && sessionStore[token];
  if (!session || Date.now() > session.expiry)
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  req.admin = session.username;
  next();
}
function requirePortalAuth(req, res, next) {
  const token   = req.headers['x-admin-token'] || req.query.token;
  const session = token && sessionStore[token];
  if (!session || Date.now() > session.expiry)
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USER || password !== ADMIN_PASS)
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  const token = crypto.randomBytes(32).toString('hex');
  sessionStore[token] = { username, expiry: Date.now() + SESSION_TTL };
  res.json({ success: true, token });
});
app.post('/api/admin/logout', requireAuth, (req, res) => {
  delete sessionStore[req.headers['x-admin-token']];
  res.json({ success: true });
});
app.get('/api/admin/me', requireAuth, (req, res) => {
  res.json({ success: true, username: req.admin });
});
app.post('/api/portal/login', (req, res) => {
  const { username, password } = req.body || {};
  const ok = (username === PORTAL_USER && password === PORTAL_PASS) ||
             (username === ADMIN_USER  && password === ADMIN_PASS);
  if (!ok) return res.status(401).json({ success: false, error: 'Invalid credentials' });
  const token = crypto.randomBytes(32).toString('hex');
  sessionStore[token] = { username, expiry: Date.now() + SESSION_TTL };
  res.json({ success: true, token });
});

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
  return evts
    .filter(e => { const k = `${e.status}|${e.location}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
};
const errResult = (c, cn, tn, msg) => ({
  carrier: c, carrierName: cn, trackingNumber: tn,
  currentStatus: 'Unavailable', origin: '', destination: '', serviceType: '',
  events: [], fetchedAt: new Date().toISOString(), isValid: false, error: msg
});

// ═══════════════════════════════════════════
//   17TRACK FALLBACK — FIXED
//   The public (no-key) endpoint only registers
//   a number and returns no events. This version
//   properly uses the API key and fetches events.
// ═══════════════════════════════════════════
const TRACK17_CARRIER_CODES = { DHL: 2, FEDEX: 100002, UPS: 100003, TNT: 6 };

async function track17track(trackingNumber, carrier, carrierName) {
  const API_KEY = process.env.TRACK17_API_KEY;

  // ── Path 1: API key present → register + fetch
  if (API_KEY && API_KEY !== 'your_17track_api_key_here') {
    try {
      const carrierCode = TRACK17_CARRIER_CODES[carrier] || 0;

      // Step 1: register tracking
      const regBody = JSON.stringify([{ number: trackingNumber, carrier: carrierCode }]);
      await httpRequest({
        hostname: 'api.17track.net', path: '/track/v2.2/register',
        method: 'POST', timeout: 10000,
        headers: { '17token': API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(regBody) }
      }, regBody);

      // Step 2: wait 1.5s then fetch
      await new Promise(r => setTimeout(r, 1500));

      const getBody = JSON.stringify([{ number: trackingNumber }]);
      const getRes = await httpRequest({
        hostname: 'api.17track.net', path: '/track/v2.2/gettrackinfo',
        method: 'POST', timeout: 15000,
        headers: { '17token': API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(getBody) }
      }, getBody);

      if (getRes.status === 200) {
        const parsed = JSON.parse(getRes.body);
        const track  = parsed?.data?.accepted?.[0]?.track;
        
        // z2 = tracking events array
        if (track?.z2?.length > 0) {
          const events = track.z2
            .map(e => ({
              timestamp: e.a ? new Date(e.a).toISOString() : new Date().toISOString(),
              status:    clean(e.z || e.d || ''),
              location:  clean(e.c || '')
            }))
            .filter(e => e.status);

          if (events.length > 0) {
            console.log(`[17track] ✓ API success — ${events.length} events for ${trackingNumber}`);
            return {
              carrier, carrierName, trackingNumber,
              currentStatus: normalizeStatus(track.e || events[0].status),
              origin: clean(track.o || ''), destination: clean(track.d || ''),
              serviceType: carrierName,
              events: dedup(events),
              fetchedAt: new Date().toISOString(), isValid: true, source: '17track'
            };
          }
        }

        // Package registered but no events yet (recently created shipment)
        const accepted = parsed?.data?.accepted?.[0];
        if (accepted) {
          console.log(`[17track] Registered — no events yet for ${trackingNumber}`);
          return {
            carrier, carrierName, trackingNumber,
            currentStatus: 'Registered / Pending',
            origin: '', destination: '', serviceType: carrierName,
            events: [{
              timestamp: new Date().toISOString(),
              status: 'Shipment registered. Tracking information will appear once the carrier scans the package.',
              location: ''
            }],
            fetchedAt: new Date().toISOString(), isValid: true, source: '17track-registered'
          };
        }

        // Check rejected
        const rejected = parsed?.data?.rejected?.[0];
        if (rejected) {
          const reason = rejected.error?.message || 'Tracking number not found';
          console.log(`[17track] Rejected: ${reason}`);
          return errResult(carrier, carrierName, trackingNumber, `17track: ${reason}`);
        }
      }
    } catch (e) {
      console.error('[17track] API error:', e.message);
    }
  } else {
    console.log('[17track] No API key set — cannot track. Set TRACK17_API_KEY in environment variables.');
  }

  // ── Path 2: no API key or API failed
  return errResult(
    carrier, carrierName, trackingNumber,
    'Tracking unavailable. No carrier API keys or 17track API key configured in environment variables.'
  );
}

// ═══════════════════════════════════════════
//   DHL
// ═══════════════════════════════════════════
async function trackDHL(tn) {
  const key = process.env.DHL_API_KEY;
  if (key && !['demo-key','your_dhl_api_key_here'].includes(key)) {
    try {
      const res = await httpRequest({
        hostname: 'api-eu.dhl.com',
        path: `/track/shipments?trackingNumber=${encodeURIComponent(tn)}`,
        method: 'GET', timeout: 15000,
        headers: { 'DHL-API-Key': key, 'Accept': 'application/json' }
      });
      if (res.status === 200) {
        const s = JSON.parse(res.body)?.shipments?.[0];
        if (s?.events?.length > 0) {
          const events = s.events
            .map(e => ({
              timestamp: e.timestamp || new Date().toISOString(),
              status:    clean(e.description || ''),
              location:  clean([e.location?.address?.addressLocality, e.location?.address?.countryCode].filter(Boolean).join(', '))
            }))
            .filter(e => e.status);
          if (events.length > 0) {
            return {
              carrier: 'DHL', carrierName: 'DHL Express', trackingNumber: tn,
              currentStatus: normalizeStatus(s.status?.description || events[0].status),
              origin: clean(s.origin?.address?.addressLocality || ''),
              destination: clean(s.destination?.address?.addressLocality || ''),
              serviceType: 'DHL Express', events: dedup(events),
              fetchedAt: new Date().toISOString(), isValid: true, source: 'dhl-api'
            };
          }
        }
      }
    } catch (e) { console.log('[DHL]', e.message); }
  }
  return track17track(tn, 'DHL', 'DHL Express');
}

// ═══════════════════════════════════════════
//   FEDEX
// ═══════════════════════════════════════════
async function getFedExToken() {
  const k = process.env.FEDEX_API_KEY, s = process.env.FEDEX_API_SECRET;
  if (!k || k === 'your_fedex_api_key_here') throw new Error('FedEx keys missing');
  return getCachedToken('fedex', async () => {
    const body = `grant_type=client_credentials&client_id=${encodeURIComponent(k)}&client_secret=${encodeURIComponent(s)}`;
    const res = await httpRequest({
      hostname: 'apis.fedex.com', path: '/oauth/token',
      method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
    }, body);
    if (res.status !== 200) throw new Error(`FedEx OAuth ${res.status}`);
    const d = JSON.parse(res.body);
    return { token: d.access_token, expiresIn: d.expires_in || 3600 };
  });
}
async function trackFedEx(tn) {
  const k = process.env.FEDEX_API_KEY;
  if (k && k !== 'your_fedex_api_key_here') {
    try {
      const token   = await getFedExToken();
      const payload = JSON.stringify({ trackingInfo: [{ trackingNumberInfo: { trackingNumber: tn } }], includeDetailedScans: true });
      const res = await httpRequest({
        hostname: 'apis.fedex.com', path: '/track/v1/trackingnumbers',
        method: 'POST', timeout: 20000,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'Content-Length': Buffer.byteLength(payload), 'x-locale': 'en_US' }
      }, payload);
      if (res.status === 200) {
        const result = JSON.parse(res.body)?.output?.completeTrackResults?.[0]?.trackResults?.[0];
        if (result && !result.error) {
          const events = (result.scanEvents || [])
            .map(e => ({
              timestamp: e.date ? new Date(e.date).toISOString() : new Date().toISOString(),
              status:    clean(e.eventDescription || ''),
              location:  clean([e.scanLocation?.city, e.scanLocation?.stateOrProvinceCode, e.scanLocation?.countryCode].filter(Boolean).join(', '))
            }))
            .filter(e => e.status);
          if (events.length > 0) {
            const sh = result.shipperInformation?.address, re = result.recipientInformation?.address;
            return {
              carrier: 'FEDEX', carrierName: 'FedEx', trackingNumber: tn,
              currentStatus: normalizeStatus(result.latestStatusDetail?.description || events[0].status),
              origin: clean([sh?.city, sh?.countryCode].filter(Boolean).join(', ')),
              destination: clean([re?.city, re?.countryCode].filter(Boolean).join(', ')),
              serviceType: clean(result.serviceDetail?.description || 'FedEx Express'),
              events: dedup(events), fetchedAt: new Date().toISOString(), isValid: true, source: 'fedex-api'
            };
          }
        }
      }
    } catch (e) { console.log('[FedEx]', e.message); }
  }
  return track17track(tn, 'FEDEX', 'FedEx');
}

// ═══════════════════════════════════════════
//   UPS
// ═══════════════════════════════════════════
async function getUPSToken() {
  const id = process.env.UPS_CLIENT_ID, s = process.env.UPS_CLIENT_SECRET;
  if (!id || id === 'your_ups_client_id_here') throw new Error('UPS keys missing');
  return getCachedToken('ups', async () => {
    const creds = Buffer.from(`${id}:${s}`).toString('base64');
    const body  = 'grant_type=client_credentials';
    const res   = await httpRequest({
      hostname: 'onlinetools.ups.com', path: '/security/v1/oauth/token',
      method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${creds}`, 'x-merchant-id': 'string', 'Content-Length': Buffer.byteLength(body) }
    }, body);
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
      const res   = await httpRequest({
        hostname: 'onlinetools.ups.com',
        path: `/api/track/v1/details/${encodeURIComponent(tn)}?locale=en_US&returnSignature=false`,
        method: 'GET', timeout: 20000,
        headers: { 'Authorization': `Bearer ${token}`, 'transId': String(Date.now()), 'transactionSrc': 'garuda-express', 'Accept': 'application/json' }
      });
      if (res.status === 200) {
        const j = JSON.parse(res.body), shipment = j?.trackResponse?.shipment?.[0], pkg = shipment?.package?.[0];
        if (pkg) {
          const events = (pkg.activity || []).map(a => {
            const d = a.date || '', t = a.time || '';
            let ts;
            try { ts = d && t ? new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}Z`).toISOString() : new Date().toISOString(); }
            catch { ts = new Date().toISOString(); }
            return { timestamp: ts, status: clean(a.status?.description || ''), location: clean([a.location?.address?.city, a.location?.address?.country].filter(Boolean).join(', ')) };
          }).filter(e => e.status);
          if (events.length > 0) {
            return {
              carrier: 'UPS', carrierName: 'UPS', trackingNumber: tn,
              currentStatus: normalizeStatus(pkg.currentStatus?.description || events[0].status),
              origin: clean([shipment.shipFrom?.address?.city].filter(Boolean).join(', ')),
              destination: clean([shipment.shipTo?.address?.city].filter(Boolean).join(', ')),
              serviceType: clean(shipment.service?.description || 'UPS'),
              events: dedup(events), fetchedAt: new Date().toISOString(), isValid: true, source: 'ups-api'
            };
          }
        }
      }
    } catch (e) { console.log('[UPS]', e.message); }
  }
  return track17track(tn, 'UPS', 'UPS');
}

// ═══════════════════════════════════════════
//   CARRIER ROUTER
// ═══════════════════════════════════════════
async function scrapeCarrier(carrier, tn) {
  const c = (carrier || '').toUpperCase().trim();
  if (c === 'DHL')   return trackDHL(tn);
  if (c === 'UPS')   return trackUPS(tn);
  if (c === 'FEDEX') return trackFedEx(tn);
  return track17track(tn, c, c);
}

// ═══════════════════════════════════════════
//   GE NUMBER & STATS
// ═══════════════════════════════════════════
function generateGENumber() {
  const y    = new Date().getFullYear();
  const rows = Object.values(shipments).filter(s => s.ge_tracking_number.startsWith(`GE-${y}-`));
  let max = 0;
  rows.forEach(r => { const m = r.ge_tracking_number.match(/GE-\d{4}-(\d+)/); if (m) max = Math.max(max, parseInt(m[1])); });
  return `GE-${y}-${String(max + 1).padStart(5, '0')}`;
}
function getStats() {
  const all = Object.values(shipments);
  const today = new Date().toISOString().slice(0, 10);
  return {
    total: all.length,
    dhl:   all.filter(s => s.carrier === 'DHL').length,
    ups:   all.filter(s => s.carrier === 'UPS').length,
    fedex: all.filter(s => s.carrier === 'FEDEX').length,
    today: all.filter(s => s.created_at.startsWith(today)).length
  };
}

const rowToShipment = r => ({
  geTrackingNumber: r.ge_tracking_number, carrierTrackingNumber: r.carrier_tracking_number,
  carrier: r.carrier, customerName: r.customer_name, fromName: r.from_name || '',
  fromAddress: r.from_address, toName: r.to_name || '', toAddress: r.to_address,
  serviceType: r.service_type, weight: r.weight, dimensions: r.dimensions,
  pieces: r.pieces || '', description: r.description || '', shipDate: r.ship_date || '',
  createdAt: r.created_at, updatedAt: r.updated_at
});

// ═══════════════════════════════════════════
//   TRACKING CACHE
// ═══════════════════════════════════════════
function getCached(ge) {
  const c = trackingCache[ge];
  if (!c) return null;
  if (Date.now() - c.cachedAt > CACHE_TTL_MS) { delete trackingCache[ge]; return null; }
  return c.data;
}
function setCache(ge, data) {
  trackingCache[ge] = { data, cachedAt: Date.now() };
}

// ═══════════════════════════════════════════
//   PUBLIC TRACKING
// ═══════════════════════════════════════════
app.get('/api/track/:geNumber', async (req, res) => {
  const ge  = req.params.geNumber.toUpperCase();
  const row = shipments[ge];
  if (!row) return res.json({ success: false, error: `No shipment found for: ${ge}` });
  const cached = getCached(ge);
  if (cached) return res.json({ success: true, shipment: cached, cached: true });
  try {
    const td = await scrapeCarrier(row.carrier, row.carrier_tracking_number);
    if (!td.isValid) return res.json({ success: false, error: td.error, carrier: row.carrier, carrierTrackingNumber: row.carrier_tracking_number });
    const shipment = {
      geTrackingNumber: row.ge_tracking_number, carrierTrackingNumber: row.carrier_tracking_number,
      carrier: row.carrier, carrierName: td.carrierName, customerName: row.customer_name,
      fromAddress: row.from_address, toAddress: row.to_address,
      currentStatus: td.currentStatus, origin: td.origin || row.from_address,
      destination: td.destination || row.to_address, serviceType: td.serviceType || row.service_type,
      trackingData: td, createdAt: row.created_at, fetchedAt: td.fetchedAt, source: td.source
    };
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
    TRACK17: { configured: isSet('TRACK17_API_KEY','your_17track_api_key_here'), note: 'Universal fallback — requires API key', envVars: 'TRACK17_API_KEY', getKeyUrl: 'https://www.17track.net/en/api' }
  }, chain: 'Carrier API → 17track (with API key) → error message' });
});

// ═══════════════════════════════════════════
//   SHIPMENTS CRUD
// ═══════════════════════════════════════════
app.get('/api/shipments', requireAuth, (req, res) => {
  const c   = (req.query.carrier || '').toUpperCase();
  let list  = Object.values(shipments).sort((a, b) => b.id - a.id);
  if (c && c !== 'ALL') list = list.filter(s => s.carrier === c);
  res.json({ success: true, shipments: list.map(rowToShipment), stats: getStats() });
});

app.post('/api/shipments', requireAuth, (req, res) => {
  const { carrier, carrierTrackingNumber, geTrackingNumber, customerName, fromName, fromAddress, toName, toAddress, serviceType, weight, dimensions, pieces, description, shipDate } = req.body || {};
  if (!carrier || !carrierTrackingNumber || !customerName) return res.json({ success: false, error: 'Missing required fields' });
  const c = carrier.toUpperCase();
  if (!['DHL','UPS','FEDEX'].includes(c)) return res.json({ success: false, error: 'Invalid carrier' });
  const ge = (geTrackingNumber || generateGENumber()).toUpperCase();
  if (shipments[ge]) return res.json({ success: false, error: `${ge} already exists` });
  const now = new Date().toISOString();
  const row = { id: idCounter++, ge_tracking_number: ge, carrier_tracking_number: carrierTrackingNumber.trim(), carrier: c, customer_name: customerName.trim(), from_name: fromName||'', from_address: fromAddress||'', to_name: toName||'', to_address: toAddress||'', service_type: serviceType||'', weight: weight||'', dimensions: dimensions||'', pieces: pieces||'', description: description||'', ship_date: shipDate||'', created_at: now, updated_at: now };
  shipments[ge] = row;
  res.json({ success: true, shipment: rowToShipment(row) });
});

app.get('/api/shipments/:ge', requireAuth, (req, res) => {
  const row = shipments[req.params.ge.toUpperCase()];
  if (!row) return res.json({ success: false, error: 'Not found' });
  res.json({ success: true, shipment: rowToShipment(row) });
});

app.put('/api/shipments/:ge', requireAuth, (req, res) => {
  const ge = req.params.ge.toUpperCase(), row = shipments[ge];
  if (!row) return res.json({ success: false, error: 'Not found' });
  const { customerName, fromName, fromAddress, toName, toAddress, serviceType, weight, dimensions, pieces, description, shipDate, carrierTrackingNumber: ctn } = req.body || {};
  Object.assign(row, {
    customer_name: customerName||row.customer_name, carrier_tracking_number: ctn||row.carrier_tracking_number,
    from_name: fromName||row.from_name, from_address: fromAddress||row.from_address,
    to_name: toName||row.to_name, to_address: toAddress||row.to_address,
    service_type: serviceType||row.service_type, weight: weight||row.weight,
    dimensions: dimensions||row.dimensions, pieces: pieces!==undefined?pieces:row.pieces||'',
    description: description||row.description, ship_date: shipDate||row.ship_date,
    updated_at: new Date().toISOString()
  });
  delete trackingCache[ge];
  res.json({ success: true, shipment: rowToShipment(row) });
});

app.delete('/api/shipments/:ge', requireAuth, (req, res) => {
  const ge = req.params.ge.toUpperCase();
  if (!shipments[ge]) return res.json({ success: false, error: 'Not found' });
  delete shipments[ge];
  delete trackingCache[ge];
  waybills = waybills.filter(w => w.ge_tracking_number !== ge);
  res.json({ success: true });
});

app.get('/api/generate-ge-number', requireAuth, (req, res) => res.json({ success: true, geNumber: generateGENumber() }));
app.post('/api/shipments/:ge/refresh', requireAuth, (req, res) => { delete trackingCache[req.params.ge.toUpperCase()]; res.json({ success: true }); });
app.post('/api/clear-all', requireAuth, (req, res) => {
  const n = Object.keys(shipments).length;
  shipments = {}; waybills = []; trackingCache = {};
  res.json({ success: true, message: `Cleared ${n} shipments` });
});

app.post('/api/test-carrier', requireAuth, async (req, res) => {
  const { carrier, trackingNumber } = req.body || {};
  if (!carrier || !trackingNumber) return res.json({ success: false, error: 'carrier and trackingNumber required' });
  const t0 = Date.now();
  try {
    const d = await scrapeCarrier(carrier.toUpperCase(), trackingNumber);
    res.json({ success: d.isValid, data: d, eventsFound: d.events?.length||0, duration: `${Date.now()-t0}ms`, source: d.source||'unknown' });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/detect-carrier', (req, res) => {
  const { trackingNumber } = req.body || {}, n = (trackingNumber||'').trim().toUpperCase();
  let carrier = null;
  if (/^1Z[A-Z0-9]{16}$/i.test(n))                                          carrier = 'UPS';
  else if (/^\d{12,15}$/.test(n))                                            carrier = 'FEDEX';
  else if (/^(\d{10,12}|[A-Z]{4}\d+|GM\d+|JD\d+)$/i.test(n))               carrier = 'DHL';
  res.json({ success: !!carrier, carrier });
});

// ═══════════════════════════════════════════
//   PORTAL UPLOAD (memory — no disk on Vercel)
// ═══════════════════════════════════════════
app.post('/api/portal/upload', requirePortalAuth, (req, res) => {
  uploadWaybill.single('waybill')(req, res, async err => {
    if (err) return res.json({ success: false, error: err.message });
    if (!req.file) return res.json({ success: false, error: 'No file uploaded' });
    try {
      const parsed  = parseWaybillBuffer(req.file.buffer, req.file.originalname);
      const carrier = parsed.carrier || (req.body.carrier||'DHL').toUpperCase();
      const ge = generateGENumber(), now = new Date().toISOString();
      const row = { id: idCounter++, ge_tracking_number: ge, carrier_tracking_number: parsed.trackingNumber||'PENDING', carrier, customer_name: parsed.toName||parsed.customerName||'Unknown', from_name: parsed.fromName||'', from_address: parsed.fromAddress||'', to_name: parsed.toName||'', to_address: parsed.toAddress||'', service_type: parsed.serviceType||'Garuda Express', weight: parsed.weight||'', dimensions: parsed.dimensions||'', pieces: parsed.pieces||'', description: parsed.description||'', ship_date: parsed.shipDate||'', created_at: now, updated_at: now };
      shipments[ge] = row;
      waybills.push({ ge_tracking_number: ge, original_filename: req.file.originalname, carrier, parsed_data: parsed, created_at: now });
      res.json({ success: true, geNumber: ge, parsed, message: 'Garuda tracking number assigned: ' + ge });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });
});

app.post('/api/portal/upload-bulk', requirePortalAuth, (req, res) => {
  uploadWaybill.array('waybills', 20)(req, res, async err => {
    if (err) return res.json({ success: false, error: err.message });
    if (!req.files || !req.files.length) return res.json({ success: false, error: 'No files uploaded' });
    const results = [];
    for (const file of req.files) {
      try {
        const parsed  = parseWaybillBuffer(file.buffer, file.originalname);
        const carrier = parsed.carrier || (req.body.carrier||'DHL').toUpperCase();
        const ge = generateGENumber(), now = new Date().toISOString();
        const row = { id: idCounter++, ge_tracking_number: ge, carrier_tracking_number: parsed.trackingNumber||'PENDING', carrier, customer_name: parsed.toName||parsed.customerName||'Unknown', from_name: parsed.fromName||'', from_address: parsed.fromAddress||'', to_name: parsed.toName||'', to_address: parsed.toAddress||'', service_type: parsed.serviceType||'Garuda Express', weight: parsed.weight||'', dimensions: parsed.dimensions||'', pieces: parsed.pieces||'', description: parsed.description||'', ship_date: parsed.shipDate||'', created_at: now, updated_at: now };
        shipments[ge] = row;
        waybills.push({ ge_tracking_number: ge, original_filename: file.originalname, carrier, parsed_data: parsed, created_at: now });
        results.push({ success: true, filename: file.originalname, geNumber: ge, parsed });
      } catch (e) {
        results.push({ success: false, filename: file.originalname, error: e.message });
      }
    }
    res.json({ success: true, results, total: results.length, succeeded: results.filter(r=>r.success).length });
  });
});

// ── Waybill parser — works from Buffer (no filesystem needed)
function parseWaybillBuffer(buffer, filename) {
  // Basic text extraction from PDF buffer using simple pattern
  // For production, use pdf-parse with the buffer directly
  const p = { carrier:'', trackingNumber:'', pieces:'1', fromName:'', fromAddress:'', toName:'', toAddress:'', serviceType:'', weight:'', dimensions:'', description:'', shipDate:'', customerName:'' };
  try {
    // Try to extract text from buffer as UTF-8 (works for text-based PDFs)
    const text = buffer.toString('latin1');
    return parseWaybillText(text, p);
  } catch (e) {
    return p;
  }
}

function parseWaybillText(text, p) {
  const norm  = text.replace(/[ \t]+/g, ' ').trim();
  const lines = norm.split('\n').map(l => l.trim()).filter(Boolean);

  if (/FedEx|FEDEX|TRK#/i.test(norm))        p.carrier = 'FEDEX';
  else if (/\bDHL\b/i.test(norm))             p.carrier = 'DHL';
  else if (/\bUPS\b|\bUPS SAVER\b/i.test(norm)) p.carrier = 'UPS';

  const upsM    = norm.match(/\b(1Z\s?[A-Z0-9]{3}\s?[A-Z0-9]{3}\s?[A-Z0-9]{2}\s?[A-Z0-9]{4}\s?[A-Z0-9]{4})\b/i);
  const trkInl  = norm.match(/TRK#\s+([\d][\d ]{10,16}[\d])/i);
  const wbM     = norm.match(/WAYBILL\s+([\d][\d\s]{6,14}[\d])/i);
  if (upsM)   { p.trackingNumber = upsM[1].replace(/\s/g,'').toUpperCase(); if (!p.carrier) p.carrier = 'UPS'; }
  else if (trkInl) { p.trackingNumber = trkInl[1].replace(/\s/g,''); if (!p.carrier) p.carrier = 'FEDEX'; }
  else if (wbM)    { p.trackingNumber = wbM[1].replace(/\s/g,''); if (!p.carrier) p.carrier = 'DHL'; }

  const wtM = norm.match(/(?:ACTWGT|SHP\s*WT)[:\s]*([\d.]+\s*KG)/i) || norm.match(/\b([\d.]+)\s*KG\b/i);
  if (wtM) p.weight = wtM[1].trim().toUpperCase().includes('KG') ? wtM[1].trim() : wtM[1].trim() + ' KG';

  const dtM = norm.match(/(?:SHIP\s*DATE|DATE)[:\s]*(\d{1,2}\s*[A-Z]{3}\s*\d{2,4})/i);
  if (dtM) p.shipDate = dtM[1].trim();

  if (/UPS\s+SAVER/i.test(norm))                     p.serviceType = 'UPS Saver';
  else if (/EXPRESS\s+WORLDWIDE.*WPX/i.test(norm))   p.serviceType = 'DHL Express Worldwide (WPX)';
  else if (/EXPRESS\s+WORLDWIDE/i.test(norm))        p.serviceType = 'DHL Express Worldwide';
  else if (/FedEx.*EXPRESS/i.test(norm))             p.serviceType = 'FedEx Express';

  const trim120 = s => (s||'').trim().substring(0,120);
  p.fromName = trim120(p.fromName); p.toName = trim120(p.toName);
  p.fromAddress = trim120(p.fromAddress); p.toAddress = trim120(p.toAddress);
  p.customerName = p.toName || p.fromName || 'Unknown';
  return p;
}

// ═══════════════════════════════════════════
//   WAYBILL HTML
// ═══════════════════════════════════════════
const GARUDA_LOGO_B64 = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/wAARCAFBAakDASIAAhEBAxEB/8QAHAABAAIDAQEBAAAAAAAAAAAAAAMEAgUGBwEI/8QATBAAAgIBAgIGBgYIAwUFCQAAAQIAAwQFEQYSEyExQVFhIjJCcYGRBxRSYoKhFSMzcpKisbLBwtEWJENUYxdTc5PTNDVVdJSjs9Li/9oADAMBAAIRAxEAPwD8ZREQEREBERAREQEREBERAREQEREBERARMoBJAAJJ6gBOn0TgjVs/Z8lfqNRG4Nikufw93x2nsRM9HsVmZ2hy8lxcbJyrOjxce299t+WtCx+QnrGmcD6HiqCaDlWfbyG3/l6h894';

function barcodesvg(text) {
  const widths = [2,1,2,3,1,3,1,1,2,2,3,2,1,1,3,1,2,3,2,1,1,3,3,1,1,2,1,3,2,3];
  let x=8, bars=[], isBar=true;
  for(let i=0;i<text.length;i++){
    const c = text.charCodeAt(i);
    const pat = [widths[c%10], widths[(c>>2)%10], widths[(c>>4)%8+2], widths[(c>>6)%10]];
    for(const w of pat){ if(isBar) bars.push(`<rect x="${x}" y="4" width="${w*2}" height="48" fill="#000"/>`); x+=w*2+1; isBar=!isBar; }
    isBar=true; x+=1;
  }
  bars.push(`<rect x="${x}" y="4" width="3" height="48" fill="#000"/>`); x+=4;
  bars.push(`<rect x="${x}" y="4" width="1" height="48" fill="#000"/>`); x+=4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${x+8} 68" style="width:100%;max-width:280px;height:auto"><rect width="100%" height="100%" fill="white"/>${bars.join('')}<text x="${(x+16)/2}" y="66" text-anchor="middle" font-family="Courier New,monospace" font-size="9" fill="#000">${text}</text></svg>`;
}

app.get('/api/waybill/:ge/html', (req, res) => {
  const token   = req.headers['x-admin-token'] || req.query.token;
  const session = token && sessionStore[token];
  if (!session || Date.now() > session.expiry)
    return res.status(401).send('<html><body style="font-family:sans-serif;padding:2rem;background:#1a0820;color:#fff"><h2>🔒 Session expired</h2></body></html>');
  const row = shipments[req.params.ge.toUpperCase()];
  if (!row) return res.status(404).send('<html><body style="font-family:sans-serif;padding:2rem;background:#1a0820;color:#fff"><h2>❌ Shipment not found</h2></body></html>');
  res.set('Content-Type','text/html'); res.send(garudaWaybillHTML(row));
});

function garudaWaybillHTML(row) {
  const date = row.ship_date || new Date(row.created_at).toLocaleDateString('en-IN',{day:'2-digit',month:'short',year:'numeric'});
  const svcDisplay = (row.service_type||'').replace(/\b(DHL|UPS|FEDEX|FedEx)\b/gi,'Garuda Express') || 'Garuda Express International';
  const bc = row.ge_tracking_number.replace(/-/g,'');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Garuda Express Waybill — ${row.ge_tracking_number}</title>
<style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:'Helvetica Neue',Arial,sans-serif;background:#e8e8e8;min-height:100vh;padding:24px;display:flex;justify-content:center;}.wb{width:148mm;background:#fff;border:2px solid #1a0820;box-shadow:0 8px 32px rgba(0,0,0,0.25);}.wb-hdr{background:#1a0820;color:#fff;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;}.wb-logo{height:42px;width:auto;object-fit:contain;filter:brightness(0) invert(1);}.wb-hdr-right{text-align:right;}.ge-lbl{font-size:6px;text-transform:uppercase;letter-spacing:2px;color:rgba(255,255,255,0.45);}.ge-val{font-family:monospace;font-size:14px;font-weight:800;letter-spacing:2.5px;color:#C9A0F0;}.svc-band{background:#5B2D8B;padding:6px 14px;display:flex;justify-content:space-between;align-items:center;}.svc-name{font-weight:900;font-size:11px;letter-spacing:0.5px;color:#fff;}.ag{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #ddd;}.ab{padding:9px 12px;}.ab:first-child{border-right:1px solid #ddd;}.ab-lbl{font-size:6.5px;text-transform:uppercase;letter-spacing:1.5px;color:#5B2D8B;font-weight:700;margin-bottom:5px;}.ab-name{font-size:10.5px;font-weight:700;color:#1a0820;margin-bottom:3px;}.ab-addr{font-size:8.5px;color:#444;line-height:1.5;white-space:pre-line;}.dg{display:grid;grid-template-columns:1fr 1fr 0.6fr 1fr;border-bottom:1px solid #ddd;}.dc{padding:6px 10px;border-right:1px solid #f0f0f0;}.dc span:first-child{display:block;font-size:6px;text-transform:uppercase;letter-spacing:1.5px;color:#999;margin-bottom:2px;}.dc span:last-child{font-size:9.5px;font-weight:700;color:#1a0820;}.bcs{padding:12px;border-bottom:1px solid #ddd;text-align:center;background:#fafafa;}.ge-bc{font-family:monospace;font-size:15px;font-weight:800;letter-spacing:4px;color:#1a0820;margin-top:3px;display:block;}.ct{padding:7px 12px;background:#f7f4ff;border-bottom:1px solid #ddd;}.ct-lbl{font-size:6.5px;text-transform:uppercase;letter-spacing:1.5px;color:#888;}.ct-val{font-family:monospace;font-size:10px;font-weight:700;color:#1a0820;}.wf{background:#f9f9f9;padding:8px 12px;display:flex;justify-content:space-between;align-items:center;}.wf-c{font-size:7.5px;color:#555;line-height:1.5;}.wf-c b{color:#1a0820;}.no-print{position:fixed;top:16px;right:16px;display:flex;gap:10px;z-index:999;}.no-print button{padding:10px 20px;border:none;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px;}.btn-print{background:#5B2D8B;color:#fff;}.btn-close{background:#333;color:#fff;}@media print{body{background:#fff;padding:0;}.wb{box-shadow:none;border:1px solid #000;}.no-print{display:none!important;}}</style></head><body>
<div class="no-print"><button class="btn-print" onclick="window.print()">&#128424; Print / PDF</button><button class="btn-close" onclick="window.close()">&#10005; Close</button></div>
<div class="wb">
  <div class="wb-hdr"><img src="${GARUDA_LOGO_B64}" alt="Garuda Express" class="wb-logo"/><div class="wb-hdr-right"><div class="ge-lbl">Garuda Tracking ID</div><div class="ge-val">${row.ge_tracking_number}</div></div></div>
  <div class="svc-band"><span class="svc-name">Garuda Express International</span><span style="font-size:9px;font-weight:600;color:rgba(255,255,255,0.7)">${svcDisplay} · ${date}</span></div>
  <div class="ag">
    <div class="ab"><div class="ab-lbl">&#128230; Sender / From</div><div class="ab-name">${row.from_name||row.customer_name||'—'}</div><div class="ab-addr">${(row.from_address||'—').replace(/,\s*/g,'\n')}</div></div>
    <div class="ab"><div class="ab-lbl">&#127968; Recipient / To</div><div class="ab-name">${row.to_name||'—'}</div><div class="ab-addr">${(row.to_address||'—').replace(/,\s*/g,'\n')}</div></div>
  </div>
  <div class="dg"><div class="dc"><span>Weight</span><span>${row.weight||'—'}</span></div><div class="dc"><span>Dimensions</span><span>${row.dimensions||'—'}</span></div><div class="dc"><span>Pieces</span><span>${row.pieces||'1'}</span></div><div class="dc"><span>Ship Date</span><span>${date}</span></div></div>
  ${row.description?`<div style="padding:5px 12px;border-bottom:1px solid #ddd;font-size:9px"><b style="color:#999;text-transform:uppercase;letter-spacing:1px">Contents:</b> ${row.description}</div>`:''}
  <div class="bcs">${barcodesvg(bc)}<span class="ge-bc">${row.ge_tracking_number}</span></div>
  <div class="ct"><div class="ct-lbl">Carrier Tracking Reference</div><div class="ct-val">${row.carrier_tracking_number}</div></div>
  <div class="wf"><div class="wf-c"><b>Garuda Express International</b> · Anna Nagar, Chennai, India<br>Tel: +91 81222 57307 | +91 95661 22447 | info@garudaexpresscourier.com</div><div style="font-size:8px;font-weight:800;color:#5B2D8B">garudaexpresscourier.com</div></div>
</div></body></html>`;
}

// ═══════════════════════════════════════════
//   DASHBOARD
// ═══════════════════════════════════════════
app.get('/api/dashboard/shipments', requireAuth, (req, res) => {
  const { from, to, carrier, search } = req.query;
  let list = Object.values(shipments).sort((a, b) => b.id - a.id);
  if (from)   list = list.filter(s => s.created_at.slice(0,10) >= from);
  if (to)     list = list.filter(s => s.created_at.slice(0,10) <= to);
  if (carrier && carrier !== 'ALL') list = list.filter(s => s.carrier === carrier.toUpperCase());
  if (search) { const q = search.toLowerCase(); list = list.filter(s => [s.ge_tracking_number,s.carrier_tracking_number,s.customer_name,s.to_name].some(v => (v||'').toLowerCase().includes(q))); }
  res.json({ success: true, shipments: list.map((r,i) => ({ sNo:i+1,id:r.id,date:r.created_at,geTrackingNumber:r.ge_tracking_number,carrierTrackingNumber:r.carrier_tracking_number,carrier:r.carrier,customerName:r.customer_name,fromName:r.from_name,fromAddress:r.from_address,toName:r.to_name,toAddress:r.to_address,serviceType:r.service_type,weight:r.weight,dimensions:r.dimensions,description:r.description,updatedAt:r.updated_at })), total: list.length, stats: getStats() });
});

app.put('/api/dashboard/shipments/:id', requireAuth, (req, res) => {
  const id  = parseInt(req.params.id);
  const row = Object.values(shipments).find(s => s.id === id);
  if (!row) return res.json({ success: false, error: 'Not found' });
  const { customerName, fromName, fromAddress, toName, toAddress, serviceType, weight, dimensions, carrierTrackingNumber, description } = req.body || {};
  Object.assign(row, { customer_name: customerName||row.customer_name, from_name: fromName||row.from_name, from_address: fromAddress||row.from_address, to_name: toName||row.to_name, to_address: toAddress||row.to_address, service_type: serviceType||row.service_type, weight: weight||row.weight, dimensions: dimensions||row.dimensions, carrier_tracking_number: carrierTrackingNumber||row.carrier_tracking_number, description: description||row.description, updated_at: new Date().toISOString() });
  delete trackingCache[row.ge_tracking_number];
  res.json({ success: true });
});

// ── Health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', shipments: Object.keys(shipments).length, version: '5.0.0-vercel' });
});

// ── 404 for unknown API routes
app.use('/api/*', (req, res) => res.status(404).json({ error: 'Not found' }));

// Vercel serverless handler — export as plain function
module.exports = (req, res) => app(req, res);
