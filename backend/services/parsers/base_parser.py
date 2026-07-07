#!/usr/bin/env python3
"""
Base parser class + shared extraction utilities for Garuda Express AWB parsers.

Every carrier parser inherits from BaseParser and must implement:
  detect(text) -> bool          -- return True if text looks like this carrier
  parse(text)  -> dict          -- return a populated fields dict

Shared helpers live here so each carrier parser stays lean.
"""
import re, json

# ── Scorable / mandatory field lists (shared with ocr_worker.py) ────────────

SCORABLE_FIELDS = [
    'from_name','from_address','from_city','from_country','from_postal',
    'to_name','to_address','to_city','to_country','to_postal',
    'carrier','carrier_tracking_number','actual_weight','dimensions','contents',
]

MANDATORY_FIELDS = ['carrier_tracking_number', 'to_name', 'to_country']

MANDATORY_FIELD_LABELS = {
    'carrier_tracking_number': 'Tracking number not detected',
    'to_name': 'Receiver name not detected',
    'to_country': 'Destination country not detected',
}

# ── Country map ──────────────────────────────────────────────────────────────

COUNTRY_MAP = {
    r'\bINDIA\b':             'India',
    r'\bAUSTRALIA\b':         'Australia',
    r'\bCANADA\b':            'Canada',
    r'\(CA\)':                'Canada',
    r'\bSINGAPORE\b':         'Singapore',
    r'\(SG\)':                'Singapore',
    r'HONG\s*KONG':           'Hong Kong',
    r'\bIRELAND\b':           'Ireland',
    r'REPUBLIC\s*OF\b':       'Ireland',
    r'UNITED\s*STATES':       'USA',
    r'\bUSA\b':               'USA',
    r'\bUNITED\s*KINGDOM\b':  'UK',
    r'\bUAE\b':               'UAE',
    r'UNITED\s*ARAB':         'UAE',
    r'\bGERMANY\b':           'Germany',
    r'\bFRANCE\b':            'France',
    r'\bJAPAN\b':             'Japan',
    r'\bCHINA\b':             'China',
    r'\bNEW\s*ZEALAND\b':     'New Zealand',
    r'\bNETHERLANDS\b':       'Netherlands',
    r'\bSWEDEN\b':            'Sweden',
    r'\bNORWAY\b':            'Norway',
    r'\bDENMARK\b':           'Denmark',
    r'\bITALY\b':             'Italy',
    r'\bSPAIN\b':             'Spain',
    r'\bMALAYSIA\b':          'Malaysia',
    r'\bTHAILAND\b':          'Thailand',
    r'\bINDONESIA\b':         'Indonesia',
    # Gulf / Middle East — common Aramex destinations
    r'\bOMAN\b':              'Oman',
    r'\bQATAR\b':             'Qatar',
    r'\bBAHRAIN\b':           'Bahrain',
    r'\bKUWAIT\b':            'Kuwait',
    r'\bSAUDI\s*ARABIA\b':    'Saudi Arabia',
    r'\bJORDAN\b':            'Jordan',
    r'\bEGYPT\b':             'Egypt',
    # South / Southeast Asia
    r'\bSRI\s*LANKA\b':       'Sri Lanka',
    r'\bBANGLADESH\b':        'Bangladesh',
    r'\bNEPAL\b':             'Nepal',
    r'\bPAKISTAN\b':          'Pakistan',
    r'\bPHILIPPINES\b':       'Philippines',
    r'\bVIETNAM\b':           'Vietnam',
    # Others
    r'\bSOUTH\s*AFRICA\b':    'South Africa',
    r'\bBRAZIL\b':            'Brazil',
    r'\bMEXICO\b':            'Mexico',
}

POSTAL_PATTERNS = [
    ('CA',      re.compile(r'\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b')),
    ('UK',      re.compile(r'\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b')),
    ('IE',      re.compile(r'\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b')),
    ('GENERIC', re.compile(r'(?:^|\s)(\d{4,6})\s*[A-Z]*\s*(?:\([A-Z]{2,3}\))?\s*[a-zA-Z]{0,2}\s*$')),
]

STREET_SUFFIX_RE = re.compile(
    r'\b(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|BLVD|BOULEVARD|'
    r'WAY|COURT|CT|PLACE|PL|UNIT|SUITE|STE|FLOOR|FLR|APT|BLOCK|PLOT)\b', re.I)

STATE_ABBR = re.compile(r'\b(TN|MH|KA|AP|TS|DL|WB|NSW|VIC|QLD|AB|ON|BC|PA|CA)\b')

STATE_NAME_MAP = {
    'ONTARIO':'ON','QUEBEC':'QC','BRITISH COLUMBIA':'BC','ALBERTA':'AB',
    'MANITOBA':'MB','SASKATCHEWAN':'SK','NOVA SCOTIA':'NS','NEW BRUNSWICK':'NB',
    'NEWFOUNDLAND':'NL','PRINCE EDWARD ISLAND':'PE',
    'NEW SOUTH WALES':'NSW','VICTORIA':'VIC','QUEENSLAND':'QLD',
    'WESTERN AUSTRALIA':'WA','SOUTH AUSTRALIA':'SA','TASMANIA':'TAS',
    'NORTHERN TERRITORY':'NT','AUSTRALIAN CAPITAL TERRITORY':'ACT',
    'TAMIL NADU':'TN','MAHARASHTRA':'MH','KARNATAKA':'KA','TELANGANA':'TS',
    'ANDHRA PRADESH':'AP','DELHI':'DL','WEST BENGAL':'WB',
}

# Tokens recognized as a real state/province (abbreviation OR single-word
# full name) when they appear as the last word right before a postal code.
# Used by _extract_postal_city_state to pick the most reliable candidate
# line when a block has more than one postal-pattern match (see comment
# there for the real sample that motivated this — a label whose address
# wraps a building name + postal code across an earlier line, before the
# real "CITY, COUNTRY POSTAL" summary line).
_KNOWN_STATE_TOKENS = {
    'TN', 'MH', 'KA', 'AP', 'TS', 'DL', 'WB', 'NSW', 'VIC', 'QLD', 'AB',
    'ON', 'BC', 'PA', 'CA',
} | {
    'ONTARIO', 'QUEBEC', 'ALBERTA', 'MANITOBA', 'SASKATCHEWAN', 'DELHI',
    'VICTORIA', 'QUEENSLAND', 'TASMANIA', 'KARNATAKA', 'MAHARASHTRA',
    'TELANGANA', 'KERALA', 'GUJARAT', 'PUNJAB', 'RAJASTHAN',
}

# Multi-word state/province names that can appear with no separator from
# the city name on the same line (e.g. "Akkur (Nagapattinam) Tamil Nadu")
# — sorted longest-first so e.g. "Andhra Pradesh" is tried before any
# shorter name that might otherwise partial-match its tail.
_MULTIWORD_STATE_NAMES = sorted([
    'Tamil Nadu', 'Andhra Pradesh', 'West Bengal', 'Madhya Pradesh',
    'Uttar Pradesh', 'Himachal Pradesh', 'Arunachal Pradesh',
    'New South Wales', 'South Australia', 'Western Australia',
    'British Columbia', 'Nova Scotia', 'New Brunswick',
    'Northern Territory', 'Prince Edward Island',
], key=len, reverse=True)

# A structured-form field-label line (or an OCR-garbled near-miss of one,
# e.g. "Country Fostal Code" for "Country  ZIP/Postal Code") that survived
# into the address block — confirmed picked up as a fake "city" by the
# backward-scan in _extract_postal_city_state when it sits immediately
# above the real country/postal line, displacing the real city line one
# further line back.
_FORM_LABEL_NOISE_RE = re.compile(
    r'\b(country|city|state|province|postal|zip|p\.?o\.?\s*box|address|'
    r'account\s*no|reference|phone\s*number)\b', re.I)

ADDRESS_LINE_RE = re.compile(
    r'^(?:UNIT|STE|SUITE|FLOOR|FLR|APT|APARTMENT|BLDG|BLOCK|PLOT|DOOR|NO\.?|#)\b', re.I)
LEADING_DIGIT_RE = re.compile(r'^\d')

# Tokens that mark the start of unrelated label metadata bleeding into a
# name/address line — either because OCR merged two visually-separate
# columns onto one text line, or because a from/to block was captured a
# little too eagerly. Stripped from the *first occurrence* onward, not just
# at line-start, since the bleed-in junk is frequently appended mid-line
# (e.g. "57 DEEPIKA FLAT CAD: 260478344/FAPI2208" — confirmed on a real
# FedEx OCR sample). `ACTW\s*S?\s*GT` tolerates the "ACTWSGT" OCR misread
# (an extra S) seen on another real sample, alongside the correct ACTWGT.
_TRAILING_METADATA_RE = re.compile(
    r'\s*\b(?:ACTW\s*S?\s*GT|SHIP\s*DWT|SHIP\s*DATE|DATE\s*:|TRK#|SHP\s*WT|SHP#|DWT\b|REF\s*:|REF\s*CODE|CONTACT\s*:?|'
    r'DIMS\b|CAD\s*:|B?ILL\s*SENDER|EIN\s*/\s*VAT|DESC\d*\s*:|PIECES\b|WAYBILL\b|'
    r'TRACKING\s*#|FORM\b|FED\s*E?X\.?\s*$|EXPRESS\.?\s*$|'
    r'\d+(?:\.\d+)?\s*(?:KG|LB)\s+\d+\s*OF\s*\d+).*$',
    re.I)


def strip_trailing_metadata(line):
    """Cuts a captured address/name line off at the first label-metadata
    token found anywhere in it (see _TRAILING_METADATA_RE), and returns the
    cleaned remainder. Returns '' if the whole line was metadata noise."""
    return _TRAILING_METADATA_RE.sub('', line).strip()


def extract_lines_after(text, start_re, stop_res=None, max_lines=10, clean=True):
    """Extract up to `max_lines` content lines that follow `start_re`.

    This replaces the fragile pattern used previously throughout the carrier
    parsers — a lazy regex capture bounded by `\\n\\s*\\n` (blank line) or a
    `(?:[^\\n]+\\n){0,N}` repetition (which silently stops the moment it hits
    ANY blank line). Real OCR/PDF text extraction routinely inserts blank
    lines between every visual row (confirmed on every carrier's samples —
    DHL, FedEx, UPS), so those patterns were truncating from_/to_ address
    blocks after just one or two lines, sometimes after zero. Here, blank
    lines are *skipped*, not treated as a terminator — only an explicit
    stop-marker line (start of a new section) ends the block early.

    Returns a '\\n'-joined string of the captured lines, or None if start_re
    doesn't match.
    """
    m = re.search(start_re, text, re.I)
    if m is None:
        return None
    tail = text[m.end():]
    nl = tail.find('\n')
    first_rest, after = (tail, '') if nl == -1 else (tail[:nl], tail[nl + 1:])

    collected = []

    def _consider(raw_line):
        s = raw_line.strip()
        if not s:
            return True  # blank line: skip silently, keep scanning
        if stop_res and any(p.search(s) for p in stop_res):
            return False  # stop marker hit: end the block
        if clean:
            s = strip_trailing_metadata(s)
        if s:
            collected.append(s)
        return len(collected) < max_lines

    if first_rest.strip():
        if not _consider(first_rest):
            return '\n'.join(collected) if collected else None

    if len(collected) < max_lines:
        for raw_line in after.split('\n'):
            if not _consider(raw_line):
                break

    return '\n'.join(collected) if collected else None


# ── Shared field-score / validation helpers ──────────────────────────────────

def compute_field_score(fields):
    detected = sum(1 for f in SCORABLE_FIELDS if fields.get(f) not in (None, '', 'null'))
    return round((detected / len(SCORABLE_FIELDS)) * 100, 1)


def validate_fields(fields):
    warnings = []
    for f in MANDATORY_FIELDS:
        if fields.get(f) in (None, '', 'null'):
            warnings.append(MANDATORY_FIELD_LABELS.get(f, f'{f} not detected'))
    return warnings


def blank_fields():
    return {
        "from_name": None, "from_address": None, "from_contact": None,
        "from_city": None, "from_state": None, "from_country": None, "from_postal": None,
        "to_name": None, "to_address": None, "to_contact": None,
        "to_city": None, "to_state": None, "to_country": None, "to_postal": None,
        "carrier": None, "carrier_tracking_number": None,
        "ship_date": None, "pieces": 1,
        "actual_weight": None, "billing_weight": None, "weight_unit": "kg",
        "dimensions": None, "contents": None,
        "service_type": None, "declared_value": None, "currency": "INR",
        "invoice_number": None,
        # Garuda Master Waybill extensions — mirrors services/waybillFieldSchema.js
        # FIELD_DEFS. None of these are in SCORABLE_FIELDS/MANDATORY_FIELDS
        # above (deliberately — see the matching comment in the JS schema):
        # they're carrier/shipment-type-dependent and routinely absent even on
        # a perfectly-read label. Carrier parsers aren't required to fill
        # these; the Gemini enrichment layer fills what it can on top.
        "sender_company": None, "receiver_company": None, "receiver_attention": None,
        "reference_number": None,
        "customs_value": None, "carriage_value": None,
        "origin_code": None, "destination_code": None,
        "package_length": None, "package_width": None, "package_height": None,
        "service_code": None, "route_code": None,
        "billing_type": None, "account_number": None,
        "carrier_specific": None,
    }


# ── Shared address-block utilities (used by all carrier parsers) ─────────────

def _is_locality_line(line):
    for _, pat in POSTAL_PATTERNS:
        if pat.search(line):
            return True
    for pat in COUNTRY_MAP:
        if re.search(pat, line, re.I):
            return True
    if _HYPHEN_CITY_STATE_POSTAL_RE.match(line.strip()):
        return True
    return False


# Country names that can appear as the lone word directly before a postal
# code (e.g. "India 600018", "Singapore 088385") — used to tell a real STATE
# apart from the COUNTRY repeating itself on the postal line. Built from
# COUNTRY_MAP's own values so it can't drift out of sync with that map.
_COUNTRY_NAME_SET = {v.upper() for v in COUNTRY_MAP.values()}
# City-states where the "city" IS the country name, not a place to be found
# by scanning backward through preceding lines (which, on a real sample,
# picked up a contact person's name instead — "Ms. Marianne Ponce" — because
# nothing else in the block looked like a locality or street line).
_CITY_STATE_COUNTRIES = {'SINGAPORE', 'MONACO', 'HONG KONG'}

# Indian DHL waybills often print address locality as one hyphenated token —
# "CHENNAI-TN-600018", "COIMBATORE-TN-641021" — which the generic
# whitespace-anchored POSTAL_PATTERNS below never matched (no whitespace
# precedes the digits), silently leaving city/state/postal all null even
# though the data was sitting right there. Checked first, before the
# whitespace-based patterns.
_HYPHEN_CITY_STATE_POSTAL_RE = re.compile(r'^([A-Za-z][A-Za-z .]*?)-([A-Z]{2})-(\d{4,6})$')


def _extract_postal_city_state(block):
    block_lines = block.split('\n')

    for line in block_lines:
        hm = _HYPHEN_CITY_STATE_POSTAL_RE.match(line.strip())
        if hm:
            return hm.group(3), hm.group(1).strip().title(), hm.group(2).upper()

    for kind, pat in POSTAL_PATTERNS:
        candidates = []  # (postal, city, state, is_strong)
        for idx, line in enumerate(block_lines):
            m = pat.search(line)
            if not m:
                continue
            postal = (m.group(1) + ' ' + m.group(2)).strip() if kind in ('CA', 'UK', 'IE') else m.group(1)
            prefix = line[:m.start()].strip(' ,.')
            words = [w for w in re.split(r'[,\s]+', prefix) if w]
            city, state, strong = None, None, False
            if len(words) >= 2:
                state = words[-1]
                city = ' '.join(words[:-1])
                strong = state.upper() in _KNOWN_STATE_TOKENS
                # A recognized city-state (Singapore, Hong Kong, Monaco)
                # has no real "state" subdivision — a second word before
                # the postal code on that line (e.g. "SINGAPORE SG
                # 768161") is a repeated country code, not a state.
                if words[0].upper() in _CITY_STATE_COUNTRIES:
                    city, state, strong = words[0], None, True
            elif len(words) == 1:
                word_upper = words[0].upper()
                is_country_name = word_upper in _COUNTRY_NAME_SET
                # Real state, not a repeated country name — keep prior behavior.
                state = None if is_country_name else words[0]
                strong = is_country_name
                if is_country_name and word_upper in _CITY_STATE_COUNTRIES:
                    city = words[0]
                else:
                    for back in range(idx - 1, -1, -1):
                        candidate = block_lines[back].strip()
                        if (candidate and not _is_locality_line(candidate)
                                and not STREET_SUFFIX_RE.search(candidate)
                                and not re.match(r'^[\d\+\-\s\(\)\.]+$', candidate)
                                and not _FORM_LABEL_NOISE_RE.search(candidate)):
                            city = candidate
                            # The candidate line itself sometimes bundles
                            # city+state with no separator of its own
                            # (e.g. "Akkur (Nagapattinam) Tamil Nadu") —
                            # split off a recognized multi-word state name
                            # from the end rather than leaving the whole
                            # line in `city` and `state` stuck at None.
                            for state_name in _MULTIWORD_STATE_NAMES:
                                suffix_re = re.compile(r'\s+' + re.escape(state_name) + r'$', re.I)
                                if suffix_re.search(candidate):
                                    city = suffix_re.sub('', candidate).strip()
                                    state = state_name
                                    break
                            break
            candidates.append((postal, city, state, strong))

        if not candidates:
            continue
        # Prefer the first candidate that's reliably anchored (a
        # recognized state/country/city-state token) over an earlier,
        # weaker match — confirmed necessary on a real FedEx sample where
        # a building-name line ("BIZHUB 768161") happened to match the
        # generic postal pattern *before* the actual "SINGAPORE 768161"
        # locality line, silently producing "city: Bizhub" instead of
        # "city: Singapore". Falls back to the first match when nothing
        # in the block looks reliably anchored, preserving prior behavior
        # for every block that only ever had one candidate anyway.
        strong_candidates = [c for c in candidates if c[3]]
        chosen = strong_candidates[0] if strong_candidates else candidates[0]
        return chosen[0], chosen[1], chosen[2]
    return None, None, None


def detect_country(block):
    for pat, country in COUNTRY_MAP.items():
        if re.search(pat, block, re.I):
            return country
    return None


def parse_address_block(block, fields, prefix):
    lines = [
        l.strip() for l in block.split('\n')
        if l.strip() and len(l.strip()) > 1
        and not re.match(r'^Contact\s*:', l, re.I)
    ]
    if not lines:
        return

    # Name: skip digit-only lines and street-address-looking lines
    name_line, remaining = None, lines
    for i, l in enumerate(lines):
        if re.match(r'^[\d\+\-\s\(\)\.]+$', l):
            continue
        if ADDRESS_LINE_RE.match(l) or LEADING_DIGIT_RE.match(l):
            continue
        name_line = l
        remaining = lines[i + 1:]
        break
    # NOTE: `remaining` defaults to ALL lines (not []) when no name line is
    # found — confirmed bug on a real Aramex sample where the structured
    # from_block ended up being just a bare street address (every other
    # label was too OCR-garbled to extract). Every line started with a
    # digit/looked address-like, so the loop above never found a name and
    # `remaining` was left empty, silently dropping a perfectly valid
    # address with nothing to show for it.

    if name_line and not fields.get(f'{prefix}name'):
        clean = re.sub(r'^(?:Mr\.|Ms\.|Mrs\.|DR\.)\s*', '', name_line, flags=re.I)
        # ACTW\s*S?\s*GT tolerates the real "ACTWSGT" OCR misread (extra S)
        # alongside the correct ACTWGT; SHP# is FedEx/UPS shipment-number noise.
        clean = re.sub(r'\b(?:ACTW\s*S?\s*GT|SHIP\s*DATE|TRK#|SHP#|REF\s*:|CONTACT\s*:?).*$', '', clean, flags=re.I).strip()
        # Trailing phone number stuck directly to the name with no separator
        # (a real OCR artifact, e.g. "SWETHA K 16136971929"). The optional
        # `(?:\+?1[-\s]?)?` consumes a NANP country-code digit ahead of the
        # 10-digit block — without it, only the last 10 digits were stripped,
        # leaving a stray leading "1" glued to the name ("SWETHA K 1").
        # Broad on purpose: a legitimate person/company name essentially
        # never ends in 7+ consecutive digits, so this is safe regardless
        # of the phone's country format. The previous version only matched
        # a strict 10-digit NANP shape, which on a 12-digit international
        # number ("MANIKANDAN KULLAN 917708992856") removed just the last
        # 10 digits and left 2 stray digits stuck onto the name.
        clean = re.sub(r'[\s\-\(\)]*\+?\d[\d\s\-\(\)]{6,}\d\s*$', '', clean).strip()
        fields[f'{prefix}name'] = clean.strip()

        # Many real labels print the sender/receiver name twice in a row
        # (once as "contact name", once as "company name" — confirmed on
        # FedEx/DHL samples, e.g. "SYED NAJEEBKAN\n\nSYED NAJEEBKAN\n57 DEEPIKA
        # FLAT..."). Left alone, that duplicate becomes the first "address"
        # line. Drop a leading remaining-line that's just the same name again
        # — title-prefix-insensitive ("MR.RAJASEKAR MANNE\nMR.RAJASEKAR
        # MANNE\n..." repeats the title on BOTH lines, but `clean` above has
        # already had its title stripped, so the comparison needs to strip
        # the same prefix from the candidate repeat line too).
        while remaining and re.sub(r'^(?:Mr\.|Ms\.|Mrs\.|DR\.)\s*', '', remaining[0].strip(), flags=re.I).upper() == clean.strip().upper():
            remaining = remaining[1:]

        # Many real labels print a personal contact name directly under the
        # company name before the street address (e.g. DHL: "SCDA Interiors
        # Pte Ltd\nMs. Marianne Ponce\n8 Teck Lim Road,..."). A title prefix
        # (Mr./Ms./Mrs./Miss/Dr.) is a strong, low-false-positive signal
        # that this is a person's name, not a continuation of the address —
        # pull it into receiver_attention rather than letting it become the
        # first (wrong) line of the street address.
        if prefix == 'to_' and remaining and re.match(r'^(?:Mr|Ms|Mrs|Miss|Dr)\.?\s+\S', remaining[0], re.I):
            if not fields.get('receiver_attention'):
                fields['receiver_attention'] = remaining[0].strip()
            remaining = remaining[1:]

    # Address lines: stop at locality/country lines
    addr_lines = []
    for l in remaining[:8]:
        if _is_locality_line(l):
            break
        addr_lines.append(l)
    addr_lines = addr_lines[:5]

    country = detect_country(block)
    if country and not fields.get(f'{prefix}country'):
        fields[f'{prefix}country'] = country

    postal, city, state = _extract_postal_city_state(block)

    # Hong Kong has no postal codes at all, so the postal-anchored lookup
    # above never finds a line to derive the city from. Fall back to the
    # line directly above the country-name line, stripped of trailing
    # decorative punctuation — confirmed correct against a real DHL Hong
    # Kong sample: "...TUNG CHUNG--\nHONG KONG SAR, CHINA" → city "Tung Chung".
    if not city and fields.get(f'{prefix}country') == 'Hong Kong':
        hk_idx = next((i for i, l in enumerate(lines) if re.search(r'HONG\s*KONG', l, re.I)), None)
        if hk_idx is not None and hk_idx > 0:
            candidate = re.sub(r'[\-\s]+$', '', lines[hk_idx - 1]).strip()
            if candidate and not STREET_SUFFIX_RE.search(candidate):
                city = candidate

    # Drop any collected address line that's really just a repeat of the
    # city — not only when it's the LAST line (the original check), since
    # a real sample printed the city on its own line *and* again inside a
    # later hyphenated "CITY-ST-POSTAL" summary line, with another street
    # line in between ("PHIALADELPHIA,\nPA 19104- 2651.\nPHIALADELPHIA-PA-
    # 19104"). Punctuation-insensitive so "PHIALADELPHIA," still matches
    # the cleanly-extracted city "Phialadelphia".
    if city:
        city_norm = re.sub(r'[^A-Z0-9]', '', city.upper())
        addr_lines = [l for l in addr_lines if re.sub(r'[^A-Z0-9]', '', l.upper()) != city_norm]

    if addr_lines and not fields.get(f'{prefix}address'):
        fields[f'{prefix}address'] = ', '.join(addr_lines)

    if postal and not fields.get(f'{prefix}postal'):
        fields[f'{prefix}postal'] = re.sub(r'\s+', '', postal) if re.match(r'^[A-Z]\d[A-Z]', postal) else postal
    if city and not fields.get(f'{prefix}city'):
        fields[f'{prefix}city'] = city.title()
    if state and not fields.get(f'{prefix}state'):
        fields[f'{prefix}state'] = STATE_NAME_MAP.get(state.upper(), state)

    if not fields.get(f'{prefix}state'):
        state_m = STATE_ABBR.search(block)
        if state_m:
            fields[f'{prefix}state'] = state_m.group(1)


# ── Shared numeric extractors (all parsers may call these) ───────────────────

def extract_dimensions_from_dims(text):
    """FedEx-style DIMS: LxWxH CM"""
    m = re.search(r'DIMS[:\s]+(\d+)\s*[xX×]\s*(\d+)\s*[xX×]\s*(\d+)\s*(CM|IN|MM)?', text, re.I)
    if m:
        return json.dumps({
            "l": float(m.group(1)), "w": float(m.group(2)),
            "h": float(m.group(3)), "unit": (m.group(4) or 'cm').lower()
        })
    return None


def extract_dimensions_from_dwt(text):
    """UPS-style DWT: L,W,H"""
    m = re.search(r'DWT[:\s]+(\d+)\s*,\s*(\d+)\s*,\s*(\d+)', text, re.I)
    if m:
        return json.dumps({
            "l": float(m.group(1)), "w": float(m.group(2)),
            "h": float(m.group(3)), "unit": "cm"
        })
    return None


def extract_ship_date(text):
    m = re.search(r'(?:SHIP\s*DATE|DATE)[:\s]+(\d{1,2}\s*[A-Z]{3}\s*\d{2,4})', text, re.I)
    if m:
        return m.group(1).strip()
    m = re.search(r'DATE[:\s]+(\d{1,2}\s+[A-Z]{3}\s+\d{4})', text, re.I)
    if m:
        return m.group(1).strip()
    return None


def extract_invoice(text):
    m = re.search(r'INV[:/\s]+([A-Z0-9/\-\.]+)', text, re.I)
    if m and len(m.group(1)) < 30:
        return m.group(1).strip()
    return None


def extract_declared_value(text):
    m = re.search(
        r'(?:CUSTOMS\s*VALUE|DECLARED\s*VALUE)[:\s=]+([0-9,\.]+)\s*(INR|USD|GBP|EUR|AUD|CAD|SGD)?',
        text, re.I)
    if m:
        return float(m.group(1).replace(',', '')), (m.group(2) or 'INR').upper()
    return None, None


_PHONE_RE = re.compile(
    r'(?<!\d)('
    r'\+?(?:91|971|968|966|974|973|965)[-\s]?\d{8,10}'   # country code + national number (India/Gulf)
    r'|\+?1[-\s]?[2-9]\d{9}'                              # NANP with leading 1 (Canada/US)
    r'|[6-9]\d{9}'                                        # bare 10-digit (India-style mobile)
    r'|\+?[0-9]{2,4}[-\s]\d{6,12}'                        # generic intl format w/ separator
    r'|\(\d{3}\)\s*\d{3}[-\s]\d{4}'                       # US-style (xxx) xxx-xxxx
    r')(?!\d)'
)


def extract_phones(text):
    # Every alternative ends in (?!\d) — confirmed necessary: without it, a
    # longer international number silently gets truncated into a
    # shorter-but-still-valid-looking match (a real UAE number,
    # "971566902667", was matching as just "9715669026" — the regex
    # engine happily stopped at 10 characters and left the trailing "67"
    # unconsumed, instead of recognizing the full 12-digit number).
    phones = _PHONE_RE.findall(text)
    cleaned = [re.sub(r'[\s\-\(\)]', '', p) for p in phones]
    return [p for p in cleaned if 8 <= len(re.sub(r'[^\d]', '', p)) <= 15]


def extract_phones_with_positions(text):
    """Same matching as extract_phones, but returns (phone, start_offset)
    pairs — for carrier parsers that need to assign a phone to sender vs.
    receiver based on which side of some anchor it falls on, rather than
    by list position (list position breaks when the same number is
    printed twice for one party — confirmed on a real sample)."""
    out = []
    for m in _PHONE_RE.finditer(text):
        phone = re.sub(r'[\s\-\(\)]', '', m.group(1))
        if 8 <= len(re.sub(r'[^\d]', '', phone)) <= 15:
            out.append((phone, m.start()))
    return out


def extract_barcode_number(text):
    """Human-readable number printed alongside a barcode, wrapped in
    asterisks — e.g. "*37294289760*" — a common convention on forwarder/
    Aramex-style labels where the AWB sits directly under a Code128/39
    barcode. This is a much stronger signal than a bare digit-length guess,
    so callers should try it before any "any N-digit number" fallback."""
    matches = re.findall(r'\*(\d{8,14})\*', text)
    if matches:
        return max(matches, key=len)
    return None


def find_digit_run(text, length, exclude=None):
    """Last-resort tracking-number fallback: find a standalone digit run of
    exactly `length` digits, skipping anything already in `exclude` (e.g.
    phone numbers already extracted via extract_phones()). Without this
    exclusion, a phone number that happens to be 10 or 12 digits long can get
    misassigned as the carrier tracking number — see GenericParser/AramexParser."""
    exclude = set(exclude or [])
    for m in re.finditer(rf'\b(\d{{{length}}})\b', text):
        if m.group(1) not in exclude:
            return m.group(1)
    return None


# ── Base class ───────────────────────────────────────────────────────────────

class BaseParser:
    """All carrier parsers inherit from this.

    Subclasses must override detect() and parse().
    """

    carrier_name: str = 'Unknown'

    def detect(self, text: str) -> bool:
        raise NotImplementedError

    def parse(self, text: str) -> dict:
        raise NotImplementedError

    # Convenience: subclasses call super()._init_fields() to get a clean slate
    def _init_fields(self) -> dict:
        return blank_fields()