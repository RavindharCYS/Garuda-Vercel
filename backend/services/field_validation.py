#!/usr/bin/env python3
"""
services/parsers/field_validation.py — cross-field sanity checks for
parsed AWB/waybill data.

Every carrier parser gets individual fields right most of the time, but
"right shape, wrong value" mistakes slip through single-field regexes
constantly — a postal code that's the right length but for the wrong
country, a weight that's off by a decimal place, a ship date decades in
the past. None of that is catchable by validating one field in isolation;
it only shows up when you check fields AGAINST each other.

This module never blocks or "fixes" anything — every carrier parser
keeps working exactly as it does today. It only adds a list of
human-readable warnings for a reviewer (or a confidence-gate rule) to
act on. Called from dispatcher.py right after parsing; the warnings ride
along in the result under "sanity_warnings" (kept separate from the
existing hard MANDATORY_FIELDS warnings in validate_fields(), which mean
"this field is missing" — these mean "this field has a value, but it
looks wrong").
"""
import re
from datetime import datetime, timedelta

# ── Postal code format per country ──────────────────────────────────────────
# Deliberately conservative: only flags a MISMATCH when the country is one
# we're confident enough about to have a specific pattern for, and the
# postal code clearly doesn't fit it. No pattern for a country = no check
# for that field, rather than guessing.
_POSTAL_FORMATS = {
    'India': (re.compile(r'^\d{6}$'), '6 digits'),
    'USA': (re.compile(r'^\d{5}(-\d{4})?$'), '5 digits (optionally -NNNN)'),
    'Canada': (re.compile(r'^[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$'), 'A1A 1A1'),
    'Australia': (re.compile(r'^\d{4}$'), '4 digits'),
    'UAE': (None, None),  # UAE has no formal postal code system — never flag
    'UK': (re.compile(r'^[A-Za-z]{1,2}\d[A-Za-z\d]?\s?\d[A-Za-z]{2}$'), 'e.g. SW1A 1AA'),
    'Singapore': (re.compile(r'^\d{6}$'), '6 digits'),
}

# ── Phone number digit-count range per country ──────────────────────────────
# Deliberately a wide range (national number length varies with area code/
# trunk-prefix conventions) — this catches "clearly wrong" (a 3-digit or
# 25-digit "phone number") without false-flagging legitimate variation.
_PHONE_DIGIT_RANGE = {
    'India': (10, 12), 'USA': (10, 11), 'Canada': (10, 11), 'Australia': (9, 11),
    'UAE': (9, 12), 'UK': (10, 12), 'Singapore': (8, 10),
}

_MAX_PLAUSIBLE_WEIGHT_KG = 1000  # air-freight parcel/document shipments; flag, don't reject
_MIN_PLAUSIBLE_WEIGHT_KG = 0.01
_MAX_PLAUSIBLE_PIECES = 100
_MAX_PLAUSIBLE_DECLARED_VALUE = 10_000_000  # flags a likely misplaced decimal/currency mixup


def _parse_date_loose(value):
    """Tries the handful of date formats this codebase's parsers actually
    produce (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD, M/D/YYYY) — returns None
    rather than raising if nothing matches, since this is a sanity check,
    not a required parse."""
    if not value:
        return None
    for fmt in ('%m/%d/%Y', '%d/%m/%Y', '%Y-%m-%d', '%m/%d/%y'):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return None


def validate_field_consistency(fields):
    """Returns a list of {field, message, severity} dicts — never raises,
    never mutates `fields`. `severity` is 'warn' (worth a human glancing
    at) or 'flag' (worth surfacing prominently — likely wrong, not just
    unusual)."""
    warnings = []

    def add(field, message, severity='warn'):
        warnings.append({'field': field, 'message': message, 'severity': severity})

    # ── Postal code vs. country ──────────────────────────────────────────
    for side in ('from', 'to'):
        country = fields.get(f'{side}_country')
        postal = fields.get(f'{side}_postal')
        if country and postal and country in _POSTAL_FORMATS:
            pattern, shape = _POSTAL_FORMATS[country]
            if pattern and not pattern.match(str(postal).strip()):
                add(f'{side}_postal',
                    f'"{postal}" doesn\'t look like a {country} postal code (expected {shape})',
                    'flag')

    # ── Phone number vs. country ─────────────────────────────────────────
    for side in ('from', 'to'):
        country = fields.get(f'{side}_country')
        phone = fields.get(f'{side}_contact')
        if country and phone and country in _PHONE_DIGIT_RANGE:
            digit_count = len(re.sub(r'\D', '', str(phone)))
            lo, hi = _PHONE_DIGIT_RANGE[country]
            if not (lo <= digit_count <= hi):
                add(f'{side}_contact',
                    f'"{phone}" has {digit_count} digits — unusual for a {country} phone number '
                    f'(expected {lo}-{hi})',
                    'warn')

    # ── Weight plausibility ──────────────────────────────────────────────
    weight = fields.get('actual_weight')
    if weight is not None:
        try:
            w = float(weight)
            if w > _MAX_PLAUSIBLE_WEIGHT_KG:
                add('actual_weight', f'{w}kg is unusually heavy for a parcel — check for a misplaced decimal', 'flag')
            elif w < _MIN_PLAUSIBLE_WEIGHT_KG:
                add('actual_weight', f'{w}kg is implausibly light — check the unit/decimal', 'flag')
        except (TypeError, ValueError):
            pass

    # actual_weight vs. billing_weight: billing (chargeable/volumetric)
    # weight is legitimately >= actual weight, but never drastically less
    # — that direction only happens from a misread.
    actual, billing = fields.get('actual_weight'), fields.get('billing_weight')
    if actual is not None and billing is not None:
        try:
            a, b = float(actual), float(billing)
            if b > 0 and a / b > 3:
                add('billing_weight', f'Billing weight ({b}kg) is much lower than actual weight ({a}kg)', 'warn')
        except (TypeError, ValueError, ZeroDivisionError):
            pass

    # ── Pieces plausibility ──────────────────────────────────────────────
    pieces = fields.get('pieces')
    if pieces is not None:
        try:
            p = int(pieces)
            if p <= 0:
                add('pieces', f'{p} pieces isn\'t valid — expected a positive integer', 'flag')
            elif p > _MAX_PLAUSIBLE_PIECES:
                add('pieces', f'{p} pieces is unusually high — check for a misread', 'warn')
        except (TypeError, ValueError):
            pass

    # ── Declared value plausibility ──────────────────────────────────────
    value = fields.get('declared_value')
    if value is not None:
        try:
            v = float(value)
            if v <= 0:
                add('declared_value', f'Declared value {v} isn\'t valid — expected a positive amount', 'flag')
            elif v > _MAX_PLAUSIBLE_DECLARED_VALUE:
                add('declared_value', f'Declared value {v} is unusually high — check for a misplaced decimal', 'warn')
        except (TypeError, ValueError):
            pass

    # ── Ship date plausibility ────────────────────────────────────────────
    ship_date = fields.get('ship_date')
    parsed = _parse_date_loose(ship_date) if ship_date else None
    if ship_date and not parsed:
        add('ship_date', f'"{ship_date}" doesn\'t look like a valid date', 'flag')
    elif parsed:
        now = datetime.now()
        if parsed > now + timedelta(days=14):
            add('ship_date', f'"{ship_date}" is more than 2 weeks in the future — check for a misread', 'warn')
        elif parsed < now - timedelta(days=3650):
            add('ship_date', f'"{ship_date}" is more than 10 years old — check for a misread (e.g. 2-digit year)', 'warn')

    # ── From/to identical (a common "block extraction grabbed the same
    #     data twice" failure mode — the sender and receiver being
    #     genuinely identical practically never happens for an
    #     international/domestic courier shipment) ─────────────────────
    if fields.get('from_name') and fields.get('to_name') and \
            fields['from_name'].strip().upper() == fields['to_name'].strip().upper():
        add('to_name', 'Sender and receiver names are identical — likely a mis-extraction', 'flag')

    return warnings
