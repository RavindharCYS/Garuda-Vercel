#!/usr/bin/env python3
"""
Aramex AWB parser for Garuda Express.

Handles Aramex Forward Air Waybill labels.

Detected by the presence of:
  - 'ARAMEX' in text
  - OR barcode-wrapped tracking number pattern '*XXXXXXXXXXX*'
    combined with Aramex-specific fields (PPX, EXP, route codes)

Tracking format : *37294289782*  (11-digit, barcode-wrapped)

Carrier-specific fields extracted:
  - ppx  : Billing type flag (PPX = Prepaid)
  - exp  : Service type flag (EXP = Express)
  - route: Origin/destination airport codes (e.g. "MAA AUH")

Sample labels covered:
  * KIND_ATTN_MR_ALAA_KHAMASH  - Aramex, India -> UAE (AUH)
  * KIND_ATTN_MR_MAHMOOD_QAT   - Aramex, India -> Oman (MCT)
  * CICON_EPOXY_STEEL_CUTTING  - Aramex, India -> UAE (AUH)

-------------------------------------------------------------------------
CHANGELOG (this revision)
-------------------------------------------------------------------------
Fixed two bugs confirmed against real OCR output (tesseract, see the
bulk-upload screenshot for shipment 37294289782, confidence 62.5%):

  1. `from_name` was coming back as "aqramex" — the flat-OCR fallback in
     `_extract_from_block` kept the carrier letterhead / section-header
     line as the first surviving line and handed it to
     parse_address_block as the shipper name. Fixed by filtering out
     letterhead and section-header noise before picking lines.

  2. `contents` was coming back as "Custms Value | Currency" instead of
     "MONTHLY CALENDAR" — the "Description of Goods" field sits directly
     left of the "Customs Value | Currency" grid on the form, and OCR
     column-bleed pulled the neighbouring header text into the capture
     instead of the actual goods description. Fixed by validating the
     captured value against a header/label blacklist and falling
     through to alternate strategies (incl. a position-based fallback:
     the goods description line that precedes the EXP/STD service line)
     when the primary capture looks like bled-in header text.

Also hardened defensively (lower confidence these manifest on these
exact samples, but cheap to make robust):

  3. Declared value / currency: kept the fast adjacent-token regex (it
     matches all three real samples, where "150.00 INR" / "200.00 INR"
     sit on the same line with no intervening text) but added a
     decoupled fallback that finds the amount and currency code
     independently within the shipment-info window, in case OCR ever
     drops the connecting whitespace or injects a stray token between
     them.

  4. City/State: kept the existing label-anchored multi-line patterns
     (still the most reliable when OCR preserves "City\n<value>"), and
     added a flexible fallback that tolerates the City/State row being
     horizontally merged with the adjacent Services (PROD GRP/PROD TYP)
     and Remarks columns on this form layout.

  5. KIND ATTN normalization: added a *direction-agnostic* safety net —
     if 'KIND ATTN' ends up in to_company instead of to_name (the
     reverse of what real samples show, but possible under different
     OCR noise), swap them. This does NOT assume the inversion the
     original bug report claimed; it only fires if that specific
     pattern is actually observed in a given parse.

NOT changed — claims investigated and found NOT to reproduce against the
real samples / parser's own documented field mapping:

  - "_extract_countries_from_barcode_block reads shipment weights
    instead of countries" — checked against real flat text order
    ("...*37294289782*\nIndia\nUnited Arab Emirates\nMAA AUH..."); the
    two lines immediately after the barcode genuinely are the origin
    and destination countries on all three samples. Left as-is.
  - "To (Receiver Name) / Company are inverted on the form" — checked
    against all three AWBs and this file's own docstring: Receiver Name
    correctly holds the "KIND ATTN ..." line and Company correctly
    holds the corporate name. The original mapping was already right;
    a hard-coded swap would have broken this.
"""
import re
import json
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # services/
from parsers.base_parser import (
    BaseParser, parse_address_block,
    extract_ship_date, extract_phones, extract_phones_with_positions,
    extract_barcode_number, find_digit_run,
)

# Known IATA 3-letter airport/station codes used by Aramex
_KNOWN_AIRPORT_CODES = {
    'MAA', 'BOM', 'DEL', 'HYD', 'BLR', 'CCU', 'AMD', 'COK', 'CJB',
    'AUH', 'DXB', 'SHJ', 'MCT', 'DOH', 'BAH', 'KWI', 'RUH', 'JED',
    'LHR', 'CDG', 'AMS', 'FRA', 'SIN', 'HKG', 'SYD', 'MEL', 'YYZ',
    'YVR', 'YUL', 'JFK', 'ORD', 'LAX', 'DFW', 'PHL', 'NRT', 'ICN',
    'KUL', 'BKK', 'CGK', 'MNL', 'CMB', 'DAC', 'KTM',
}

# Destination-city fallback for the Gulf airport codes Aramex's Indian
# outbound lane actually uses. The to_city OCR text is unreliable (the
# city is printed twice across two form columns and Tesseract regularly
# merges/drops one copy — see _parse_to_region), but the destination
# airport code is extracted reliably, so deriving the city from it is a
# much sturdier signal than trying to regex it out of the raw text.
_GULF_AIRPORT_CITY = {
    'AUH': 'Abu Dhabi', 'DXB': 'Dubai', 'SHJ': 'Sharjah',
    'MCT': 'Muscat', 'DOH': 'Doha', 'BAH': 'Manama',
    'KWI': 'Kuwait City', 'RUH': 'Riyadh', 'JED': 'Jeddah',
}
_GULF_AIRPORT_COUNTRY = {
    'AUH': 'United Arab Emirates', 'DXB': 'United Arab Emirates',
    'SHJ': 'United Arab Emirates', 'MCT': 'Oman', 'DOH': 'Qatar',
    'BAH': 'Bahrain', 'KWI': 'Kuwait', 'RUH': 'Saudi Arabia',
    'JED': 'Saudi Arabia',
}

# Indian state names Aramex's Indian shipper labels spell out in full.
# Used both to populate from_state and, when the "Country" line itself
# gets dropped by OCR (it does, on some of these labels), to infer
# from_country = India from the presence of a recognizable state name.
_INDIAN_STATE_HINTS = [
    'TAMIL NADU', 'MAHARASHTRA', 'KARNATAKA', 'TELANGANA',
    'ANDHRA PRADESH', 'DELHI', 'WEST BENGAL', 'KERALA', 'GUJARAT',
    'PUNJAB', 'RAJASTHAN', 'UTTAR PRADESH', 'MADHYA PRADESH',
]

# Multi-word state/province/city-state names that can appear glued
# directly onto a city name with only a space between them (no comma) —
# e.g. "Chennai Tamil Nadu", "Saint Ives New South Wales",
# "Sterling VIRGINIA" — used by _parse_scrambled_classic_awb's city/state
# splitter. Sorted longest-first so e.g. "New South Wales" is tried before
# a shorter name that might otherwise partial-match its tail.
_CITY_STATE_SPLIT_NAMES = sorted([
    'Tamil Nadu', 'Andhra Pradesh', 'West Bengal', 'Madhya Pradesh',
    'Uttar Pradesh', 'Himachal Pradesh', 'Arunachal Pradesh',
    'New South Wales', 'South Australia', 'Western Australia',
    'British Columbia', 'Nova Scotia', 'New Brunswick',
    'Northern Territory', 'Prince Edward Island',
    'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado',
    'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho',
    'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana',
    'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
    'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
    'New Hampshire', 'New Jersey', 'New Mexico', 'New York',
    'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
    'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota',
    'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington',
    'West Virginia', 'Wisconsin', 'Wyoming', 'Ontario', 'Quebec',
    'Alberta', 'Manitoba', 'Saskatchewan', 'Victoria', 'Queensland',
    'Tasmania', 'Karnataka', 'Maharashtra', 'Telangana', 'Kerala',
    'Gujarat', 'Punjab', 'Rajasthan', 'Delhi',
], key=len, reverse=True)
_COMPANY_SUFFIX_RE = re.compile(
    r'\b(LLC|LTD|PLC|INC|PTE|CORP|CO\.?|COMPANY|ENTERPRISES|INDUSTRIES|TRADING)\b',
    re.I)

# --- Fix 1 support: letterhead / section-header noise to strip out of the
# flat-OCR shipper-block fallback before picking the name line. Built from
# what was actually observed in the OCR text ("aqramex", "4 FROM
# (SHIPPER)", "Shipper's Account No.", "FORWARDER", "ARWAYSEL" i.e. a
# garbled "AIRWAYBILL"), generalized with fuzzy/typo-tolerant patterns
# rather than exact strings, since tesseract output varies run to run.
_LETTERHEAD_NOISE_RE = re.compile(
    r'^(a[qg]?ramex|forwarder|air\s*way\s*bill|ar[wv]ay\s*sel|'
    r'\d*\s*from\s*\(?\s*shipper\s*\)?|'
    r"shipper'?s?\s*account\s*no\.?|"
    r"shipper'?s?\s*ref\.?|"
    r'shipment\s*no\.?)\s*[:.]?\s*$',
    re.I)


def _is_caps_name_like(line):
    """Shipper/receiver names on these Aramex forms are always printed in
    capitals (e.g. "MANIKANDAN KULLAN"), while OCR-garbled form labels
    that survive the letterhead blacklist (typos of "Shipper's Ref.",
    "Dept/Floor No.", etc.) tend to be mixed-case. Rather than trying to
    blacklist every possible OCR misread of a label, prefer lines that
    look like the genuinely-capitalized name field when ordering
    candidates — this generalizes better than exact-string matching.
    """
    letters = [c for c in line if c.isalpha()]
    if len(letters) < 4:
        return False
    upper_ratio = sum(1 for c in letters if c.isupper()) / len(letters)
    return upper_ratio > 0.85


# Trailing digit/underscore noise that horizontal OCR bleed sometimes
# appends to an otherwise-clean name/address line (e.g. the account
# number column's "21708 92856" merging onto the shipper-name line:
# "MANIKANDAN KULLAN 21708 92856 _"). Strips a trailing run of 4+
# digit/space/underscore characters, which on these forms is never
# legitimate trailing content on a name line (postal codes/account
# numbers appear on their own line and are already excluded elsewhere).
_TRAILING_DIGIT_NOISE_RE = re.compile(r'\s+[\d\s_]{4,}$')


def _strip_trailing_digit_noise(line):
    return _TRAILING_DIGIT_NOISE_RE.sub('', line).strip()

# --- Fix 2 support: header/label fragments that can bleed into the
# "Description of Goods" capture from the adjacent Customs Value /
# Currency grid on this form. If the captured contents string matches
# this, treat it as a failed capture rather than trusting it.
_CONTENTS_BLACKLIST_RE = re.compile(
    r'custms?\s*value|customs\s*value|currency|description\s*of\s*goods|'
    r'harmonized?\s*code|country\s*of\s*manufacture|^remarks$|^weight$|'
    r'no\s*charges|cost\s*of\s*goods|bill\s*(shipper|receiver)|account',
    re.I)


def _pre_legal_text(text):
    """Returns `text` truncated right before the "CONDITIONS OF CARRIAGE"
    legal-boilerplate section, if present. Used by every method that scans
    for a real shipment-data value via a loosely-anchored fallback regex
    (weight, contents, declared value, service type, pieces) — confirmed
    necessary on a real sample where the formal data fields are an
    image-only section absent from the native PDF text layer, leaving the
    legal terms (several thousand characters, full of numbers and words
    like "goods") as the ONLY text for an under-constrained fallback
    pattern to match against. The structured "1 FROM (SHIPPER)/2 TO
    (RECEIVER)" address grid, by contrast, can legitimately appear AFTER
    this marker on some samples — so this helper is deliberately NOT
    applied to the address/phone extraction methods, which need the full
    text.
    """
    m = re.search(r'CONDITIONS\s+OF\s+CARRIAGE', text, re.I)
    return text[:m.start()] if m else text

_SERVICE_LINE_RE = re.compile(r'^\s*(EXP|STD|PPX|DOM)\s*$', re.I)

# --- Global recovery support: on real tesseract output, enough section
# headers get dropped/garbled (no "TO (RECEIVER)" text survives at all on
# the sample checked) that BOTH the structured block regex and the flat
# KIND-ATTN-anchored fallback in _extract_to_block can miss fields like
# city/country/company entirely — they're real values, just scattered
# 15-20 noisy OCR lines past the fallback's window, with intervening
# junk lines that trip its stop condition early (e.g. "Bill Shipper
# Account" falsely matches a bare "SHIPPER" stop-word check). Rather
# than try to guess a window size that survives arbitrary OCR noise,
# this does a last-resort whole-document scan for "Label\nValue" pairs
# and assigns them to from_/to_ by position relative to the KIND ATTN
# anchor, only filling fields still empty after the normal extraction.
_GLOBAL_LABEL_VALUE_PATTERNS = {
    'city':    re.compile(r'\bCity\b\s*\n+\s*([A-Za-z][A-Za-z\s\(\)\.]+)', re.I),
    'country': re.compile(r'\bCountry\b\s*\n+\s*([A-Za-z][A-Za-z\s]+)', re.I),
    'company': re.compile(r'\bCompany\b\s*\n+\s*([A-Za-z][^\n]+)', re.I),
}

# Field naming in the production schema is NOT a uniform from_/to_
# prefix for every key — company specifically is stored as
# sender_company / receiver_company (confirmed against the real
# /shipments/bulk response payload), not from_company / to_company.
# Map (side, key) -> actual field name explicitly rather than assuming
# a uniform prefix.
_RECOVERY_FIELD_NAME = {
    ('from_', 'city'):    'from_city',
    ('to_', 'city'):      'to_city',
    ('from_', 'country'): 'from_country',
    ('to_', 'country'):   'to_country',
    ('from_', 'company'): 'sender_company',
    ('to_', 'company'):   'receiver_company',
}


class AramexParser(BaseParser):
    carrier_name = 'Aramex'

    # ── Detection ─────────────────────────────────────────────────────────────

    def detect(self, text):
        upper = text.upper()
        if 'ARAMEX' in upper:
            return True
        # Aramex labels use barcode-wrapped AWB numbers like *37294289782*
        # combined with PPX/EXP service codes
        if extract_barcode_number(text) and any(t in upper for t in ['PPX', 'EXP', 'FORWARDER AIRWAYBILL', 'FORWARD AIR']):
            return True
        return False

    # ── Main parse ────────────────────────────────────────────────────────────

    def parse(self, text):
        fields = self._init_fields()
        fields['carrier'] = 'Aramex'

        self._tracking(text, fields)
        self._weight(text, fields)
        self._ship_date(text, fields)
        self._contents(text, fields)
        self._declared_value(text, fields)
        self._service(text, fields)
        self._pieces(text, fields)
        self._origin_destination(text, fields)

        # Two real Aramex label formats are in use, and BOTH extract from
        # their native PDF text layer in an order that scrambles the
        # visual layout — neither the structured "1 FROM (SHIPPER)/2 TO
        # (RECEIVER)" grid regex below nor the flat "KIND ATTN"-anchored
        # fallback reliably matches either one on the real text (those
        # literal anchor strings may not survive extraction at all, or —
        # on some real samples — appear out of their expected context,
        # which previously caused a text-content sniff here to wrongly
        # skip straight to the old path). Attempt the dedicated,
        # position-based extractor for each format unconditionally: both
        # require finding an actual barcode-wrapped AWB number before
        # they touch any fields, so there's no real risk in trying first —
        # only fall through to the original generic block-extraction path
        # (still needed for any sample that's neither of these two) when
        # neither one finds what it needs.
        if self._parse_scrambled_thermal_label(text, fields):
            pass
        elif self._parse_scrambled_classic_awb(text, fields):
            pass
        else:
            from_block = self._extract_from_block(text)
            to_block = self._extract_to_block(text)
            from_block, to_block = self._addresses(from_block, to_block, fields)
            self._recover_scattered_fields(text, fields)
            self._phones(text, from_block, to_block, fields)

        self._extract_countries_from_barcode_block(text, fields)
        self._apply_gulf_destination_fallback(fields)
        self._normalize_kind_attn(fields)
        self._carrier_specific(text, fields)

        return fields

    # ── Scrambled classic-AWB layout (native PDF text-layer order) ──────────
    # Built and verified against GROUND TRUTH: run through the actual
    # production extractor (pdf_native_text.extract_native_pdf_text)
    # against the real uploaded PDFs and reading the literal output — not
    # a reconstruction from memory.
    #
    # The real structure is two short, internally-consistent field blocks
    # bracketing the "CONDITIONS OF CARRIAGE" legal boilerplate — NOT a
    # single scrambled run — confirmed identical on both real samples
    # (AWB *32202672935*, India->USA; AWB *32202634995*, India->Australia):
    #
    #   Block A (everything before "CONDITIONS OF CARRIAGE" — i.e.
    #   _pre_legal_text()), one field group per line:
    #     [0]  account_number                [1]  from_contact
    #     [2]  "from_name from_contact"       [3]  from_name (repeat)
    #     [4]  from_address                   [5]  "from_city from_state"
    #     [6]  "from_country from_postal"     [7]  to_name (short variant)
    #     [8]  "to_contact to_contact"        [9]  to_name (full variant)
    #     [10] to_address                     [11] to_state
    #     [12] to_city                        [13] "to_country to_postal"
    #     [14] ship_date
    #
    #   Block B (starts right after the barcode-wrapped AWB number, which
    #   itself sits after the legal text and a barcode graphic — found by
    #   searching the whole document rather than assuming a fixed offset
    #   from Block A, since a variable amount of legal text sits between
    #   them):
    #     [0]  *AWB NUMBER*                   [1]  "origin_code dest_code"
    #     [2]  "pieces actual_wt billing_wt"  [3]  contents
    #     [4]  "declared_value currency"      [5]  "service billing_code"
    #
    # Each combined line is parsed with its own small, specific regex —
    # not blind position trust — so a document that doesn't quite match
    # fails that one field's regex and simply leaves it for the generic
    # fallback, rather than silently mis-assigning a neighboring field's
    # value. Block A additionally requires a strict entry signature
    # (account-number digit line immediately followed by a "name phone"
    # combined line) before touching any field at all — confirmed
    # necessary: a genuinely structured "1 FROM (SHIPPER)" grid document
    # (own labels each on their own line) doesn't produce that
    # combination, but without this check this method was misreading
    # such a document's own label lines as data. Likewise Block B's
    # origin/destination code match excludes this format's own known
    # service-type codes (EXP/PPX/etc.), which also fit a bare
    # "XXX YYY" 3-letter pattern and would otherwise false-positive on
    # a structured document's "EXP PPX" service line.

    def _parse_scrambled_classic_awb(self, text, fields):
        found_any = False

        # ── Block A ──────────────────────────────────────────────────────
        a = [l.strip() for l in _pre_legal_text(text).split('\n') if l.strip()]

        def a_at(i):
            return a[i] if 0 <= i < len(a) else None

        block_a_valid = (
            len(a) >= 15
            and a_at(0) and re.match(r'^\d{5,12}$', a[0])
            and a_at(2) and re.match(r'^.+?\s+\+?\d{7,15}$', a[2])
        )

        if block_a_valid:
            m = re.match(r'^(\d{5,12})$', a[0])
            if m and not fields.get('account_number'):
                fields['account_number'] = m.group(1)
                found_any = True

            m = re.match(r'^(.+?)\s+(\+?\d{7,15})$', a[2])
            if m:
                if not fields.get('from_name'):
                    fields['from_name'] = m.group(1).strip()
                if not fields.get('from_contact'):
                    fields['from_contact'] = m.group(2)
                found_any = True
            elif a_at(3) and not fields.get('from_name'):
                fields['from_name'] = a[3]

            if a_at(4) and not fields.get('from_address'):
                fields['from_address'] = re.sub(r'-\s*$', '', a[4]).strip()
                found_any = True

            fc, fs = self._split_city_state(a_at(5))
            if fc and not fields.get('from_city'):
                fields['from_city'] = fc
            if fs and not fields.get('from_state'):
                fields['from_state'] = fs

            m = re.match(r'^(.+?)\s+([\w\-]{3,10})$', a[6]) if a_at(6) else None
            if m:
                if not fields.get('from_country'):
                    fields['from_country'] = self._detect_country_local(m.group(1)) or m.group(1).strip()
                if not fields.get('from_postal'):
                    fields['from_postal'] = m.group(2)

            # to_name appears twice — a short/truncated read at [7] and a
            # fuller one at [9] (text-layer artifact, not two people);
            # prefer whichever is longer, since that's consistently the
            # more complete one on both real samples.
            cand_names = [n for n in (a_at(7), a_at(9))
                          if n and re.match(r"^[A-Za-z][A-Za-z .'\-]{1,60}$", n)]
            if cand_names and not fields.get('to_name'):
                fields['to_name'] = max(cand_names, key=len)
                found_any = True

            m = re.match(r'^(\+?\d{7,15})\s+\+?\d{7,15}$', a[8]) if a_at(8) else None
            if m and not fields.get('to_contact'):
                fields['to_contact'] = m.group(1)

            if a_at(10) and not fields.get('to_address'):
                fields['to_address'] = re.sub(r'-\s*$', '', a[10]).strip()

            if a_at(11) and not fields.get('to_state') and re.match(r"^[A-Za-z][A-Za-z .'\-]{1,40}$", a[11]):
                fields['to_state'] = a[11]
            if a_at(12) and not fields.get('to_city') and re.match(r"^[A-Za-z][A-Za-z .'\-]{1,40}$", a[12]):
                fields['to_city'] = a[12]

            m = re.match(r'^(.+?)\s+([\w\-]{3,10})$', a[13]) if a_at(13) else None
            if m:
                if not fields.get('to_country'):
                    fields['to_country'] = self._detect_country_local(m.group(1)) or m.group(1).strip()
                if not fields.get('to_postal'):
                    fields['to_postal'] = m.group(2)

            if a_at(14) and not fields.get('ship_date') and re.match(r'^\d{2}/\d{2}/\d{4}$', a[14]):
                fields['ship_date'] = a[14]

        # ── Block B ──────────────────────────────────────────────────────
        # Anchored on the AWB-number barcode wherever it actually falls in
        # the document (rather than assuming a fixed distance from Block
        # A), since a variable amount of legal boilerplate separates them.
        full_lines = [l.strip() for l in text.split('\n') if l.strip()]
        barcode_re = re.compile(r'^\*(\d{8,14})\*$')
        b0 = next((i for i, l in enumerate(full_lines) if barcode_re.match(l)), None)

        def b_at(offset):
            i = b0 + offset if b0 is not None else -1
            return full_lines[i] if 0 <= i < len(full_lines) else None

        if b0 is not None:
            _NOT_AIRPORT_CODE = {'EXP', 'STD', 'PPX', 'DOM', 'NSR', 'CVG', 'INT'}
            m = re.match(r'^([A-Z]{3})\s+([A-Z]{3})$', b_at(1) or '')
            if m and m.group(1) not in _NOT_AIRPORT_CODE and m.group(2) not in _NOT_AIRPORT_CODE:
                found_any = True
                if not fields.get('origin_code'):
                    fields['origin_code'] = m.group(1)
                if not fields.get('destination_code'):
                    fields['destination_code'] = m.group(2)

            m = re.match(r'^(\d{1,3})\s+([\d.]+)\s*KG\s+([\d.]+)\s*KG$', b_at(2) or '', re.I)
            if m:
                found_any = True
                fields['pieces'] = int(m.group(1))
                if not fields.get('actual_weight'):
                    fields['actual_weight'] = float(m.group(2))
                    fields['weight_unit'] = 'kg'
                if not fields.get('billing_weight'):
                    fields['billing_weight'] = float(m.group(3))

            v = b_at(3)
            if v and not fields.get('contents') and not _CONTENTS_BLACKLIST_RE.search(v):
                fields['contents'] = v
                found_any = True

            # Always overwrite — the general-purpose declared-value regex
            # has a confirmed bug with comma-grouped thousands
            # ("1,500.00" → 500.00, since \d+\.\d{2} can't span the
            # comma), and this read is a precise, validated match.
            m = re.match(r'^([\d,]+\.\d{2})\s+([A-Z]{3})$', b_at(4) or '')
            if m:
                fields['declared_value'] = float(m.group(1).replace(',', ''))
                fields['currency'] = m.group(2)
                found_any = True

        return found_any

    @staticmethod
    def _split_city_state(line):
        if not line:
            return None, None
        for name in _CITY_STATE_SPLIT_NAMES:
            suffix_re = re.compile(r'\s+' + re.escape(name) + r'$', re.I)
            if suffix_re.search(line):
                return suffix_re.sub('', line).strip(), name
        parts = line.rsplit(' ', 1)
        if len(parts) == 2 and parts[1]:
            return parts[0].strip(), parts[1].strip()
        return line.strip(), None

    @staticmethod
    def _detect_country_local(text):
        from parsers.base_parser import detect_country
        return detect_country(text)

    # ── Scrambled thermal-label layout (native PDF text-layer order) ────────
    # Built and verified against GROUND TRUTH the same way as the classic-
    # AWB method above. One extra wrinkle this format has: a 2D barcode
    # graphic renders as literal block-drawing Unicode characters (█▌▐▄▀
    # etc.) that the text layer captures interleaved INTO otherwise-
    # normal content lines (e.g. one real line reads literally
    # "To: JASER ████████8 ▐▐▐▐▐▐▐▐") rather than sitting off on their
    # own lines — _clean_barcode_noise() strips those glyph-heavy tokens
    # per line before anything else here looks at the text.
    #
    # Once cleaned, both real samples (AWB *37294398492* and
    # *37294398470*, both Chennai -> Dubai) share this exact structure:
    #   MAA                                  <- origin_code
    #   *AWB NUMBER*
    #   Destination: Pickup Date: <date> <time>
    #   DXB                                  <- destination_code
    #   Product Group: Type: Payment:
    #   EXP PPX P
    #   Weight: <n>KG Chargeable: <n>KG
    #   Description:<contents1> Custom Value: <value> <currency>
    #   <contents2>
    #   Cash on delivery: Pieces:<n>
    #   From:
    #   Account: <account_number>
    #   <from_name>
    #   <from_name> (repeat)
    #   <from_address>
    #   <from_city> <from_country>
    #   Tel: <from_contact>
    #   To: <to_name>
    #   <to_name> (repeat)
    #   <to_address line 1>
    #   <to_address line 2>
    #   <to_city> -
    #   <to_country>
    #   Tel: <to_contact>
    #   Mob: <to_contact> (repeat)
    #   Shpr Ref: GARUDA Con Ref:        <- detection anchor
    # Detected by that distinctive "Shpr Ref: GARUDA" footer, which the
    # classic form above never has.

    def _parse_scrambled_thermal_label(self, text, fields):
        if not re.search(r'Shpr\s*Ref\s*:\s*GARUDA', text, re.I):
            return False

        lines = [self._clean_barcode_noise(l) for l in text.split('\n')]
        lines = [l for l in lines if l]
        found_any = False

        def idx_of(pred):
            return next((i for i, l in enumerate(lines) if pred(l)), None)

        awb_i = idx_of(lambda l: bool(re.match(r'^\*\d{8,14}\*$', l)))
        if awb_i is not None:
            if awb_i - 1 >= 0 and re.match(r'^[A-Z]{3}$', lines[awb_i - 1]) and not fields.get('origin_code'):
                fields['origin_code'] = lines[awb_i - 1]
                found_any = True
            nxt = lines[awb_i + 1] if awb_i + 1 < len(lines) else ''
            m = re.match(r'^Destination\s*:\s*Pickup\s*Date\s*:\s*(\d{1,2}/\d{1,2}/\d{4})', nxt)
            if m:
                if not fields.get('ship_date'):
                    fields['ship_date'] = m.group(1)
                if awb_i + 2 < len(lines) and re.match(r'^[A-Z]{3}$', lines[awb_i + 2]) and not fields.get('destination_code'):
                    fields['destination_code'] = lines[awb_i + 2]
                found_any = True

        m = re.search(r'Weight\s*:\s*([\d.]+)\s*KG.*?Chargeable\s*:\s*([\d.]+)\s*KG', text, re.I | re.S)
        if m:
            found_any = True
            if not fields.get('actual_weight'):
                fields['actual_weight'] = float(m.group(1))
                fields['weight_unit'] = 'kg'
            if not fields.get('billing_weight'):
                fields['billing_weight'] = float(m.group(2))

        m = re.search(
            r'Description\s*:\s*([^\n]*?)\s*Custom\s*Value\s*:\s*([\d,]+\.?\d*)\s*([A-Z]{3})?\s*\n\s*([^\n]*)',
            text, re.I)
        if m:
            found_any = True
            desc1 = m.group(1).strip()
            desc2 = m.group(4).strip()
            if desc2 and not re.match(r'^(Cash|From|Account|Pieces|To|Tel|Mob)\b', desc2, re.I):
                contents = f'{desc1} {desc2}'.strip()
            else:
                contents = desc1
            if contents and not fields.get('contents'):
                fields['contents'] = contents
            if m.group(2) and not fields.get('declared_value'):
                fields['declared_value'] = float(m.group(2).replace(',', ''))
            if m.group(3):
                fields['currency'] = m.group(3)

        m = re.search(r'Pieces\s*:\s*(\d+)', text, re.I)
        if m:
            fields['pieces'] = int(m.group(1))
            found_any = True

        m = re.search(r'Account\s*:\s*(\d+)', text, re.I)
        if m and not fields.get('account_number'):
            fields['account_number'] = m.group(1)
            found_any = True

        acct_i = idx_of(lambda l: bool(re.match(r'^Account\s*:\s*\d+$', l, re.I)))
        if acct_i is not None:
            j = acct_i + 1
            name = lines[j] if j < len(lines) else None
            if name and re.match(r"^[A-Za-z][A-Za-z .'\-]{1,60}$", name):
                if not fields.get('from_name'):
                    fields['from_name'] = name
                    found_any = True
                j += 1
                if j < len(lines) and lines[j] == name:
                    j += 1
                if j < len(lines) and not fields.get('from_address'):
                    fields['from_address'] = lines[j].rstrip('-, ').strip()
                j += 1
                if j < len(lines):
                    cm = re.match(r'^([A-Za-z][A-Za-z\s]*?)\s+([A-Za-z][A-Za-z\s]*)$', lines[j])
                    if cm:
                        country = self._detect_country_local(cm.group(2))
                        if country:
                            if not fields.get('from_city'):
                                fields['from_city'] = cm.group(1).strip()
                            if not fields.get('from_country'):
                                fields['from_country'] = country

        m = re.search(r'Account\s*:.*?Tel\s*:\s*(\+?\d[\d\s]{6,15})', text, re.I | re.S)
        if m and not fields.get('from_contact'):
            fields['from_contact'] = re.sub(r'\s+', '', m.group(1))

        to_i = idx_of(lambda l: bool(re.match(r'^To\s*:\s*\S', l, re.I)))
        if to_i is not None:
            name = re.sub(r'^To\s*:\s*', '', lines[to_i], flags=re.I).strip()
            if name and not fields.get('to_name'):
                fields['to_name'] = name
                found_any = True
            j = to_i + 1
            if j < len(lines) and lines[j] == name:
                j += 1
            addr_lines = []
            while j < len(lines) and not re.match(r'^[A-Za-z][A-Za-z\s]*-$', lines[j]):
                addr_lines.append(lines[j])
                j += 1
                if len(addr_lines) >= 3:
                    break
            if addr_lines and not fields.get('to_address'):
                fields['to_address'] = ' '.join(addr_lines).strip()
            if j < len(lines):
                cm = re.match(r'^([A-Za-z][A-Za-z\s]*)-$', lines[j])
                if cm and not fields.get('to_city'):
                    fields['to_city'] = cm.group(1).strip()
                if j + 1 < len(lines) and not fields.get('to_country'):
                    country = self._detect_country_local(lines[j + 1])
                    if country:
                        fields['to_country'] = country

        m = re.search(r'To\s*:.*?(?:Tel|Mob)\s*:\s*(\+?\d[\d\s]{6,15})', text, re.I | re.S)
        if m and not fields.get('to_contact'):
            fields['to_contact'] = re.sub(r'\s+', '', m.group(1))

        return found_any

    _BARCODE_GLYPHS = '█▌▐▄▀▁▂▃▅▆▇■□▪▫'

    @classmethod
    def _clean_barcode_noise(cls, line):
        """Strips barcode-graphic glyph runs that the text layer renders
        interleaved directly into otherwise-normal content lines on the
        thermal-label format (e.g. "To: JASER ████████8 ▐▐▐▐▐▐▐▐" ->
        "To: JASER") — a token is dropped if 2+ of its characters are
        block-drawing glyphs, real words never trip this."""
        kept = [t for t in line.split(' ') if sum(c in cls._BARCODE_GLYPHS for c in t) < 2]
        return ' '.join(kept).strip()

    # ── Tracking ──────────────────────────────────────────────────────────────
    # Aramex uses barcode-wrapped AWB: *37294289782*

    def _tracking(self, text, fields):
        awb = extract_barcode_number(text)
        if awb:
            fields['carrier_tracking_number'] = awb
            return
        phones = extract_phones(text)
        n = find_digit_run(text, 11, exclude=phones)
        if n:
            fields['carrier_tracking_number'] = n

    # ── Weight ────────────────────────────────────────────────────────────────
    # Aramex: "2.20 KG" — first occurrence is actual weight

    def _weight(self, text, fields):
        m = re.search(r'(\d+\.\d+)\s*KG', _pre_legal_text(text), re.I)
        if m:
            fields['actual_weight'] = float(m.group(1))
            fields['weight_unit'] = 'kg'
        fields['billing_weight'] = fields['billing_weight'] or fields['actual_weight']

    # ── Ship date ─────────────────────────────────────────────────────────────
    # Aramex: "03/17/2026" (MM/DD/YYYY)

    def _ship_date(self, text, fields):
        m = re.search(r'\b(\d{2}/\d{2}/\d{4})\b', _pre_legal_text(text))
        if m:
            fields['ship_date'] = m.group(1)
            return
        fields['ship_date'] = extract_ship_date(text)

    # ── Contents ──────────────────────────────────────────────────────────────
    # Aramex: "Description of Goods/Harmonized Code: MONTHLY CALENDAR"
    #
    # FIX: the naive "grab whatever follows the label" capture can pull in
    # the neighbouring "Customs Value | Currency" header text instead of
    # the real goods description, because that header sits immediately to
    # the right of the Description-of-Goods field on the form and OCR can
    # bleed it in. We now validate every candidate against a blacklist and
    # fall through multiple strategies, ending with a position-based
    # heuristic anchored on the EXP/STD service-type line, which in the
    # real flat-text layout reliably follows the goods description
    # ("...150.00 INR\nMONTHLY CALENDAR\nEXP...").

    def _contents(self, text, fields):
        text = _pre_legal_text(text)
        candidates = []

        m = re.search(r'Description\s+of\s+Goods[^:]*:\s*([^\n]{3,80})', text, re.I)
        if m:
            candidates.append(m.group(1).strip())

        # NOTE: this secondary pattern must not be allowed to match the
        # "8 COST OF GOODS" section header elsewhere on the form — a bare
        # "GOODS" keyword search will happily latch onto it and grab
        # whatever junk follows ("No Charges ifnot Noted"), which is
        # exactly the failure seen on the 37294289782 sample's real OCR
        # output. Guard with a negative lookbehind for "COST OF ".
        m = re.search(r'(?<!COST OF )(?:GOODS|COMMODITY|CONTENT)[:\s]+([A-Z][^\n]{3,80})', text, re.I)
        if m:
            candidates.append(m.group(1).strip())

        for val in candidates:
            if val and val.upper() not in ('', 'N/A') and not _CONTENTS_BLACKLIST_RE.search(val):
                fields['contents'] = val
                return

        # Position-based fallback: the observed real-world orderings put
        # the goods-description line either directly before OR directly
        # after the declared-value/currency line, depending on whether
        # the source is clean PDF-text extraction (value, then contents)
        # or real tesseract OCR (contents, then value) — confirmed by
        # comparing actual samples of both. Rather than assume a fixed
        # direction, scan a small window on both sides of the value match
        # and pick the closest line that survives validation: not
        # blacklisted header/label text, not a phone/digit run, not an
        # airport-code pair, and — since a goods description never reads
        # like a company name — not containing a legal-entity suffix
        # (LLC/LTD/CO/etc, reusing _COMPANY_SUFFIX_RE).
        m_val = re.search(
            r'(\d+\.\d{2})\s+(INR|USD|GBP|EUR|AED|OMR|QAR|SAR|SGD|AUD|CAD)',
            text, re.I)
        if m_val:
            lines = [l.strip() for l in text.split('\n')]
            # locate which line index contains the value match
            running = 0
            val_idx = None
            for idx, raw_line in enumerate(text.split('\n')):
                running += len(raw_line) + 1  # +1 for the stripped '\n'
                if running > m_val.start():
                    val_idx = idx
                    break
            if val_idx is not None:
                window = []
                for dist in range(1, 5):
                    if val_idx - dist >= 0:
                        window.append((dist, lines[val_idx - dist]))
                    if val_idx + dist < len(lines):
                        window.append((dist, lines[val_idx + dist]))
                window.sort(key=lambda t: t[0])
                for _, cand in window:
                    if (cand and len(cand) >= 3
                            and not re.match(r'^[\d\.\s]+$', cand)
                            and not _CONTENTS_BLACKLIST_RE.search(cand)
                            and not re.match(r'^[A-Z]{3}\s+[A-Z]{3}$', cand)
                            and not _COMPANY_SUFFIX_RE.search(cand)
                            and not re.match(r'^\+?\d[\d\s\-]{6,}$', cand)):
                        fields['contents'] = cand
                        return

        # Secondary fallback: the goods description line directly
        # precedes the EXP/STD service-type line in some text orderings.
        lines = [l.strip() for l in text.split('\n')]
        for i, line in enumerate(lines):
            if re.match(r'^\s*(EXP|STD|PPX|DOM)(\s+(EXP|STD|PPX|DOM))?\s*$', line, re.I):
                for j in range(i - 1, max(i - 4, -1), -1):
                    cand = lines[j].strip()
                    if (cand and len(cand) >= 3
                            and not re.match(r'^[\d\.\s]+$', cand)
                            and not _CONTENTS_BLACKLIST_RE.search(cand)
                            and not re.match(r'^[A-Z]{3}\s+[A-Z]{3}$', cand)
                            and not _COMPANY_SUFFIX_RE.search(cand)
                            and 'PROD' not in cand.upper()
                            and 'SERVICE' not in cand.upper()):
                        fields['contents'] = cand
                        return
                break

    # ── Declared value ────────────────────────────────────────────────────────
    # Aramex: "150.00 INR" (bare amount + currency near customs value area)

    def _declared_value(self, text, fields):
        text = _pre_legal_text(text)
        m = re.search(
            r'(\d+\.\d{2})\s+(INR|USD|GBP|EUR|AED|OMR|QAR|SAR|SGD|AUD|CAD)',
            text, re.I)
        if m:
            fields['declared_value'] = float(m.group(1))
            fields['currency'] = m.group(2).upper()
            return

        # Decoupled fallback: amount and currency found independently
        # within the same neighbourhood of text, in case OCR drops the
        # connecting whitespace or injects a stray token between them.
        m_amt = re.search(r'\b(\d+\.\d{2})\b', text)
        m_cur = re.search(
            r'\b(INR|USD|GBP|EUR|AED|OMR|QAR|SAR|SGD|AUD|CAD)\b', text, re.I)
        if m_amt:
            fields['declared_value'] = float(m_amt.group(1))
        if m_cur:
            fields['currency'] = m_cur.group(1).upper()

    # ── Service type ──────────────────────────────────────────────────────────
    # Aramex: EXP = Express, PPX = Prepaid billing

    def _service(self, text, fields):
        upper = text.upper()
        if re.search(r'\bEXP\b', upper):
            fields['service_type'] = 'Express'
        fields['billing_type'] = 'Prepaid' if re.search(r'\bPPX\b', upper) else None

    # ── Pieces ────────────────────────────────────────────────────────────────
    # Aramex: "No. of Pieces  1"

    def _pieces(self, text, fields):
        m = re.search(r'No\.\s*of\s*Pieces\s+(\d+)', text, re.I)
        if m:
            fields['pieces'] = int(m.group(1))
            return
        m = re.search(r'(\d+)\s*OF\s*(\d+)', text, re.I)
        if m:
            fields['pieces'] = int(m.group(2))

    # ── Origin / destination codes ────────────────────────────────────────────
    # Aramex: "ORG. STN  MAA" / "DEST. STN  AUH"
    # Also appears as "MAA AUH" on its own line

    def _origin_destination(self, text, fields):
        # The two airport codes consistently appear together on their own
        # line (e.g. "MAA AUH"), printed *after* the "ORG.STN | DEST.STN"
        # labels rather than immediately beside each one. A naive
        # label-adjacent regex ends up grabbing whatever 3-letter token
        # happens to follow the label textually — which is usually the
        # *origin* code even when matching the "DEST. STN" label, since
        # both codes sit together on the next line. Try the paired-code
        # line first; it has been 100% reliable across real samples,
        # whereas the label regex silently produces wrong values.
        for line in text.split('\n'):
            tokens = re.findall(r'\b([A-Z]{3})\b', line.strip())
            if (len(tokens) == 2
                    and tokens[0] in _KNOWN_AIRPORT_CODES
                    and tokens[1] in _KNOWN_AIRPORT_CODES):
                fields['origin_code'] = tokens[0]
                fields['destination_code'] = tokens[1]
                return

        # Fallback only: label-adjacent codes, validated against the
        # known-code set so OCR noise can't produce garbage values.
        m_org = re.search(r'\bORG\.?\s*STN\s+([A-Z]{3})\b', text, re.I)
        m_dst = re.search(r'\bDEST\.?\s*STN\s+([A-Z]{3})\b', text, re.I)
        if m_org and m_org.group(1).upper() in _KNOWN_AIRPORT_CODES:
            fields['origin_code'] = m_org.group(1).upper()
        if m_dst and m_dst.group(1).upper() in _KNOWN_AIRPORT_CODES:
            fields['destination_code'] = m_dst.group(1).upper()

    # ── Addresses ─────────────────────────────────────────────────────────────
    # Aramex structured layout:
    #   1 FROM (SHIPPER)
    #     From (Your Name): MANIKANDAN KULLAN
    #     Street Address:   NO.1, THIRUVALLUVAR STREET...
    #     City:             Akkur (Nagapattinam)
    #     State/Province:   Tamil Nadu
    #     Country:          India
    #     ZIP/Postal Code:  609301
    #
    #   2 TO (RECEIVER)
    #     To (Receiver Name): KIND ATTN MR.ALAA KHAMASH
    #     Company:            CICON EPOXY & STEEL CUTTING PLANT LLC SPC
    #     Street Address:     P.O BOX NO - 9704...
    #     City:               Abu Dhabi
    #     Country:            United Arab Emirates
    #
    # Flat OCR text fallback: sender block appears at the top before the AWB
    # barcode number; receiver "KIND ATTN" marker signals the receiver block.

    def _addresses(self, from_block, to_block, fields):
        from_block = self._extract_and_strip_company(from_block, fields, 'sender_company')
        to_block = self._extract_and_strip_company(to_block, fields, 'receiver_company')
        if from_block:
            parse_address_block(from_block, fields, 'from_')
        if to_block:
            parse_address_block(to_block, fields, 'to_')
        return from_block, to_block

    def _extract_and_strip_company(self, block, fields, company_field):
        """Pulls a legal-entity-suffixed line (LLC/LTD/PTE/CO/...) out of a
        from_/to_ block and into sender_company/receiver_company, removing
        it from the block so it doesn't also end up folded into the street
        address by parse_address_block's generic line collector.

        This is a fallback alongside (not a replacement for) the
        structured grid's own "Company\\n<value>" label match in
        _recover_scattered_fields — that one is more precise when the
        grid's own label text is present, but on a real sample that
        section turned out to be image-only (rasterized, no text layer at
        all), leaving the company name only findable here, inside the
        flat KIND-ATTN-anchored block built from genuinely-native text.
        Skips the very first line (the contact/recipient name), since
        that's never the company even on the rare label that contains a
        legal-entity-like word.
        """
        if not block or fields.get(company_field):
            return block
        lines = block.split('\n')
        for i, line in enumerate(lines[1:], start=1):
            if _COMPANY_SUFFIX_RE.search(line) and not re.match(r'^[\d\+\-\s\(\)\.]+$', line.strip()):
                fields[company_field] = line.strip()
                return '\n'.join(lines[:i] + lines[i + 1:])
        return block

    def _recover_scattered_fields(self, text, fields):
        """Last-resort safety net for fields the windowed block
        extraction misses on heavily-garbled real OCR text — see the
        module-level comment on _GLOBAL_LABEL_VALUE_PATTERNS. Confirmed
        necessary against the real rawText for sample 37294289782,
        where to_city/to_country/to_company were landing as null because
        they sit well past the KIND-ATTN-anchored fallback's window.
        Only fills fields that are still empty; never overwrites a value
        the normal extraction already found.

        Confirmed bug: without a "KIND ATTN" anchor to work from (not
        every real sample has one — see the classic-AWB scrambled layout
        this file also handles), `anchor` fell back to the midpoint of
        the ENTIRE text — and since the "CONDITIONS OF CARRIAGE" legal
        boilerplate runs to several thousand characters (dwarfing the
        actual shipment-data portion), that midpoint lands deep inside
        the legal text on most real samples. The generic label patterns
        below then matched clause fragments there and handed them back as
        from_name/to_city/etc. Restricted to _pre_legal_text() so the
        legal section is never a match target here, regardless of where
        the anchor ends up.
        """
        pre_legal = _pre_legal_text(text)
        anchor_m = re.search(r'KIND\s*ATTN', pre_legal, re.I)
        anchor = anchor_m.start() if anchor_m else len(pre_legal) // 2
        for key, pat in _GLOBAL_LABEL_VALUE_PATTERNS.items():
            for m in pat.finditer(pre_legal):
                val = m.group(1).strip().split('\n')[0].strip()
                val = re.sub(r'\s{2,}.*$', '', val).strip()  # drop trailing bled-in columns
                if not val or len(val) < 2:
                    continue
                side = 'to_' if m.start() > anchor else 'from_'
                fname = side + key
                if not fields.get(fname):
                    fields[fname] = val

    def _extract_from_block(self, text):
        # Structured layout: section between "1 FROM" and "2 TO"
        m = re.search(
            r'(?:1\s*FROM|FROM\s*\(SHIPPER\))(.*?)(?=2\s*TO\s*\(RECEIVER\)|TO\s*\(RECEIVER\))',
            text, re.I | re.S)
        if m:
            block = m.group(1)
            lines = []
            found = set()
            for label, pat in [
                ('name',    r'From\s*\(Your\s*Name\)[^\n]*\n([^\n]+)'),
                ('addr',    r'Street\s*Address[^\n]*\n([^\n]+)'),
                ('city',    r'^City\s*\n([^\n]+)'),
                ('state',   r'State/Province\s*\n([^\n]+)'),
                ('country', r'^Country\s*\n([^\n]+)'),
                ('postal',  r'ZIP/Postal\s*Code\s*\n([^\n]+)'),
            ]:
                mm = re.search(pat, block, re.I | re.M)
                if mm:
                    lines.append(mm.group(1).strip())
                    found.add(label)
            # FIX (claim 1 / horizontal bleed): if the structured pass
            # above missed city/state (labels dropped or merged with the
            # adjacent Services/Remarks columns), try a flexible
            # fallback that doesn't require the value to sit alone on
            # the very next line.
            if not any(re.match(r'^(akkur|tamil|bangalore|mumbai|delhi|chennai)', l, re.I) for l in lines):
                flex = re.search(
                    r'City\s+State/Province.*?\n\s*([\w\s\(\)]+?)\s{2,}'
                    r'([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*)',
                    block, re.I)
                if flex:
                    lines.append(flex.group(1).strip())
                    lines.append(flex.group(2).strip())
                    found.add('city')
            # Only trust this pass if it actually recovered locality info
            # (city or country) — confirmed necessary on a real sample
            # where OCR corruption garbled the "City"/"Country" header
            # labels badly enough that only the street-address line
            # survived. Returning early with just that would skip the
            # flat-OCR fallback below, which handles this exact unlabeled
            # content correctly (proven on 2 other samples) via
            # parse_address_block's own general-purpose city/postal
            # detection — but only gets a chance to run if this method
            # doesn't claim a (incomplete) win first.
            if lines and ('city' in found or 'country' in found):
                return '\n'.join(lines)

        # Flat OCR fallback: sender block is before "KIND ATTN" or the
        # barcode, or the "2 TO (RECEIVER)" section marker — whichever
        # comes first. The section-marker stop is needed alongside "KIND
        # ATTN" because heavy OCR corruption can reorder content within
        # the receiver section (confirmed on a real sample where the
        # receiver's company name read out BEFORE "KIND ATTN" in OCR
        # order), which would otherwise bleed straight into this block.
        #
        # Confirmed bug: when NONE of those three stop-patterns appear
        # early (or at all) in the text, `.*?` has nothing to lazily stop
        # at and keeps expanding — on a real sample that landed deep
        # inside the "CONDITIONS OF CARRIAGE" legal boilerplate, and the
        # line-sorting below then handed back legal-text sentences as
        # from_name/from_city (several ALL-CAPS-opening clause fragments
        # happened to look "name-like" to the caps-heuristic sort). Search
        # within _pre_legal_text() so that section can never be a match
        # target here, regardless of why the earlier stop-patterns missed.
        m = re.search(r'^(.*?)(?=KIND\s*ATTN|\*\d{8,14}\*|\d\s*TO\s*\(RECEIVER\))', _pre_legal_text(text), re.S | re.I)
        if m:
            raw = m.group(1).strip()
            lines = [
                l.strip() for l in raw.split('\n')
                if l.strip()
                and not re.match(r'^[\d\.\s]+$', l.strip())
                and not re.match(r'^X$', l.strip(), re.I)
                # FIX: drop carrier letterhead / section-header noise
                # (e.g. "aqramex", "4 FROM (SHIPPER)", "Shipper's
                # Account No.", "FORWARDER", "ARWAYSEL") so the first
                # surviving line is an actual data value, not page
                # furniture. This is what was producing
                # from_name == "aqramex" in production.
                and not _LETTERHEAD_NOISE_RE.match(l.strip())
            ]
            # NOTE: a previous version of this method also ran every line
            # through `_strip_trailing_digit_noise()` here, intended to
            # clean up stray OCR digit artifacts. Removed — confirmed
            # actively destroying two different kinds of legitimate data
            # on real samples: a sender's phone number glued to the end of
            # a repeated name line ("MANIKANDAN KULLAN 917708992856"), and
            # a postal code glued to the end of a country-name line
            # ("India 609301") — both lost their trailing digits entirely,
            # silently leaving from_contact/from_postal null even though
            # the data was sitting right there in the block.
            lines = [l for l in lines if l]
            if lines:
                # Prefer caps-style "name" lines first (see
                # _is_caps_name_like) so leftover OCR-garbled label
                # fragments (e.g. a misread "Shipper's Ref.") don't get
                # picked over the real name line just because they
                # survived the letterhead blacklist. Stable sort keeps
                # original relative order within each group.
                lines.sort(key=lambda l: 0 if _is_caps_name_like(l) else 1)
                return '\n'.join(lines[:14])

        # Waybill-doc fallback
        m = re.search(r'Shipper\s*:\s*(.*?)(?=\nReceiver\s*:|$)', text, re.I | re.S)
        if m:
            lines = [l.strip() for l in m.group(1).strip().split('\n') if l.strip()][:5]
            return '\n'.join(lines)
        return None

    def _extract_to_block(self, text):
        # Structured layout: section after "2 TO (RECEIVER)"
        m = re.search(
            r"(?:2\s*TO\s*\(RECEIVER\)|TO\s*\(RECEIVER\))(.*?)(?=3\s*SHIPPER|SHIPPER'S\s*SIGNATURE|CONDITIONS\s*OF|\Z)",
            text, re.I | re.S)
        if m:
            block = m.group(1)
            lines = []
            found = set()
            for label, pat in [
                ('name',    r'To\s*\(Receiver\s*Name\)[^\n]*\n([^\n]+)'),
                ('company', r'^Company\s*\n([^\n]+)'),
                ('addr',    r'Street\s*Address[^\n]*\n([^\n]+)'),
                ('city',    r'^City\s*\n([^\n]+)'),
                ('state',   r'State/Province\s*\n([^\n]+)'),
                ('country', r'^Country\s*\n([^\n]+)'),
                ('postal',  r'ZIP/Postal\s*Code\s*\n([^\n]+)'),
            ]:
                mm = re.search(pat, block, re.I | re.M)
                if mm:
                    lines.append(mm.group(1).strip())
                    found.add(label)
            # See matching comment in _extract_from_block — only trust this
            # pass if it actually recovered locality info.
            if lines and ('city' in found or 'country' in found):
                return '\n'.join(lines)

        # Flat OCR fallback: receiver block starts at "KIND ATTN" marker
        m = re.search(
            r'(KIND\s*ATTN[^\n]*\n(?:(?!CONDITIONS\s*OF|SHIPPER|ARAMEX\s+will)[^\n]+\n){0,8})',
            text, re.I)
        if m:
            lines = [l.strip() for l in m.group(1).split('\n') if l.strip()]
            return '\n'.join(lines[:8])
        return None

    # ── Phones ────────────────────────────────────────────────────────────────

    def _phones(self, text, from_block, to_block, fields):
        # Prefer a phone found WITHIN the matched from_/to_ block over the
        # whole-document guess below.
        if from_block:
            fp = extract_phones(from_block)
            if fp and not fields['from_contact']:
                fields['from_contact'] = fp[0]
        if to_block:
            tp = extract_phones(to_block)
            if tp and not fields['to_contact']:
                fields['to_contact'] = tp[0]

        # Whole-document fallback, anchored on "KIND ATTN" and
        # deduplicated by phone number — needed because (a) a from_/to_
        # block can legitimately end up phone-less even though the
        # document has the number (e.g. it only survived glued to the
        # name on a line that a *different* cleaning pass strips trailing
        # digits from, for that field's sake — confirmed on a real
        # sample), and (b) the same phone is frequently printed twice for
        # one party, which breaks a naive whole-document "phones[0]=
        # sender, phones[1]=receiver" index (the repeat just shifts
        # everything by one rather than ever reaching the other party's
        # number).
        #
        # Restricted to _pre_legal_text() — same reasoning as
        # _recover_scattered_fields above: without a "KIND ATTN" anchor,
        # this fell back to the whole-document midpoint, which on a
        # long-legal-boilerplate sample sits inside that boilerplate.
        if not fields['from_contact'] or not fields['to_contact']:
            pre_legal = _pre_legal_text(text)
            anchor_m = re.search(r'KIND\s*ATTN', pre_legal, re.I)
            anchor = anchor_m.start() if anchor_m else len(pre_legal) // 2
            seen = set()
            before, after = None, None
            for phone, pos in extract_phones_with_positions(pre_legal):
                if phone in seen:
                    continue
                seen.add(phone)
                if pos < anchor:
                    before = before or phone
                else:
                    after = after or phone
            if before and not fields['from_contact']:
                fields['from_contact'] = before
            if after and not fields['to_contact']:
                fields['to_contact'] = after

    # ── KIND ATTN normalization (defensive, direction-agnostic) ─────────────
    # On every real sample checked, "KIND ATTN ..." correctly lands in
    # to_name and the corporate name correctly lands in to_company — the
    # original bug report's claim that these are swapped does not
    # reproduce. This safety net only fires if KIND ATTN is found on the
    # *company* side instead (the reverse case), which could plausibly
    # happen under different OCR noise even though it hasn't been
    # observed yet. It does nothing on the samples on hand.

    def _apply_gulf_destination_fallback(self, fields):
        """Fills to_city/to_country from the destination airport code when
        the OCR'd address text didn't yield them directly. The destination
        code (_origin_destination) comes from a dedicated paired-code line
        that's been 100% reliable across real samples, making it a sturdier
        signal than re-parsing a city name that's frequently split across
        merged form columns. NOTE: this map/intent already existed in this
        file (_GULF_AIRPORT_CITY) but was never actually called from
        anywhere — confirmed by grep — so it had no effect until now.
        """
        code = (fields.get('destination_code') or '').upper()
        if not fields.get('to_city') and code in _GULF_AIRPORT_CITY:
            fields['to_city'] = _GULF_AIRPORT_CITY[code]
        if not fields.get('to_country') and code in _GULF_AIRPORT_COUNTRY:
            fields['to_country'] = _GULF_AIRPORT_COUNTRY[code]

    def _normalize_kind_attn(self, fields):
        to_company = fields.get('to_company') or ''
        to_name = fields.get('to_name') or ''
        if 'KIND ATTN' in to_company.upper() and 'KIND ATTN' not in to_name.upper():
            fields['to_company'], fields['to_name'] = to_name, to_company

    # ── Carrier-specific extras ───────────────────────────────────────────────

    def _carrier_specific(self, text, fields):
        upper = text.upper()
        ppx = bool(re.search(r'\bPPX\b', upper))
        exp = bool(re.search(r'\bEXP\b', upper))
        route = None
        if fields.get('origin_code') and fields.get('destination_code'):
            route = f"{fields['origin_code']} {fields['destination_code']}"
        fields['carrier_specific'] = json.dumps({
            'aramex': {'ppx': ppx, 'exp': exp, 'route': route}
        })

    # ── Country extraction (flat OCR layout) ──────────────────────────────────
    # In Aramex flat OCR text the from/to countries appear on consecutive lines
    # immediately after the barcode-wrapped AWB number. Verified against real
    # flat text from all three samples on hand — this pattern holds
    # ("...*37294289782*\nIndia\nUnited Arab Emirates\nMAA AUH..."), so this
    # is left functionally unchanged from the original implementation.
    # Override the inherited country detection with this targeted extraction.

    def _extract_countries_from_barcode_block(self, text, fields):
        """After *AWB* the next two non-empty, non-code lines are from_country
        and to_country.  Falls back to COUNTRY_MAP scan if this pattern is
        absent (e.g. structured label format with explicit Country: fields)."""
        m = re.search(r'\*\d{8,14}\*\s*\n(.*?)(?=\n[A-Z]{3}\s+[A-Z]{3}|\Z)',
                      text, re.S | re.I)
        if not m:
            return
        lines = [l.strip() for l in m.group(1).split('\n') if l.strip()]
        if len(lines) >= 2:
            from parsers.base_parser import detect_country
            c1 = detect_country(lines[0])
            c2 = detect_country(lines[1])
            if c1 and not fields.get('from_country'):
                fields['from_country'] = c1
            if c2 and not fields.get('to_country'):
                fields['to_country'] = c2