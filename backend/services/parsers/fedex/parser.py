#!/usr/bin/env python3
"""
FedEx AWB parser for Garuda Express.

Handles FedEx Express International Priority labels.

Detected by the presence of:
  - 'FEDEX' / 'FED EX' / 'FEDERAL EXPRESS' in text
  - OR FedEx-specific field markers: TRK#, ACTWGT

Tracking format : TRK# XXXX XXXX XXXX  (12-digit, space-grouped)
Fallback        : standalone 12-digit number

Sample labels covered:
  • SWETHA_K__CANADA     – FedEx Express, Ottawa ON, Canada
  • EMILY_GERRARD        – FedEx Express, Calgary AB, Canada
  • HUORIGIN__SINGAPORE  – FedEx Express, Singapore
  • EX889649670588       – FedEx Express, Singapore (MSS Asan / Huorigin)
"""
import re, json, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))  # services/
from parsers.base_parser import (
    BaseParser, parse_address_block, extract_lines_after,
    extract_ship_date,
    extract_declared_value, extract_phones,
)


class FedExParser(BaseParser):
    carrier_name = 'FedEx'

    # ── Detection ────────────────────────────────────────────────────────────

    def detect(self, text: str) -> bool:
        upper = text.upper()
        return any(token in upper for token in [
            'FEDEX', 'FED EX', 'FEDERAL EXPRESS',
            'TRK#', 'ACTWGT', 'ACTWG T',
        ])

    # ── Main parse ───────────────────────────────────────────────────────────

    def parse(self, text: str) -> dict:
        fields = self._init_fields()
        fields['carrier'] = 'FedEx'

        from_block = self._extract_from_block(text)
        to_block = self._extract_to_block(text)

        self._tracking(text, fields)
        self._weight(text, fields)
        self._ship_date(text, fields)
        self._contents(text, fields)
        self._declared_value(text, fields)
        self._service(text, fields)
        self._pieces(text, fields)
        self._addresses(from_block, to_block, fields)
        self._phones(text, from_block, to_block, fields)

        return fields

    # ── Tracking ─────────────────────────────────────────────────────────────

    def _tracking(self, text, fields):
        # Primary: TRK# XXXX XXXX XXXX — tolerate common OCR misreads of
        # the '#' itself (confirmed real: "TRKe" for "TRK#"); a corrupted
        # DIGIT within the number (also seen on a real sample: "880/" for
        # "8807") isn't something a regex can safely recover from, since
        # there's no reliable way to know which digit a stray symbol like
        # "/" was meant to be.
        m = re.search(r'TRK\s*[#eE\$sS]?\s*(\d{4})\s+(\d{4})\s+(\d{4})', text, re.I)
        if m:
            fields['carrier_tracking_number'] = m.group(1) + m.group(2) + m.group(3)
            return

        # Fallback: standalone 12-digit number (e.g. 8896 4967 0588 run together)
        m = re.search(r'\b(\d{12})\b', text)
        if m:
            fields['carrier_tracking_number'] = m.group(1)

    # ── Weight ───────────────────────────────────────────────────────────────

    def _weight(self, text, fields):
        # ACTW\s*S?\s*G?T tolerates the real "ACTWSGT" OCR misread (extra S)
        # confirmed on a real sample, alongside the correct ACTWGT/ACTWT.
        m = re.search(r'ACTW\s*S?\s*G?T[:\s]+([0-9]+\.?[0-9]*)\s*(KG|LB)', text, re.I)
        if m:
            fields['actual_weight'] = float(m.group(1))
            fields['weight_unit'] = m.group(2).lower()
        fields['billing_weight'] = fields['billing_weight'] or fields['actual_weight']

    # ── Dimensions ───────────────────────────────────────────────────────────
    # Deliberately not extracted from the waybill — OCR reads on this field
    # were consistently unreliable in practice (see the matching note in
    # waybillFieldSchema.js), so we leave it None rather than guess.

    # ── Ship date ────────────────────────────────────────────────────────────

    def _ship_date(self, text, fields):
        fields['ship_date'] = extract_ship_date(text)

    # ── Contents ─────────────────────────────────────────────────────────────
    # FedEx labels carry DESC1 / DESC2 / DESC3 / DESC4 lines.
    # Example:
    #   DESC1:INDIAN BRANDED SPICE POWDER (MADE FROM ROSTED AND DRIED CHIL
    #   DESC2:INDIAN BRANDED SNACKS(MADE FROM RICE FLOUR, GRAM FLOUR, VARI
    #   DESC3:INDIAN BRANDED SPICES
    #   DESC4:INDIAN BRANDED SWEET(MADE FROM GRAM FLOUR, ALL PURPOSE FLOUR
    # We concatenate up to 2 meaningful description lines.

    def _contents(self, text, fields):
        # NOTE: separator is `[:\t ]+` — deliberately NOT `[:\s]+`. `\s` also
        # matches newlines, so on a real sample where DESC2/DESC3 are empty
        # ("DESC2:\n\nDESC3:\n\nDESC4:") the old `[:\s]+` greedily ate through
        # the blank line(s) and grabbed the *next* "DESC3:" label text as if
        # it were DESC2's value — confirmed bug, produced contents like
        # "HERBAL PRODUCTS; DESC3:". Restricting to horizontal whitespace
        # only keeps each match on its own line.
        descs = re.findall(r'DESC\d*[:\t ]+([^\n]{3,80})', text, re.I)
        descs = [
            d.strip() for d in descs
            if d.strip() and len(d.strip()) > 2
            and not re.match(r'^DESC\d*\s*:?\s*$', d.strip(), re.I)
        ]
        if descs:
            fields['contents'] = '; '.join(descs[:2])

    # ── Invoice # ────────────────────────────────────────────────────────────
    # Deliberately not extracted from the waybill — same reasoning as
    # dimensions above.

    # ── Declared value ───────────────────────────────────────────────────────

    def _declared_value(self, text, fields):
        val, cur = extract_declared_value(text)
        if val is not None:
            fields['declared_value'] = val
            fields['currency'] = cur

    # ── Service type ─────────────────────────────────────────────────────────

    def _service(self, text, fields):
        upper = text.upper()
        for svc in ['INTERNATIONAL PRIORITY', 'INTERNATIONAL ECONOMY',
                    'PRIORITY OVERNIGHT', 'IP EOD']:
            if svc in upper:
                fields['service_type'] = svc.title()
                break

    # ── Pieces ───────────────────────────────────────────────────────────────

    def _pieces(self, text, fields):
        m = re.search(r'(\d+)\s*OF\s*(\d+)', text, re.I)
        if m:
            fields['pieces'] = int(m.group(2))

    # ── Addresses ────────────────────────────────────────────────────────────
    # FedEx layout:
    #   ORIGIN ID:MAAA  7010353043
    #   MARIYAMMAL KUMARAN                   ← sender name (same line as after ORIGIN ID num)
    #   MARIYAMMAL KUMARAN
    #   NO 5 ADHITHANAR STREET
    #   RAJIVGANDHI NAGAR ALAPAKKAM
    #   KANCHIPURAM, TN 600116
    #   IN
    #
    #   TO SWETHA K                          ← recipient name on "TO" line
    #   UNIT -601, 1551 LYCEE PLACE
    #   OTTAWA ONTARIO K1G 4B5
    #   (CA)

    # FedEx prints a 2-letter country code as the LAST line of each
    # address block — sometimes parenthesized ("(CA)"), sometimes bare
    # ("CA", "IN") depending on which page of the label it's read from.
    # The shared COUNTRY_MAP (used by every carrier parser) only matches
    # full country names ("INDIA", "CANADA", ...), so this never matched
    # and from_country came back null on every single FedEx-from-India
    # sample in this project — confirmed on all of them, since the Indian
    # sender block always ends in a bare "IN" line, never "INDIA".
    _COUNTRY_CODE_FALLBACK = {
        'IN': 'India', 'CA': 'Canada', 'US': 'United States', 'SG': 'Singapore',
        'AU': 'Australia', 'GB': 'United Kingdom', 'HK': 'Hong Kong',
        'AE': 'United Arab Emirates', 'CN': 'China', 'MY': 'Malaysia',
        'DE': 'Germany', 'FR': 'France', 'JP': 'Japan', 'NZ': 'New Zealand',
        'IE': 'Ireland', 'NL': 'Netherlands', 'ZA': 'South Africa',
    }

    def _country_code_fallback(self, block, fields, prefix):
        if not block or fields.get(f'{prefix}country'):
            return
        # Only the last non-empty line — the country code is reliably the
        # final line of the block, and restricting the check there (rather
        # than scanning every line) avoids a 2-letter state/unit
        # abbreviation elsewhere in the address being mistaken for one.
        non_empty = [l.strip() for l in block.split('\n') if l.strip()]
        if not non_empty:
            return
        code = non_empty[-1].strip('() ').upper()
        if code in self._COUNTRY_CODE_FALLBACK:
            fields[f'{prefix}country'] = self._COUNTRY_CODE_FALLBACK[code]

    def _addresses(self, from_block, to_block, fields):
        if from_block:
            parse_address_block(from_block, fields, 'from_')
            self._country_code_fallback(from_block, fields, 'from_')
        if to_block:
            parse_address_block(to_block, fields, 'to_')
            self._country_code_fallback(to_block, fields, 'to_')

    def _extract_from_block(self, text):
        # Capture sender name from the ORIGIN ID line, then following address
        # lines. Previously a `(?:[^\n]+\n){0,6}` repetition that silently
        # stopped at the FIRST blank line — confirmed on real FedEx OCR
        # samples (EMILY_GERRARD, SWETHA_K) this was dropping from_address /
        # from_city / from_country entirely, since a blank line routinely
        # appears between the name and the address lines.
        stop_res = [re.compile(r'^(?:SHIP\s*DATE|TO\s+[A-Z]|TRK#|REF\s*:)', re.I)]
        block = extract_lines_after(text, r'ORIGIN\s*ID[:\s]*\S*\s*', stop_res, max_lines=7)
        if block:
            lines = block.split('\n')
            # The captured block's first line is consistently the
            # remainder of the ORIGIN ID account/origin code (everything
            # up to the next newline after "ORIGIN ID:MAAA " is whatever
            # follows it on the SAME source line) — confirmed on every
            # FedEx sample in this project, never an actual address/name
            # line. Whether it happens to also look like a 10-digit phone
            # number is coincidental (depends only on which digit it
            # starts with), so it's dropped here rather than left to
            # accidentally leak into from_contact on some samples and not
            # others.
            if lines and re.match(r'^\d{6,14}$', lines[0].strip()):
                lines = lines[1:]
            block = '\n'.join(lines)
        return block

    def _extract_to_block(self, text):
        # "TO <NAME>" on one line, followed by address lines.
        stop_res = [re.compile(r'^(?:ACTWGT|TRK#|DIMS\b|DESC\d|FROM\s|REF\s*:)', re.I)]
        block = extract_lines_after(text, r'(?:^|\n)TO\s+', stop_res, max_lines=8)
        if block:
            return block
        # OCR sometimes merges "TO" directly into the name with no space
        # at all ("TOSWETHA K") — confirmed on a real sample, which made
        # the pattern above fail to match completely (to_name/to_address/
        # to_city/to_country all came back null). Retry requiring only
        # that "TO" is followed by an uppercase letter, not whitespace.
        return extract_lines_after(text, r'(?:^|\n)TO(?=[A-Z]{2,})', stop_res, max_lines=8)

    # ── Phones ───────────────────────────────────────────────────────────────

    def _phones(self, text, from_block, to_block, fields):
        # NOTE: a previous version of this method also tried to read a
        # sender phone directly off the ORIGIN ID line (`ORIGIN ID:MAAA
        # 7010353043` etc). That regex was removed — confirmed wrong on
        # every real FedEx sample in this project: that digit string is
        # the sender's FedEx account/origin code, not a phone number, and
        # these labels never print a separate phone immediately after it.
        # The greedy match was instead carving off the LAST 7 digits of
        # the account code itself and reporting them as from_contact.

        # Prefer a phone found WITHIN the matched from_/to_ address block
        # over a blind "first phone in the whole document = sender, second
        # = receiver" guess. Confirmed wrong on a real sample where the
        # sender has no phone printed at all and the only phone in the
        # document belongs to the receiver — the old whole-document
        # heuristic mis-assigned that receiver phone to from_contact.
        if from_block:
            fp = extract_phones(from_block)
            if fp and not fields['from_contact']:
                fields['from_contact'] = fp[0]
        if to_block:
            tp = extract_phones(to_block)
            if tp and not fields['to_contact']:
                fields['to_contact'] = tp[0]

        # Whole-document fallback ONLY when a block couldn't be located at
        # all — not merely "located, but has no phone in it". The latter is
        # a real, correct answer (e.g. this sender simply doesn't print a
        # phone on the label) and falling back to an arbitrary phone found
        # elsewhere in the document would just leak the OTHER party's
        # number in, exactly the bug this method exists to avoid.
        if from_block is None and not fields['from_contact']:
            phones = extract_phones(text)
            if phones:
                fields['from_contact'] = phones[0]
        if to_block is None and not fields['to_contact']:
            phones = extract_phones(text)
            if phones:
                fields['to_contact'] = phones[-1] if len(phones) > 1 else phones[0]