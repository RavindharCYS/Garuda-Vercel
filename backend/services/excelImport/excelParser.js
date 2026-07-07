// services/excelImport/excelParser.js — Excel Shipment Import (requirement doc §Backend Changes)
// Reads a vendor Excel file (.xlsx/.xls) from disk and returns raw row objects
// keyed by header text, exactly as they appear in the workbook. Vendor-specific
// column-name mapping happens downstream in iclParser.js / worldFirstParser.js —
// this module only knows how to open a workbook and iterate its first sheet.
'use strict';

const fs = require('fs');
const XLSX = require('xlsx');

/**
 * Reads the first sheet of an Excel workbook and returns an array of row
 * objects (header text -> cell value). Blank cells come back as '' (not
 * undefined) so downstream code can treat "missing" and "blank" the same way.
 */
function readExcelRows(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error('Excel file not found on disk');
  }

  let workbook;
  try {
    workbook = XLSX.readFile(filePath, { cellDates: false });
  } catch (err) {
    throw new Error('Could not read Excel file — is it a valid .xlsx/.xls?');
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('Excel workbook has no sheets');

  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: true });
  return rows;
}

/**
 * Builds a case/whitespace-insensitive lookup map from a raw row so vendor
 * parsers can tolerate header variations (extra spaces, different casing)
 * without needing an exact string match.
 */
function buildLookup(row) {
  const map = {};
  for (const [key, value] of Object.entries(row)) {
    const norm = String(key).trim().toLowerCase().replace(/\s+/g, ' ');
    map[norm] = value;
  }
  return map;
}

/** Returns the first non-empty value found for any of the given header aliases. */
function pick(lookup, aliases) {
  for (const alias of aliases) {
    const norm = String(alias).trim().toLowerCase().replace(/\s+/g, ' ');
    const v = lookup[norm];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

module.exports = { readExcelRows, buildLookup, pick };
