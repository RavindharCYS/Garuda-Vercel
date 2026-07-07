// routes/bulkUpload.js — Bulk Upload Redesign (requirement spec §8)
// Employee permissions: upload-only + edit own (no delete, no system/carrier settings).
'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const db      = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const bulkUploadService = require('../services/bulkUploadService');
const { createShipmentFromRecord } = require('../services/excelImport');
const { validateShipmentRecord } = require('../services/excelImport/validation');
const { isDuplicateAWB } = require('../utils/validators');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

const UPLOAD_DIR = path.join(__dirname, '../uploads/bulk');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => cb(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`),
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = ['.csv', '.xlsx', '.xls', '.zip', '.pdf'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  },
});

function fileTypeOf(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.xlsx' || ext === '.xls') return 'excel';
  if (ext === '.zip') return 'zip';
  if (ext === '.pdf') return 'pdf';
  return 'unknown';
}

// POST /api/bulk-upload — upload a CSV, Excel, ZIP (of images/PDFs), or PDF batch
router.post('/', requirePermission('bulk_upload.create'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });
  const fileType = fileTypeOf(req.file.originalname);

  try {
    let summary;
    if (fileType === 'csv' || fileType === 'excel') {
      summary = await bulkUploadService.processSpreadsheetUpload({
        filePath: req.file.path, fileType, fileName: req.file.originalname, uploadedBy: req.user.id,
      });
    } else if (fileType === 'zip' || fileType === 'pdf') {
      summary = await bulkUploadService.processDocumentBatchUpload({
        filePath: req.file.path, fileType, fileName: req.file.originalname, uploadedBy: req.user.id,
      });
    } else {
      return res.status(400).json({ success: false, error: 'Unsupported file type. Use CSV, Excel, ZIP, or PDF.' });
    }
    res.status(201).json({ success: true, ...summary });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Bulk upload processing failed: ' + err.message });
  }
});

// GET /api/bulk-upload — list jobs (own jobs for employees, all for admins)
router.get('/', (req, res) => {
  const scoped = req.user.role !== 'admin';
  const rows = db.prepare(`
    SELECT * FROM bulk_upload_jobs ${scoped ? 'WHERE uploaded_by = ?' : ''} ORDER BY created_at DESC LIMIT 100
  `).all(...(scoped ? [req.user.id] : []));
  res.json({ success: true, data: rows });
});

// GET /api/bulk-upload/:jobId — job detail + records for review
router.get('/:jobId', (req, res) => {
  const job = db.prepare('SELECT * FROM bulk_upload_jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  if (req.user.role !== 'admin' && job.uploaded_by !== req.user.id) {
    return res.status(403).json({ success: false, error: 'You can only view your own bulk upload jobs' });
  }
  res.json({ success: true, ...bulkUploadService.getJobSummary(job.id) });
});

// POST /api/bulk-upload/:jobId/import — confirm import of validated rows into shipments
router.post('/:jobId/import', requirePermission('bulk_upload.edit_own'), async (req, res) => {
  const job = db.prepare('SELECT * FROM bulk_upload_jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  if (req.user.role !== 'admin' && job.uploaded_by !== req.user.id) {
    return res.status(403).json({ success: false, error: 'You can only import your own bulk upload jobs' });
  }
  const { skipInvalid = true } = req.body || {};
  const result = await bulkUploadService.importJob(job.id, req.user.id, { skipInvalid });
  res.json({ success: true, ...result });
});

// POST /api/bulk-upload/:jobId/records/:recordId/complete — fill in the
// missing required fields (Tracking Number / Shipper Name / Consignee Name)
// on a row that failed validation during Excel Vendor Import and create its
// shipment. Re-validates before creating — if still missing something or
// now a duplicate, returns the (updated) errors instead so the admin can
// try again rather than silently failing.
router.post('/:jobId/records/:recordId/complete', requirePermission('bulk_upload.edit_own'), async (req, res) => {
  const job = db.prepare('SELECT * FROM bulk_upload_jobs WHERE id = ?').get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  if (req.user.role !== 'admin' && job.uploaded_by !== req.user.id) {
    return res.status(403).json({ success: false, error: 'You can only complete rows from your own bulk upload jobs' });
  }
  const record = db.prepare('SELECT * FROM bulk_upload_records WHERE id = ? AND job_id = ?').get(req.params.recordId, req.params.jobId);
  if (!record) return res.status(404).json({ success: false, error: 'Row not found in this job' });
  if (record.validation_status === 'Imported') {
    return res.status(400).json({ success: false, error: 'This row was already imported' });
  }

  // Merge the admin's corrections into the originally-mapped record.
  const merged = { ...JSON.parse(record.raw_data || '{}'), ...(req.body || {}) };

  const check = validateShipmentRecord(merged);
  const duplicate = check.valid && isDuplicateAWB(merged.carrier_tracking_number);
  const errors = duplicate ? [...check.errors, 'Duplicate Shipment — Tracking Number already exists'] : check.errors;

  if (!check.valid || duplicate) {
    db.prepare('UPDATE bulk_upload_records SET raw_data = ?, validation_errors = ? WHERE id = ?')
      .run(JSON.stringify(merged), JSON.stringify(errors), record.id);
    return res.status(400).json({ success: false, error: errors.join('; '), validationErrors: errors });
  }

  try {
    const created = await createShipmentFromRecord(merged, req.user.id, { autoTrackingEnabled: true, generateWaybills: true });
    db.prepare(`
      UPDATE bulk_upload_records SET raw_data = ?, shipment_id = ?, validation_status = 'Imported', validation_errors = NULL WHERE id = ?
    `).run(JSON.stringify(merged), created.id, record.id);

    logAudit(req, { action: 'EXCEL_IMPORT_ROW_COMPLETED', entity: 'shipments', entityId: created.id,
      details: `Completed pending row #${record.row_number} of job #${job.id} — ${created.ge_tracking_number}`, actor: req.user });

    res.json({ success: true, shipment: { id: created.id, ge_tracking_number: created.ge_tracking_number } });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not create shipment: ' + err.message });
  }
});

module.exports = router;