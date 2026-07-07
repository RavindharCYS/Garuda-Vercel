// services/excelImport/validation.js — Excel Shipment Import validation rules
// Implements the "Validation Rules" section of the requirement doc: skip rows
// missing Tracking Number / Shipper Name / Consignee Name, and report why.
// Duplicate detection (against existing shipments) is handled by the caller
// using utils/validators.js#isDuplicateAWB, since that check needs a live DB
// lookup and this module stays a pure function of the mapped row.
'use strict';

function validateShipmentRecord(record) {
  const errors = [];

  if (!record.carrier_tracking_number) errors.push('Missing Tracking Number');
  if (!record.from_name) errors.push('Missing Shipper Name');
  if (!record.to_name) errors.push('Missing Consignee Name');

  return { valid: errors.length === 0, errors };
}

module.exports = { validateShipmentRecord };
