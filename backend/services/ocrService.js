// services/ocrService.js — AWB Extraction Engine (requirement spec §7)
// Engine selection: Google Vision (primary, if configured) -> Tesseract (backup).
// Tesseract path delegates to the Python worker (services/ocr_worker.py) which
// also contains the field-parsing regexes (AWB/tracking/sender/receiver/etc).
// Google Vision path extracts raw text here in Node, then reuses the SAME
// Python field parser (via --parse-only stdin mode) so both engines produce
// identically-shaped field objects.
//
// Gemini enrichment layer (services/geminiService.js): the regex parsers
// above are fast and free but brittle on noisy/rotated scans or unfamiliar
// label layouts. If GEMINI_API_KEY is configured, the raw OCR text is also
// sent to Gemini, which independently fills the same field schema; Gemini's
// answer is preferred wherever it provides a non-empty value, and the regex
// result is kept as the fallback for anything Gemini leaves null or if the
// Gemini call fails outright (rate limit, network, invalid key, etc.) — so a
// Gemini outage NEVER breaks OCR, it just loses the accuracy boost.
// extractWaybillData() enriches one file via a single Gemini call;
// extractWaybillDataBatch() enriches many files via a SINGLE batched Gemini
// request (chunked internally — see geminiService.extractFieldsBatch) which
// is the right entry point for bulk/ZIP uploads.
'use strict';

const { execFile } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const logger = require('../utils/logger');
const db     = require('../utils/db');
const googleVision = require('./googleVisionService');
const gemini = require('./geminiService');
const { logApiCall } = require('./apiHealth');
const { computeFieldScore } = require('./waybillFieldSchema');

const WORKER_PATH = path.join(__dirname, 'ocr_worker.py');

async function getSetting(key, fallback) {
  try {
    const row = await db.get('SELECT value FROM system_settings WHERE key = ?', [key]);
    return row ? row.value : fallback;
  } catch (_) { return fallback; }
}

/** Run the Python worker against a raw text string to get parsed waybill fields,
 *  the field-completeness score, and mandatory-field validation warnings. */
function parseFieldsFromText(rawText) {
  return new Promise((resolve, reject) => {
    const child = execFile('python3', [WORKER_PATH, '--parse-only'], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(new Error(`Field parser failed: ${err.message}`));
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve({ fields: parsed.fields || {}, field_score: parsed.field_score || 0, warnings: parsed.warnings || [] });
      }
      catch (e) { reject(new Error('Field parser returned invalid JSON')); }
    });
    child.stdin.write(rawText);
    child.stdin.end();
  });
}

/** Full Tesseract pipeline (image/PDF rotation-correction + OCR + field parse) via the Python worker. */
function runTesseract(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error(`File not found: ${filePath}`));
    const start = Date.now();
    const child = execFile('python3', [WORKER_PATH, filePath], { timeout: 280_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      const ok = !err;
      logApiCall({ provider: 'tesseract', endpoint: 'ocr', success: ok, responseMs: Date.now() - start, error: err?.message });
      if (err && !stdout) return reject(new Error(`OCR process failed: ${err.message}`));
      let result;
      try { result = JSON.parse(stdout.trim()); }
      catch (e) { return reject(new Error('OCR returned invalid JSON')); }
      if (!result.success) return reject(new Error(`OCR: ${result.error}`));
      resolve({
        rawText: result.rawText || '',
        // `confidence` is now the blended score (ocr_confidence * 0.7 + field_score * 0.3)
        // computed in the worker, so a label with high raw OCR confidence but
        // mostly-null fields no longer reports a misleadingly high confidence.
        confidence: result.confidence || 0,
        ocr_confidence: result.ocr_confidence || 0,
        field_score: result.field_score || 0,
        rotation_applied: result.rotation_applied || 0,
        fields: result.fields || {},
        warnings: result.warnings || [],
        // Reflects whichever layer the worker actually used — 'pdf_text_layer'
        // (native PDF text, no OCR at all), 'onnxtr', 'tesseract', or a hybrid
        // like 'pdf_text_layer+tesseract' when native text was usable but
        // missing fields an OCR pass then filled in. Previously hardcoded to
        // 'tesseract' regardless of what the worker actually did.
        engine: result.engine || 'tesseract',
      });
    });
    if (child.stderr) child.stderr.on('data', d => logger.debug(`[OCR/tesseract] ${d}`));
  });
}

/**
 * Convert a PDF's first pages to images using the same pdf2image pipeline the
 * Python worker uses, so Google Vision can OCR page-by-page (Vision's sync
 * REST endpoint only accepts images, not PDFs, without a GCS round-trip).
 */
function pdfToImages(filePath) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-ocr-'));
    const script = `
import sys, json
from pdf2image import convert_from_path
pages = convert_from_path(sys.argv[1], dpi=200)
paths = []
for i, p in enumerate(pages[:3]):
    out = sys.argv[2] + f"/page_{i}.png"
    p.save(out, 'PNG')
    paths.append(out)
print(json.dumps(paths))
`;
    execFile('python3', ['-c', script, filePath, tmpDir], { timeout: 60000 }, (err, stdout) => {
      if (err) return reject(err);
      try { resolve(JSON.parse(stdout.trim())); } catch (e) { reject(e); }
    });
  });
}

/** Google Vision pipeline: image (or rasterized PDF pages) -> text -> shared field parser. */
async function runGoogleVision(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let bestText = '', bestConfidence = 0;

  if (ext === '.pdf') {
    const pages = await pdfToImages(filePath);
    for (const pagePath of pages) {
      const { rawText, confidence } = await googleVision.detectTextFromFile(pagePath);
      if (rawText.length > bestText.length) { bestText = rawText; bestConfidence = confidence; }
      fs.unlinkSync(pagePath);
    }
  } else {
    const { rawText, confidence } = await googleVision.detectTextFromFile(filePath);
    bestText = rawText; bestConfidence = confidence;
  }

  const { fields, field_score, warnings } = await parseFieldsFromText(bestText);
  // Blend OCR confidence with field-completeness, same as the Tesseract path —
  // otherwise a label with mostly-null fields can still report ~88% confidence
  // purely because Vision read the text cleanly.
  const finalConfidence = Math.round((bestConfidence * 0.7 + field_score * 0.3) * 10) / 10;
  return {
    rawText: bestText,
    confidence: finalConfidence,
    ocr_confidence: bestConfidence,
    field_score,
    rotation_applied: 0,
    fields,
    warnings,
    engine: 'google_vision',
  };
}

/**
 * Engine-selection pipeline (NO Gemini) — selects OCR engine per system_settings
 * (`ocr_engine_primary`, default 'google_vision'), with automatic fallback
 * to Tesseract on any failure (unconfigured key, quota, network, etc).
 * Exported as `extractWaybillDataRaw` for callers that want the regex-only
 * result; most callers should use `extractWaybillData` / `extractWaybillDataBatch`
 * below instead, which add the Gemini accuracy layer on top of this.
 */
async function extractWaybillDataRaw(filePath) {
  const primary = await getSetting('ocr_engine_primary', 'google_vision');

  let result;
  if (primary === 'google_vision' && googleVision.isConfigured()) {
    try {
      result = await runGoogleVision(filePath);
    } catch (err) {
      logger.warn('Google Vision OCR failed — falling back to Tesseract', { error: err.message });
    }
  }
  if (!result) result = await runTesseract(filePath);
  return { ...result, fields: normalizeCarrierSpecific(result.fields) };
}

/** Whether the Gemini enrichment layer should run, per env + an optional system_settings override. */
async function isGeminiEnrichmentEnabled() {
  if (!gemini.isConfigured()) return false;
  // Allows an admin to flip this off via system_settings without removing the
  // API key (e.g. to temporarily go back to regex-only during a Gemini outage).
  return (await getSetting('ocr_gemini_enrichment', '1')) !== '0';
}

/**
 * Merge a Gemini-extracted fields object on top of the regex-parsed fields.
 * Gemini wins for any field it confidently filled (non-null/non-empty);
 * the regex value is kept untouched for anything Gemini left null — this
 * means a Gemini failure or partial answer can only ever IMPROVE or match
 * the regex-only result, never make it worse.
 */
function mergeGeminiFields(regexFields, geminiFields) {
  if (!geminiFields) return regexFields;
  const merged = { ...regexFields };
  for (const key of Object.keys(geminiFields)) {
    const v = geminiFields[key];
    if (v !== null && v !== undefined && v !== '') merged[key] = v;
  }
  return normalizeCarrierSpecific(merged);
}

/**
 * carrier_specific holds carrier-unique extras (FedEx CAD/EWO, UPS zone, DHL
 * account, Aramex flags — see services/waybillFieldSchema.js) and must always
 * reach the DB/API as a JSON-encoded string, never a bare object. Both the
 * Python regex parsers and Gemini are expected to already return a string,
 * but this is a cheap defensive normalization in case either side ever
 * returns a parsed object instead.
 */
function normalizeCarrierSpecific(fields) {
  const v = fields.carrier_specific;
  if (v !== null && v !== undefined && typeof v === 'object') {
    return { ...fields, carrier_specific: JSON.stringify(v) };
  }
  return fields;
}

/** Recompute field_score + blended confidence after merging in Gemini's fields. */
function rescoreResult(result, mergedFields, geminiUsed) {
  const field_score = computeFieldScore(mergedFields);
  const confidence = Math.round((result.ocr_confidence * 0.7 + field_score * 0.3) * 10) / 10;
  return {
    ...result,
    fields: mergedFields,
    field_score,
    confidence,
    engine: geminiUsed ? `${result.engine}+gemini` : result.engine,
    gemini_used: geminiUsed,
  };
}

/**
 * Main single-file entry point. Runs the existing OCR/regex pipeline, then —
 * if Gemini is configured and enabled — sends the raw OCR text to Gemini in
 * ONE extra request to fill/correct fields the regexes missed. Any Gemini
 * failure (bad key, quota exhausted, timeout, malformed response, etc.) is
 * caught and logged; the function still resolves with the regex-only result
 * rather than rejecting, so OCR availability is never coupled to Gemini's.
 */
async function extractWaybillData(filePath) {
  const result = await extractWaybillDataRaw(filePath);

  if (!(await isGeminiEnrichmentEnabled()) || !result.rawText) return result;

  try {
    const geminiFields = await gemini.extractFields(result.rawText);
    if (!geminiFields) return result; // Gemini itself already logged/handled the failure
    const merged = mergeGeminiFields(result.fields, geminiFields);
    return rescoreResult(result, merged, true);
  } catch (err) {
    // Defensive — gemini.extractFields() is designed to never throw, but if
    // it somehow does, OCR must still succeed on the regex result alone.
    logger.warn('Gemini enrichment threw unexpectedly — continuing with regex-only fields', { file: filePath, error: err.message });
    return result;
  }
}

/**
 * Batch entry point for multiple files (bulk/ZIP uploads) — runs OCR on every
 * file independently (one file's failure never blocks the others), then
 * enriches ALL of them with a SINGLE batched Gemini call (internally chunked
 * by geminiService to protect accuracy + respect free-tier rate limits)
 * instead of one Gemini request per file. This is the "send multiple AWBs in
 * a single request" batch-processing path.
 *
 * Returns an array the same length/order as filePaths. Per-file OCR failures
 * come back as `{ error: <message> }` instead of throwing, so the caller can
 * keep processing the rest of the batch (mirrors bulkUploadService's existing
 * per-file try/catch behavior, just centralized here).
 */
async function extractWaybillDataBatch(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return [];

  const ocrResults = await Promise.all(filePaths.map(async (filePath) => {
    try {
      const result = await extractWaybillDataRaw(filePath);
      return { ok: true, result };
    } catch (err) {
      logger.error('OCR failed for file in batch', { file: filePath, error: err.message });
      return { ok: false, error: err.message };
    }
  }));

  if (!(await isGeminiEnrichmentEnabled())) {
    return ocrResults.map(r => (r.ok ? r.result : { error: r.error }));
  }

  // Only enrich files whose OCR actually produced usable text.
  const enrichTargets = [];
  ocrResults.forEach((r, idx) => {
    if (r.ok && r.result.rawText) enrichTargets.push(idx);
  });

  let geminiFieldsByIdx = new Map();
  if (enrichTargets.length) {
    try {
      const texts = enrichTargets.map(idx => ocrResults[idx].result.rawText);
      const batchFields = await gemini.extractFieldsBatch(texts);
      enrichTargets.forEach((idx, j) => geminiFieldsByIdx.set(idx, batchFields[j]));
    } catch (err) {
      // extractFieldsBatch() is designed to never throw (it resolves nulls
      // per-item on failure), but guard anyway — a Gemini-wide outage must
      // never take down the whole bulk-upload batch.
      logger.warn('Gemini batch enrichment failed entirely — continuing with regex-only fields for this batch', { error: err.message, fileCount: filePaths.length });
    }
  }

  return ocrResults.map((r, idx) => {
    if (!r.ok) return { error: r.error };
    const geminiFields = geminiFieldsByIdx.get(idx) || null;
    if (!geminiFields) return r.result;
    const merged = mergeGeminiFields(r.result.fields, geminiFields);
    return rescoreResult(r.result, merged, true);
  });
}

module.exports = {
  extractWaybillData, extractWaybillDataBatch, extractWaybillDataRaw,
  runTesseract, runGoogleVision,
};