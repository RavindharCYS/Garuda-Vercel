// services/waybillFieldSchema.js — Single source of truth for the AWB field
// shape shared between the Python regex parser (services/parsers/base_parser.py)
// and the Gemini enrichment service (services/geminiService.js).
//
// Keeping ONE definition here means the Gemini structured-output schema can
// never drift out of sync with what the rest of the system (validators,
// bulk import, shipments table) actually expects.
'use strict';

// Mirrors parsers/base_parser.py blank_fields() — keep in sync if that changes.
const FIELD_DEFS = [
  ['from_name',               'STRING'],
  ['from_address',            'STRING'],
  ['from_contact',            'STRING'],
  ['from_city',                'STRING'],
  ['from_state',               'STRING'],
  ['from_country',             'STRING'],
  ['from_postal',              'STRING'],
  ['to_name',                  'STRING'],
  ['to_address',               'STRING'],
  ['to_contact',               'STRING'],
  ['to_city',                  'STRING'],
  ['to_state',                 'STRING'],
  ['to_country',               'STRING'],
  ['to_postal',                'STRING'],
  ['carrier',                  'STRING'],
  ['carrier_tracking_number',  'STRING'],
  ['ship_date',                'STRING'],   // free-form as printed on the label (e.g. "12/05/2026" or "2026-05-12")
  ['pieces',                   'INTEGER'],
  ['actual_weight',            'NUMBER'],
  ['billing_weight',           'NUMBER'],
  ['weight_unit',              'STRING'],
  // NOTE: dimensions and invoice_number are deliberately NOT in this list.
  // Both were the most common source of bad OCR reads on real waybills
  // (garbled dimension strings, misread invoice numbers) — rather than ask
  // Gemini/regex to keep guessing at fields it consistently gets wrong,
  // these are simply never extracted from the waybill at all and stay null
  // (blankFields() still defines the keys so downstream code — e.g. the
  // Excel-import pipeline, which fills `dimensions` from its own vendor
  // column and is unrelated to this schema — isn't affected).
  ['contents',                 'STRING'],
  ['service_type',             'STRING'],
  ['declared_value',           'NUMBER'],
  ['currency',                 'STRING'],

  // ── Garuda Master Waybill extensions ─────────────────────────────────────
  ['sender_company',           'STRING'],
  ['receiver_company',         'STRING'],
  ['receiver_attention',       'STRING'],   // "ATTN:" line on the receiver block
  ['reference_number',         'STRING'],   // customer/shipper reference (was already used downstream but missing here — now the single source of truth)
  ['customs_value',            'NUMBER'],
  ['carriage_value',           'NUMBER'],
  ['origin_code',              'STRING'],   // carrier station/airport code, e.g. "MAA"
  ['destination_code',         'STRING'],   // carrier station/airport code, e.g. "YYZ"
  ['package_length',           'NUMBER'],
  ['package_width',            'NUMBER'],
  ['package_height',           'NUMBER'],
  ['service_code',             'STRING'],   // carrier's internal service code, e.g. FedEx "IP"
  ['route_code',               'STRING'],   // carrier routing/sort code
  ['billing_type',             'STRING'],   // e.g. "Prepaid" | "Collect" | "Third Party"
  ['account_number',           'STRING'],   // carrier billing account number
  // Carrier-unique fields that don't fit a common column (FedEx CAD/EWO, UPS
  // zone, DHL account, Aramex PPX, etc). Stored as a JSON-encoded STRING —
  // Gemini's structured-output schema can't express a free-form nested
  // object, so we ask it for a JSON string here and parse downstream.
  // Shape: {"fedex": {...}} | {"ups": {...}} | {"dhl": {...}} | {"aramex": {...}}
  ['carrier_specific',         'STRING'],
];

const FIELD_KEYS = FIELD_DEFS.map(([k]) => k);

// Mirrors parsers/base_parser.py SCORABLE_FIELDS — used to compute field_score.
// Deliberately NOT extended with the Garuda Master Waybill fields added below
// (sender_company, customs_value, route_code, etc.) — those are carrier- or
// shipment-type-dependent and routinely absent even on a perfectly-read
// label, so including them would make field_score punish good extractions.
const SCORABLE_FIELDS = [
  'from_name', 'from_address', 'from_city', 'from_country', 'from_postal',
  'to_name', 'to_address', 'to_city', 'to_country', 'to_postal',
  'carrier', 'carrier_tracking_number', 'actual_weight', 'contents',
];

// Mirrors ocr_worker.py MANDATORY_FIELDS.
const MANDATORY_FIELDS = ['carrier_tracking_number', 'to_name', 'to_country'];

/** Default/blank field object — mirrors parsers/base_parser.py blank_fields(). */
function blankFields() {
  return {
    from_name: null, from_address: null, from_contact: null,
    from_city: null, from_state: null, from_country: null, from_postal: null,
    to_name: null, to_address: null, to_contact: null,
    to_city: null, to_state: null, to_country: null, to_postal: null,
    carrier: null, carrier_tracking_number: null,
    ship_date: null, pieces: 1,
    actual_weight: null, billing_weight: null, weight_unit: 'kg',
    dimensions: null, contents: null,
    service_type: null, declared_value: null, currency: 'INR',
    invoice_number: null,
    // Garuda Master Waybill extensions
    sender_company: null, receiver_company: null, receiver_attention: null,
    reference_number: null,
    customs_value: null, carriage_value: null,
    origin_code: null, destination_code: null,
    package_length: null, package_width: null, package_height: null,
    service_code: null, route_code: null,
    billing_type: null, account_number: null,
    carrier_specific: null,
  };
}

/** field_score = (% of SCORABLE_FIELDS that are non-empty) — mirrors the Python formula exactly. */
function computeFieldScore(fields) {
  const detected = SCORABLE_FIELDS.filter(f => {
    const v = fields[f];
    return v !== null && v !== undefined && v !== '' && v !== 'null';
  }).length;
  return Math.round((detected / SCORABLE_FIELDS.length) * 1000) / 10;
}

/** Mirrors ocr_worker.py validate_fields() — mandatory-field warnings. */
function validateMandatoryFields(fields) {
  const labels = {
    carrier_tracking_number: 'Tracking number not detected',
    to_name: 'Receiver name not detected',
    to_country: 'Destination country not detected',
  };
  const warnings = [];
  for (const f of MANDATORY_FIELDS) {
    const v = fields[f];
    if (v === null || v === undefined || v === '' || v === 'null') {
      warnings.push(labels[f] || `${f} not detected`);
    }
  }
  return warnings;
}

/**
 * Coerce an arbitrary object (e.g. raw Gemini JSON) into a well-shaped fields
 * object: every key present, unknown keys dropped, numeric fields coerced to
 * Number (or null if not parseable), strings trimmed. Never throws — bad
 * input just results in nulls for the affected field.
 */
function normalizeFields(raw) {
  const out = blankFields();
  if (!raw || typeof raw !== 'object') return out;

  for (const [key, type] of FIELD_DEFS) {
    let v = raw[key];
    if (v === undefined || v === null || v === '' || v === 'null' || v === 'N/A' || v === 'n/a') continue;

    if (type === 'NUMBER' || type === 'INTEGER') {
      const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^\d.-]/g, ''));
      if (!Number.isNaN(n)) out[key] = type === 'INTEGER' ? Math.round(n) : n;
      continue;
    }

    // STRING
    out[key] = String(v).trim();
  }
  return out;
}

/**
 * Gemini `responseSchema` (OpenAPI-subset / Google AI Schema proto) for ONE
 * waybill record. Every field is nullable since OCR text frequently won't
 * contain every field, and we'd rather get an honest `null` than a
 * hallucinated value.
 */
function recordSchema() {
  const properties = {};
  for (const [key, type] of FIELD_DEFS) {
    properties[key] = { type, nullable: true };
  }
  return {
    type: 'OBJECT',
    properties,
    required: FIELD_KEYS,
  };
}

/** Gemini `responseSchema` for a BATCH call — a fixed-length array of record objects. */
function batchSchema(count) {
  return {
    type: 'ARRAY',
    items: recordSchema(),
    minItems: count,
    maxItems: count,
  };
}

module.exports = {
  FIELD_KEYS, SCORABLE_FIELDS, MANDATORY_FIELDS,
  blankFields, computeFieldScore, validateMandatoryFields,
  normalizeFields, recordSchema, batchSchema,
};