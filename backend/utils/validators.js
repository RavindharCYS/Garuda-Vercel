// utils/validators.js — Bulk upload validation pipeline helpers
// (Carrier Detection, AWB Validation, Tracking Validation, Country Validation, Weight Validation)
'use strict';

const db = require('./db');

// Known AWB/tracking formats observed in real waybills (see requirement spec section 7).
const AWB_PATTERNS = [
  { carrier: 'UPS',   regex: /^1Z[A-Z0-9]{16}$/i },                 // 1ZH4Y8210404603959
  { carrier: 'FedEx', regex: /^\d{12}$/ },                          // 889684647537
  { carrier: 'DHL',   regex: /^\d{10}$/ },                          // 2020372535
  { carrier: 'Aramex',     regex: /^\d{10,12}$/ },
  { carrier: 'BlueDart',   regex: /^[0-9]{8,11}$/ },
  { carrier: 'DTDC',       regex: /^[A-Z0-9]{8,12}$/i },
  { carrier: 'Delhivery',  regex: /^[0-9]{12,14}$/ },
  { carrier: 'IndiaPost',  regex: /^[A-Z]{2}\d{9}[A-Z]{2}$/i },      // EE123456789IN style
];

const COUNTRY_LIST = [
  'India','United States','USA','United Kingdom','UK','Canada','Australia','Singapore',
  'Hong Kong','Ireland','Germany','France','Japan','China','UAE','New Zealand','Malaysia',
  'Netherlands','Italy','Spain','Switzerland','South Korea','Thailand','Indonesia','Vietnam',
  'Philippines','Sri Lanka','Bangladesh','Nepal','Qatar','Saudi Arabia','Kuwait','Oman','Bahrain',
];

/** Detect carrier from an AWB/tracking number using known format patterns. */
function detectCarrierFromAWB(awb) {
  if (awb == null || awb === '') return null;
  const clean = String(awb).trim().replace(/\s+/g, '');
  for (const p of AWB_PATTERNS) {
    if (p.regex.test(clean)) return p.carrier;
  }
  return null;
}

/** Validate AWB format. If carrierHint provided, validates against that carrier's pattern specifically. */
function validateAWB(awb, carrierHint) {
  if (awb == null || String(awb).trim().length < 6) return { valid: false, reason: 'AWB number missing or too short' };
  const clean = String(awb).trim().replace(/\s+/g, '');
  if (carrierHint) {
    const p = AWB_PATTERNS.find(x => x.carrier.toLowerCase() === String(carrierHint).toLowerCase());
    if (p && !p.regex.test(clean)) return { valid: false, reason: `AWB does not match expected ${carrierHint} format` };
  }
  const matched = detectCarrierFromAWB(clean);
  if (!matched && !carrierHint) return { valid: true, warning: 'Unrecognized AWB format — carrier could not be auto-detected' };
  return { valid: true };
}

/** Tracking number validation is currently the same format check as AWB (carrier tracking # IS the AWB in this system). */
function validateTrackingNumber(num) {
  return validateAWB(num);
}

function validateCountry(country) {
  if (!country) return { valid: false, reason: 'Country is required' };
  const ok = COUNTRY_LIST.some(c => c.toLowerCase() === country.trim().toLowerCase());
  return ok ? { valid: true } : { valid: false, reason: `"${country}" is not a recognized country name` };
}

function validateWeight(weight) {
  const n = parseFloat(weight);
  if (isNaN(n)) return { valid: false, reason: 'Weight must be numeric' };
  if (n <= 0 || n > 1000) return { valid: false, reason: 'Weight out of plausible range (0–1000 kg)' };
  return { valid: true };
}

/** Duplicate detection — checks if AWB/tracking number already exists in shipments. */
async function isDuplicateAWB(awb) {
  if (awb == null || awb === '') return false;
  const clean = String(awb).trim();
  const row = await db.get(
    'SELECT id FROM shipments WHERE carrier_tracking_number = ? OR awb_number = ?',
    [clean, clean]
  );
  return !!row;
}

/** Runs the full validation pipeline used by the Bulk Upload module. Returns { valid, errors[], warnings[], detectedCarrier }. */
async function runValidationPipeline(record) {
  const errors = [];
  const warnings = [];

  const awb = record.carrier_tracking_number || record.awb_number;
  const detectedCarrier = record.carrier || detectCarrierFromAWB(awb);

  const awbCheck = validateAWB(awb, record.carrier);
  if (!awbCheck.valid) errors.push(awbCheck.reason);
  if (awbCheck.warning) warnings.push(awbCheck.warning);

  if (await isDuplicateAWB(awb)) errors.push('Duplicate AWB / tracking number already exists in system');

  if (record.to_country) {
    const c = validateCountry(record.to_country);
    if (!c.valid) warnings.push(c.reason);
  }
  if (record.from_country) {
    const c = validateCountry(record.from_country);
    if (!c.valid) warnings.push(`Origin: ${c.reason}`);
  }

  if (record.actual_weight != null && record.actual_weight !== '') {
    const w = validateWeight(record.actual_weight);
    if (!w.valid) errors.push(w.reason);
  }

  if (!record.service_type || !String(record.service_type).trim()) {
    warnings.push('Service type not detected');
  }

  return { valid: errors.length === 0, errors, warnings, detectedCarrier };
}

module.exports = {
  detectCarrierFromAWB, validateAWB, validateTrackingNumber,
  validateCountry, validateWeight, isDuplicateAWB, runValidationPipeline,
  COUNTRY_LIST, AWB_PATTERNS,
};