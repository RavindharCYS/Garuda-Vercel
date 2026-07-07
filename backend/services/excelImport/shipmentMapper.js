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

/** Converts a normalized vendor row (from iclParser/worldFirstParser) into a Garuda shipment record. */
function toShipmentRecord(n) {
  const weight = toNumber(n.weight);

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

    to_name: clean(n.consignee_name),
    to_address: clean(n.consignee_address),
    to_city: clean(n.consignee_city),
    to_state: clean(n.consignee_state),
    to_postal: clean(n.consignee_pin),
    to_country: clean(n.destination_country),

    pieces: toNumber(n.pieces) || 1,
    actual_weight: weight,
    billing_weight: weight,
    weight_unit: 'kg',
    contents: clean(n.content),

    declared_value: toNumber(n.value),
    currency: clean(n.currency) || 'INR',

    booking_date: toDate(n.booking_date),
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

module.exports = { toShipmentRecord, clean, toNumber, toDate };