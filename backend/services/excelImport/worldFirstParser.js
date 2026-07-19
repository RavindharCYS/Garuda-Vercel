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

    // Additional World First fields (extracted if available)
    origin: pick(l, ['Origin']),
    customer_name: pick(l, ['Customer Name']),
    mode: pick(l, ['mode', 'Mode']),

    // Extra context, not in the required set but harmless to retain
    reference_number: pick(l, ['Client Reference']),

    _raw: row,
  };
}

module.exports = { mapWorldFirstRow };