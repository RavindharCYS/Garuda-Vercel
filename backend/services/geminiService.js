// services/geminiService.js — Gemini-powered AWB field extraction.
//
// Purpose: the regex parsers in services/parsers/ are fast and free but brittle
// against OCR noise (rotated scans, smudged labels, unfamiliar layouts). This
// service sends the *raw OCR text* to Gemini and asks it to fill the SAME
// field schema (services/waybillFieldSchema.js) using its language
// understanding instead of fixed regexes — used as an accuracy layer on top
// of (not a replacement for) the existing OCR pipeline. See ocrService.js for
// how the two are merged, with the regex result always kept as a fallback.
//
// Configuration (.env):
//   GEMINI_API_KEY        — required. Get a free key at https://aistudio.google.com/apikey
//   GEMINI_MODEL           — optional, default 'gemini-2.5-flash'
//   GEMINI_BATCH_SIZE      — optional, default 5. Max AWBs per single Gemini
//                            request. Kept deliberately small because
//                            extraction accuracy degrades as the batch grows
//                            (see extractFieldsBatch below) — larger jobs are
//                            automatically split into multiple chunked calls.
//   GEMINI_MAX_RETRIES     — optional, default 3 (retries on 429/5xx/network errors)
//   GEMINI_TIMEOUT_MS      — optional, default 30000
//
// If GEMINI_API_KEY is not set, isConfigured() returns false and every
// caller in this codebase falls back to the regex-only result — Gemini is
// strictly additive, never a hard dependency.
'use strict';

const axios  = require('axios');
const logger = require('../utils/logger');
const { logApiCall } = require('./apiHealth');
const { recordSchema, batchSchema, normalizeFields } = require('./waybillFieldSchema');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function getModel()       { return process.env.GEMINI_MODEL || 'gemini-2.5-flash'; }
function getBatchSize()   { return clampInt(process.env.GEMINI_BATCH_SIZE, 5, 1, 10); }
function getMaxRetries()  { return clampInt(process.env.GEMINI_MAX_RETRIES, 3, 0, 6); }
function getTimeoutMs()   { return clampInt(process.env.GEMINI_TIMEOUT_MS, 30000, 5000, 120000); }

function clampInt(val, fallback, min, max) {
  const n = parseInt(val, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

const SYSTEM_INSTRUCTION = `You are an expert AWB (Air Waybill) / shipping label data-extraction engine for a courier management system.
You will be given raw OCR text extracted from a scanned waybill/shipping label (FedEx, DHL, UPS, or other carriers). The OCR text may contain noise, misreads, broken line breaks, or merged words — use context and shipping-document conventions to infer the correct value anyway.

Rules:
- Extract ONLY information that is actually present or strongly implied in the text. Never invent tracking numbers, names, or addresses.
- If a field is not present or you are not reasonably confident, return null for it — do not guess.
- "carrier_tracking_number" is the carrier's own AWB/tracking number (e.g. FedEx 12-digit, UPS "1Z..." 18-char, DHL 10-digit), NOT an internal reference or invoice number.
- "from_*" fields describe the SHIPPER/SENDER. "to_*" fields describe the RECEIVER/CONSIGNEE.
- Normalize country names to their common English form (e.g. "United States" -> "USA").
- "actual_weight" and "billing_weight" are numeric only (no units in the value itself); put the unit in "weight_unit".
- "ship_date" should be returned exactly as printed on the label (do not reformat or guess a different date format).
- "pieces" is an integer count of packages, default 1 if not stated.

Garuda Master Waybill fields (return null for any of these not present — most labels won't have all of them):
- "sender_company" / "receiver_company": the company/organization name printed above or alongside the person's name in the shipper/consignee block (distinct from "from_name"/"to_name", which are the person's name).
- "receiver_attention": the person named after an "ATTN:" / "Attention:" / "C/O" line in the receiver block.
- "reference_number": the shipper's own reference/order/PO number (often labeled "REF", "Your Reference", or "Customer Ref") — NOT the carrier tracking number and NOT the invoice number.
- "customs_value" / "carriage_value": numeric values only, found near "Customs Value", "Value for Customs", or "Carriage Value" / "Freight Value" labels.
- "origin_code" / "destination_code": short carrier station/airport/hub codes (e.g. "MAA", "YYZ", "LHR") printed near the routing or barcode section, NOT the full city name.
- "package_length" / "package_width" / "package_height": individual numeric dimensions (in the unit printed, do not convert) if given separately rather than as a combined "dimensions" string.
- "service_code": the carrier's short internal service code (e.g. FedEx "IP", "IE"; UPS "11"), distinct from the human-readable "service_type".
- "route_code": any routing/sort code printed on the label (often near a barcode), distinct from origin/destination station codes.
- "billing_type": how the shipment is billed — typically one of "Prepaid", "Collect", or "Third Party" — only if explicitly stated.
- "account_number": the carrier billing account number, if printed (distinct from carrier_tracking_number and invoice_number).
- "carrier_specific": ANY other carrier-unique label text that doesn't map to a field above (e.g. FedEx "CAD"/"EWO" codes, UPS zone codes, DHL account references, Aramex flags). Return this as a JSON-encoded STRING (not a nested object) with the carrier name as the top-level key, e.g. "{\\"fedex\\":{\\"cad\\":\\"260478344\\",\\"ewo\\":\\"IP EOD\\"}}". If nothing carrier-specific is found, return null.`;

/**
 * Build the literal prompt body for a batch of AWBs, in the
 * "AWB 1 / ======== / <text>" format.
 */
function buildBatchPrompt(rawTexts) {
  const blocks = rawTexts.map((text, i) =>
    `AWB ${i + 1}\n========\n\n${(text || '').trim().slice(0, 8000)}`
  );
  return [
    `Below are ${rawTexts.length} separate AWB/waybill OCR text blocks, each preceded by an "AWB N" header.`,
    `Extract the shipment fields for EACH one independently.`,
    `Return a JSON array with EXACTLY ${rawTexts.length} objects, in the SAME ORDER as the AWBs below (array index 0 = AWB 1, index 1 = AWB 2, etc.). Do not skip, merge, or reorder entries even if two AWBs look similar.`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/** Low-level call to the Gemini generateContent REST endpoint with retry/backoff. */
async function callGemini(promptText, responseSchema) {
  if (!isConfigured()) throw new Error('GEMINI_API_KEY not configured');

  const url = `${API_BASE}/${getModel()}:generateContent`;
  const body = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [{ text: promptText }] }],
    generationConfig: {
      temperature: 0.1,            // low temperature — this is extraction, not creative writing
      responseMimeType: 'application/json',
      responseSchema,
    },
  };

  const maxRetries = getMaxRetries();
  let lastErr;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const start = Date.now();
    try {
      const resp = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        timeout: getTimeoutMs(),
      });

      logApiCall({ provider: 'gemini', endpoint: 'generateContent', success: true, statusCode: resp.status, responseMs: Date.now() - start });

      const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        const finishReason = resp.data?.candidates?.[0]?.finishReason;
        throw new Error(`Empty response from Gemini${finishReason ? ` (finishReason: ${finishReason})` : ''}`);
      }
      const parsed = parseJsonLoose(text);
      logger.info(`[Gemini] call succeeded in ${Date.now() - start}ms (${Array.isArray(parsed) ? parsed.length + ' records' : '1 record'})`);
      return parsed;

    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = !status || status === 429 || status >= 500;

      logApiCall({
        provider: 'gemini', endpoint: 'generateContent', success: false,
        statusCode: status, responseMs: Date.now() - start,
        error: err.response?.data?.error?.message || err.message,
      });

      if (!retryable || attempt === maxRetries) break;

      // Exponential backoff with jitter. Honor Retry-After on 429s if present.
      const retryAfterHeader = parseInt(err.response?.headers?.['retry-after'], 10);
      const backoffMs = !Number.isNaN(retryAfterHeader)
        ? retryAfterHeader * 1000
        : Math.min(15000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 300);

      logger.warn(`[Gemini] attempt ${attempt + 1}/${maxRetries + 1} failed (${status || err.message}) — retrying in ${backoffMs}ms`);
      await sleep(backoffMs);
    }
  }

  throw new Error(`Gemini request failed after ${maxRetries + 1} attempt(s): ${describeGeminiError(lastErr)}`);
}

/** Turn a raw axios error into an actionable message — the most common failure
 *  modes (bad key, model not accessible to this key/region, wrong endpoint)
 *  all come back as generic-looking 400/401/403/404s otherwise. */
function describeGeminiError(err) {
  const status = err?.response?.status;
  const apiMsg = err?.response?.data?.error?.message || err?.message;
  if (status === 400 || status === 401 || status === 403) {
    return `${apiMsg} (HTTP ${status} — check GEMINI_API_KEY is valid and the Generative Language API is enabled for it)`;
  }
  if (status === 404) {
    return `${apiMsg} (HTTP 404 — GEMINI_MODEL="${getModel()}" may not exist or isn't available to this API key; try gemini-2.0-flash or gemini-2.5-flash-lite)`;
  }
  if (!status) {
    return `${apiMsg} (no HTTP response — check the server has outbound network access to generativelanguage.googleapis.com)`;
  }
  return apiMsg;
}

/** Strip markdown code fences defensively, then JSON.parse. Throws a descriptive error on failure. */
function parseJsonLoose(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Gemini returned invalid JSON: ${e.message}`);
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Extract fields for a SINGLE AWB's raw OCR text.
 * Returns a normalized fields object, or null if Gemini failed (caller should
 * fall back to the regex-parsed fields in that case — this never throws).
 */
async function extractFields(rawText) {
  if (!rawText || !rawText.trim()) return null;
  try {
    const raw = await callGemini(
      `Extract the shipment fields from this single AWB/waybill OCR text:\n\n${rawText.trim().slice(0, 8000)}`,
      recordSchema()
    );
    return normalizeFields(Array.isArray(raw) ? raw[0] : raw);
  } catch (err) {
    logger.warn('[Gemini] single-record extraction failed — caller will fall back to regex fields', { error: err.message });
    return null;
  }
}

/**
 * Extract fields for MULTIPLE AWBs in as few Gemini requests as possible.
 *
 * Per Gemini's free-tier rate limits and observed accuracy, large batches are
 * automatically split into chunks of GEMINI_BATCH_SIZE (default 5) — sending
 * 30 AWBs in one request measurably degrades per-record accuracy (the model
 * starts conflating fields between adjacent records), so this trades a few
 * extra HTTP calls for keeping each individual request's accuracy high.
 *
 * Returns an array the SAME LENGTH as rawTexts, in the same order. Any
 * individual record that fails (including a whole chunk failing) comes back
 * as `null` at that position rather than throwing — callers should treat
 * `null` as "fall back to regex fields for this one" exactly like
 * extractFields() does for a single record.
 */
async function extractFieldsBatch(rawTexts) {
  if (!Array.isArray(rawTexts) || rawTexts.length === 0) return [];
  if (rawTexts.length === 1) return [await extractFields(rawTexts[0])];

  const batchSize = getBatchSize();
  const chunks = chunk(rawTexts, batchSize);
  const results = new Array(rawTexts.length).fill(null);
  let offset = 0;

  for (const group of chunks) {
    const indices = group.map((_, i) => offset + i);
    try {
      const raw = await callGemini(buildBatchPrompt(group), batchSchema());
      if (!Array.isArray(raw)) throw new Error('Gemini batch response was not a JSON array');

      if (raw.length !== group.length) {
        // Count mismatch — the model dropped/merged/split records. Don't trust
        // positional alignment in that case; fall back to per-item calls for
        // this chunk instead of silently misassigning fields to the wrong AWB.
        logger.warn(`[Gemini] batch returned ${raw.length} records for ${group.length} AWBs — falling back to per-item extraction for this chunk`);
        await fillIndividually(group, indices, results);
      } else {
        raw.forEach((rec, j) => { results[indices[j]] = normalizeFields(rec); });
      }
    } catch (err) {
      logger.warn('[Gemini] batch extraction failed for chunk — falling back to per-item extraction', { error: err.message, chunkSize: group.length });
      await fillIndividually(group, indices, results);
    }
    offset += group.length;
  }

  return results;
}

/** Fallback: re-run failed/misaligned chunk members one at a time so a single bad AWB doesn't void the whole chunk. */
async function fillIndividually(texts, indices, results) {
  for (let i = 0; i < texts.length; i++) {
    results[indices[i]] = await extractFields(texts[i]);
  }
}

module.exports = { isConfigured, extractFields, extractFieldsBatch, getBatchSize };