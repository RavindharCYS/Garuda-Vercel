#!/usr/bin/env python3
"""
DHL Express parser for Garuda Express.

Handles DHL Express Worldwide (DOX and WPX) labels.

Detected by the presence of:
  - 'EXPRESS WORLDWIDE'
  - 'DHL A/C' or 'DHL A\\C'
  - 'WAYBILL DOC' or 'WAYBILL WPX'
  - 'WAYBILL XX XXXX XXXX' pattern

Tracking format : WAYBILL XX XXXX XXXX  (10-digit, space-grouped)
Fallback        : standalone 10-digit number

Sample labels covered:
  • MR_RAJASEKAR_MANNE__HONGKONG  – DHL Express Worldwide DOX, Hong Kong
  • AWB__14_ / AWB__5_            – DHL Express Worldwide (Singapore / USA)
"""
import re, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from parsers.base_parser import (
    BaseParser, parse_address_block, extract_lines_after,
    extract_ship_date,
    extract_declared_value, extract_phones,
)


class DHLParser(BaseParser):
    carrier_name = 'DHL'

    # ── Detection ────────────────────────────────────────────────────────────

    def detect(self, text: str) -> bool:
        upper = text.upper()
        return any(token in upper for token in [
            'EXPRESS WORLDWIDE',
            'DHL A\\C', 'DHL A/C',
            'WAYBILL DOC', 'WAYBILL WPX',
        ]) or bool(re.search(r'WAYBILL\s+\d{2}\s+\d{4}\s+\d{4}', text, re.I))

    # ── Main parse ───────────────────────────────────────────────────────────

    def parse(self, text: str) -> dict:
        fields = self._init_fields()
        fields['carrier'] = 'DHL'

        self._tracking(text, fields)
        self._weight(text, fields)
        self._ship_date(text, fields)
        self._contents(text, fields)
        self._declared_value(text, fields)
        self._service(text, fields)
        self._pieces(text, fields)
        self._addresses(text, fields)
        self._phones(text, fields)
        self._reference(text, fields)

        return fields

    # ── Tracking ─────────────────────────────────────────────────────────────
    # DHL waybill: "WAYBILL 20 2037 2535" → "2020372535"

    def _tracking(self, text, fields):
        m = re.search(r'WAYBILL\s+(\d{2})\s+(\d{4})\s+(\d{4})', text, re.I)
        if m:
            fields['carrier_tracking_number'] = m.group(1) + m.group(2) + m.group(3)
            return
        # Fallback: 10-digit standalone
        m = re.search(r'\b(\d{10})\b', text)
        if m:
            fields['carrier_tracking_number'] = m.group(1)

    # ── Weight ───────────────────────────────────────────────────────────────
    # DHL uses "Pce/Shpt Weight  X.XX KG" format

    def _weight(self, text, fields):
        # Search for the weight value directly rather than requiring strict
        # adjacency to the "N/M" piece count — DHL's Day/Time/Ref-Code/
        # Weight/Piece mini-table can legitimately reconstruct with the
        # weight value and piece count several lines apart (confirmed on
        # AWB__14_: "13.50 KG" and "1/1" land in different fragments of the
        # table once it's read out), so a tight "KG\s+N/M" requirement was
        # silently leaving actual_weight null on a real, correctly-extracted
        # sample.
        m = re.search(r'\b([0-9]{1,4}\.[0-9]{1,2})\s*KG\b', text, re.I)
        if m:
            fields['actual_weight'] = float(m.group(1))
            fields['weight_unit'] = 'kg'
        # Alternate: "Cust Decl Shpt Wgt ... X.XX KG" — tolerate intervening
        # words/newlines between the label and the colon-then-value (e.g.
        # "...(UOM): Pieces\n13.50 KG 1") rather than requiring the value
        # immediately after the colon.
        if not fields['actual_weight']:
            m = re.search(r'Cust\s+Decl\s+Shpt\s+Wgt.{0,40}?([0-9]{1,4}\.[0-9]{1,2})\s*KG', text, re.I | re.S)
            if m:
                fields['actual_weight'] = float(m.group(1))
                fields['weight_unit'] = 'kg'
        fields['billing_weight'] = fields['billing_weight'] or fields['actual_weight']

    # ── Ship date ────────────────────────────────────────────────────────────

    def _ship_date(self, text, fields):
        # DHL uses "2026-03-06" ISO format in header
        m = re.search(r'\b(\d{4}-\d{2}-\d{2})\b', text)
        if m:
            fields['ship_date'] = m.group(1)
            return
        fields['ship_date'] = extract_ship_date(text)

    # ── Contents ─────────────────────────────────────────────────────────────
    # DHL: "Content Description: Documents - general business"
    # or  "Content Description: Sample Matching to WM N 12956 ..."

    def _contents(self, text, fields):
        m = re.search(r'Content\s*Description[:\s]+([^\n]{3,100})', text, re.I)
        if m:
            fields['contents'] = m.group(1).strip()

    # ── Invoice # ────────────────────────────────────────────────────────────
    # Deliberately not extracted from the waybill — OCR reads on this field
    # were consistently unreliable in practice (see the matching note in
    # waybillFieldSchema.js), so we leave it None rather than guess.

    def _declared_value(self, text, fields):
        # DHL sometimes writes "Declared Value=4280 INR"
        m = re.search(r'Declared\s*Value\s*=\s*([0-9,\.]+)\s*(INR|USD|GBP|EUR|AUD|CAD|SGD)?', text, re.I)
        if m:
            fields['declared_value'] = float(m.group(1).replace(',', ''))
            fields['currency'] = (m.group(2) or 'INR').upper()
            return
        val, cur = extract_declared_value(text)
        if val is not None:
            fields['declared_value'] = val
            fields['currency'] = cur

    # ── Service type ─────────────────────────────────────────────────────────

    def _service(self, text, fields):
        upper = text.upper()
        if 'EXPRESS WORLDWIDE' in upper:
            # DOX = document, WPX = package
            if 'DOX' in upper:
                fields['service_type'] = 'Express Worldwide (DOX)'
            elif 'WPX' in upper:
                fields['service_type'] = 'Express Worldwide (WPX)'
            else:
                fields['service_type'] = 'Express Worldwide'

    # ── Pieces ───────────────────────────────────────────────────────────────

    def _pieces(self, text, fields):
        # DHL piece count prints as "N/M" (e.g. "1/1") in the Piece column
        # of the weight mini-table. Searching for this directly — rather
        # than requiring it to immediately follow "KG" — avoids a real bug:
        # when the weight value and piece count end up several lines apart
        # after layout reconstruction, the old code fell through to a
        # `Pieces\s*\n\s*(\d+)` fallback that matched the leading digits of
        # the *weight* value itself ("Pieces\n13.50 KG" → captured "13" as
        # the piece count instead of the real value, 1).
        for m in re.finditer(r'(?<!\d)(\d{1,2})\s*/\s*(\d{1,2})(?!\d)', text):
            a, b = int(m.group(1)), int(m.group(2))
            if 1 <= a <= b <= 99:
                fields['pieces'] = b
                return
        m = re.search(r'Pieces?\s*\n\s*(\d{1,3})\b', text, re.I)
        if m:
            fields['pieces'] = int(m.group(1))

    # ── Reference number ─────────────────────────────────────────────────────
    # DHL: "Ref Code: D407"

    def _reference(self, text, fields):
        m = re.search(r'Ref\s*Code\s*:\s*([A-Za-z0-9\-]{2,20})', text, re.I)
        if m:
            fields['reference_number'] = m.group(1).strip()

    # ── Addresses ────────────────────────────────────────────────────────────
    # DHL layout (label page):
    #   From :  <NAME>
    #           <ADDRESS>
    #           <CITY COUNTRY>
    #   To :    <NAME>
    #           <ADDRESS>
    #           <CITY COUNTRY>
    #
    # DHL layout (waybill-doc page):
    #   Shipper :   <NAME>  Contact: <PHONE>
    #               <ADDRESS>
    #   Receiver :  <NAME>  Contact:
    #               <ADDRESS>

    def _addresses(self, text, fields):
        from_block = self._extract_from_block(text)
        to_block   = self._extract_to_block(text)
        if from_block:
            parse_address_block(from_block, fields, 'from_')
        if to_block:
            parse_address_block(to_block, fields, 'to_')

    def _extract_from_block(self, text):
        # Label: "From : ..."
        # max_lines=8, not 6 — confirmed on 2 real samples (AWB__5_,
        # MR_RAJASEKAR_MANNE) that a 6-line cap was truncating the block
        # right before its final country-name line ("...CHENNAI-TN-
        # 641021\nIndia 641021"), silently leaving from_country null even
        # though the word "India" was sitting right there, one line past
        # the cutoff.
        stop_res = [re.compile(r'^(?:To|Receiver)\s*:', re.I)]
        block = extract_lines_after(text, r'From\s*:\s*', stop_res, max_lines=8)
        if block and len(block.strip()) > 5:
            return block
        # Waybill doc: "Shipper : ..."
        stop_res = [re.compile(r'^Receiver\s*:', re.I)]
        return extract_lines_after(text, r'Shipper\s*:\s*', stop_res, max_lines=8)

    def _extract_to_block(self, text):
        # Label: "To : ..."
        # NOTE: previously bounded by `\nOrigin:|HKGO|SINO|CVGH|\Z` via a lazy
        # DOTALL capture with NO blank-line guard for this branch specifically
        # — but the sibling "Receiver :" branch below used `\n\s*\n` as a stop
        # condition, which truncated the block at the FIRST blank line. Real
        # OCR/PDF text extraction inserts blank lines between nearly every
        # visual row on these waybills (confirmed on AWB__14_/AWB__5_ — the
        # whole `to_` block, or just the country line, vanished). Both
        # branches now skip blank lines instead of stopping on them.
        stop_res = [re.compile(r'^(?:Origin\s*:|HKGO|SINO|CVGH)', re.I)]
        block = extract_lines_after(text, r'(?:^|\n)To\s*:\s*', stop_res, max_lines=7)
        if block:
            return block
        # Waybill doc: "Receiver : ..."
        stop_res = [re.compile(
            r'^(?:Shipper\s*:|WAYBILL|TRK#|TRACKING|SINO|HKGO|CVGH|'
            r'Product\s*Details|Payer\s*Details|Shipment\s*Details)', re.I)]
        return extract_lines_after(text, r'Receiver\s*:\s*', stop_res, max_lines=9)

    # ── Phones ───────────────────────────────────────────────────────────────

    def _phones(self, text, fields):
        # DHL shipper contact sits right after "Contact:"
        m = re.search(r'Shipper\s*:.*?Contact:\s*\n?\s*([+\d][\d\s\-]{7,15})', text, re.I | re.S)
        if m:
            fp = re.sub(r'[^\d+]', '', m.group(1))
            if len(fp) >= 8:
                fields['from_contact'] = fp

        phones = extract_phones(text)
        if phones:
            if not fields['from_contact']:
                fields['from_contact'] = phones[0]
            if len(phones) > 1 and not fields['to_contact']:
                fields['to_contact'] = phones[1]