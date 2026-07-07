#!/usr/bin/env python3
"""
Garuda Express — AWB Parser Dispatcher
=======================================

Usage
-----
    from parsers.dispatcher import get_parser, dispatch

    fields = dispatch(raw_text)          # simplest usage
    # -- or --
    parser = get_parser(raw_text)        # get the matched parser
    fields = parser.parse(raw_text)      # parse explicitly

Design
------
Parsers are tried in priority order.  The FIRST one whose detect() returns
True wins.  If none match, GenericParser is used as a best-effort fallback
that combines the most universal patterns from all carriers.

Adding a new carrier
--------------------
1. Create  services/parsers/<carrier>/parser.py
   with a class that inherits BaseParser and implements detect() + parse().
2. Import it here and add an instance to PARSERS (before GenericParser).

No other files need to change.
"""
import re, sys, os, json
sys.path.insert(0, os.path.dirname(__file__))          # parsers/
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # services/

from parsers.base_parser import (
    BaseParser, blank_fields, parse_address_block,
    extract_dimensions_from_dims, extract_dimensions_from_dwt,
    extract_ship_date, extract_invoice, extract_declared_value,
    extract_phones, extract_barcode_number, find_digit_run,
    compute_field_score, validate_fields,
)
from parsers.fedex.parser import FedExParser
from parsers.dhl.parser   import DHLParser
from parsers.ups.parser   import UPSParser
from parsers.Aramex.parser import AramexParser


# ── Generic fallback ─────────────────────────────────────────────────────────
# Fires when no carrier is identified.  Combines the most universal patterns
# so at least tracking / weight / to_name / to_country are populated even for
# unknown label formats.

class GenericParser(BaseParser):
    carrier_name = 'Unknown'

    def detect(self, text: str) -> bool:
        return True          # always matches — must be LAST in PARSERS list

    def parse(self, text: str) -> dict:
        fields = self._init_fields()
        full = text.upper()

        # Carrier hints
        if any(x in full for x in ['FEDEX', 'FED EX', 'FEDERAL EXPRESS', 'TRK#', 'ACTWGT']):
            fields['carrier'] = 'FedEx'
        elif any(x in full for x in ['EXPRESS WORLDWIDE', 'DHL A/C', 'DHL A\\C', 'WAYBILL DOC']):
            fields['carrier'] = 'DHL'
        elif any(x in full for x in ['UPS SAVER', 'UPS WORLDWIDE', 'SHP WT:']):
            fields['carrier'] = 'UPS'
        elif 'ARAMEX' in full:
            fields['carrier'] = 'Aramex'
        elif 'BLUEDART' in full or 'BLUE DART' in full:
            fields['carrier'] = 'BlueDart'
        elif 'DTDC' in full:
            fields['carrier'] = 'DTDC'

        # Phones — extracted early so the tracking-number fallback below can
        # exclude them (a phone number that happens to be 10/12 digits long
        # was previously getting misassigned as the AWB — see find_digit_run).
        phones = extract_phones(text)

        # Tracking — try all known formats in priority order
        m = re.search(r'TRK#\s*(\d{4})\s+(\d{4})\s+(\d{4})', text, re.I)
        if m:
            fields['carrier_tracking_number'] = m.group(1)+m.group(2)+m.group(3)
        if not fields['carrier_tracking_number']:
            m = re.search(r'WAYBILL\s+(\d{2})\s+(\d{4})\s+(\d{4})', text, re.I)
            if m:
                fields['carrier_tracking_number'] = m.group(1)+m.group(2)+m.group(3)
        if not fields['carrier_tracking_number']:
            m = re.search(r'TRACKING\s*#[:\s]+([1][Z][A-Z0-9\s]{14,22})\b', text, re.I)
            if m:
                fields['carrier_tracking_number'] = re.sub(r'\s+', '', m.group(1)).upper()
        if not fields['carrier_tracking_number']:
            m = re.search(r'\b(1Z[A-Z0-9]{16})\b', text, re.I)
            if m:
                fields['carrier_tracking_number'] = m.group(1).upper()
        # Barcode-wrapped number (e.g. "*37294289760*") beats a bare
        # digit-length guess — it's an explicit machine-readable marker.
        if not fields['carrier_tracking_number']:
            fields['carrier_tracking_number'] = extract_barcode_number(text)
        if not fields['carrier_tracking_number']:
            fields['carrier_tracking_number'] = find_digit_run(text, 12, exclude=phones)
        if not fields['carrier_tracking_number']:
            fields['carrier_tracking_number'] = find_digit_run(text, 10, exclude=phones)

        # Weight
        m = re.search(r'ACTWG?T[:\s]+([0-9]+\.?[0-9]*)\s*(KG|LB)', text, re.I)
        if m:
            fields['actual_weight'] = float(m.group(1))
            fields['weight_unit'] = m.group(2).lower()
        if not fields['actual_weight']:
            m = re.search(r'SHP\s*WT[:\s]+([0-9]+\.?[0-9]*)\s*(KG|LB)', text, re.I)
            if m:
                fields['actual_weight'] = float(m.group(1))
        if not fields['actual_weight']:
            m = re.search(r'^([0-9]+(?:\.[0-9]+)?)\s*KG\s+[0-9]+\s+OF\s+[0-9]+', text, re.M)
            if m:
                fields['actual_weight'] = float(m.group(1))
        if not fields['actual_weight']:
            m = re.search(r'([0-9]+\.?[0-9]*)\s*KG\s+[0-9]+/[0-9]+', text, re.I)
            if m:
                fields['actual_weight'] = float(m.group(1))
        fields['billing_weight'] = fields['billing_weight'] or fields['actual_weight']

        # Dimensions
        fields['dimensions'] = (
            extract_dimensions_from_dims(text) or
            extract_dimensions_from_dwt(text)
        )

        # Ship date
        fields['ship_date'] = extract_ship_date(text)

        # Contents
        descs = re.findall(r'DESC\d*[:\s]+([^\n]{3,80})', text, re.I)
        descs = [d.strip() for d in descs if d.strip() and d.strip().upper() not in ('DESC2','DESC3','DESC4','')]
        if descs:
            fields['contents'] = '; '.join(descs[:2])
        if not fields['contents']:
            m = re.search(r'Content\s*Description[:\s]+([^\n]{3,100})', text, re.I)
            if m:
                fields['contents'] = m.group(1).strip()
        if not fields['contents']:
            m = re.search(r'DESC[:\s]+([A-Z][^\n]{5,80})', text, re.I)
            if m:
                fields['contents'] = m.group(1).strip()

        # Invoice / declared value
        fields['invoice_number'] = extract_invoice(text)
        val, cur = extract_declared_value(text)
        if val is not None:
            fields['declared_value'] = val
            fields['currency'] = cur

        # Pieces
        m = re.search(r'(\d+)\s*OF\s*(\d+)', text, re.I)
        if m:
            fields['pieces'] = int(m.group(2))

        # Addresses — try each block-extraction strategy in turn
        from_block = self._from_block(text)
        to_block   = self._to_block(text)
        if from_block:
            parse_address_block(from_block, fields, 'from_')
        if to_block:
            parse_address_block(to_block, fields, 'to_')

        # Phones
        if phones:
            if not fields['from_contact']:
                fields['from_contact'] = phones[0]
            if len(phones) > 1 and not fields['to_contact']:
                fields['to_contact'] = phones[1]

        return fields

    def _from_block(self, text):
        # DHL From :
        m = re.search(r'From\s*:\s*(.*?)(?=\n\s*(?:To|Receiver)\s*:|$)', text, re.I | re.S)
        if m and len(m.group(1).strip()) > 5:
            return m.group(1).strip()
        # DHL Shipper :
        m = re.search(r'Shipper\s*:\s*(.*?)(?=\nReceiver\s*:|$)', text, re.I | re.S)
        if m:
            return '\n'.join(l.strip() for l in m.group(1).strip().split('\n') if l.strip())[:5]
        # FedEx ORIGIN ID
        m = re.search(
            r'ORIGIN\s*ID[:\s]*\S*\s*([^\n]*)\n'
            r'((?:(?!SHIP\s*DATE|TO\s+[A-Z]|ACTWGT|TRK#|REF:)[^\n]+\n){0,6})',
            text, re.I)
        if m:
            first = m.group(1).strip()
            extra = [l.strip() for l in m.group(2).split('\n') if l.strip()]
            lines = ([first] if first else []) + extra
            return '\n'.join(lines[:6]) if lines else None
        # UPS top block
        m = re.search(r'^(.*?)(?=SHIP\s*TO:)', text, re.S | re.I)
        if m:
            raw = m.group(1).strip()
            lines = [l.strip() for l in raw.split('\n') if l.strip()
                     and not re.match(r'^[0-9\.]+\s*(KG|LB|OF)', l.strip(), re.I)]
            return '\n'.join(lines[-5:]) if len(lines) > 5 else '\n'.join(lines)
        return None

    def _to_block(self, text):
        # DHL To :
        m = re.search(r'(?:^|\n)To\s*:\s*(.*?)(?=\nOrigin:|HKGO|SINO|CVGH|\Z)', text, re.I | re.S)
        if m:
            return '\n'.join(l.strip() for l in m.group(1).split('\n') if l.strip())
        # DHL Receiver :
        m = re.search(r'Receiver\s*:\s*(.*?)(?=\nShipper\s*:|\n\s*\n|\nWAYBILL|\nTRK#|\nTRACKING|\Z)',
                      text, re.I | re.S)
        if m:
            return '\n'.join(l.strip() for l in m.group(1).split('\n') if l.strip())
        # FedEx TO <NAME>
        m = re.search(
            r'(?:^|\n)TO\s+([^\n]+)\n'
            r'((?:(?!ACTWGT|TRK#|DIMS|DESC\d|FROM\s|REF:)[^\n]+\n){1,8})',
            text, re.M | re.I)
        if m:
            return (m.group(1).strip() + '\n' + m.group(2)).strip()
        # UPS SHIP TO:
        m = re.search(
            r'SHIP\s*TO:\s*(.*?)(?=\n\s*\n|BILLING|Reference\s*No|TRACKING\s*#|\Z)',
            text, re.I | re.S)
        if m:
            lines = [l.strip() for l in m.group(1).split('\n') if l.strip()][:8]
            return '\n'.join(lines)
        return None


# ── Parser registry ──────────────────────────────────────────────────────────
# Order matters: more-specific detectors must come before GenericParser.

PARSERS = [
    FedExParser(),
    DHLParser(),
    UPSParser(),
    AramexParser(),
    # Add new carriers here, e.g. BlueDartParser()
    GenericParser(),   # ← must be last
]


def get_parser(text: str) -> BaseParser:
    """Return the first parser whose detect() returns True for *text*."""
    for parser in PARSERS:
        if parser.detect(text):
            return parser
    return GenericParser()   # safety net (GenericParser.detect() always returns True)


def dispatch(text: str) -> dict:
    """Detect carrier and return parsed fields dict."""
    parser = get_parser(text)
    return parser.parse(text)


# ── Public convenience API ───────────────────────────────────────────────────
# ocr_worker.py can call this instead of the old parse_waybill_fields()

def parse_and_score(text: str) -> dict:
    """
    Full pipeline:
      detect → parse → score → validate
    Returns the same shape that ocr_worker.py's --parse-only mode returns.
    """
    fields = dispatch(text)
    return {
        "fields": fields,
        "field_score": compute_field_score(fields),
        "warnings": validate_fields(fields),
    }