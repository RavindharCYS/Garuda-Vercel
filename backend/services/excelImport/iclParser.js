// services/excelImport/iclParser.js — ICL vendor column mapping
// Maps a raw ICL Excel row (see requirement doc "Excel Mapping" table) into
// the normalized shipment model shared with worldFirstParser.js.
//
// IMPORTANT (per requirement doc): "AWBNo" is NOT the tracking number.
// "Forwading No" (sic — matches the vendor's actual column spelling) is what
// becomes the Garuda tracking number; AWBNo is retained separately as the
// Original AWB.
'use strict';

const { buildLookup, pick } = require('./excelParser');

function mapICLRow(row) {
  const l = buildLookup(row);

  return {
    vendor: 'ICL',

    // Common mapping (requirement doc table)
    tracking_number: pick(l, ['Forwading No', 'Forwarding No']),
    original_awb: pick(l, ['AWBNo', 'AWB No', 'AWB']),
    booking_date: pick(l, ['Booking Date']),
    shipper_name: pick(l, ['Shipper Name']),
    consignee_name: pick(l, ['Consignee Name']),
    destination_country: pick(l, ['Destination Country']),
    weight: pick(l, ['Chargeable Weight']),
    pieces: pick(l, ['Total No of Items']),
    content: pick(l, ['Content']),
    value: pick(l, ['Shipment_Value']),

    // Additional ICL fields (extracted if available)
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

    // Extra context, not in the required set but harmless to retain
    reference_number: pick(l, ['Client Reference']),
    invoice_number: pick(l, ['Invoice Number', 'invno']),

    _raw: row,
  };
}

module.exports = { mapICLRow };
