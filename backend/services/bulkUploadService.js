// services/bulkUploadService.js — Bulk Upload Redesign (requirement spec §8)
// Supports CSV, Excel, ZIP (of images/PDFs), and PDF-batch uploads.
// Pipeline: parse -> validate (carrier/AWB/duplicate/country/weight) -> queue
// (bulk_upload_jobs/bulk_upload_records) -> import on confirm.
'use strict';

const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const XLSX     = require('xlsx');
const AdmZip   = require('adm-zip');
const db       = require('../utils/db');
const logger   = require('../utils/logger');
const { runValidationPipeline, isDuplicateAWB } = require('../utils/validators');
const { generateGENumber } = require('../utils/generateGE');
const { extractWaybillDataBatch } = require('./ocrService');
const { logAudit } = require('../utils/audit');
const { queueNotification } = require('./notificationService');

const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.tiff', '.webp'];

// ── Mandatory-field validation layer ────────────────────────────────────────
// Previously a record could come back from OCR with e.g. to_country = null
// and still be marked 'Valid' with nothing in the UI to flag it. This is a
// backstop check — independent of whatever utils/validators.js does
// internally — that surfaces those gaps as warnings on every record, whether
// it came from a spreadsheet row or an OCR'd document.
const MANDATORY_FIELDS = ['carrier_tracking_number', 'to_name', 'to_country'];
const MANDATORY_FIELD_WARNINGS = {
  carrier_tracking_number: 'Tracking number not detected',
  to_name: 'Receiver name not detected',
  to_country: 'Destination country not detected',
};

function checkMandatoryFields(fields) {
  const warnings = [];
  for (const f of MANDATORY_FIELDS) {
    if (fields[f] === null || fields[f] === undefined || fields[f] === '') {
      warnings.push(MANDATORY_FIELD_WARNINGS[f]);
    }
  }
  return warnings;
}

/** Merge extra warning strings into a validation result without duplicating any. */
function mergeValidationWarnings(validation, extraWarnings) {
  if (!extraWarnings || !extraWarnings.length) return validation;
  const seen = new Set(validation.warnings || []);
  const merged = [...(validation.warnings || [])];
  for (const w of extraWarnings) {
    if (!seen.has(w)) { merged.push(w); seen.add(w); }
  }
  return { ...validation, warnings: merged };
}

/** Create a new bulk_upload_jobs row and return its id. */
async function createJob({ uploadedBy, fileName, fileType }) {
  const info = await db.run(`
    INSERT INTO bulk_upload_jobs (uploaded_by, file_name, file_type, status) VALUES (?,?,?, 'Processing') RETURNING id
  `, [uploadedBy, fileName, fileType]);
  return info.lastInsertRowid;
}

async function addRecord(jobId, rowNumber, rawData, validation) {
  const info = await db.run(`
    INSERT INTO bulk_upload_records (job_id, row_number, raw_data, detected_carrier, validation_status, validation_errors, validation_warnings)
    VALUES (?,?,?,?,?,?,?) RETURNING id
  `, [
    jobId, rowNumber, JSON.stringify(rawData), validation.detectedCarrier || null,
    validation.valid ? 'Valid' : 'Invalid',
    validation.errors.length ? JSON.stringify(validation.errors) : null,
    validation.warnings.length ? JSON.stringify(validation.warnings) : null
  ]);
  return info.lastInsertRowid;
}

async function finalizeJob(jobId) {
  const total = (await db.get('SELECT COUNT(*) c FROM bulk_upload_records WHERE job_id=?', [jobId])).c;
  const invalid = (await db.get("SELECT COUNT(*) c FROM bulk_upload_records WHERE job_id=? AND validation_status='Invalid'", [jobId])).c;
  await db.run(`
    UPDATE bulk_upload_jobs SET total_records=?, failed_count=?, success_count=?, status='Validated', completed_at=datetime('now') WHERE id=?
  `, [total, invalid, total - invalid, jobId]);
}

// ── CSV / Excel parsing ───────────────────────────────────────────────────────
const COLUMN_ALIASES = {
  carrier: ['carrier', 'courier'],
  carrier_tracking_number: ['carrier_tracking_number', 'awb', 'awb_number', 'tracking_number', 'tracking', 'trackingnumber'],
  from_name: ['from_name', 'sender', 'shipper', 'shippername'],
  from_country: ['from_country', 'origin_country', 'origincountry'],
  from_city: ['from_city', 'origin_city', 'origincity'],
  to_name: ['to_name', 'receiver', 'consignee', 'recipient'],
  to_country: ['to_country', 'destination_country', 'destinationcountry'],
  to_city: ['to_city', 'destination_city', 'destinationcity'],
  actual_weight: ['actual_weight', 'weight'],
  pieces: ['pieces', 'qty', 'quantity'],
  ship_date: ['ship_date', 'shipdate', 'date'],
  contents: ['contents', 'description', 'desc'],
  reference_number: ['reference_number', 'reference', 'ref'],
  invoice_number: ['invoice_number', 'invoice'],

  // ── Garuda Master Waybill extensions ─────────────────────────────────────
  sender_company: ['sender_company', 'shipper_company', 'from_company', 'company_sender'],
  receiver_company: ['receiver_company', 'consignee_company', 'to_company', 'company_receiver'],
  receiver_attention: ['receiver_attention', 'attention', 'attn', 'care_of', 'c_o'],
  customs_value: ['customs_value', 'customsvalue', 'value_for_customs'],
  carriage_value: ['carriage_value', 'carriagevalue', 'freight_value'],
  origin_code: ['origin_code', 'origincode', 'origin_station'],
  destination_code: ['destination_code', 'destinationcode', 'destination_station'],
  route_code: ['route_code', 'routecode', 'routing_code'],
  service_code: ['service_code', 'servicecode'],
  package_length: ['package_length', 'length', 'pkg_length'],
  package_width: ['package_width', 'width', 'pkg_width'],
  package_height: ['package_height', 'height', 'pkg_height'],
  billing_type: ['billing_type', 'billingtype', 'payment_type'],
  account_number: ['account_number', 'accountnumber', 'carrier_account'],
};

function normalizeRow(rawRow) {
  const lowerMap = {};
  for (const [k, v] of Object.entries(rawRow)) lowerMap[k.trim().toLowerCase().replace(/\s+/g, '_')] = v;
  const out = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      if (lowerMap[alias] != null && lowerMap[alias] !== '') { out[field] = lowerMap[alias]; break; }
    }
  }
  return out;
}

/** Parse a CSV or Excel file into normalized shipment-like row objects. */
function parseSpreadsheet(filePath, fileType) {
  const wb = fileType === 'csv'
    ? XLSX.read(fs.readFileSync(filePath, 'utf8'), { type: 'string' })
    : XLSX.readFile(filePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows.map(normalizeRow);
}

/** Extract images/PDFs from a ZIP archive into a temp dir, return file paths. */
function extractZip(filePath) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-bulk-'));
  const zip = new AdmZip(filePath);
  const out = [];
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (!IMAGE_EXTS.includes(ext) && ext !== '.pdf') continue;
    const dest = path.join(tmpDir, path.basename(entry.entryName).replace(/[^a-zA-Z0-9.\-_]/g, '_'));
    fs.writeFileSync(dest, entry.getData());
    out.push(dest);
  }
  return out;
}

/**
 * Process a CSV/Excel upload: parse rows, run validation pipeline on each,
 * persist to bulk_upload_records for review, return the job summary.
 */
async function processSpreadsheetUpload({ filePath, fileType, fileName, uploadedBy }) {
  const jobId = await createJob({ uploadedBy, fileName, fileType });
  const rows = parseSpreadsheet(filePath, fileType);

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    let validation = await runValidationPipeline(row);
    validation = mergeValidationWarnings(validation, checkMandatoryFields(row));
    await addRecord(jobId, idx + 1, row, validation);
  }

  await finalizeJob(jobId);
  logAudit(null, { action: 'BULK_UPLOAD', entity: 'bulk_upload_jobs', entityId: jobId, actor: { id: uploadedBy },
    details: `${fileName} (${fileType}) — ${rows.length} rows parsed` });

  return getJobSummary(jobId);
}

/**
 * Process a ZIP/PDF-batch upload: extract each file, run OCR, validate the
 * extracted fields, persist to bulk_upload_records for review.
 *
 * OCR + Gemini enrichment for every file in the batch happens via a SINGLE
 * call to extractWaybillDataBatch() (services/ocrService.js), which itself
 * sends all the raw OCR text to Gemini in one (internally chunked) request
 * instead of one Gemini API call per file — this is the "send multiple AWBs
 * in a single request" batch path, and it matters a lot on Gemini's free
 * tier where requests-per-minute/day are tightly limited.
 */
async function processDocumentBatchUpload({ filePath, fileType, fileName, uploadedBy }) {
  const jobId = await createJob({ uploadedBy, fileName, fileType });
  const files = fileType === 'zip' ? extractZip(filePath) : [filePath];

  let batchResults;
  try {
    batchResults = await extractWaybillDataBatch(files);
  } catch (err) {
    // extractWaybillDataBatch() is designed to isolate per-file failures and
    // never throw, but guard the whole job anyway so a totally unexpected
    // error still leaves the job in a sane (if empty) state instead of
    // crashing the request.
    logger.error('Batch OCR extraction failed unexpectedly', { jobId, error: err.message });
    batchResults = files.map(() => ({ error: err.message }));
  }

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const rowNum = i + 1;
    const res = batchResults[i];
    if (!res || res.error) {
      logger.error('Bulk OCR failed for file', { file: f, error: res?.error || 'Unknown error' });
      await addRecord(jobId, rowNum, { _source_file: path.basename(f), _error: res?.error || 'OCR failed' },
        { valid: false, errors: [`OCR failed: ${res?.error || 'Unknown error'}`], warnings: [] });
    } else {
      const { fields, confidence, engine, field_score, warnings: ocrWarnings, gemini_used } = res;
      let validation = await runValidationPipeline(fields);
      validation = mergeValidationWarnings(validation, [...(ocrWarnings || []), ...checkMandatoryFields(fields)]);
      await addRecord(jobId, rowNum, {
        ...fields,
        _source_file: path.basename(f),
        _ocr_confidence: confidence,
        _ocr_field_score: field_score,
        _ocr_engine: engine,
        _gemini_used: !!gemini_used,
      }, validation);
    }
    if (fileType === 'zip' && fs.existsSync(f)) fs.unlinkSync(f);
  }

  await finalizeJob(jobId);
  logAudit(null, { action: 'BULK_UPLOAD', entity: 'bulk_upload_jobs', entityId: jobId, actor: { id: uploadedBy },
    details: `${fileName} (${fileType}) — ${files.length} document(s) OCR'd` });

  return getJobSummary(jobId);
}

async function getJobSummary(jobId) {
  const job = await db.get('SELECT * FROM bulk_upload_jobs WHERE id = ?', [jobId]);
  const records = await db.all('SELECT * FROM bulk_upload_records WHERE job_id = ? ORDER BY row_number', [jobId]);
  return {
    job,
    records: records.map(r => ({
      ...r,
      raw_data: JSON.parse(r.raw_data || '{}'),
      validation_errors: r.validation_errors ? JSON.parse(r.validation_errors) : [],
      validation_warnings: r.validation_warnings ? JSON.parse(r.validation_warnings) : [],
    })),
  };
}

/** Import the *valid* records of a job into the shipments table (admin/employee confirm step). */
async function importJob(jobId, userId, { skipInvalid = true } = {}) {
  const { registerForTracking } = require('./trackingService'); // required lazily to avoid a require cycle (trackingService doesn't need this module)
  const records = await db.all("SELECT * FROM bulk_upload_records WHERE job_id = ? AND validation_status != 'Imported'", [jobId]);
  let imported = 0, skipped = 0;
  const shipments = [];

  const INSERT_SHIPMENT_SQL = `
    INSERT INTO shipments (
      ge_tracking_number, carrier, carrier_tracking_number, awb_number,
      from_name, from_country, from_city, to_name, to_country, to_city,
      actual_weight, pieces, ship_date, contents, reference_number, invoice_number,
      sender_company, receiver_company, receiver_attention,
      origin_code, destination_code, route_code, service_code,
      length, width, height, customs_value, carriage_value,
      billing_type, account_number, carrier_specific, auto_tracking_enabled,
      status, created_by
    ) VALUES (?,?,?,?, ?,?,?,?,?,?, ?,?,?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?,?, ?,?,?,?, 'Processing', ?) RETURNING id
  `;

  for (const rec of records) {
    if (skipInvalid && rec.validation_status === 'Invalid') { skipped++; continue; }
    const d = JSON.parse(rec.raw_data || '{}');
    const trackingNum = d.carrier_tracking_number != null ? String(d.carrier_tracking_number).trim() : null;

    // Hard duplicate guard, checked fresh immediately before every insert —
    // deliberately NOT relying solely on the validation-time isDuplicateAWB()
    // check (runValidationPipeline, called when the job was first parsed):
    // that check only catches a tracking number already in `shipments` AT
    // THAT TIME. It can't see a duplicate sitting in a different row of the
    // SAME batch (e.g. the same PDF included twice in one ZIP) — both rows
    // would have passed validation since neither was in `shipments` yet. It
    // also runs unconditionally here even if `skipInvalid` is false, so a
    // forced/override import can't push a duplicate through either.
    if (trackingNum && (await isDuplicateAWB(trackingNum))) {
      logger.warn('Bulk import skipped duplicate tracking number', { recordId: rec.id, trackingNum });
      await db.run("UPDATE bulk_upload_records SET validation_status='Invalid', validation_errors=? WHERE id=?",
        [JSON.stringify(['Duplicate AWB / tracking number already exists in system']), rec.id]);
      skipped++;
      continue;
    }

    const ge = await generateGENumber(db);
    // carrier_specific may already be a JSON string (from Gemini/OCR) or a
    // raw object (from a hand-built spreadsheet row) — always store as text.
    const carrierSpecific = d.carrier_specific == null ? null
      : (typeof d.carrier_specific === 'string' ? d.carrier_specific : JSON.stringify(d.carrier_specific));
    try {
      const info = await db.run(INSERT_SHIPMENT_SQL, [
        ge, d.carrier || rec.detected_carrier || null, trackingNum, trackingNum,
        d.from_name || null, d.from_country || null, d.from_city || null,
        d.to_name || null, d.to_country || null, d.to_city || null,
        d.actual_weight || null, d.pieces || 1, d.ship_date || null, d.contents || null,
        d.reference_number || null, d.invoice_number || null,
        d.sender_company || null, d.receiver_company || null, d.receiver_attention || null,
        d.origin_code || null, d.destination_code || null, d.route_code || null, d.service_code || null,
        d.package_length || null, d.package_width || null, d.package_height || null,
        d.customs_value || null, d.carriage_value || null,
        d.billing_type || null, d.account_number || null, carrierSpecific, 1, // auto_tracking_enabled — was previously never set at all, silently defaulting to the column's SQL default of 0 and permanently excluding these shipments from tracking
        userId
      ]);
      await db.run("UPDATE bulk_upload_records SET validation_status='Imported', shipment_id=? WHERE id=?", [info.lastInsertRowid, rec.id]);
      imported++;
      shipments.push({ id: info.lastInsertRowid, ge_tracking_number: ge });

      if (trackingNum) {
        try { await registerForTracking(info.lastInsertRowid); }
        catch (err) { logger.warn('Bulk import: tracking registration failed', { shipmentId: info.lastInsertRowid, error: err.message }); }
      }
    } catch (err) {
      logger.error('Bulk import row failed', { recordId: rec.id, error: err.message });
      skipped++;
    }
  }

  await db.run("UPDATE bulk_upload_jobs SET status='Imported', success_count=?, failed_count=? WHERE id=?", [imported, skipped, jobId]);
  logAudit(null, { action: 'BULK_UPLOAD', entity: 'bulk_upload_jobs', entityId: jobId, actor: { id: userId },
    details: `Imported ${imported}, skipped ${skipped}` });

  queueNotification({ event: 'bulk_upload_completed', userId, context: { jobId, imported, skipped } });

  return { imported, skipped, shipments };
}

module.exports = {
  processSpreadsheetUpload, processDocumentBatchUpload, importJob, getJobSummary,
  parseSpreadsheet, extractZip, normalizeRow,
  createJob, addRecord, finalizeJob,
};