# tests/test_field_validation.py
#
# Unit tests for services/parsers/field_validation.py — verifies each
# sanity check actually fires on bad data and stays silent on good data.
import sys
from pathlib import Path

SERVICES_DIR = Path(__file__).parent.parent / 'services'
sys.path.insert(0, str(SERVICES_DIR))
sys.path.insert(0, str(SERVICES_DIR / 'parsers'))

from parsers.field_validation import validate_field_consistency  # noqa: E402


def _fields(**overrides):
    base = {
        'from_name': 'SENDER NAME', 'to_name': 'RECEIVER NAME',
        'from_country': 'India', 'from_postal': '600034',
        'to_country': 'USA', 'to_postal': '20165', 'to_contact': '9199314184',
        'actual_weight': 5.0, 'billing_weight': 5.0,
        'pieces': 1, 'declared_value': 500.0, 'ship_date': '07/28/2026',
    }
    base.update(overrides)
    return base


def test_clean_data_produces_no_warnings():
    assert validate_field_consistency(_fields()) == []


def test_postal_code_country_mismatch_flagged():
    warnings = validate_field_consistency(_fields(from_postal='ABCDE'))
    assert any(w['field'] == 'from_postal' and w['severity'] == 'flag' for w in warnings)


def test_uae_postal_never_flagged_no_formal_system():
    warnings = validate_field_consistency(_fields(to_country='UAE', to_postal='anything-goes'))
    assert not any(w['field'] == 'to_postal' for w in warnings)


def test_phone_digit_count_out_of_range_warned():
    warnings = validate_field_consistency(_fields(to_contact='123'))
    assert any(w['field'] == 'to_contact' for w in warnings)


def test_implausible_weight_flagged():
    warnings = validate_field_consistency(_fields(actual_weight=50000))
    assert any(w['field'] == 'actual_weight' and w['severity'] == 'flag' for w in warnings)


def test_billing_weight_far_below_actual_warned():
    warnings = validate_field_consistency(_fields(actual_weight=100, billing_weight=1))
    assert any(w['field'] == 'billing_weight' for w in warnings)


def test_negative_pieces_flagged():
    warnings = validate_field_consistency(_fields(pieces=-1))
    assert any(w['field'] == 'pieces' and w['severity'] == 'flag' for w in warnings)


def test_negative_declared_value_flagged():
    warnings = validate_field_consistency(_fields(declared_value=-100))
    assert any(w['field'] == 'declared_value' and w['severity'] == 'flag' for w in warnings)


def test_invalid_date_flagged():
    warnings = validate_field_consistency(_fields(ship_date='13/45/2026'))
    assert any(w['field'] == 'ship_date' and w['severity'] == 'flag' for w in warnings)


def test_far_future_date_warned():
    warnings = validate_field_consistency(_fields(ship_date='12/31/2099'))
    assert any(w['field'] == 'ship_date' for w in warnings)


def test_identical_sender_receiver_flagged():
    warnings = validate_field_consistency(_fields(from_name='SAME NAME', to_name='same name'))
    assert any(w['field'] == 'to_name' and w['severity'] == 'flag' for w in warnings)


def test_missing_fields_dont_crash():
    # Every field absent — should return cleanly with no warnings, not raise.
    assert validate_field_consistency({}) == []
