// services/excelImport/index.js — Excel Shipment Import orchestrator
// Implements the "Excel Upload Workflow" from the requirement doc end-to-end:
//   Read Excel -> Identify Vendor -> Extract Required Fields ->
//   Convert into Shipment Object -> Validate -> Save Shipment ->
//   Generate Garuda Waybill -> Generate GE Tracking Number ->
//   Register for Tracking (one time, then TrackingMore/17Track push updates
//   to routes/webhooks.js — no polling, no cycles, no per-shipment interval).
//
// Deliberately a standalone module (not a modification of the OCR bulk-upload
// pipeline in services/bulkUploadService.js) so the existing PDF workflow is
// left completely untouched, per the requirement doc's "Backend Changes"
// section. It DOES reuse bulkUploadService's job/record bookkeeping
// (bulk_upload_jobs / bulk_upload_records) though, so rows missing a
// required field land in the same review queue instead of being silently
// dropped — the admin can fill in the missing Tracking Number / Shipper
// Name / Consignee Name later and complete the import for that row.
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('../../utils/db');
const logger = require('../../utils/logger');
const { generateGENumber } = require('../../utils/generateGE');
const { isDuplicateAWB } = require('../../utils/validators');
const { generateWaybill } = require('../waybillService');
const { registerForTracking } = require('../trackingService');
const { createJob, addRecord, finalizeJob } = require('../bulkUploadService');

const { readExcelRows } = require('./excelParser');
const { mapICLRow } = require('./iclParser');
const { mapWorldFirstRow } = require('./worldFirstParser');
const { toShipmentRecord } = require('./shipmentMapper');
const { validateShipmentRecord } = require('./validation');

const VENDOR_PARSERS = {
  'ICL': mapICLRow,
  'World First': mapWorldFirstRow,
};

const WAYBILL_DIR = path.join(__dirname, '../../uploads/waybills');

const INSERT_SHIPMENT = db.prepare(`
  INSERT INTO shipments (
    ge_tracking_number, vendor, carrier,
    carrier_tracking_number, awb_number, reference_number,
    from_name, from_address, from_city, from_state, from_postal,
    to_name, to_address, to_city, to_state, to_country, to_postal,
    pieces, actual_weight, billing_weight, weight_unit, contents,
    declared_value, currency, booking_date, service_type, invoice_number,
    status, carrier_specific, auto_tracking_enabled,
    created_by, updated_at
  ) VALUES (
    ?,?,?,
    ?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,?,
    ?,?,?,
    ?, datetime('now')
  )
`);

function shipmentValues(ge, record, userId, autoTrackingEnabled) {
  return [
    ge, record.vendor, record.carrier || null, // carrier left blank here — registerForTracking() fills it in right after insert
    record.carrier_tracking_number, record.awb_number, record.reference_number,
    record.from_name, record.from_address, record.from_city, record.from_state, record.from_postal,
    record.to_name, record.to_address, record.to_city, record.to_state, record.to_country, record.to_postal,
    record.pieces, record.actual_weight, record.billing_weight, record.weight_unit, record.contents,
    record.declared_value, record.currency, record.booking_date, record.service_type, record.invoice_number,
    record.status, record.carrier_specific, autoTrackingEnabled ? 1 : 0,
    userId,
  ];
}

/**
 * Saves a normalized+validated shipment record, generating its GE number,
 * its Garuda Waybill PDF, and registering it for tracking (one time — see
 * services/trackingService.js#registerForTracking) — all the same
 * regardless of whether the row was valid the first time or fixed up later
 * via the "complete a pending row" endpoint (routes/bulkUpload.js).
 */
async function createShipmentFromRecord(record, uploadedBy, { autoTrackingEnabled = true, generateWaybills = true } = {}) {
  const ge = generateGENumber(db);
  const info = INSERT_SHIPMENT.run(...shipmentValues(ge, record, uploadedBy, autoTrackingEnabled));
  const shipmentId = info.lastInsertRowid;

  if (autoTrackingEnabled && (record.carrier_tracking_number || record.awb_number)) {
    try { await registerForTracking(shipmentId); }
    catch (err) { logger.warn('Excel import: tracking registration failed', { shipmentId, ge, error: err.message }); }
  }

  if (generateWaybills) {
    if (!fs.existsSync(WAYBILL_DIR)) fs.mkdirSync(WAYBILL_DIR, { recursive: true });
    try {
      const shipmentRow = db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
      const outputPath = path.join(WAYBILL_DIR, `GE_${ge}_${Date.now()}.pdf`);
      await generateWaybill(shipmentRow, outputPath);
      db.prepare(`UPDATE shipments SET garuda_waybill_generated = 1, updated_at = datetime('now') WHERE id = ?`).run(shipmentId);
    } catch (err) {
      // Shipment is already saved and trackable — a waybill PDF failure
      // shouldn't roll that back, just log it.
      logger.error('Excel import: waybill generation failed', { shipmentId, ge, error: err.message });
    }
  }

  return { id: shipmentId, ge_tracking_number: ge };
}

/**
 * Runs the full Excel import pipeline for one uploaded vendor workbook.
 * @param {object} opts
 * @param {string} opts.filePath   Path to the uploaded .xlsx/.xls on disk
 * @param {string} opts.vendor     'ICL' | 'World First'
 * @param {number} opts.uploadedBy User id performing the import
 * @param {boolean} [opts.generateWaybills=true] Generate a Garuda Waybill PDF per imported row
 * @param {boolean} [opts.autoTrackingEnabled=true] Register each imported shipment with TrackingMore/17Track (one time — see registerForTracking)
 * @param {string} [opts.fileName] Original filename, stored on the review job for display
 * @returns {Promise<object>} Import summary (jobId/rowsRead/imported/duplicates/invalid/generatedWaybills/pending/shipments)
 */
async function importExcelShipments({
  filePath, vendor, uploadedBy, generateWaybills = true,
  autoTrackingEnabled = true, fileName = null,
}) {
  const parseRow = VENDOR_PARSERS[vendor];
  if (!parseRow) {
    throw new Error(`Unsupported vendor "${vendor}" — expected "ICL" or "World First"`);
  }

  const rawRows = readExcelRows(filePath);
  const rowsRead = rawRows.length;

  // Review job — every row (valid or not) gets a bulk_upload_records entry,
  // so invalid rows have somewhere to live for the admin to fix instead of
  // just being reported in a one-time summary and lost.
  const jobId = createJob({ uploadedBy, fileName: fileName || path.basename(filePath), fileType: 'excel' });

  let imported = 0, duplicates = 0, invalid = 0, generatedWaybills = 0;
  const pending = []; // rows that need the admin to fill in missing fields
  const shipments = [];

  for (let i = 0; i < rawRows.length; i++) {
    const rowNumber = i + 2; // account for the header row so this matches the spreadsheet's own row numbers
    const normalized = parseRow(rawRows[i]);
    const record = toShipmentRecord(normalized);

    // ── Validation Rules — required fields ─────────────────────────────────
    const check = validateShipmentRecord(record);
    const duplicate = check.valid && isDuplicateAWB(record.carrier_tracking_number);
    const errors = duplicate ? [...check.errors, 'Duplicate Shipment — Tracking Number already exists'] : check.errors;

    if (!check.valid || duplicate) {
      invalid += !check.valid ? 1 : 0;
      duplicates += duplicate ? 1 : 0;
      const recordId = addRecord(jobId, rowNumber, record, { valid: false, errors, warnings: [], detectedCarrier: vendor });
      pending.push({ recordId, row: rowNumber, trackingNumber: record.carrier_tracking_number || null, reason: errors.join('; ') });
      continue;
    }

    // ── Convert into Shipment Object / Save Shipment / Generate GE Number /
    // Register for Tracking (identifies the real carrier as a side effect —
    // see services/trackingService.js#registerForTracking) / Generate
    // Garuda Waybill PDF ─────────────────────────────────────────────────────
    let created;
    try {
      created = await createShipmentFromRecord(record, uploadedBy, { autoTrackingEnabled, generateWaybills });
      imported++;
    } catch (err) {
      logger.error('Excel import: shipment insert failed', { row: rowNumber, error: err.message });
      invalid++;
      const recordId = addRecord(jobId, rowNumber, record, { valid: false, errors: ['Could not save shipment: ' + err.message], warnings: [], detectedCarrier: vendor });
      pending.push({ recordId, row: rowNumber, trackingNumber: record.carrier_tracking_number || null, reason: 'Could not save shipment: ' + err.message });
      continue;
    }

    const recordId = addRecord(jobId, rowNumber, record, { valid: true, errors: [], warnings: [], detectedCarrier: vendor });
    db.prepare('UPDATE bulk_upload_records SET shipment_id = ?, validation_status = ? WHERE id = ?').run(created.id, 'Imported', recordId);

    shipments.push({ id: created.id, ge_tracking_number: created.ge_tracking_number, tracking_number: record.carrier_tracking_number });
  }

  generatedWaybills = shipments.length
    ? db.prepare(`SELECT COUNT(*) c FROM shipments WHERE id IN (${shipments.map(() => '?').join(',')}) AND garuda_waybill_generated = 1`).get(...shipments.map(s => s.id)).c
    : 0;

  finalizeJob(jobId);

  return { jobId, vendor, rowsRead, imported, duplicates, invalid, generatedWaybills, pending, skipped: pending, shipments };
}

module.exports = { importExcelShipments, createShipmentFromRecord, VENDOR_PARSERS };