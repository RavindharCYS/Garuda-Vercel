// services/excelImport/shipmentMapper.js — normalized vendor row -> Garuda shipment record
// Converts the vendor-agnostic object produced by iclParser.js / worldFirstParser.js
// into the same shape routes/shipments.js already inserts into the `shipments`
// table, so Excel-imported shipments are indistinguishable downstream from
// ones created via OCR or the manual form (same GE number generation, same
// waybill generation, same tracking pipeline).
'use strict';

function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, ''));
  return Number.isNaN(n) ? null : n;
}

/** Normalizes DD/MM/YYYY (and DD-MM-YYYY) vendor dates into YYYY-MM-DD. Leaves anything else as-is. */
function toDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return s;
}

/**
 * Parses the vendor "Dimensions" column, which packs one or more box groups
 * into a single cell as "L*W*H*qty=weight", separated by ';' when a shipment
 * has more than one distinct box size — e.g.:
 *   "10.000*10.000*10.000*1=0.500"                                  -> 1 group,  1 piece
 *   "32.000*46.000*37.000*1=11.000; 45.000*61.000*34.000*1=19.000"  -> 2 groups, 2 pieces
 * Each group's own qty (the number right before "=") is what actually
 * counts toward pieces, so a group written as "...*3=..." contributes 3
 * pieces, not 1 — this sums that across all groups rather than just
 * counting how many groups there are.
 * Returns { groups, totalPieces } — groups is [] and totalPieces is null if
 * the cell is empty or doesn't match the expected shape at all (so callers
 * can fall back to whatever pieces value the sheet's own pieces column gave
 * them instead of overwriting it with a wrong number).
 */
function parseDimensionGroups(raw) {
  if (!raw) return { groups: [], totalPieces: null };
  const groupPattern = /([\d.]+)\s*\*\s*([\d.]+)\s*\*\s*([\d.]+)\s*\*\s*(\d+)\s*=\s*([\d.]+)/g;
  const groups = [];
  let match;
  while ((match = groupPattern.exec(String(raw))) !== null) {
    const [, length, width, height, qty, weight] = match;
    groups.push({
      length: parseFloat(length), width: parseFloat(width), height: parseFloat(height),
      qty: parseInt(qty, 10), weight: parseFloat(weight),
    });
  }
  if (!groups.length) return { groups: [], totalPieces: null };
  const totalPieces = groups.reduce((sum, g) => sum + (Number.isFinite(g.qty) ? g.qty : 0), 0);
  return { groups, totalPieces: totalPieces || null };
}

/** Converts a normalized vendor row (from iclParser/worldFirstParser) into a Garuda shipment record. */
function toShipmentRecord(n) {
  const weight = toNumber(n.weight);
  const { totalPieces } = parseDimensionGroups(n.dimensions);
  // Prefer the sheet's own pieces column when it's present (it's the
  // vendor's own count and may legitimately differ from what the raw
  // dimension groups imply); only fall back to the dimensions-derived count
  // when that column is missing/blank, and only default to 1 as a last resort.
  const pieces = toNumber(n.pieces) || totalPieces || 1;

  return {
    // NOTE: `vendor` (ICL / World First) is who supplied this shipment data —
    // it is NOT the actual courier/carrier. The vendor Excel exports don't
    // specify which courier is used, so `carrier` is intentionally left null
    // here (same as any other shipment with an unknown carrier) rather than
    // being overwritten with the vendor name.
    vendor: n.vendor,
    carrier_tracking_number: clean(n.tracking_number),    // Forwading No -> Tracking Number
    awb_number: clean(n.original_awb),                    // AWBNo -> Original AWB (kept separate, per spec)
    reference_number: clean(n.reference_number),

    from_name: clean(n.shipper_name),
    from_address: clean(n.shipper_address),
    from_city: clean(n.shipper_city || n.origin),
    from_state: clean(n.shipper_state),
    from_postal: clean(n.shipper_pin),
    // Neither vendor sheet has a shipper-country column at all — Garuda's own
    // shipments always originate from India, so default it here rather than
    // leaving it null. Mirrors the same "Chennai, India" default already
    // applied to freshly OCR-scanned shipments in
    // ocrService.js#applyFromLocationDefaults and used as the Waybill's own
    // formatOrigin() fallback — without this, Excel-imported shipments would
    // show "Not provided" for From Country everywhere except the Waybill PDF
    // itself (which has its own separate fallback baked into formatOrigin()).
    from_country: clean(n.shipper_country) || 'India',

    to_name: clean(n.consignee_name),
    to_address: clean(n.consignee_address),
    to_city: clean(n.consignee_city),
    to_state: clean(n.consignee_state),
    to_postal: clean(n.consignee_pin),
    to_country: clean(n.destination_country),

    pieces,
    actual_weight: weight,
    billing_weight: weight,
    weight_unit: 'kg',
    dimensions: clean(n.dimensions),
    contents: clean(n.content),

    declared_value: toNumber(n.value),
    currency: clean(n.currency) || 'INR',

    booking_date: toDate(n.booking_date),
    // The vendor Excel sheets record this under a column named "Booking
    // Date" (see iclParser.js / worldFirstParser.js) — that's the shipment's
    // ship date, so it's recorded into ship_date too (used for filtering,
    // sorting, and shown on the Garuda Waybill's "Ship Date" fields).
    ship_date: toDate(n.booking_date),
    service_type: clean(n.service_name || n.mode),
    invoice_number: clean(n.invoice_number),
    status: 'Processing',

    // Full vendor-specific extras retained as JSON so nothing is lost even
    // when a field doesn't have a dedicated shipments column.
    carrier_specific: JSON.stringify({
      vendor: n.vendor,
      service_name: n.service_name || null,
      currency_code: n.currency || null,
      origin: n.origin || null,
      customer_name: n.customer_name || null,
      mode: n.mode || null,
      client_reference: n.reference_number || null,
      source: 'excel_import',
    }),
  };
}

module.exports = { toShipmentRecord, clean, toNumber, toDate, parseDimensionGroups };