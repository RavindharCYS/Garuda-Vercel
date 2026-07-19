#!/usr/bin/env python3
"""
UPS parser for Garuda Express.

Handles UPS Saver international labels.

Detected by the presence of:
  - 'UPS SAVER' / 'UPS WORLDWIDE' / 'UPS EXPRESS'
  - 'TRACKING #: 1Z' pattern
  - 'SHP WT:' (UPS-specific weight field)

Tracking format : 1Z + 16 alphanumeric chars  (e.g. 1ZH4Y8210404603959)

Sample labels covered:
  • SANKARA_NARAYANAN_AUS   – UPS Saver, Winston Hills NSW, Australia
  • PRRVIND___IRELAND        – UPS Saver, Dublin, Ireland
"""
import re, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))
from parsers.base_parser import (
    BaseParser, parse_address_block, extract_lines_after, strip_trailing_metadata,
    extract_ship_date,
    extract_declared_value, extract_phones,
)


class UPSParser(BaseParser):
    carrier_name = 'UPS'

    # ── Detection ────────────────────────────────────────────────────────────

    def detect(self, text: str) -> bool:
        upper = text.upper()
        return any(token in upper for token in [
            'UPS SAVER', 'UPS WORLDWIDE', 'UPS EXPRESS',
            'SHP WT:', 'SHP#:',
        ]) or bool(re.search(r'TRACKING\s*#[:\s]+1Z', text, re.I))

    # ── Main parse ───────────────────────────────────────────────────────────

    def parse(self, text: str) -> dict:
        fields = self._init_fields()
        fields['carrier'] = 'UPS'

        self._tracking(text, fields)
        self._weight(text, fields)
        self._ship_date(text, fields)
        self._contents(text, fields)
        self._declared_value(text, fields)
        self._service(text, fields)
        self._pieces(text, fields)
        self._addresses(text, fields)
        self._phones(text, fields)

        return fields

    # ── Tracking ─────────────────────────────────────────────────────────────
    # UPS: "TRACKING #: 1Z H4Y 821 04 0460 3959" (spaces stripped → 1ZH4Y8210404603959)

    def _tracking(self, text, fields):
        # Labelled tracking line
        m = re.search(r'TRACKING\s*#[:\s]+([1][Z][A-Z0-9\s]{14,22})\b', text, re.I)
        if m:
            fields['carrier_tracking_number'] = re.sub(r'\s+', '', m.group(1)).upper()
            return
        # Bare 1Z... anywhere
        m = re.search(r'\b(1Z[A-Z0-9]{16})\b', text, re.I)
        if m:
            fields['carrier_tracking_number'] = m.group(1).upper()

    # ── Weight ───────────────────────────────────────────────────────────────
    # UPS: "SHP WT: 4.5 KG" and/or "5 KG  1 OF 1" (header)

    def _weight(self, text, fields):
        m = re.search(r'SHP\s*WT[:\s]+([0-9]+\.?[0-9]*)\s*(KG|LB)', text, re.I)
        if m:
            fields['actual_weight'] = float(m.group(1))
            fields['weight_unit'] = m.group(2).lower()
        # Header weight: "5 KG  1 OF 1"
        if not fields['actual_weight']:
            m = re.search(r'^([0-9]+(?:\.[0-9]+)?)\s*KG\s+[0-9]+\s+OF\s+[0-9]+', text, re.M)
            if m:
                fields['actual_weight'] = float(m.group(1))
        fields['billing_weight'] = fields['billing_weight'] or fields['actual_weight']

    # ── Dimensions / Invoice ─────────────────────────────────────────────────
    # Deliberately not extracted from the waybill — OCR reads on these two
    # fields were consistently unreliable in practice, so we leave them None
    # (see the matching note in waybillFieldSchema.js) rather than guess.

    # ── Ship date ────────────────────────────────────────────────────────────
    # UPS: "DATE: 16 MAR 2026"

    def _ship_date(self, text, fields):
        m = re.search(r'DATE[:\s]+(\d{1,2}\s+[A-Z]{3}\s+\d{4})', text, re.I)
        if m:
            fields['ship_date'] = m.group(1).strip()
            return
        fields['ship_date'] = extract_ship_date(text)

    # ── Contents ─────────────────────────────────────────────────────────────
    # UPS: "DESC: LADIES WEAR COTTON KURTA SET"
    # or   "BILLING: P/P\nDESC: LADIES WEAR COTTON KURTA SET"

    def _contents(self, text, fields):
        m = re.search(r'DESC[:\s]+([A-Z][^\n]{5,80})', text, re.I)
        if m:
            fields['contents'] = m.group(1).strip()

    # ── Declared value ───────────────────────────────────────────────────────

    def _declared_value(self, text, fields):
        val, cur = extract_declared_value(text)
        if val is not None:
            fields['declared_value'] = val
            fields['currency'] = cur

    # ── Service type ─────────────────────────────────────────────────────────

    def _service(self, text, fields):
        upper = text.upper()
        if 'UPS SAVER' in upper:
            fields['service_type'] = 'UPS Saver'
        elif 'UPS WORLDWIDE' in upper:
            fields['service_type'] = 'UPS Worldwide'
        elif 'UPS EXPRESS' in upper:
            fields['service_type'] = 'UPS Express'

    # ── Pieces ───────────────────────────────────────────────────────────────
    # UPS: "5 KG  1 OF 1"

    def _pieces(self, text, fields):
        m = re.search(r'(\d+)\s*OF\s*(\d+)', text, re.I)
        if m:
            fields['pieces'] = int(m.group(2))

    # ── Addresses ────────────────────────────────────────────────────────────
    # UPS layout:
    #   <SENDER block at top — name + phone + address + country>
    #   SHIP TO:
    #   <RECIPIENT NAME>
    #   <PHONE>
    #   <RECIPIENT NAME again>
    #   <STREET>
    #   <CITY>
    #   <STATE POSTAL>
    #   <COUNTRY>

    def _addresses(self, text, fields):
        from_block = self._extract_from_block(text)
        to_block   = self._extract_to_block(text)
        if from_block:
            parse_address_block(from_block, fields, 'from_')
        if to_block:
            parse_address_block(to_block, fields, 'to_')

    def _extract_from_block(self, text):
        # Everything before SHIP TO: is the sender block.
        # NOTE: this used to keep only the LAST 5 non-blank lines — but on a
        # real sample the sender's actual name is the very FIRST line, and
        # taking the tail dropped it entirely, leaving from_name to fall back
        # to OCR noise further down the block. parse_address_block() already
        # knows how to skip digit-only/address-prefix lines to find the real
        # name, so it's safer to hand it everything (capped generously) and
        # let it choose, rather than pre-guessing which slice matters.
        # Each line also now goes through strip_trailing_metadata() — this
        # block previously skipped it entirely (unlike DHL/FedEx), so
        # SHP#/SHP WT/DWT column-bleed noise (confirmed on a real sample —
        # multi-column OCR merges the weight/date/dims column into the
        # address column line-by-line) passed straight through unfiltered.
        m = re.search(r'^(.*?)(?=SHIP\s*TO:)', text, re.S | re.I)
        if m:
            raw = m.group(1).strip()
            lines = []
            for l in raw.split('\n'):
                l = l.strip()
                if not l or re.match(r'^[0-9\.]+\s*(KG|LB|OF)', l, re.I):
                    continue
                l = strip_trailing_metadata(l)
                if l:
                    lines.append(l)
            return '\n'.join(lines[:10])
        return None

    def _extract_to_block(self, text):
        # SHIP TO: block — grab generously, stop at a real section marker.
        # Previously stopped at the first blank line (`\n\s*\n`) — confirmed
        # on real samples (SANKARA_NARAYANAN, PRRVIND) this truncated the
        # block right after the street line, losing the postal/state/country
        # lines that follow a blank line in the OCR output.
        stop_res = [re.compile(r'^(?:BILLING|Reference\s*No|TRACKING\s*#)', re.I)]
        return extract_lines_after(text, r'SHIP\s*TO:\s*', stop_res, max_lines=8)

    # ── Phones ───────────────────────────────────────────────────────────────
    # UPS labels print sender phone at top (e.g. "91-9566122447")
    # and recipient phone just below SHIP TO name

    def _phones(self, text, fields):
        phones = extract_phones(text)
        if phones:
            if not fields['from_contact']:
                fields['from_contact'] = phones[0]
            if len(phones) > 1 and not fields['to_contact']:
                fields['to_contact'] = phones[1]