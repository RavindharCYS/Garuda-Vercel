// utils/generateGE.js — GE tracking number generator
'use strict';

const crypto = require('crypto');

/**
 * Generates a unique random Garuda Express tracking number.
 * Format: GE + 7 random digits (e.g. GE2847391)
 * Total: 9 chars — unpredictable, collision-resistant via DB check.
 */
async function generateGENumber(db) {
  let geNum;
  let attempts = 0;
  do {
    // Generate 7 cryptographically random digits
    const rand = parseInt(crypto.randomBytes(4).readUInt32BE(0) % 9000000) + 1000000;
    geNum = `GE${rand}`;
    const exists = await db.get('SELECT 1 FROM shipments WHERE ge_tracking_number = ?', [geNum]);
    if (!exists) break;
    attempts++;
  } while (attempts < 100);
  return geNum;
}

/**
 * Validates a GE tracking number: GE + exactly 7 digits.
 * Valid: GE2847391, GE1000000, GE9999999
 */
function isValidGENumber(str) {
  if (!str) return false;
  return /^GE\d{7}$/.test(str.trim().toUpperCase());
}

module.exports = { generateGENumber, isValidGENumber };
