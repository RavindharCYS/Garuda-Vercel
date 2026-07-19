// services/excelImport/worldFirstParser.js — World First vendor column mapping
// Maps a raw World First Excel row (see requirement doc "Excel Mapping" table)
// into the normalized shipment model shared with iclParser.js.
//
// IMPORTANT (per requirement doc): "AWBNo" is NOT the tracking number.
// "Forwading No" (sic — matches the vendor's actual column spelling) is what
// becomes the Garuda tracking number; AWBNo is retained separately as the
// Original AWB.
'use strict';

const { buildLookup, pick } = require('./excelParser');

function mapWorldFirstRow(row) {
  const l = buildLookup(row);

  return {
    vendor: 'World First',

    // Common mapping (requirement doc table)
    tracking_number: pick(l, ['Forwading No', 'Forwarding No']),
    original_awb: pick(l, ['AWBNo', 'AWB No', 'AWB']),
    booking_date: pick(l, ['Booking Date']),
    shipper_name: pick(l, ['Shipper Name']),
    consignee_name: pick(l, ['Consignee Name']),
    destination_country: pick(l, ['Destination Country']),
    weight: pick(l, ['Chargeable Weight']),
    pieces: pick(l, ['Total No of Items']),
    // See iclParser.js / shipmentMapper.js#parseDimensionGroups — same
    // "L*W*H*qty=weight[; L*W*H*qty=weight...]" format as the ICL sheet.
    dimensions: pick(l, ['Dimensions']),
    content: pick(l, ['content', 'Content']),
    value: pick(l, ['Value']),

    // Additional World First fields (extracted if available) — mirrors
    // iclParser.js's column names, since both vendors export from the same
    // aggregator platform template and use identical headers for these
    // fields. These were previously missing here entirely, which meant
    // World-First-sourced shipments had no shipper/consignee address at
    // all — the generated Waybill's From/To boxes fell back to a sparse
    // "name + country only" paragraph instead of the full structured
    // address block that ICL and OCR-scanned shipments get.
    shipper_address: pick(l, ['ShipperAddress']),
    shipper_city: pick(l, ['ShipperCity']),
    shipper_state: pick(l, ['ShipperState']),
    shipper_pin: pick(l, ['Shipper_Pin']),
    consignee_address: pick(l, ['ConsigneeAddress']),
    consignee_city: pick(l, ['ConsigneeCity']),
    consignee_state: pick(l, ['ConsigneeState']),
    consignee_pin: pick(l, ['Consignee_Pin']),
    service_name: pick(l, ['ServiceName']),
    currency: pick(l, ['Currency_Code']),
    invoice_number: pick(l, ['Invoice Number', 'invno']),

    origin: pick(l, ['Origin']),
    customer_name: pick(l, ['Customer Name']),
    mode: pick(l, ['mode', 'Mode']),

    // Extra context, not in the required set but harmless to retain
    reference_number: pick(l, ['Client Reference']),

    _raw: row,
  };
}

module.exports = { mapWorldFirstRow };