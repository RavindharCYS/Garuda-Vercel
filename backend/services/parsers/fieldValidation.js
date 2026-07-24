// services/fieldValidation.js — JS port of services/parsers/field_validation.py
//
// Why this exists as a duplicate rather than calling the Python module:
// ocrService.js recomputes field_score right after merging in Gemini's
// fields (which can change values the Python sanity check already ran
// against), and shelling back out to Python just for this would add a
// second subprocess round-trip to every OCR request. Keep both in sync
// when adding a new check — field_validation.py's docstring says the
// same.
'use strict';

const POSTAL_FORMATS = {
  India: [/^\d{6}$/, '6 digits'],
  USA: [/^\d{5}(-\d{4})?$/, '5 digits (optionally -NNNN)'],
  Canada: [/^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/, 'A1A 1A1'],
  Australia: [/^\d{4}$/, '4 digits'],
  UAE: [null, null], // no formal postal code system — never flag
  UK: [/^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$/, 'e.g. SW1A 1AA'],
  Singapore: [/^\d{6}$/, '6 digits'],
};

const PHONE_DIGIT_RANGE = {
  India: [10, 12], USA: [10, 11], Canada: [10, 11], Australia: [9, 11],
  UAE: [9, 12], UK: [10, 12], Singapore: [8, 10],
};

const MAX_PLAUSIBLE_WEIGHT_KG = 1000;
const MIN_PLAUSIBLE_WEIGHT_KG = 0.01;
const MAX_PLAUSIBLE_PIECES = 100;
const MAX_PLAUSIBLE_DECLARED_VALUE = 10_000_000;

function parseDateLoose(value) {
  if (!value) return null;
  const v = value.trim();
  let m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // ambiguous MM/DD vs DD/MM — try MM/DD first
  if (m) {
    const month = Number(m[1]), day = Number(m[2]), year = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      // JS Date silently rolls invalid combos (e.g. month 13, day 32) into
      // the next month/year rather than failing — reject anything that
      // doesn't round-trip back to the same month/day, since Python's
      // strptime (which the equivalent Python check uses) rejects those
      // outright rather than rolling them over.
      if (d.getMonth() === month - 1 && d.getDate() === day) return d;
    }
    return null;
  }
  m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const d = new Date(year, month - 1, day);
      if (d.getMonth() === month - 1 && d.getDate() === day) return d;
    }
  }
  return null;
}

/**
 * @param {object} fields
 * @returns {{field: string, message: string, severity: 'warn'|'flag'}[]}
 */
function validateFieldConsistency(fields) {
  const warnings = [];
  const add = (field, message, severity = 'warn') => warnings.push({ field, message, severity });

  for (const side of ['from', 'to']) {
    const country = fields[`${side}_country`];
    const postal = fields[`${side}_postal`];
    if (country && postal && POSTAL_FORMATS[country]) {
      const [pattern, shape] = POSTAL_FORMATS[country];
      if (pattern && !pattern.test(String(postal).trim())) {
        add(`${side}_postal`, `"${postal}" doesn't look like a ${country} postal code (expected ${shape})`, 'flag');
      }
    }
  }

  for (const side of ['from', 'to']) {
    const country = fields[`${side}_country`];
    const phone = fields[`${side}_contact`];
    if (country && phone && PHONE_DIGIT_RANGE[country]) {
      const digitCount = String(phone).replace(/\D/g, '').length;
      const [lo, hi] = PHONE_DIGIT_RANGE[country];
      if (digitCount < lo || digitCount > hi) {
        add(`${side}_contact`,
          `"${phone}" has ${digitCount} digits — unusual for a ${country} phone number (expected ${lo}-${hi})`);
      }
    }
  }

  const weight = fields.actual_weight;
  if (weight !== null && weight !== undefined) {
    const w = Number(weight);
    if (!isNaN(w)) {
      if (w > MAX_PLAUSIBLE_WEIGHT_KG) add('actual_weight', `${w}kg is unusually heavy for a parcel — check for a misplaced decimal`, 'flag');
      else if (w < MIN_PLAUSIBLE_WEIGHT_KG) add('actual_weight', `${w}kg is implausibly light — check the unit/decimal`, 'flag');
    }
  }

  const actual = fields.actual_weight, billing = fields.billing_weight;
  if (actual !== null && actual !== undefined && billing !== null && billing !== undefined) {
    const a = Number(actual), b = Number(billing);
    if (!isNaN(a) && !isNaN(b) && b > 0 && a / b > 3) {
      add('billing_weight', `Billing weight (${b}kg) is much lower than actual weight (${a}kg)`);
    }
  }

  const pieces = fields.pieces;
  if (pieces !== null && pieces !== undefined) {
    const p = parseInt(pieces, 10);
    if (!isNaN(p)) {
      if (p <= 0) add('pieces', `${p} pieces isn't valid — expected a positive integer`, 'flag');
      else if (p > MAX_PLAUSIBLE_PIECES) add('pieces', `${p} pieces is unusually high — check for a misread`);
    }
  }

  const value = fields.declared_value;
  if (value !== null && value !== undefined) {
    const v = Number(value);
    if (!isNaN(v)) {
      if (v <= 0) add('declared_value', `Declared value ${v} isn't valid — expected a positive amount`, 'flag');
      else if (v > MAX_PLAUSIBLE_DECLARED_VALUE) add('declared_value', `Declared value ${v} is unusually high — check for a misplaced decimal`);
    }
  }

  const shipDate = fields.ship_date;
  const parsed = shipDate ? parseDateLoose(shipDate) : null;
  if (shipDate && !parsed) {
    add('ship_date', `"${shipDate}" doesn't look like a valid date`, 'flag');
  } else if (parsed) {
    const now = new Date();
    const twoWeeksOut = new Date(now.getTime() + 14 * 86400000);
    const tenYearsAgo = new Date(now.getTime() - 3650 * 86400000);
    if (parsed > twoWeeksOut) add('ship_date', `"${shipDate}" is more than 2 weeks in the future — check for a misread`);
    else if (parsed < tenYearsAgo) add('ship_date', `"${shipDate}" is more than 10 years old — check for a misread (e.g. 2-digit year)`);
  }

  if (fields.from_name && fields.to_name &&
      String(fields.from_name).trim().toUpperCase() === String(fields.to_name).trim().toUpperCase()) {
    add('to_name', 'Sender and receiver names are identical — likely a mis-extraction', 'flag');
  }

  return warnings;
}

module.exports = { validateFieldConsistency };
