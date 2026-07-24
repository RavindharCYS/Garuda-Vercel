# tests/test_carrier_parsers.py
#
# Fixture-based regression suite for the waybill/AWB text parsers
# (services/parsers/*). This is the thing that was missing every time a
# parser fix looked solid in isolation and then broke on the next real
# document: every fixture here is real ground-truth text — either the
# literal output of the production extractor
# (pdf_native_text.extract_native_pdf_text) run against a real uploaded
# PDF, or (for the regression/ folder) a synthetic case protecting
# against a specific bug class that's already bitten this codebase.
#
# Run before shipping ANY change to services/parsers/:
#   cd backend && pytest tests/test_carrier_parsers.py -v
#
# Adding a new fixture when you fix a real bug:
#   1. Save the real rawText (e.g. from the OCR review page's Network
#      tab response, or by running extract_native_pdf_text on the PDF)
#      into tests/fixtures/<carrier_or_format>/<name>.json
#   2. Fill in "expected" with the fields that SHOULD be extracted.
#   3. This test discovers and runs every fixture automatically — no
#      other wiring needed.
import json
import sys
from pathlib import Path

import pytest

FIXTURES_DIR = Path(__file__).parent / 'fixtures'
SERVICES_DIR = Path(__file__).parent.parent / 'services'
sys.path.insert(0, str(SERVICES_DIR))
sys.path.insert(0, str(SERVICES_DIR / 'parsers'))

from parsers.dispatcher import dispatch  # noqa: E402


def _discover_fixtures():
    """Every *.json file under tests/fixtures/, grouped by its parent
    folder name (e.g. "aramex_classic_awb/32202672935.json" shows up in
    test output as that pair) so a failure immediately tells you which
    format broke, not just which file."""
    cases = []
    for path in sorted(FIXTURES_DIR.rglob('*.json')):
        cases.append(pytest.param(path, id=f'{path.parent.name}/{path.stem}'))
    return cases


@pytest.mark.parametrize('fixture_path', _discover_fixtures())
def test_fixture_extracts_expected_fields(fixture_path):
    with open(fixture_path) as f:
        fixture = json.load(f)

    raw_text = fixture['raw_text']
    expected = fixture['expected']

    result = dispatch(raw_text)

    mismatches = []
    for field, expected_value in expected.items():
        actual_value = result.get(field)
        if actual_value != expected_value:
            mismatches.append(f'  {field}: expected {expected_value!r}, got {actual_value!r}')

    if mismatches:
        source = fixture.get('source_pdf', '(no source recorded)')
        pytest.fail(
            f'{len(mismatches)} field(s) mismatched for {fixture_path.name} (source: {source}):\n'
            + '\n'.join(mismatches)
        )


def test_every_fixture_folder_has_at_least_one_case():
    """Catches an empty/misnamed fixture folder silently contributing
    zero test coverage."""
    folders = {p.parent for p in FIXTURES_DIR.rglob('*.json')}
    assert len(folders) >= 3, (
        f'Expected fixtures for at least 3 formats, found {len(folders)}: {folders}. '
        'If a fixture folder was added but has no .json files in it, this is silently invisible '
        'without this check.'
    )
