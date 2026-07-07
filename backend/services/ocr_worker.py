#!/usr/bin/env python3
"""
Garuda Express OCR Worker v2
Called: python3 ocr_worker.py <filepath>
Returns JSON to stdout.

v2.1 — field parsing delegated to the carrier-specific parser modules in
services/parsers/.  The monolithic parse_waybill_fields() below is kept as
a fallback shim; the dispatcher is tried first.
"""
import sys, json, re, os
from pathlib import Path

# ── Inject the parsers package path ──────────────────────────────────────────
_SERVICES_DIR = os.path.dirname(os.path.abspath(__file__))
if _SERVICES_DIR not in sys.path:
    sys.path.insert(0, _SERVICES_DIR)

try:
    from parsers.dispatcher import dispatch as _dispatch_parse, \
                                    compute_field_score as _score, \
                                    validate_fields as _validate
    _DISPATCHER_AVAILABLE = True
except ImportError:
    _DISPATCHER_AVAILABLE = False

KNOWN_WORDS = [
    'kg','tracking','ship','origin','fedex','ups','dhl','waybill',
    'from','date','dims','actwgt','trk','billing','desc',
    'ship date','trk#','ship to','origin id','weight','pieces',
    'contents','sender','consignee','recipient','express'
]

# Fields used to compute the "did we actually extract a usable record" score.
# Deliberately excludes fields that always carry a default value (pieces,
# weight_unit, currency) since those would never penalize a bad extraction.
SCORABLE_FIELDS = [
    'from_name','from_address','from_city','from_country','from_postal',
    'to_name','to_address','to_city','to_country','to_postal',
    'carrier','carrier_tracking_number','actual_weight','dimensions','contents',
]

# Fields that must be present for a record to be usable downstream; missing
# ones surface as validation warnings instead of being silently dropped.
MANDATORY_FIELDS = ['carrier_tracking_number', 'to_name', 'to_country']

MANDATORY_FIELD_LABELS = {
    'carrier_tracking_number': 'Tracking number not detected',
    'to_name': 'Receiver name not detected',
    'to_country': 'Destination country not detected',
}


def compute_field_score(fields):
    """field_score = (detected_fields / total_fields) * 100, per the audit's
    recommended confidence logic — a record with high OCR confidence but
    mostly-null fields should NOT look like a successful extraction."""
    detected = sum(1 for f in SCORABLE_FIELDS if fields.get(f) not in (None, '', 'null'))
    return round((detected / len(SCORABLE_FIELDS)) * 100, 1)


def validate_fields(fields):
    """Mandatory-field validation layer. Previously a record with
    to_country=null was still reported as a clean success — this makes that
    failure visible instead of silent."""
    warnings = []
    for f in MANDATORY_FIELDS:
        if fields.get(f) in (None, '', 'null'):
            warnings.append(MANDATORY_FIELD_LABELS.get(f, f'{f} not detected'))
    return warnings


def best_rotation(img):
    """Kept for backward compatibility with any external caller that
    imported this directly; the OCR pipeline itself now uses
    parsers/ocr_layers.py, which does the same rotation search but feeds
    the result through layout-aware reconstruction instead of returning
    flat reading-order text."""
    from parsers.ocr_layers import best_rotation as _br
    return _br(img)

def ocr_image(img):
    """Kept for backward compatibility; see best_rotation() note above."""
    from parsers.ocr_layers import ocr_image_with_layout as _ocr
    return _ocr(img)

# Fields whose simultaneous absence signals that the native PDF text layer
# (if used) probably missed an image-only data section on this particular
# template — confirmed on a real Aramex sample where the tracking barcode,
# weight, declared value, and item description are all rasterized while
# the surrounding sender/receiver text and legal terms are native text.
# Triggers a second OCR pass whose fields get merged in (gaps only, never
# overwriting a value the native-text pass already found).
_CRITICAL_FIELDS_FOR_OCR_FALLBACK = ['carrier_tracking_number', 'actual_weight', 'contents']


def _merge_fields(primary, fallback):
    """Fills any null/empty field in `primary` from `fallback`, in place.
    Never overwrites a value `primary` already has."""
    for k, v in fallback.items():
        if primary.get(k) in (None, '', 'null') and v not in (None, '', 'null'):
            primary[k] = v
    return primary


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "No file path"})); sys.exit(1)

    # --parse-only mode: read raw OCR text from stdin (already extracted by
    # another engine, e.g. Google Vision in services/ocrService.js) and run
    # ONLY the field-parsing regexes, so both OCR engines share one parser.
    if sys.argv[1] == '--parse-only':
        text = sys.stdin.read()
        fields = parse_waybill_fields(text)
        print(json.dumps({
            "fields": fields,
            "field_score": compute_field_score(fields),
            "warnings": validate_fields(fields),
        }, ensure_ascii=False))
        return

    filepath = sys.argv[1]
    if not os.path.exists(filepath):
        print(json.dumps({"success": False, "error": f"File not found: {filepath}"})); sys.exit(1)
    try:
        from parsers.text_extraction import extract_native_only, extract_via_ocr

        native_text = extract_native_only(filepath)
        rawText, engine, ocr_conf, rotation = None, None, None, 0
        fields = None

        if native_text:
            fields = parse_waybill_fields(native_text)
            rawText, engine, ocr_conf = native_text, 'pdf_text_layer', 99.0

        needs_ocr_fallback = (
            fields is None
            or all(fields.get(f) in (None, '', 'null') for f in _CRITICAL_FIELDS_FOR_OCR_FALLBACK)
        )
        if needs_ocr_fallback:
            ocr_result = extract_via_ocr(filepath)
            ocr_fields = parse_waybill_fields(ocr_result['text'])
            if fields is None:
                fields = ocr_fields
                rawText, engine = ocr_result['text'], ocr_result['engine']
                ocr_conf, rotation = ocr_result['confidence'], ocr_result['rotation_applied']
            else:
                # Native text WAS usable, but missing critical fields — merge
                # in whatever OCR found for those, and note both engines were
                # involved (don't discard the (better-quality) native rawText).
                fields = _merge_fields(fields, ocr_fields)
                engine = f"pdf_text_layer+{ocr_result['engine']}"

        field_score = compute_field_score(fields)
        final_confidence = round((ocr_conf or 0) * 0.7 + field_score * 0.3, 1)
        print(json.dumps({
            "success": True,
            "rawText": rawText,
            "engine": engine,
            "ocr_confidence": ocr_conf,
            "field_score": field_score,
            "confidence": final_confidence,
            "rotation_applied": rotation,
            "fields": fields,
            "warnings": validate_fields(fields),
        }, ensure_ascii=False))
    except Exception as e:
        import traceback
        print(json.dumps({"success": False, "error": str(e), "trace": traceback.format_exc()}))
        sys.exit(1)

def parse_waybill_fields(text):
    # Carrier-aware dispatcher (v2.1)
    if _DISPATCHER_AVAILABLE:
        return _dispatch_parse(text)
    return _legacy_parse_waybill_fields(text)


def _legacy_parse_waybill_fields(text):
    full = text.upper()
    fields = {
        "from_name":None,"from_address":None,"from_contact":None,
        "from_city":None,"from_state":None,"from_country":None,"from_postal":None,
        "to_name":None,"to_address":None,"to_contact":None,
        "to_city":None,"to_state":None,"to_country":None,"to_postal":None,
        "carrier":None,"carrier_tracking_number":None,
        "ship_date":None,"pieces":1,
        "actual_weight":None,"billing_weight":None,"weight_unit":"kg",
        "dimensions":None,"contents":None,
        "service_type":None,"declared_value":None,"currency":"INR",
        "invoice_number":None
    }

    # Carrier
    if any(x in full for x in ['FEDEX','FED EX','FEDERAL EXPRESS','TRK#','ACTWGT']):
        fields['carrier'] = 'FedEx'
    if any(x in full for x in ['UPS SAVER','UPS WORLDWIDE','UPS EXPRESS','TRACKING #: 1Z','SHP WT:']):
        fields['carrier'] = 'UPS'
    if any(x in full for x in ['EXPRESS WORLDWIDE','DHL A\\C','DHL A/C','WAYBILL DOC']):
        fields['carrier'] = 'DHL'
    if 'ARAMEX' in full: fields['carrier'] = 'Aramex'
    if 'BLUEDART' in full or 'BLUE DART' in full: fields['carrier'] = 'BlueDart'
    if 'DTDC' in full: fields['carrier'] = 'DTDC'

    # Tracking: FedEx TRK# XXXX XXXX XXXX
    m = re.search(r'TRK#\s*(\d{4})\s+(\d{4})\s+(\d{4})', text, re.I)
    if m:
        fields['carrier_tracking_number'] = m.group(1)+m.group(2)+m.group(3)
        fields['carrier'] = fields['carrier'] or 'FedEx'

    # DHL: WAYBILL XX XXXX XXXX
    if not fields['carrier_tracking_number']:
        m = re.search(r'WAYBILL\s+(\d{2})\s+(\d{4})\s+(\d{4})', text, re.I)
        if m:
            fields['carrier_tracking_number'] = m.group(1)+m.group(2)+m.group(3)
            fields['carrier'] = fields['carrier'] or 'DHL'

    # UPS: 1Z tracking
    if not fields['carrier_tracking_number']:
        m = re.search(r'TRACKING\s*#[:\s]+([1][Z][A-Z0-9]{14,20})\b', text, re.I)
        if m:
            fields['carrier_tracking_number'] = re.sub(r'\s+','',m.group(1))
            fields['carrier'] = fields['carrier'] or 'UPS'

    # Weight: FedEx ACTWGT
    m = re.search(r'ACTWG?T[:\s]+([0-9]+\.?[0-9]*)\s*(KG|LB)', text, re.I)
    if m:
        fields['actual_weight'] = float(m.group(1))
        fields['weight_unit'] = m.group(2).lower()

    # UPS SHP WT
    if not fields['actual_weight']:
        m = re.search(r'SHP\s*WT[:\s]+([0-9]+\.?[0-9]*)\s*(KG|LB)', text, re.I)
        if m: fields['actual_weight'] = float(m.group(1))

    # UPS header "5 KG 1 OF 1"
    if not fields['actual_weight']:
        m = re.search(r'^([0-9]+(?:\.[0-9]+)?)\s*KG\s+[0-9]+\s+OF\s+[0-9]+', text, re.M)
        if m: fields['actual_weight'] = float(m.group(1))

    # DHL Pce/Shpt weight
    if not fields['actual_weight']:
        m = re.search(r'([0-9]+\.?[0-9]*)\s*KG\s+[0-9]+/[0-9]+', text, re.I)
        if m: fields['actual_weight'] = float(m.group(1))

    fields['billing_weight'] = fields['billing_weight'] or fields['actual_weight']

    # Dimensions: FedEx DIMS:
    m = re.search(r'DIMS[:\s]+([0-9]+)\s*[xX×]\s*([0-9]+)\s*[xX×]\s*([0-9]+)\s*(CM|IN|MM)?', text, re.I)
    if m:
        fields['dimensions'] = json.dumps({"l":float(m.group(1)),"w":float(m.group(2)),"h":float(m.group(3)),"unit":(m.group(4) or 'cm').lower()})

    # Dimensions: UPS DWT:
    if not fields['dimensions']:
        m = re.search(r'DWT[:\s]+([0-9]+),([0-9]+),([0-9]+)', text, re.I)
        if m:
            fields['dimensions'] = json.dumps({"l":float(m.group(1)),"w":float(m.group(2)),"h":float(m.group(3)),"unit":"cm"})

    # Ship date
    m = re.search(r'(?:SHIP\s*DATE|DATE)[:\s]+(\d{1,2}\s*[A-Z]{3}\s*\d{2,4})', text, re.I)
    if m: fields['ship_date'] = m.group(1).strip()
    if not fields['ship_date']:
        m = re.search(r'DATE[:\s]+(\d{1,2}\s+[A-Z]{3}\s+\d{4})', text, re.I)
        if m: fields['ship_date'] = m.group(1).strip()

    # Pieces
    m = re.search(r'(\d+)\s*OF\s*(\d+)', text, re.I)
    if m: fields['pieces'] = int(m.group(2))
    if not fields['pieces'] or fields['pieces'] == 1:
        m = re.search(r'Piece\s*\n.*?(\d+)/(\d+)', text, re.I|re.S)
        if m: fields['pieces'] = int(m.group(2))

    # Contents: FedEx DESC1
    descs = re.findall(r'DESC\d*[:\s]+([^\n]{3,80})', text, re.I)
    descs = [d.strip() for d in descs if d.strip() and len(d.strip())>2 and d.strip().upper() not in ['DESC2','DESC3','DESC4','']]
    if descs: fields['contents'] = '; '.join(descs[:2])

    # Contents: UPS BILLING/DESC
    if not fields['contents']:
        m = re.search(r'DESC[:\s]+([A-Z][^\n]{5,80})', text, re.I)
        if m: fields['contents'] = m.group(1).strip()

    # Contents: DHL Content Description
    if not fields['contents']:
        m = re.search(r'Content\s*Description[:\s]+([^\n]{3,100})', text, re.I)
        if m: fields['contents'] = m.group(1).strip()

    # Invoice
    m = re.search(r'INV[:/\s]+([A-Z0-9/\-\.]+)', text, re.I)
    if m and len(m.group(1))<30: fields['invoice_number'] = m.group(1).strip()

    # Declared value
    m = re.search(r'(?:CUSTOMS\s*VALUE|DECLARED\s*VALUE)[:\s=]+([0-9,\.]+)\s*(INR|USD|GBP|EUR|AUD|CAD|SGD)?', text, re.I)
    if m:
        fields['declared_value'] = float(m.group(1).replace(',',''))
        fields['currency'] = (m.group(2) or 'INR').upper()

    # Service
    for svc in ['EXPRESS WORLDWIDE','UPS SAVER','UPS EXPRESS','PRIORITY OVERNIGHT','INTERNATIONAL PRIORITY','INTERNATIONAL ECONOMY']:
        if svc in full:
            fields['service_type'] = svc.title(); break

    # From / To blocks
    from_block = extract_from_block(text)
    to_block = extract_to_block(text)
    if from_block: parse_address_block(from_block, fields, 'from_')
    if to_block: parse_address_block(to_block, fields, 'to_')

    # Phones
    phones = re.findall(r'(?<!\d)(\+?(?:91[-\s]?)?[6-9]\d{9}|\+?[0-9]{2,4}[-\s]\d{6,12}|\(\d{3}\)\s*\d{3}[-\s]\d{4})', text)
    phones = [re.sub(r'[\s\-\(\)]','',p) for p in phones]
    phones = [p for p in phones if 8<=len(re.sub(r'[^\d]','',p))<=15]

    # DHL shipper contact
    m = re.search(r'Shipper\s*:.*?Contact:\s*\n?\s*([+\d][\d\s\-]{7,15})', text, re.I|re.S)
    if m:
        fp = re.sub(r'[^\d+]','',m.group(1))
        if len(fp)>=8: fields['from_contact'] = fp

    # FedEx origin phone
    m = re.search(r'ORIGIN\s*ID[:\w\s]+(\d{7,12})\n', text, re.I)
    if m: fields['from_contact'] = fields['from_contact'] or m.group(1)

    if phones:
        if not fields['from_contact']: fields['from_contact'] = phones[0]
        if len(phones)>1 and not fields['to_contact']: fields['to_contact'] = phones[1]

    # ── Generic fallback patterns (requirement spec §7 examples) ──────────────
    # UPS: 1Z + 16 alphanumeric chars, anywhere in the text (e.g. 1ZH4Y8210404603959)
    if not fields['carrier_tracking_number']:
        m = re.search(r'\b(1Z[A-Z0-9]{16})\b', text, re.I)
        if m:
            fields['carrier_tracking_number'] = m.group(1).upper()
            fields['carrier'] = fields['carrier'] or 'UPS'

    # FedEx: standalone 12-digit tracking number (e.g. 889684647537)
    if not fields['carrier_tracking_number'] and (fields['carrier'] == 'FedEx' or 'FEDEX' in full):
        m = re.search(r'\b(\d{12})\b', text)
        if m: fields['carrier_tracking_number'] = m.group(1)

    # DHL: standalone 10-digit waybill number (e.g. 2020372535)
    if not fields['carrier_tracking_number'] and (fields['carrier'] == 'DHL' or 'DHL' in full):
        m = re.search(r'\b(\d{10})\b', text)
        if m: fields['carrier_tracking_number'] = m.group(1)

    # Last resort: no carrier context at all — try each known format in turn
    if not fields['carrier_tracking_number']:
        m = re.search(r'\b(1Z[A-Z0-9]{16})\b', text, re.I)
        if m:
            fields['carrier_tracking_number'] = m.group(1).upper(); fields['carrier'] = 'UPS'
        else:
            m = re.search(r'\b(\d{12})\b', text)
            if m:
                fields['carrier_tracking_number'] = m.group(1); fields['carrier'] = fields['carrier'] or 'FedEx'
            else:
                m = re.search(r'\b(\d{10})\b', text)
                if m:
                    fields['carrier_tracking_number'] = m.group(1); fields['carrier'] = fields['carrier'] or 'DHL'

    return fields


def extract_from_block(text):
    # DHL From :
    m = re.search(r'From\s*:\s*(.*?)(?=\n\s*(?:To|Receiver)\s*:|$)', text, re.I|re.S)
    if m and len(m.group(1).strip())>5: return m.group(1).strip()

    # DHL Shipper :
    m = re.search(r'Shipper\s*:\s*(.*?)(?=\nReceiver\s*:|$)', text, re.I|re.S)
    if m:
        lines = [l.strip() for l in m.group(1).strip().split('\n') if l.strip()][:5]
        return '\n'.join(lines)

    # FedEx ORIGIN ID block. The sender name often sits on the SAME line as
    # the origin code (e.g. "ORIGIN ID:ABC MARIYAMMAL KUMARAN") — the old
    # regex swallowed that whole line as part of the non-capturing match,
    # silently discarding the name and letting the next line (often the
    # city/state/postal line) get mistaken for the name downstream.
    m = re.search(r'ORIGIN\s*ID[:\s]*\S*\s*([^\n]*)\n((?:(?!SHIP\s*DATE|TO\s+[A-Z]|ACTWGT|TRK#|REF:)[^\n]+\n){0,6})', text, re.I)
    if m:
        first_line_name = m.group(1).strip()
        extra_lines = [l.strip() for l in m.group(2).split('\n') if l.strip()]
        lines = ([first_line_name] if first_line_name else []) + extra_lines
        if lines: return '\n'.join(lines[:6])

    # UPS top block before SHIP TO
    m = re.search(r'^(.*?)(?=SHIP\s*TO:)', text, re.S|re.I)
    if m:
        raw = m.group(1).strip()
        lines = [l.strip() for l in raw.split('\n') if l.strip() and not re.match(r'^[\d\.]+\s*(KG|LB|OF)',l.strip(),re.I)]
        return '\n'.join(lines[-5:]) if len(lines)>5 else '\n'.join(lines)

    return None


def extract_to_block(text):
    # DHL To :
    m = re.search(r'(?:^|\n)To\s*:\s*(.*?)(?=\nOrigin:|HKGO|SINO|CVGH|\Z)', text, re.I|re.S)
    if m:
        lines = [l.strip() for l in m.group(1).split('\n') if l.strip()][:6]
        return '\n'.join(lines)

    # DHL Receiver :
    m = re.search(r'Receiver\s*:\s*(.*?)(?=\nShipper\s*:|\n\s*\n|\nWAYBILL|\nTRK#|\nTRACKING|\Z)', text, re.I|re.S)
    if m:
        lines = [l.strip() for l in m.group(1).split('\n') if l.strip()][:6]
        return '\n'.join(lines)

    # FedEx TO <NAME> block. Tolerant of "TO SWETHA K" on one line AND OCR
    # splitting it as "TO\nSWETHA K" (the \s+ after TO matches the newline
    # either way). Grabs up to 8 following lines, stopping before the next
    # shipment-detail field (TRK#/ACTWGT/DIMS/DESC) so those never get
    # mistaken for address/locality lines; any remaining trailing noise is
    # trimmed by parse_address_block once it hits the locality/country line.
    m = re.search(r'(?:^|\n)TO\s+([^\n]+)\n((?:(?!ACTWGT|TRK#|DIMS|DESC\d|FROM\s|REF:)[^\n]+\n){1,8})', text, re.M|re.I)
    if m: return (m.group(1).strip()+'\n'+m.group(2)).strip()

    # UPS SHIP TO: — old stop condition (lookahead for AUS/UPS/BILLING/
    # Reference No) cut the block short whenever those tokens didn't appear
    # exactly as expected. Grab a generous run of lines instead and let
    # parse_address_block trim once it reaches the locality/country line.
    m = re.search(r'SHIP\s*TO:\s*(.*?)(?=\n\s*\n|BILLING|Reference\s*No|TRACKING\s*#|\Z)', text, re.I|re.S)
    if m:
        lines = [l.strip() for l in m.group(1).split('\n') if l.strip()][:8]
        return '\n'.join(lines)

    return None


COUNTRY_MAP = {
    r'\bINDIA\b':'India', r'\bAUSTRALIA\b':'Australia',
    r'\bCANADA\b':'Canada', r'\(CA\)':'Canada',
    r'\bSINGAPORE\b':'Singapore', r'\(SG\)':'Singapore',
    r'HONG\s*KONG':'Hong Kong', r'\bIRELAND\b':'Ireland',
    r'REPUBLIC\s*OF\b':'Ireland', r'UNITED\s*STATES':'USA',
    r'\bUSA\b':'USA', r'\bUNITED\s*KINGDOM\b':'UK',
    r'\bUAE\b':'UAE', r'UNITED\s*ARAB':'UAE',
    r'\bGERMANY\b':'Germany', r'\bFRANCE\b':'France',
    r'\bJAPAN\b':'Japan', r'\bCHINA\b':'China',
    # Added per audit — defect #6, country map was missing common destinations
    r'\bNEW\s*ZEALAND\b':'New Zealand', r'\bNETHERLANDS\b':'Netherlands',
    r'\bSWEDEN\b':'Sweden', r'\bNORWAY\b':'Norway', r'\bDENMARK\b':'Denmark',
    r'\bITALY\b':'Italy', r'\bSPAIN\b':'Spain', r'\bMALAYSIA\b':'Malaysia',
    r'\bTHAILAND\b':'Thailand', r'\bINDONESIA\b':'Indonesia',
}

# Postal code patterns, most-specific first. Canadian and UK formats are
# distinctive enough to match unambiguously; the generic 4-6 digit pattern
# (US/AU/India style) is tried last since it's more prone to false positives.
POSTAL_PATTERNS = [
    ('CA', re.compile(r'\b([A-Z]\d[A-Z])\s?(\d[A-Z]\d)\b')),                    # K1G 4B5
    ('UK', re.compile(r'\b([A-Z]{1,2}\d[A-Z\d]?)\s?(\d[A-Z]{2})\b')),           # SW1A 1AA
    ('IE', re.compile(r'\b([A-Z]\d{2})\s?([A-Z0-9]{4})\b')),                    # D02 X285 (Eircode)
    ('GENERIC', re.compile(r'(?:^|\s)(\d{4,6})\s*[A-Z]*\s*$')),                 # 600028 / 2153 / 90210 — anchored to end-of-line (optionally followed by a trailing country word) so street numbers like "1551 LYCEE PLACE" never match
]

# Street-suffix words that mark a line as a street address rather than a
# city/state/postal line, even if it happens to contain digits.
STREET_SUFFIX_RE = re.compile(r'\b(STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|BLVD|BOULEVARD|WAY|COURT|CT|PLACE|PL|UNIT|SUITE|STE|FLOOR|FLR|APT|BLOCK|PLOT)\b', re.I)

STATE_ABBR = re.compile(r'\b(TN|MH|KA|AP|TS|DL|WB|NSW|VIC|QLD|AB|ON|BC|PA|CA)\b')

# Full province/state names OCR sometimes spells out in full (e.g. "OTTAWA
# ONTARIO K1G 4B5") get normalized to the same abbreviations used elsewhere
# in the system, so to_state is consistently short-form.
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

# Lines that look like a street address (unit/floor/door numbers, leading
# house numbers) rather than a person's name — used to stop the old "first
# non-numeric line = name" heuristic from grabbing "UNIT-601" instead of
# the actual recipient name (defect #4).
ADDRESS_LINE_RE = re.compile(r'^(?:UNIT|STE|SUITE|FLOOR|FLR|APT|APARTMENT|BLDG|BLOCK|PLOT|DOOR|NO\.?|#)\b', re.I)
LEADING_DIGIT_RE = re.compile(r'^\d')


def _is_locality_line(line):
    """A line is 'locality' (city/state/postal) or country info once it
    contains a postal code or a known country name — these end the street
    address and should not be appended to `*_address`."""
    for _, pat in POSTAL_PATTERNS:
        if pat.search(line):
            return True
    for pat in COUNTRY_MAP:
        if re.search(pat, line, re.I):
            return True
    return False


def _extract_postal_city_state(block):
    """Find the postal code anywhere in the block (CA/UK formats first, then
    generic digits) and derive city/state from the text immediately
    preceding it on that line — e.g. 'OTTAWA ONTARIO K1G 4B5' or
    'WINSTON HILLS NSW 2153' both split cleanly into city + state + postal
    this way, with no fixed city whitelist needed (defect #1).

    If the postal line carries only a single word before the postal code
    (e.g. 'PA 19104', with the city sitting alone on the line above it —
    common on US DHL/UPS labels split as 'PHILADELPHIA' / 'PA 19104'), that
    single word is treated as the state and the nearest non-locality,
    non-street line above is used as the city instead of misreading the
    state abbreviation itself as the city."""
    block_lines = block.split('\n')
    for kind, pat in POSTAL_PATTERNS:
        for idx, line in enumerate(block_lines):
            m = pat.search(line)
            if not m:
                continue
            postal = (m.group(1) + ' ' + m.group(2)).strip() if kind in ('CA', 'UK') else m.group(1)
            prefix = line[:m.start()].strip(' ,.')
            words = [w for w in re.split(r'[,\s]+', prefix) if w]
            city, state = None, None
            if len(words) >= 2:
                state = words[-1]
                city = ' '.join(words[:-1])
            elif len(words) == 1:
                state = words[0]
                for back in range(idx - 1, -1, -1):
                    candidate = block_lines[back].strip()
                    if candidate and not _is_locality_line(candidate) and not STREET_SUFFIX_RE.search(candidate):
                        city = candidate
                        break
            return postal, city, state
    return None, None, None


def parse_address_block(block, fields, prefix):
    lines = [l.strip() for l in block.split('\n') if l.strip() and len(l.strip())>1 and not re.match(r'^Contact\s*:',l,re.I)]
    if not lines: return

    # Name detection: skip purely numeric/symbol lines AND lines that look
    # like a street address (unit numbers, leading house numbers) so that,
    # e.g., "UNIT-601" is never mistaken for the recipient's name (defect #4).
    name_line, remaining = None, []
    for i, l in enumerate(lines):
        if re.match(r'^[\d\+\-\s\(\)\.]+$', l): continue
        if ADDRESS_LINE_RE.match(l) or LEADING_DIGIT_RE.match(l): continue
        name_line = l; remaining = lines[i+1:]; break

    if name_line and not fields[f'{prefix}name']:
        clean = re.sub(r'^(?:Mr\.|Ms\.|Mrs\.|DR\.)\s*','',name_line,flags=re.I)
        # OCR sometimes merges trailing shipment metadata onto the same
        # physical line as the name — e.g. "SYED NAJEEBKAN ACTWGT: 1.50 KG"
        # or "ANNAI MEENAKSHI COLLEGE OF NURSING Contact:" — strip everything
        # from that marker onward rather than keeping it as part of the name.
        clean = re.sub(r'\b(?:ACTWGT|SHIP\s*DATE|TRK#|REF\s*:|CONTACT\s*:?).*$', '', clean, flags=re.I).strip()
        # Strip an embedded trailing phone number, e.g. "EMILY GERRARD (604) 828-9346"
        clean = re.sub(r'\(?\d{3}\)?[-\s]?\d{3}[-\s]?\d{4}\s*$', '', clean).strip()
        fields[f'{prefix}name'] = clean.strip()

    # Address lines: collect up to 5 lines, but stop as soon as we hit the
    # city/state/postal or country line instead of always taking exactly the
    # first two lines — addresses with 3-4 street lines were being truncated,
    # and the locality line itself was getting glued onto the street address
    # (defect #5).
    addr_lines = []
    for l in remaining[:8]:
        if _is_locality_line(l):
            break
        addr_lines.append(l)
    addr_lines = addr_lines[:5]

    for pat, country in COUNTRY_MAP.items():
        if re.search(pat, block, re.I) and not fields[f'{prefix}country']:
            fields[f'{prefix}country'] = country; break

    # City/state/postal — derived from whichever line actually contains the
    # postal code, rather than matched against a small static city whitelist
    # that broke on anything not in the list (Brampton, Scarborough, Dublin,
    # Cork, Auckland, Perth, Adelaide, etc. — defect #1, #2, #3).
    postal, city, state = _extract_postal_city_state(block)

    # When the city was pulled from a standalone line above a "STATE POSTAL"
    # line (e.g. "PHILADELPHIA" / "PA 19104"), that line carries no
    # postal/country marker of its own, so the address-line loop above will
    # have swept it up as a street line too. Drop it from the address so it
    # isn't duplicated in both `*_address` and `*_city`.
    if city and addr_lines and addr_lines[-1].strip().upper() == city.strip().upper():
        addr_lines = addr_lines[:-1]

    if addr_lines and not fields[f'{prefix}address']:
        fields[f'{prefix}address'] = ', '.join(addr_lines)

    if postal and not fields[f'{prefix}postal']:
        fields[f'{prefix}postal'] = re.sub(r'\s+', '', postal) if re.match(r'^[A-Z]\d[A-Z]', postal) else postal
    if city and not fields[f'{prefix}city']:
        fields[f'{prefix}city'] = city.title()
    if state and not fields[f'{prefix}state']:
        fields[f'{prefix}state'] = STATE_NAME_MAP.get(state.upper(), state)

    if not fields[f'{prefix}state']:
        state_m = STATE_ABBR.search(block)
        if state_m: fields[f'{prefix}state'] = state_m.group(1)


if __name__ == '__main__':
    main()