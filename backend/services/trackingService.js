// services/trackingService.js — Register-once + Webhook tracking
// -----------------------------------------------------------------------
// REARCHITECTED: this used to poll TrackingMore/17Track on a schedule
// (manual/auto toggle, then Tracking Timeframe cycles, then per-shipment
// intervals). All of that is gone. Both providers do their own continuous
// tracking once a number is registered with them — 17Track's docs are
// explicit: "Subsequent trackings will be made every 6~12 hours... " on
// THEIR side, and they PUSH updates to a webhook instead of us needing to
// ask. So the model is now:
//
//   1. registerForTracking(shipment) — called ONCE, at shipment creation
//      (every creation path: manual, Excel import, OCR/PDF, generic CSV
//      import). Identifies the real carrier and registers the tracking
//      number with whichever provider succeeds. This is the only place
//      that costs an API call per shipment.
//   2. routes/webhooks.js receives push notifications from TrackingMore/
//      17Track whenever a shipment's status changes and calls
//      processWebhookUpdate() here to store it. No polling, no cycles,
//      no per-shipment interval — the providers tell us when something
//      changes.
//   3. getStoredTracking() — unchanged in spirit: still the ONLY thing a
//      user-facing request reads from (public tracker, internal shipment
//      view). Still never calls a provider live.
//   4. manualRefresh() — a one-off, admin-triggered "check right now"
//      (GET results / gettrackinfo), for when someone wants to force a
//      look without waiting for the next webhook push. Not scheduled,
//      not automatic — purely on-demand.
'use strict';

const axios  = require('axios');
const db     = require('../utils/db');
const logger = require('../utils/logger');
const crypto = require('crypto');
const { logApiCall } = require('./apiHealth');
const { logAudit }   = require('../utils/audit');

const TM_BASE  = 'https://api.trackingmore.com/v3/trackings';
const T17_BASE = 'https://api.17track.net/track/v2.4';

// ── Known carrier name -> TrackingMore courier_code, for the rare case an
// admin sets `carrier` manually without going through detection. Otherwise
// registerForTracking() asks TrackingMore's own /detect endpoint. ───────────
const TRACKINGMORE_SLUGS = {
  'UPS': 'ups', 'FedEx': 'fedex', 'DHL': 'dhl-express', 'Aramex': 'aramex',
  'TNT': 'tnt', 'DPD': 'dpd', 'GLS': 'gls', 'USPS': 'usps',
  'Canada Post': 'canada-post', 'Royal Mail': 'royal-mail', 'Australia Post': 'australia-post',
  'Singapore Post': 'singapore-post', 'EMS': 'china-ems', 'Yanwen': 'yanwen', 'SF Express': 'sf-express',
  'China Post': 'china-post', 'Blue Dart': 'bluedart', 'Delhivery': 'delhivery', 'DTDC': 'dtdc',
  'Professional Couriers': 'professional-couriers', 'Xpressbees': 'xpressbees', 'Ecom Express': 'ecom-express',
  'India Post': 'india-post', 'Shadowfax': 'shadowfax', 'Trackon': 'trackon-courier', 'Ekart': 'ekart',
  'Gati': 'gati', 'TCI Express': 'tci-express', 'Safexpress': 'safexpress',
};

// ── 17Track numeric carrier code -> friendly name (the ones named in their
// own docs — there's no single lookup endpoint for the full list). ─────────
const SEVENTEENTRACK_CARRIER_NAMES = {
  100002: 'UPS', 100003: 'FedEx', 7041: 'DHL', 100009: 'Aramex', 21051: 'USPS',
  11069: 'Blue Dart', 19318: 'Delhivery', 11020: 'DTDC', 11013: 'India Post',
  3011: 'China Post', 3014: 'SF Express',
};
const SEVENTEENTRACK_CODES_BY_NAME = Object.fromEntries(
  Object.entries(SEVENTEENTRACK_CARRIER_NAMES).map(([code, name]) => [name, Number(code)])
);

// ── TrackingMore delivery_status enum (exact strings, per "Delivery Status" doc table) ──
const TRACKINGMORE_STATUS_MAP = {
  pending: 'Information Received', notfound: 'Information Received', transit: 'In Transit',
  pickup: 'Out for Delivery', delivered: 'Delivered', expired: 'Exception',
  undelivered: 'Exception', exception: 'Exception', InfoReceived: 'Information Received',
};
// ── 17Track Main Status enum (exact strings — see "Basic Concept and Definition" doc table) ──
// Exact-match lookup deliberately — an earlier version used
// `status.includes('DELIVER')`, which silently misfired for "OutForDelivery"
// and "DeliveryFailure" (both contain the substring "DELIVER").
const SEVENTEENTRACK_STATUS_MAP = {
  NotFound: 'Information Received', InfoReceived: 'Information Received', InTransit: 'In Transit',
  Expired: 'Exception', AvailableForPickup: 'Out for Delivery', OutForDelivery: 'Out for Delivery',
  DeliveryFailure: 'Exception', Delivered: 'Delivered', Exception: 'Exception',
};

function mapTrackingMoreStatus(raw) {
  if (!raw) return 'Information Received';
  const mapped = TRACKINGMORE_STATUS_MAP[raw];
  if (!mapped) logger.warn(`[TrackingMore] unmapped delivery_status "${raw}"`);
  return mapped || String(raw);
}
function map17TrackStatus(raw) {
  if (!raw) return 'Information Received';
  const mapped = SEVENTEENTRACK_STATUS_MAP[raw];
  if (!mapped) logger.warn(`[17Track] unmapped status "${raw}"`);
  return mapped || String(raw);
}

/**
 * User-facing tracking read. Backend-only — never calls TrackingMore/17Track.
 * Returns the shipment's last known status plus its tracking_events history,
 * exactly as populated by the most recent webhook push (or manual refresh).
 */
async function getStoredTracking(geNumber) {
  const shipment = await db.get('SELECT * FROM shipments WHERE ge_tracking_number = ?', [geNumber]);
  if (!shipment) {
    return { success: false, error: 'Tracking number not found in our system.', hint: 'GE numbers look like GE2847391' };
  }

  const events = await db.all(`
    SELECT event_timestamp AS timestamp, status, location
    FROM tracking_events WHERE ge_tracking_number = ? ORDER BY event_timestamp DESC, id DESC
  `, [geNumber]);

  if (!events.length) {
    return {
      success: true,
      shipment: sanitizeShipment(shipment),
      trackingData: {
        isValid: false,
        currentStatus: shipment.tracking_status || 'Information Received',
        events: [{
          timestamp: shipment.created_at,
          status: shipment.tracking_status || (shipment.tracking_registered
            ? 'Registered for tracking. Live updates will appear here as soon as the carrier reports one.'
            : 'Shipment booked. Tracking will begin once it is registered with a tracking provider.'),
          location: '',
        }],
        fetchedAt: shipment.last_tracking_update || new Date().toISOString(),
        source: 'backend',
      },
    };
  }

  return {
    success: true,
    shipment: sanitizeShipment(shipment),
    trackingData: {
      isValid: true,
      currentStatus: shipment.tracking_status || events[0].status,
      events,
      fetchedAt: shipment.last_tracking_update || new Date().toISOString(),
      source: 'backend',
    },
  };
}

/** Best-effort guess from the tracking number's own shape, used only as a
 *  last resort when neither provider's own detection can identify a
 *  carrier — several couriers have a distinctive enough format that a
 *  blind auto-detect sometimes still fails on (17Track's docs admit this:
 *  "auto_detection... does not always guarantee an accurate result"). This
 *  is a heuristic, not authoritative — it's tried last, after TrackingMore's
 *  actual detector. */
function guessCarrierFromFormat(trackingNumber) {
  const t = String(trackingNumber).trim().toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS';
  if (/^\d{10}$/.test(t)) return 'DHL';
  if (/^\d{12}$/.test(t) || /^\d{15}$/.test(t) || /^\d{20}$/.test(t)) return 'FedEx';
  if (/^(94|93|92|82)\d{20,22}$/.test(t)) return 'USPS';
  return null;
}

/**
 * Identifies the real carrier for a tracking number, independent of which
 * provider ends up doing the actual registration. Tries, in order: a
 * carrier already on file, TrackingMore's dedicated /detect endpoint (the
 * most reliable — it's built specifically for this), then a format-based
 * guess as a last resort. Whatever this returns gets passed explicitly into
 * BOTH providers' registration calls, instead of letting each one guess
 * independently — this is what fixes cases where 17Track's blind
 * auto-detect rejects a number outright but the format is in fact
 * recognizable (e.g. plain 12-digit FedEx numbers).
 */
async function identifyCarrier(trackingNumber, knownCarrierName) {
  if (knownCarrierName) return { carrierName: knownCarrierName, source: 'existing' };

  if (process.env.TRACKINGMORE_API_KEY) {
    try {
      const resp = await axios.post(`${TM_BASE}/detect`, { tracking_number: trackingNumber }, {
        headers: { 'Tracking-Api-Key': process.env.TRACKINGMORE_API_KEY, 'Content-Type': 'application/json' },
        timeout: 8000, validateStatus: () => true,
      });
      if (resp.data?.code === 200 && resp.data?.data?.courier_name) {
        return { carrierName: resp.data.data.courier_name, courierCode: resp.data.data.courier_code, source: 'trackingmore_detect' };
      }
    } catch (err) {
      logger.warn('[CarrierDetect] TrackingMore /detect failed', { trackingNumber, error: err.message });
    }
  }

  const guessed = guessCarrierFromFormat(trackingNumber);
  if (guessed) return { carrierName: guessed, source: 'format_guess' };

  return { carrierName: null, source: 'none' };
}

/**
 * Registers a shipment's tracking number with a provider ONE TIME. This is
 * the only per-shipment cost in the whole system now — call it right after
 * creating a shipment (every creation path does this: manual entry, Excel
 * import, OCR/PDF upload, generic CSV import), never on a schedule.
 * After this succeeds, the provider tracks the shipment on its own and
 * pushes updates to routes/webhooks.js — we just wait.
 */
async function registerForTracking(shipmentId) {
  const shipment = await db.get('SELECT * FROM shipments WHERE id = ?', [shipmentId]);
  if (!shipment) return { success: false, error: 'Shipment not found' };

  const ctn = shipment.carrier_tracking_number || shipment.awb_number;
  if (!ctn) return { success: false, error: 'No carrier tracking number on file for this shipment.' };

  const identified = await identifyCarrier(ctn, shipment.carrier);
  const errors = [];

  // ── Try TrackingMore first ────────────────────────────────────────────────
  if (process.env.TRACKINGMORE_API_KEY) {
    const start = Date.now();
    try {
      const result = await registerWithTrackingMore(ctn, identified.carrierName, identified.courierCode);
      logApiCall({ provider: 'trackingmore', endpoint: 'register', success: !!result.success, responseMs: Date.now() - start });
      if (result.success) {
        await persistRegistration(shipment, result.carrierName, result.courierCode, 'trackingmore');
        return { success: true, provider: 'trackingmore', carrierName: result.carrierName };
      }
      errors.push(`TrackingMore: ${result.error}`);
    } catch (err) {
      logApiCall({ provider: 'trackingmore', endpoint: 'register', success: false, responseMs: Date.now() - start, error: err.message });
      errors.push(`TrackingMore: ${err.message}`);
    }
  } else {
    errors.push('TrackingMore: not configured (TRACKINGMORE_API_KEY missing)');
  }

  // ── Fall back to 17Track ───────────────────────────────────────────────────
  if (process.env.SEVENTEENTRACK_API_KEY) {
    const start = Date.now();
    try {
      const result = await registerWith17Track(ctn, identified.carrierName);
      logApiCall({ provider: '17track', endpoint: 'register', success: !!result.success, responseMs: Date.now() - start });
      if (result.success) {
        await persistRegistration(shipment, result.carrierName, result.courierCode, '17track');
        return { success: true, provider: '17track', carrierName: result.carrierName };
      }
      errors.push(`17Track: ${result.error}`);
    } catch (err) {
      logApiCall({ provider: '17track', endpoint: 'register', success: false, responseMs: Date.now() - start, error: err.message });
      errors.push(`17Track: ${err.message}`);
    }
  } else {
    errors.push('17Track: not configured (SEVENTEENTRACK_API_KEY missing)');
  }

  // ── Both failed / unconfigured → Manual Tracking Queue ────────────────────
  const errorSummary = errors.join(' · ');
  const wasAlreadyFlagged = !!shipment.needs_manual_tracking;
  await db.run('UPDATE shipments SET needs_manual_tracking = 1, registration_error = ? WHERE id = ?', [errorSummary, shipment.id]);
  if (!wasAlreadyFlagged) {
    logAudit(null, { action: 'TRACKING_REGISTER', entity: 'shipments', entityId: shipment.id, status: 'failure',
      details: `${shipment.ge_tracking_number}: ${errorSummary}`, actor: { username: 'system' } });
  }
  return { success: false, error: errorSummary || 'Could not register with any tracking provider.' };
}

async function persistRegistration(shipment, carrierName, courierCode, provider) {
  await db.run(`
    UPDATE shipments SET
      carrier = COALESCE(carrier, ?),
      carrier_code = ?, carrier_code_provider = ?,
      tracking_registered = 1, tracking_registered_at = datetime('now'),
      needs_manual_tracking = 0, registration_error = NULL
    WHERE id = ?
  `, [carrierName || null, courierCode != null ? String(courierCode) : null, provider, shipment.id]);
}

async function registerWithTrackingMore(trackingNumber, carrierName, knownCourierCode) {
  const headers = { 'Tracking-Api-Key': process.env.TRACKINGMORE_API_KEY, 'Content-Type': 'application/json' };
  const opts = { headers, timeout: 10000, validateStatus: () => true };

  let courierCode = knownCourierCode || TRACKINGMORE_SLUGS[carrierName] || null;
  let carrierNameOut = carrierName || null;
  if (!courierCode) {
    const detectResp = await axios.post(`${TM_BASE}/detect`, { tracking_number: trackingNumber }, opts);
    if (detectResp.data?.code === 200) {
      courierCode = detectResp.data?.data?.courier_code || null;
      carrierNameOut = detectResp.data?.data?.courier_name || carrierNameOut;
    } else if (detectResp.data?.code && detectResp.data.code !== 204) {
      return { success: false, error: `detect failed (code ${detectResp.data.code}: ${detectResp.data.message})` };
    }
  }
  if (!courierCode) return { success: false, error: 'carrier could not be identified' };

  const createResp = await axios.post(`${TM_BASE}/create`,
    [{ tracking_number: trackingNumber, courier_code: courierCode }], opts);
  // 200 = registered now; 423 = already registered — both mean we're good.
  if (createResp.data?.code !== 200 && createResp.data?.code !== 423) {
    return { success: false, error: `create failed (code ${createResp.data?.code}: ${createResp.data?.message})` };
  }
  return { success: true, carrierName: carrierNameOut, courierCode };
}

async function registerWith17Track(trackingNumber, carrierName) {
  const headers = { '17token': process.env.SEVENTEENTRACK_API_KEY, 'Content-Type': 'application/json' };
  const opts = { headers, timeout: 10000, validateStatus: () => true };

  // Pass an explicit carrier code whenever we have any identified name (from
  // TrackingMore's detector, a format guess, or one already on file) — per
  // 17Track's own docs, omitting/mismatching the carrier makes them fall
  // back to a guess that can outright reject well-formed numbers.
  const knownCode = carrierName ? SEVENTEENTRACK_CODES_BY_NAME[carrierName] : null;
  const body = knownCode ? [{ number: trackingNumber, carrier: knownCode }] : [{ number: trackingNumber }];

  const resp = await axios.post(`${T17_BASE}/register`, body, opts);
  const accepted = resp.data?.data?.accepted?.[0];
  const rejected = resp.data?.data?.rejected?.[0];

  if (accepted?.carrier) {
    const name = SEVENTEENTRACK_CARRIER_NAMES[accepted.carrier] || carrierName || `17Track Carrier #${accepted.carrier}`;
    return { success: true, carrierName: name, courierCode: accepted.carrier };
  }
  // -18019901 = "already registered" — treat as success if we at least know the carrier already.
  if (rejected?.error?.code === -18019901 && knownCode) {
    return { success: true, carrierName, courierCode: knownCode };
  }
  return { success: false, error: rejected?.error?.message || 'registration rejected' };
}

/**
 * On-demand, admin-triggered "check right now" — the ONLY other place
 * besides registerForTracking() that calls a provider live. Not scheduled,
 * not automatic. Uses whichever provider this shipment is registered with.
 */
async function manualRefresh(geNumber) {
  const shipment = await db.get('SELECT * FROM shipments WHERE ge_tracking_number = ?', [geNumber]);
  if (!shipment) return { success: false, error: 'Tracking number not found in our system.' };
  const ctn = shipment.carrier_tracking_number || shipment.awb_number;
  if (!ctn) return { success: false, error: 'No carrier tracking number on file for this shipment.' };

  if (!shipment.tracking_registered) {
    const reg = await registerForTracking(shipment.id);
    if (!reg.success) return reg;
  }

  const refreshed = await db.get('SELECT carrier_code_provider FROM shipments WHERE id = ?', [shipment.id]);
  const provider = shipment.carrier_code_provider || refreshed?.carrier_code_provider;
  const start = Date.now();
  try {
    let normalized = null;
    if (provider === '17track' && process.env.SEVENTEENTRACK_API_KEY) {
      const headers = { '17token': process.env.SEVENTEENTRACK_API_KEY, 'Content-Type': 'application/json' };
      const resp = await axios.post(`${T17_BASE}/gettrackinfo`, [{ number: ctn }], { headers, timeout: 10000, validateStatus: () => true });
      const item = resp.data?.data?.accepted?.[0];
      const events = (item?.track_info?.tracking?.providers?.[0]?.events || []).map(e => ({ timestamp: e.time_iso, status: e.description, location: e.location || '' }));
      if (events.length) normalized = { currentStatus: map17TrackStatus(item.track_info?.latest_status?.status), events: events.reverse() };
    } else if (process.env.TRACKINGMORE_API_KEY) {
      const headers = { 'Tracking-Api-Key': process.env.TRACKINGMORE_API_KEY };
      const resp = await axios.get(`${TM_BASE}/get`, { headers, params: { tracking_numbers: ctn }, timeout: 10000, validateStatus: () => true });
      const data = resp.data?.data?.[0];
      const events = (data?.origin_info?.trackinfo || []).map(e => ({ timestamp: e.checkpoint_date, status: e.tracking_detail, location: e.location || '' }));
      if (data) normalized = { currentStatus: mapTrackingMoreStatus(data.delivery_status), events: events.reverse() };
    }

    logApiCall({ provider: provider || 'unknown', endpoint: 'manual_refresh', success: !!normalized, responseMs: Date.now() - start });
    if (!normalized) return { success: false, error: 'No tracking data available yet from the provider.' };

    await recordTrackingEvents(shipment, normalized, provider || 'unknown');
    return { success: true, provider, currentStatus: normalized.currentStatus };
  } catch (err) {
    logApiCall({ provider: provider || 'unknown', endpoint: 'manual_refresh', success: false, responseMs: Date.now() - start, error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Called by routes/webhooks.js whenever TrackingMore/17Track pushes an
 * update. This — not any polling loop — is how tracking_status and
 * tracking_events actually get kept current from now on.
 */
async function processWebhookUpdate({ provider, trackingNumber, currentStatus, events }) {
  const shipment = await db.get(`
    SELECT * FROM shipments WHERE carrier_tracking_number = ? OR awb_number = ? ORDER BY id DESC LIMIT 1
  `, [trackingNumber, trackingNumber]);
  if (!shipment) {
    logger.warn(`[Webhook:${provider}] update for unknown tracking number`, { trackingNumber });
    return { success: false, error: 'No matching shipment' };
  }
  await recordTrackingEvents(shipment, { currentStatus, events }, provider);
  await db.run('UPDATE shipments SET needs_manual_tracking = 0 WHERE id = ?', [shipment.id]);
  return { success: true, shipmentId: shipment.id, ge_tracking_number: shipment.ge_tracking_number };
}

async function recordTrackingEvents(shipment, normalized, provider) {
  // OR IGNORE relies on the unique index on (ge_tracking_number,
  // event_timestamp, status, location) — see utils/initDb.js. Webhooks (and
  // the manual "Sync Pending Now" refresh) tend to resend a shipment's whole
  // event history on every call rather than just what's new, so without this
  // the same ~10 real events turn into hundreds of duplicate rows over time.
  const INSERT_SQL = `
    INSERT OR IGNORE INTO tracking_events (shipment_id, ge_tracking_number, event_timestamp, status, location, provider, raw)
    VALUES (?,?,?,?,?,?,?)
  `;
  for (const ev of (normalized.events || []).slice(0, 20)) {
    await db.run(INSERT_SQL, [shipment.id, shipment.ge_tracking_number, ev.timestamp || null, ev.status || null, ev.location || null, provider, JSON.stringify(ev)]);
  }

  const newStatus = normalized.currentStatus || null;
  const statusChanged = newStatus && newStatus !== shipment.tracking_status;

  // The shipment's own workflow `status` field (Processing/Picked Up/In
  // Transit/Out for Delivery/Delivered/Exception/Returned — see
  // ShipmentsPage.jsx STATUSES) uses almost the same vocabulary as
  // tracking_status, so a tracking update should move it forward too rather
  // than leaving it stuck on whatever it was set to at creation (usually
  // "Processing"). "Information Received" doesn't have its own bucket in
  // that list, so it maps to "Processing". Never moves status BACKWARDS
  // (e.g. a stale "In Transit" webhook arriving after admin already marked
  // it "Returned" shouldn't undo that).
  const STATUS_RANK = { 'Processing': 0, 'Picked Up': 1, 'In Transit': 2, 'Out for Delivery': 3, 'Delivered': 4, 'Exception': 4, 'Returned': 4 };
  const mappedStatus = newStatus === 'Information Received' ? 'Processing' : newStatus;
  const newRank = STATUS_RANK[mappedStatus];
  const curRank = STATUS_RANK[shipment.status] ?? 0;
  const shouldAdvanceStatus = mappedStatus && newRank !== undefined && newRank >= curRank;

  await db.run(`
    UPDATE shipments SET
      tracking_status = ?,
      status = CASE WHEN ? THEN ? ELSE status END,
      last_tracking_update = datetime('now'),
      last_status_change_at = CASE WHEN ? THEN datetime('now') ELSE last_status_change_at END,
      delivered_at = CASE WHEN ? = 'Delivered' AND delivered_at IS NULL THEN datetime('now') ELSE delivered_at END
    WHERE id = ?
  `, [newStatus, shouldAdvanceStatus ? 1 : 0, mappedStatus, statusChanged ? 1 : 0, newStatus, shipment.id]);
}

/**
 * Verifies a TrackingMore webhook signature: SHA256 hex of the raw JSON
 * payload + '/' + your TrackingMore API key, compared against the
 * `verify.signature` field TrackingMore includes in the push. Per their
 * docs' worked example: SHA256(`${rawBody}/${apiKey}`).
 */
function verifyTrackingMoreSignature(rawBody, signature) {
  const key = process.env.TRACKINGMORE_API_KEY;
  if (!key || !signature) return true; // can't verify — accept, but see routes/webhooks.js logging
  const expected = crypto.createHash('sha256').update(`${rawBody}/${key}`).digest('hex');
  return expected === signature;
}

/** Removes sensitive carrier info before returning to the public-facing tracker. */
function sanitizeShipment(shipment) {
  const { carrier_tracking_number, ocr_raw_text, awb_number, ...safe } = shipment;
  safe.carrier_display = 'Garuda Express';
  safe.carrier = undefined; // never reveal the real carrier publicly
  return safe;
}

module.exports = {
  getStoredTracking,
  registerForTracking,
  manualRefresh,
  processWebhookUpdate,
  verifyTrackingMoreSignature,
  mapTrackingMoreStatus,
  map17TrackStatus,
  TRACKINGMORE_SLUGS,
  SEVENTEENTRACK_CARRIER_NAMES,
};