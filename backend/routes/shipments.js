// routes/shipments.js — Shipment CRUD, AWB Extraction (OCR), waybill generation
// Implements requirement spec §6 (data model), §7 (AWB extraction incl. ZIP),
// and employee scoping from §1/§8 (employees see/edit only their own records).
'use strict';

const express  = require('express');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const db       = require('../utils/db');
const { requireAuth, requireAdmin, requirePermission } = require('../middleware/auth');
const { extractWaybillData, extractWaybillDataBatch } = require('../services/ocrService');
const { generateWaybill, buildWaybillFilename } = require('../services/waybillService');
const { generateGENumber }          = require('../utils/generateGE');
const { logAudit } = require('../utils/audit');
const { importExcelShipments } = require('../services/excelImport');
const { registerForTracking, manualRefresh } = require('../services/trackingService');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Excel Upload (ICL / World First) — dedicated upload dir + filter ─────────
// Kept entirely separate from the OCR `upload` instance below (different
// allowed extensions, different destination folder) per the requirement
// doc's "dedicated Excel import module" guidance.
const EXCEL_UPLOAD_DIR = path.join(UPLOAD_DIR, 'excelImport');
if (!fs.existsSync(EXCEL_UPLOAD_DIR)) fs.mkdirSync(EXCEL_UPLOAD_DIR, { recursive: true });

const excelUpload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, EXCEL_UPLOAD_DIR),
    filename: (_, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ['.xlsx', '.xls'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  },
});

/** Normalizes the incoming `vendor` form field to the canonical vendor name. */
function resolveVendor(raw) {
  const v = String(raw || '').trim().toLowerCase().replace(/\s+/g, '');
  if (v === 'icl') return 'ICL';
  if (v === 'worldfirst' || v === 'wf') return 'World First';
  return null;
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename:    (_, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ['.png', '.jpg', '.jpeg', '.tiff', '.pdf', '.webp', '.zip'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  }
});

router.use(requireAuth);

/** True if `userId` belongs to a user with role 'admin'. Used so employees can
 *  see shipments admins created (bulk/Excel imports, manual entries, etc.) —
 *  not just their own — without opening visibility to other employees' work. */
async function isCreatedByAdmin(createdBy) {
  if (createdBy == null) return false;
  const creator = await db.get('SELECT role FROM users WHERE id = ?', [createdBy]);
  return creator?.role === 'admin';
}

/** Returns true if the shipment belongs to req.user, was created by an admin, or req.user is admin. */
async function canAccess(req, shipment) {
  if (req.user.role === 'admin') return true;
  if (shipment.created_by === req.user.id) return true;
  return isCreatedByAdmin(shipment.created_by);
}

// ── GET /api/shipments ────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const { q, status, carrier, date_from, date_to, page = 1, limit = 25, sort = 'created_at', order = 'desc' } = req.query;
  const conditions = [], params = [];

  // Employee scoping (spec §1 RBAC): employees see their own shipments PLUS
  // any shipment created by an admin (e.g. Excel/bulk imports, manually
  // entered shipments) — just not other employees' own uploads.
  if (req.user.role !== 'admin') {
    conditions.push(`(created_by = ? OR created_by IN (SELECT id FROM users WHERE role = 'admin'))`);
    params.push(req.user.id);
  }

  if (q) {
    conditions.push(`(ge_tracking_number LIKE ? OR carrier_tracking_number LIKE ? OR awb_number LIKE ? OR from_name LIKE ? OR to_name LIKE ? OR from_contact LIKE ? OR to_contact LIKE ? OR contents LIKE ? OR invoice_number LIKE ? OR reference_number LIKE ? OR sender_company LIKE ? OR receiver_company LIKE ? OR route_code LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like);
  }
  if (status)    { conditions.push('status = ?');     params.push(status); }
  if (carrier)   { conditions.push('carrier = ?');    params.push(carrier); }
  if (date_from) { conditions.push('ship_date >= ?'); params.push(date_from); }
  if (date_to)   { conditions.push('ship_date <= ?'); params.push(date_to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const safeSort  = ['created_at', 'ship_date', 'booking_date', 'ge_tracking_number', 'to_name', 'status', 'tracking_status'].includes(sort) ? sort : 'created_at';
  const safeOrder = order === 'asc' ? 'ASC' : 'DESC';

  const totalRow = await db.get(`SELECT COUNT(*) as c FROM shipments ${where}`, params);
  const rows  = await db.all(`
    SELECT id, ge_tracking_number, carrier, carrier_tracking_number, awb_number, reference_number,
           from_name, from_city, from_country, to_name, to_city, to_country,
           sender_company, receiver_company, receiver_attention,
           origin_code, destination_code, route_code, billing_type,
           pieces, billing_weight, actual_weight, contents, ship_date, booking_date, pickup_date,
           shipment_type, status, tracking_status, needs_manual_tracking, invoice_number,
           customs_value, carriage_value,
           garuda_waybill_generated, created_by, created_at, updated_at
    FROM shipments ${where}
    ORDER BY ${safeSort} ${safeOrder}
    LIMIT ? OFFSET ?
  `, [...params, parseInt(limit), offset]);

  res.json({ success: true, total: totalRow.c, page: parseInt(page), limit: parseInt(limit), data: rows });
});

// NOTE: there is no Manual/Auto toggle, Tracking Timeframe cycle, or
// per-shipment interval any more — see services/trackingService.js. Each
// shipment is registered with TrackingMore/17Track ONE TIME at creation
// (registerForTracking), and the provider pushes status updates to
// routes/webhooks.js from then on. auto_tracking_enabled just controls
// whether that one-time registration happens at all for a given shipment.

// ── GET /api/shipments/manual-queue — admin view of shipments needing manual tracking ──
router.get('/manual-queue', requireAdmin, async (req, res) => {
  const rows = await db.all(`
    SELECT id, ge_tracking_number, carrier, carrier_tracking_number, to_name, to_country, status, created_at
    FROM shipments WHERE needs_manual_tracking = 1 ORDER BY created_at DESC
  `);
  res.json({ success: true, data: rows });
});

// ── POST /api/shipments/tracking/sync-pending — on-demand catch-up ───────────
// Same thing services/workers.js' Tracking Catch-Up worker does automatically
// every 30 min, just triggered immediately instead of waiting — useful right
// after registering a batch, or whenever webhooks aren't reaching this server
// yet (e.g. local development, or before the webhook URL has been pasted
// into TrackingMore/17Track's dashboard — see the Settings page).
router.post('/tracking/sync-pending', requireAdmin, async (req, res) => {
  const stale = await db.all(`
    SELECT ge_tracking_number FROM shipments
    WHERE tracking_registered = 1
      AND carrier_tracking_number IS NOT NULL
      AND (tracking_status IS NULL OR tracking_status != 'Delivered')
    LIMIT 200
  `);

  let updated = 0, failed = 0;
  for (const s of stale) {
    const result = await manualRefresh(s.ge_tracking_number);
    if (result.success) updated++; else failed++;
  }

  res.json({ success: true, checked: stale.length, updated, failed });
});

// ── POST /api/shipments/:id/tracking/refresh — Register Now / Refresh Now ────
// One button, two jobs depending on shipment state: if not yet registered
// with a provider, this does that one-time registration; if it already is,
// this does an on-demand "check right now" instead of waiting for the next
// webhook push. Either way it's the ONLY user-triggerable route that
// reaches TrackingMore/17Track live — every other tracking read (public
// tracker, GET /:id here) serves whatever is already stored in the DB.
router.post('/:id/tracking/refresh', requireAdmin, async (req, res) => {
  if (isNaN(parseInt(req.params.id))) return res.status(400).json({ success: false, error: 'Invalid ID' });
  const shipment = await db.get('SELECT * FROM shipments WHERE id = ?', [req.params.id]);
  if (!shipment) return res.status(404).json({ success: false, error: 'Not found' });
  if (!shipment.ge_tracking_number) return res.status(400).json({ success: false, error: 'Shipment has no GE tracking number yet' });

  try {
    const result = await manualRefresh(shipment.ge_tracking_number);
    logAudit(req, { action: 'TRACKING_MANUAL_REFRESH', entity: 'shipments', entityId: shipment.id,
      details: `Manual refresh — ${result.success ? `synced via ${result.provider}` : result.error}`, actor: req.user,
      status: result.success ? 'success' : 'failure' });

    const updated = await db.get('SELECT * FROM shipments WHERE id = ?', [shipment.id]);
    const events = await db.all(`
      SELECT event_timestamp, status, location, provider FROM tracking_events
      WHERE shipment_id = ? ORDER BY event_timestamp DESC LIMIT 50
    `, [shipment.id]);

    res.json({ success: result.success, error: result.success ? undefined : result.error, data: updated, trackingHistory: events });
  } catch (err) {
    console.error('[TrackingRefresh]', err);
    res.status(500).json({ success: false, error: 'Tracking refresh failed: ' + err.message });
  }
});

// ── GET /api/shipments/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  if (isNaN(parseInt(req.params.id))) return res.status(400).json({ success: false, error: 'Invalid ID' });
  const row = await db.get('SELECT * FROM shipments WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ success: false, error: 'Not found' });
  if (!(await canAccess(req, row))) return res.status(403).json({ success: false, error: 'You can only view your own shipments' });

  if (req.user.role !== 'admin') { delete row.carrier_tracking_number; delete row.carrier; delete row.ocr_raw_text; }

  const events = await db.all(`
    SELECT event_timestamp, status, location, provider FROM tracking_events
    WHERE shipment_id = ? ORDER BY event_timestamp DESC LIMIT 50
  `, [row.id]);

  res.json({ success: true, data: row, trackingHistory: events });
});

// ── POST /api/shipments/upload-ocr — single file (image/PDF) ────────────────
// OCR scan only — does NOT auto-save (user reviews first in NewShipment)
router.post('/upload-ocr', upload.single('waybill'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  try {
    const { rawText, confidence, fields, engine } = await extractWaybillData(req.file.path);
    res.json({ success: true, filename: req.file.filename, confidence, engine, fields, rawText: rawText.substring(0, 3000) });
  } catch (err) {
    console.error('[OCR]', err.message);
    res.status(500).json({ success: false, error: 'OCR failed: ' + err.message });
  }
});

// ── POST /api/shipments/bulk-upload — multiple images/PDFs (legacy alias) ────
// Kept for frontend compatibility; the dedicated /api/bulk-upload routes
// (routes/bulkUpload.js) cover the full CSV/Excel/ZIP/import-queue workflow
// from requirement spec §8. This endpoint stays OCR-scan-only (no DB writes).
router.post('/bulk-upload', upload.array('waybills', 30), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ success: false, error: 'No files' });

  // One batched OCR+Gemini pass for the whole set (see services/ocrService.js
  // extractWaybillDataBatch) instead of one Gemini request per file — keeps
  // this in line with the dedicated /api/bulk-upload batch path and avoids
  // burning through Gemini's free-tier rate limit on large selections.
  let batchResults;
  try {
    batchResults = await extractWaybillDataBatch(req.files.map(f => f.path));
  } catch (err) {
    console.error('[OCR/batch]', err.message);
    batchResults = req.files.map(() => ({ error: err.message }));
  }

  const results = req.files.map((file, i) => {
    const r = batchResults[i];
    if (!r || r.error) {
      return { filename: file.filename, originalName: file.originalname, success: false, error: r?.error || 'OCR failed' };
    }
    return {
      filename: file.filename, originalName: file.originalname, success: true,
      confidence: r.confidence, engine: r.engine, fields: r.fields,
      rawText: (r.rawText || '').substring(0, 1000),
    };
  });
  res.json({ success: true, results });
});

// ── POST /api/shipments ───────────────────────────────────────────────────────
router.post('/', requirePermission('shipments.create'), async (req, res) => {
  const d = req.body;

  // ── Duplicate check ──────────────────────────────────────────────────────
  // "No duplicates allowed" — the same original carrier waybill (identified
  // by its own tracking/AWB number, independent of our internal GE number)
  // must not be entered twice. Checked against both carrier_tracking_number
  // and awb_number since either may be the one actually populated depending
  // on the source carrier/parser, and a duplicate could be re-submitted under
  // either field.
  const dupTrackingNumber = d.carrier_tracking_number || d.awb_number || null;
  if (dupTrackingNumber) {
    const dup = await db.get(`
      SELECT id, ge_tracking_number, carrier FROM shipments
      WHERE (carrier_tracking_number = ? OR awb_number = ?)
      LIMIT 1
    `, [dupTrackingNumber, dupTrackingNumber]);
    if (dup) {
      return res.status(409).json({
        success: false,
        error: `This waybill (tracking number ${dupTrackingNumber}) has already been added as ${dup.ge_tracking_number}.`,
        duplicate_of: { id: dup.id, ge_tracking_number: dup.ge_tracking_number, carrier: dup.carrier },
      });
    }
  }

  const geNum = await generateGENumber(db);
  // package_length/width/height (application-layer field names from
  // services/waybillFieldSchema.js) map onto the existing length/width/height
  // columns — see the comment in utils/initDb.js for why there's no separate set.
  const pkgLength = d.package_length ?? d.length ?? null;
  const pkgWidth  = d.package_width  ?? d.width  ?? null;
  const pkgHeight = d.package_height ?? d.height ?? null;
  const carrierSpecific = d.carrier_specific == null ? null
    : (typeof d.carrier_specific === 'string' ? d.carrier_specific : JSON.stringify(d.carrier_specific));
  const carrier = d.carrier || null; // left blank if not given — registerForTracking() below fills it in from the tracking number

  // Auto Tracking (TrackingMore / 17Track) — a shipment with a tracking
  // number gets registered with a provider ONCE, right after it's created
  // (see registerForTracking() call below); from then on the provider
  // tracks it and pushes updates to routes/webhooks.js. There is no
  // schedule/interval to configure any more.
  const autoTrackingEnabled = d.auto_tracking_enabled === undefined ? 1 : (d.auto_tracking_enabled ? 1 : 0);

  const info = await db.run(`
    INSERT INTO shipments (
      ge_tracking_number,carrier,carrier_tracking_number,awb_number,reference_number,
      from_name,from_address,from_city,from_state,from_country,from_postal,from_contact,
      to_name,to_address,to_city,to_state,to_country,to_postal,to_contact,
      sender_company,receiver_company,receiver_attention,
      origin_code,destination_code,route_code,service_code,
      pieces,actual_weight,billing_weight,weight_unit,dimensions,length,width,height,contents,
      customs_value,carriage_value,billing_type,account_number,carrier_specific,
      booking_date,pickup_date,shipment_type,
      ship_date,service_type,special_instructions,declared_value,currency,invoice_number,
      original_waybill_file,ocr_raw_text,ocr_confidence,
      auto_tracking_enabled,
      status,created_by,updated_at
    ) VALUES (
      ?,?,?,?,?,  ?,?,?,?,?,?,?,  ?,?,?,?,?,?,?,
      ?,?,?,  ?,?,?,?,
      ?,?,?,?,?,?,?,?,?,
      ?,?,?,?,?,
      ?,?,?,  ?,?,?,?,?,?,  ?,?,?,
      ?,
      ?,?,datetime('now')
    ) RETURNING id
  `, [
    geNum, carrier, d.carrier_tracking_number || null, d.awb_number || d.carrier_tracking_number || null, d.reference_number || null,
    d.from_name || null, d.from_address || null, d.from_city || null, d.from_state || null, d.from_country || null, d.from_postal || null, d.from_contact || null,
    d.to_name || null, d.to_address || null, d.to_city || null, d.to_state || null, d.to_country || null, d.to_postal || null, d.to_contact || null,
    d.sender_company || null, d.receiver_company || null, d.receiver_attention || null,
    d.origin_code || null, d.destination_code || null, d.route_code || null, d.service_code || null,
    d.pieces || 1, d.actual_weight || null, d.billing_weight || null, d.weight_unit || 'kg', d.dimensions || null, pkgLength, pkgWidth, pkgHeight, d.contents || null,
    d.customs_value || null, d.carriage_value || null, d.billing_type || null, d.account_number || null, carrierSpecific,
    d.booking_date || null, d.pickup_date || null, d.shipment_type || null,
    d.ship_date || null, d.service_type || null, d.special_instructions || null, d.declared_value || null, d.currency || 'INR', d.invoice_number || null,
    d.original_waybill_file || null, d.ocr_raw_text || null, d.ocr_confidence || null,
    autoTrackingEnabled,
    d.status || 'Processing', req.user.id
  ]);

  if (autoTrackingEnabled && (d.carrier_tracking_number || d.awb_number)) {
    registerForTracking(info.lastInsertRowid).catch(err => console.warn('[Shipments] tracking registration failed:', err.message));
  }

  logAudit(req, { action: 'SHIPMENT_CREATE', entity: 'shipments', entityId: info.lastInsertRowid, newValue: { ge: geNum }, actor: req.user });
  const created = await db.get('SELECT * FROM shipments WHERE id = ?', [info.lastInsertRowid]);
  res.status(201).json({ success: true, data: created });
});

// ── PUT /api/shipments/:id ────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  if (isNaN(parseInt(req.params.id))) return res.status(400).json({ success: false, error: 'Invalid ID' });
  const d = req.body, id = req.params.id;
  const existing = await db.get('SELECT * FROM shipments WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
  if (!(await canAccess(req, existing))) return res.status(403).json({ success: false, error: 'You can only edit your own shipments' });

  // Same duplicate guard as creation, but excluding this record itself so a
  // no-op save (or editing unrelated fields) doesn't trip on its own number.
  const dupTrackingNumber = d.carrier_tracking_number || d.awb_number || null;
  if (dupTrackingNumber) {
    const dup = await db.get(`
      SELECT id, ge_tracking_number, carrier FROM shipments
      WHERE (carrier_tracking_number = ? OR awb_number = ?) AND id != ?
      LIMIT 1
    `, [dupTrackingNumber, dupTrackingNumber, id]);
    if (dup) {
      return res.status(409).json({
        success: false,
        error: `This waybill (tracking number ${dupTrackingNumber}) already belongs to ${dup.ge_tracking_number}.`,
        duplicate_of: { id: dup.id, ge_tracking_number: dup.ge_tracking_number, carrier: dup.carrier },
      });
    }
  }

  const pkgLength = d.package_length ?? d.length ?? null;
  const pkgWidth  = d.package_width  ?? d.width  ?? null;
  const pkgHeight = d.package_height ?? d.height ?? null;
  const carrierSpecific = d.carrier_specific == null ? null
    : (typeof d.carrier_specific === 'string' ? d.carrier_specific : JSON.stringify(d.carrier_specific));

  // Auto Tracking — editable per shipment (turn it on/off without affecting
  // any others). `undefined` means "not part of this request" so COALESCE
  // leaves it untouched; an explicit true/false overrides it. There's no
  // interval/schedule to set any more — see services/trackingService.js.
  const autoTrackingEnabled = d.auto_tracking_enabled === undefined ? null : (d.auto_tracking_enabled ? 1 : 0);

  await db.run(`
    UPDATE shipments SET
      carrier=COALESCE(?,carrier), carrier_tracking_number=COALESCE(?,carrier_tracking_number),
      awb_number=COALESCE(?,awb_number), reference_number=COALESCE(?,reference_number),
      from_name=COALESCE(?,from_name), from_address=COALESCE(?,from_address),
      from_city=COALESCE(?,from_city), from_state=COALESCE(?,from_state),
      from_country=COALESCE(?,from_country), from_postal=COALESCE(?,from_postal), from_contact=COALESCE(?,from_contact),
      to_name=COALESCE(?,to_name), to_address=COALESCE(?,to_address),
      to_city=COALESCE(?,to_city), to_state=COALESCE(?,to_state),
      to_country=COALESCE(?,to_country), to_postal=COALESCE(?,to_postal), to_contact=COALESCE(?,to_contact),
      sender_company=COALESCE(?,sender_company), receiver_company=COALESCE(?,receiver_company),
      receiver_attention=COALESCE(?,receiver_attention),
      origin_code=COALESCE(?,origin_code), destination_code=COALESCE(?,destination_code),
      route_code=COALESCE(?,route_code), service_code=COALESCE(?,service_code),
      pieces=COALESCE(?,pieces), actual_weight=COALESCE(?,actual_weight), billing_weight=COALESCE(?,billing_weight),
      dimensions=COALESCE(?,dimensions), length=COALESCE(?,length), width=COALESCE(?,width), height=COALESCE(?,height),
      customs_value=COALESCE(?,customs_value), carriage_value=COALESCE(?,carriage_value),
      billing_type=COALESCE(?,billing_type), account_number=COALESCE(?,account_number),
      carrier_specific=COALESCE(?,carrier_specific),
      contents=COALESCE(?,contents), ship_date=COALESCE(?,ship_date),
      booking_date=COALESCE(?,booking_date), pickup_date=COALESCE(?,pickup_date), shipment_type=COALESCE(?,shipment_type),
      service_type=COALESCE(?,service_type), special_instructions=COALESCE(?,special_instructions),
      declared_value=COALESCE(?,declared_value), currency=COALESCE(?,currency),
      invoice_number=COALESCE(?,invoice_number), status=COALESCE(?,status),
      auto_tracking_enabled=COALESCE(?,auto_tracking_enabled),
      updated_by=?, updated_at=datetime('now')
    WHERE id=?
  `, [
    d.carrier ?? null, d.carrier_tracking_number ?? null, d.awb_number ?? null, d.reference_number ?? null,
    d.from_name ?? null, d.from_address ?? null, d.from_city ?? null, d.from_state ?? null,
    d.from_country ?? null, d.from_postal ?? null, d.from_contact ?? null,
    d.to_name ?? null, d.to_address ?? null, d.to_city ?? null, d.to_state ?? null,
    d.to_country ?? null, d.to_postal ?? null, d.to_contact ?? null,
    d.sender_company ?? null, d.receiver_company ?? null,
    d.receiver_attention ?? null,
    d.origin_code ?? null, d.destination_code ?? null,
    d.route_code ?? null, d.service_code ?? null,
    d.pieces ?? null, d.actual_weight ?? null, d.billing_weight ?? null,
    d.dimensions ?? null, pkgLength, pkgWidth, pkgHeight,
    d.customs_value ?? null, d.carriage_value ?? null,
    d.billing_type ?? null, d.account_number ?? null,
    carrierSpecific,
    d.contents ?? null, d.ship_date ?? null,
    d.booking_date ?? null, d.pickup_date ?? null, d.shipment_type ?? null,
    d.service_type ?? null, d.special_instructions ?? null,
    d.declared_value ?? null, d.currency ?? null, d.invoice_number ?? null, d.status ?? null,
    autoTrackingEnabled,
    req.user.id, id
  ]);

  // If a tracking number was just added/changed and this shipment isn't
  // registered with a provider yet, register it now — still a one-time
  // action, not a recurring poll.
  const updated = await db.get('SELECT * FROM shipments WHERE id = ?', [id]);
  if (updated.auto_tracking_enabled && !updated.tracking_registered && (updated.carrier_tracking_number || updated.awb_number)) {
    registerForTracking(updated.id).catch(err => console.warn('[Shipments] tracking registration failed:', err.message));
  }

  logAudit(req, { action: 'SHIPMENT_UPDATE', entity: 'shipments', entityId: id, oldValue: { status: existing.status }, newValue: { status: d.status }, actor: req.user });
  res.json({ success: true, data: await db.get('SELECT * FROM shipments WHERE id = ?', [id]) });
});

// ── DELETE /api/shipments/:id ─────────────────────────────────────────────────
// Admin-only per spec §8 (employees have "No Delete" permission on uploaded data).
router.delete('/:id', requireAdmin, async (req, res) => {
  if (isNaN(parseInt(req.params.id))) return res.status(400).json({ success: false, error: 'Invalid ID' });
  const row = await db.get('SELECT * FROM shipments WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ success: false, error: 'Not found' });
  if (row.original_waybill_file) {
    const fp = path.join(UPLOAD_DIR, row.original_waybill_file);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  await db.run('DELETE FROM tracking_cache WHERE ge_tracking_number = ?', [row.ge_tracking_number]);
  await db.run('DELETE FROM tracking_events WHERE shipment_id = ?', [req.params.id]);
  await db.run('DELETE FROM shipments WHERE id = ?', [req.params.id]);
  logAudit(req, { action: 'SHIPMENT_DELETE', entity: 'shipments', entityId: req.params.id, details: `GE: ${row.ge_tracking_number}`, actor: req.user });
  res.json({ success: true, message: 'Deleted' });
});

// ── POST /api/shipments/:id/reprocess ─────────────────────────────────────────
// Re-runs OCR/field-parsing on the ORIGINAL uploaded file and overwrites the
// extraction-derived fields with the fresh result. Added so existing records
// parsed before an accuracy fix (to the OCR pipeline or carrier regex parsers)
// can be corrected in place, instead of requiring the file to be re-uploaded
// from scratch — the original file is already retained on disk
// (original_waybill_file) precisely so this is possible.
// Deliberately does NOT touch operational fields the user may have set by
// hand (status, special_instructions, ship_date, currency, account_number,
// etc.) — only the columns OCR itself produces, matching the same set the
// /upload-ocr -> NewShipment review flow populates on first create.
router.post('/:id/reprocess', requirePermission('shipments.create'), async (req, res) => {
  if (isNaN(parseInt(req.params.id))) return res.status(400).json({ success: false, error: 'Invalid ID' });
  const id = req.params.id;
  const existing = await db.get('SELECT * FROM shipments WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ success: false, error: 'Not found' });
  if (!(await canAccess(req, existing))) return res.status(403).json({ success: false, error: 'You can only reprocess your own shipments' });
  if (!existing.original_waybill_file) {
    return res.status(400).json({ success: false, error: 'No original file on record for this shipment — it predates file retention or was created manually.' });
  }
  const filePath = path.join(UPLOAD_DIR, existing.original_waybill_file);
  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ success: false, error: 'Original file is no longer on disk and cannot be reprocessed.' });
  }

  try {
    const { rawText, confidence, fields, engine } = await extractWaybillData(filePath);
    const pkgLength = fields.package_length ?? null;
    const pkgWidth  = fields.package_width  ?? null;
    const pkgHeight = fields.package_height ?? null;
    const carrierSpecific = fields.carrier_specific == null ? null
      : (typeof fields.carrier_specific === 'string' ? fields.carrier_specific : JSON.stringify(fields.carrier_specific));

    await db.run(`
      UPDATE shipments SET
        carrier=?, carrier_tracking_number=?, awb_number=?, reference_number=?,
        from_name=?, from_address=?, from_city=?, from_state=?, from_country=?, from_postal=?, from_contact=?,
        to_name=?, to_address=?, to_city=?, to_state=?, to_country=?, to_postal=?, to_contact=?,
        sender_company=?, receiver_company=?, receiver_attention=?,
        origin_code=?, destination_code=?, route_code=?, service_code=?,
        pieces=?, actual_weight=?, billing_weight=?, weight_unit=?, dimensions=?, length=?, width=?, height=?, contents=?,
        customs_value=?, carriage_value=?, billing_type=?, account_number=?, carrier_specific=?,
        service_type=?, declared_value=?, currency=?, invoice_number=?,
        ocr_raw_text=?, ocr_confidence=?,
        updated_by=?, updated_at=datetime('now')
      WHERE id=?
    `, [
      fields.carrier ?? null, fields.carrier_tracking_number ?? null, fields.carrier_tracking_number ?? null, fields.reference_number ?? null,
      fields.from_name ?? null, fields.from_address ?? null, fields.from_city ?? null, fields.from_state ?? null,
      fields.from_country ?? null, fields.from_postal ?? null, fields.from_contact ?? null,
      fields.to_name ?? null, fields.to_address ?? null, fields.to_city ?? null, fields.to_state ?? null,
      fields.to_country ?? null, fields.to_postal ?? null, fields.to_contact ?? null,
      fields.sender_company ?? null, fields.receiver_company ?? null, fields.receiver_attention ?? null,
      fields.origin_code ?? null, fields.destination_code ?? null, fields.route_code ?? null, fields.service_code ?? null,
      fields.pieces ?? 1, fields.actual_weight ?? null, fields.billing_weight ?? null, fields.weight_unit ?? 'kg', fields.dimensions ?? null,
      pkgLength, pkgWidth, pkgHeight, fields.contents ?? null,
      fields.customs_value ?? null, fields.carriage_value ?? null, fields.billing_type ?? null, fields.account_number ?? null, carrierSpecific,
      fields.service_type ?? null, fields.declared_value ?? null, fields.currency ?? 'INR', fields.invoice_number ?? null,
      rawText ?? null, confidence ?? null,
      req.user.id, id
    ]);

    logAudit(req, {
      action: 'SHIPMENT_REPROCESS', entity: 'shipments', entityId: id,
      oldValue: { carrier_tracking_number: existing.carrier_tracking_number },
      newValue: { carrier_tracking_number: fields.carrier_tracking_number, engine, confidence },
      actor: req.user,
    });
    res.json({ success: true, data: await db.get('SELECT * FROM shipments WHERE id = ?', [id]), engine, confidence });
  } catch (err) {
    console.error('[Reprocess]', err.message);
    res.status(500).json({ success: false, error: 'Reprocess failed: ' + err.message });
  }
});

// ── POST /api/shipments/:id/generate-waybill ──────────────────────────────────
// Generates the PDF into the OS temp directory, streams it to the client
// under "<Sender Name>_<GE Number>.pdf", then deletes the temp file once the
// download finishes — the backend never keeps a copy on disk. Using a fixed
// (non-timestamped) temp filename per GE number also means calling this
// twice (e.g. after editing a shipment) simply overwrites the same temp
// file instead of ever accumulating duplicates.
router.post('/:id/generate-waybill', async (req, res) => {
  if (isNaN(parseInt(req.params.id))) return res.status(400).json({ success: false, error: 'Invalid ID' });
  const shipment = await db.get('SELECT * FROM shipments WHERE id = ?', [req.params.id]);
  if (!shipment) return res.status(404).json({ success: false, error: 'Not found' });
  if (!(await canAccess(req, shipment))) return res.status(403).json({ success: false, error: 'You can only generate waybills for your own shipments' });

  const outputPath = path.join(os.tmpdir(), `garuda_waybill_${shipment.ge_tracking_number}.pdf`);
  const downloadName = buildWaybillFilename(shipment);

  try {
    await generateWaybill(shipment, outputPath);
    await db.run(`UPDATE shipments SET garuda_waybill_generated=1, updated_at=datetime('now') WHERE id=?`, [shipment.id]);
    logAudit(req, { action: 'GENERATE_WAYBILL', entity: 'shipments', entityId: shipment.id, actor: req.user });
    res.download(outputPath, downloadName, (err) => {
      fs.unlink(outputPath, () => {}); // best-effort cleanup — nothing persists on the backend either way
      if (err && !res.headersSent) {
        res.status(500).json({ success: false, error: 'Waybill generation failed: ' + err.message });
      }
    });
  } catch (err) {
    fs.existsSync(outputPath) && fs.unlink(outputPath, () => {});
    console.error('[Waybill]', err);
    res.status(500).json({ success: false, error: 'Waybill generation failed: ' + err.message });
  }
});

// ── POST /api/shipments/waybills/bulk-download ────────────────────────────────
// Generates waybill PDFs for multiple shipments (used by the Shipments page
// multi-select download, and by the "Generate Waybill?" prompt after a bulk
// PDF/Excel import) and streams them back as a single ZIP. Nothing is written
// to permanent backend storage — everything happens in a temp directory that
// is removed right after the ZIP is sent.
router.post('/waybills/bulk-download', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(n => !isNaN(n)) : [];
  if (!ids.length) return res.status(400).json({ success: false, error: 'ids (array of shipment IDs) is required' });

  const shipments = await db.all(`SELECT * FROM shipments WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  const accessible = [];
  for (const s of shipments) {
    if (await canAccess(req, s)) accessible.push(s);
  }
  if (!accessible.length) return res.status(404).json({ success: false, error: 'No accessible shipments found for the given IDs' });

  const AdmZip = require('adm-zip');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garuda-waybills-'));
  const zip = new AdmZip();

  try {
    const usedNames = new Set();
    for (const shipment of accessible) {
      let name = buildWaybillFilename(shipment);
      // Guard against two shipments sharing the same sender name + GE clash
      // (shouldn't happen since GE numbers are unique, but be defensive).
      if (usedNames.has(name)) name = `${shipment.ge_tracking_number}_${name}`;
      usedNames.add(name);

      const outputPath = path.join(tmpDir, name);
      await generateWaybill(shipment, outputPath);
      zip.addLocalFile(outputPath);
      await db.run(`UPDATE shipments SET garuda_waybill_generated=1, updated_at=datetime('now') WHERE id=?`, [shipment.id]);
    }

    logAudit(req, { action: 'GENERATE_WAYBILL_BULK', entity: 'shipments', details: `Generated ${accessible.length} waybill(s)`, actor: req.user });

    const zipBuffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Garuda_Waybills_${Date.now()}.zip"`);
    res.send(zipBuffer);
  } catch (err) {
    console.error('[Waybill Bulk]', err);
    res.status(500).json({ success: false, error: 'Bulk waybill generation failed: ' + err.message });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── POST /api/shipments/import-excel — Vendor Excel Import (ICL / World First) ──
// New ingestion path alongside Bulk PDF Upload, per requirement doc: select
// vendor, upload their Excel export, and every valid row becomes a shipment
// with its own GE tracking number and Garuda Waybill PDF — the same
// downstream pipeline the PDF/OCR flow produces, so both import methods are
// indistinguishable once a shipment exists.
router.post('/import-excel', requirePermission('shipments.create'), excelUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No Excel file uploaded' });

  const vendor = resolveVendor(req.body?.vendor);
  if (!vendor) {
    fs.existsSync(req.file.path) && fs.unlink(req.file.path, () => {});
    return res.status(400).json({ success: false, error: 'Vendor is required and must be "ICL" or "World First"' });
  }

  try {
    // Auto Tracking — applies to every shipment created by this import.
    // Each row gets registered with a tracking provider once, right after
    // it's created (see services/excelImport/index.js), so there's no
    // schedule/interval to choose here any more — just on or off.
    const autoTrackingEnabled = req.body?.auto_tracking_enabled === undefined
      ? true : (req.body.auto_tracking_enabled === 'true' || req.body.auto_tracking_enabled === '1' || req.body.auto_tracking_enabled === true);

    const summary = await importExcelShipments({
      filePath: req.file.path,
      vendor,
      uploadedBy: req.user.id,
      autoTrackingEnabled,
      fileName: req.file.originalname,
    });

    logAudit(req, {
      action: 'EXCEL_IMPORT', entity: 'shipments',
      details: `${vendor} — read ${summary.rowsRead}, imported ${summary.imported}, duplicates ${summary.duplicates}, invalid ${summary.invalid}, job #${summary.jobId}`,
      actor: req.user,
    });

    res.status(201).json({
      success: true,
      vendor,
      jobId: summary.jobId,
      rowsRead: summary.rowsRead,
      imported: summary.imported,
      duplicates: summary.duplicates,
      invalid: summary.invalid,
      skippedRows: summary.skipped,   // kept for backward compatibility (CSV export of skipped rows)
      pendingRows: summary.pending,   // same data + recordId, for the "fill in missing fields" review UI
      shipments: summary.shipments,   // frontend uses these IDs for the "Generate Waybill?" bulk-download prompt
    });
  } catch (err) {
    console.error('[ExcelImport]', err);
    res.status(500).json({ success: false, error: 'Excel import failed: ' + err.message });
  } finally {
    fs.existsSync(req.file.path) && fs.unlink(req.file.path, () => {});
  }
});

// ── GET /api/shipments/export/xlsx — "Full Content" export ───────────────────
// Every shipment matching the current filter bar (search/status/carrier/date
// range — same filters as the main listing endpoint above, not just
// date/status), with every field, regardless of what page you're on.
// Pairs with the client-side "Visible Content" export in ShipmentsPage.jsx,
// which builds its own file from exactly what's rendered on screen instead
// of calling this endpoint.
router.get('/export/xlsx', requireAdmin, async (req, res) => {
  const XLSX = require('xlsx');
  const { q, status, carrier, date_from, date_to } = req.query;
  const conditions = [], params = [];

  if (q) {
    conditions.push(`(ge_tracking_number LIKE ? OR carrier_tracking_number LIKE ? OR awb_number LIKE ? OR from_name LIKE ? OR to_name LIKE ? OR from_contact LIKE ? OR to_contact LIKE ? OR contents LIKE ? OR invoice_number LIKE ? OR reference_number LIKE ? OR sender_company LIKE ? OR receiver_company LIKE ? OR route_code LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like, like, like, like, like, like, like);
  }
  if (status)    { conditions.push('status = ?');     params.push(status); }
  if (carrier)   { conditions.push('carrier = ?');    params.push(carrier); }
  if (date_from) { conditions.push('ship_date >= ?'); params.push(date_from); }
  if (date_to)   { conditions.push('ship_date <= ?'); params.push(date_to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows  = await db.all(`SELECT * FROM shipments ${where} ORDER BY created_at DESC`, params);
  const clean = rows.map(({ ocr_raw_text, ...rest }) => rest);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(clean.length ? clean : [{ note: 'No matching shipments' }]), 'Shipments');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  logAudit(req, { action: 'SHIPMENTS_EXPORT', entity: 'shipments', details: `scope=full, rows=${clean.length}, filters=${JSON.stringify({ q, status, carrier, date_from, date_to })}`, actor: req.user });
  res.setHeader('Content-Disposition', `attachment; filename=GarudaExpress_Export_${Date.now()}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;