// services/excelImport/index.js — Excel Shipment Import orchestrator
// Implements the "Excel Upload Workflow" from the requirement doc end-to-end:
//   Read Excel -> Identify Vendor -> Extract Required Fields ->
//   Convert into Shipment Object -> Validate -> Save Shipment ->
//   Generate GE Tracking Number -> Register for Tracking (one time, then
//   TrackingMore/17Track push updates to routes/webhooks.js — no polling, no
//   cycles, no per-shipment interval). Garuda Waybill generation is a
//   separate, on-demand step (see createShipmentFromRecord's doc comment
//   below) rather than part of this pipeline.
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

const db = require('../../utils/db');
const logger = require('../../utils/logger');
const { generateGENumber } = require('../../utils/generateGE');
const { isDuplicateAWB } = require('../../utils/validators');
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

const INSERT_SHIPMENT_SQL = `
  INSERT INTO shipments (
    ge_tracking_number, vendor, carrier,
    carrier_tracking_number, awb_number, reference_number,
    from_name, from_address, from_city, from_state, from_postal,
    to_name, to_address, to_city, to_state, to_country, to_postal,
    pieces, actual_weight, billing_weight, weight_unit, contents,
    declared_value, currency, booking_date, ship_date, service_type, invoice_number,
    status, carrier_specific, auto_tracking_enabled,
    created_by, updated_at
  ) VALUES (
    ?,?,?,
    ?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,?,?,
    ?,?,?,?,?,?,
    ?,?,?,
    ?, datetime('now')
  ) RETURNING id
`;

function shipmentValues(ge, record, userId, autoTrackingEnabled) {
  return [
    ge, record.vendor, record.carrier || null, // carrier left blank here — registerForTracking() fills it in right after insert
    record.carrier_tracking_number, record.awb_number, record.reference_number,
    record.from_name, record.from_address, record.from_city, record.from_state, record.from_postal,
    record.to_name, record.to_address, record.to_city, record.to_state, record.to_country, record.to_postal,
    record.pieces, record.actual_weight, record.billing_weight, record.weight_unit, record.contents,
    record.declared_value, record.currency, record.booking_date, record.ship_date, record.service_type, record.invoice_number,
    record.status, record.carrier_specific, autoTrackingEnabled ? 1 : 0,
    userId,
  ];
}

/**
 * Saves a normalized+validated shipment record, generating its GE number
 * and registering it for tracking (one time — see
 * services/trackingService.js#registerForTracking) — all the same
 * regardless of whether the row was valid the first time or fixed up later
 * via the "complete a pending row" endpoint (routes/bulkUpload.js).
 *
 * NOTE: this no longer auto-generates/stores a Garuda Waybill PDF on the
 * backend. Per the "Generate Waybill?" requirement, waybill PDFs are only
 * ever produced on demand — via POST /api/shipments/:id/generate-waybill or
 * POST /api/shipments/waybills/bulk-download — and are streamed straight to
 * the requester without being written to permanent backend storage.
 */
async function createShipmentFromRecord(record, uploadedBy, { autoTrackingEnabled = true } = {}) {
  const ge = await generateGENumber(db);
  const info = await db.run(INSERT_SHIPMENT_SQL, shipmentValues(ge, record, uploadedBy, autoTrackingEnabled));
  const shipmentId = info.lastInsertRowid;

  if (autoTrackingEnabled && (record.carrier_tracking_number || record.awb_number)) {
    try { await registerForTracking(shipmentId); }
    catch (err) { logger.warn('Excel import: tracking registration failed', { shipmentId, ge, error: err.message }); }
  }

  return { id: shipmentId, ge_tracking_number: ge };
}

/**
 * Runs the full Excel import pipeline for one uploaded vendor workbook.
 * @param {object} opts
 * @param {string} opts.filePath   Path to the uploaded .xlsx/.xls on disk
 * @param {string} opts.vendor     'ICL' | 'World First'
 * @param {number} opts.uploadedBy User id performing the import
 * @param {boolean} [opts.autoTrackingEnabled=true] Register each imported shipment with TrackingMore/17Track (one time — see registerForTracking)
 * @param {string} [opts.fileName] Original filename, stored on the review job for display
 * @returns {Promise<object>} Import summary (jobId/rowsRead/imported/duplicates/invalid/pending/shipments) —
 *   waybill generation is a separate, on-demand step the frontend triggers via
 *   the "Generate Waybill?" confirmation using the returned `shipments` list.
 */
async function importExcelShipments({
  filePath, vendor, uploadedBy,
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
  const jobId = await createJob({ uploadedBy, fileName: fileName || path.basename(filePath), fileType: 'excel' });

  let imported = 0, duplicates = 0, invalid = 0;
  const pending = []; // rows that need the admin to fill in missing fields
  const shipments = [];

  for (let i = 0; i < rawRows.length; i++) {
    const rowNumber = i + 2; // account for the header row so this matches the spreadsheet's own row numbers
    const normalized = parseRow(rawRows[i]);
    const record = toShipmentRecord(normalized);

    // ── Validation Rules — required fields ─────────────────────────────────
    const check = validateShipmentRecord(record);
    const duplicate = check.valid && (await isDuplicateAWB(record.carrier_tracking_number));
    const errors = duplicate ? [...check.errors, 'Duplicate Shipment — Tracking Number already exists'] : check.errors;

    if (!check.valid || duplicate) {
      invalid += !check.valid ? 1 : 0;
      duplicates += duplicate ? 1 : 0;
      const recordId = await addRecord(jobId, rowNumber, record, { valid: false, errors, warnings: [], detectedCarrier: vendor });
      pending.push({ recordId, row: rowNumber, trackingNumber: record.carrier_tracking_number || null, reason: errors.join('; ') });
      continue;
    }

    // ── Convert into Shipment Object / Save Shipment / Generate GE Number /
    // Register for Tracking (identifies the real carrier as a side effect —
    // see services/trackingService.js#registerForTracking) / Generate
    // Garuda Waybill PDF ─────────────────────────────────────────────────────
    let created;
    try {
      created = await createShipmentFromRecord(record, uploadedBy, { autoTrackingEnabled });
      imported++;
    } catch (err) {
      logger.error('Excel import: shipment insert failed', { row: rowNumber, error: err.message });
      invalid++;
      const recordId = await addRecord(jobId, rowNumber, record, { valid: false, errors: ['Could not save shipment: ' + err.message], warnings: [], detectedCarrier: vendor });
      pending.push({ recordId, row: rowNumber, trackingNumber: record.carrier_tracking_number || null, reason: 'Could not save shipment: ' + err.message });
      continue;
    }

    const recordId = await addRecord(jobId, rowNumber, record, { valid: true, errors: [], warnings: [], detectedCarrier: vendor });
    await db.run('UPDATE bulk_upload_records SET shipment_id = ?, validation_status = ? WHERE id = ?', [created.id, 'Imported', recordId]);

    shipments.push({ id: created.id, ge_tracking_number: created.ge_tracking_number, tracking_number: record.carrier_tracking_number });
  }

  await finalizeJob(jobId);

  return { jobId, vendor, rowsRead, imported, duplicates, invalid, pending, skipped: pending, shipments };
}

module.exports = { importExcelShipments, createShipmentFromRecord, VENDOR_PARSERS };