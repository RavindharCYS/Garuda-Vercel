#!/usr/bin/env python3
"""
Layer 0 of the extraction pipeline: native PDF text-layer extraction.

Several carriers' AWB PDFs (every DHL waybill, both Aramex airwaybills,
one of the two FedEx samples, in this project's test set) are born-digital
— the text is a real, selectable text layer, not a scanned image. Routing
these through rasterize-then-OCR (as the previous version of this backend
did unconditionally) throws away perfect text and replaces it with OCR
noise. This module extracts that text layer directly with pdfplumber and
reconstructs proper reading order with `layout_reconstruct`, so OCR is
only ever used as a fallback for pages that are genuinely scanned/
photographed (see `text_extraction.py` for the layer-selection logic).

Why not just pdfplumber.page.extract_text() / extract_words()?
-----------------------------------------------------------------
Two real problems showed up testing against actual carrier PDFs:

1. Reading order: pdfplumber's own text/word order generally follows the
   order objects were drawn in the PDF content stream, not visual
   position — on a 2-column label (sender block left, SHIP DATE/WEIGHT/
   DIMS block right, at the same height) this interleaves both blocks.
   Fixed by routing extracted words through `layout_reconstruct`.

2. Duplicate glyphs: at least one carrier's PDF template draws certain
   fields (e.g. "13.50 KG", "1/1") TWICE, as two separate text runs at
   the exact same coordinates (confirmed by inspecting page.chars: two
   fully identical (text, x0, top) tuples back to back) — a templating/
   bolding artifact. pdfplumber's word-builder ties on x-position and
   visually interleaves both copies' characters, producing corrupted
   text like "1133..5500 KKGG" instead of "13.50 KG". Fixed by
   deduplicating exact-duplicate characters before grouping into words.
"""
import statistics
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))          # parsers/
from layout_reconstruct import reconstruct_reading_order

__all__ = ['extract_native_pdf_text', 'page_words_deduped']


def extract_native_pdf_text(pdf_path, max_pages=4):
    """Returns the reconstructed text of up to `max_pages` pages of a
    PDF's native text layer, or '' if the PDF has no usable text layer
    (i.e. it's a scanned/image-only PDF and the caller should fall back
    to OCR).
    """
    import pdfplumber

    texts = []
    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages[:max_pages]:
            words = page_words_deduped(page)
            if not words:
                continue
            texts.append(reconstruct_reading_order(words, page_width=page.width))
    return '\n\n=== PAGE BREAK ===\n\n'.join(t for t in texts if t.strip())


def page_words_deduped(page, x_tolerance=3.0, y_tolerance_frac=0.3):
    """Word-level boxes for one pdfplumber page, built directly from
    page.chars with exact-duplicate-glyph removal (see module docstring,
    point 2) instead of pdfplumber's own extract_words().
    """
    chars = _dedupe_chars(page.chars)
    if not chars:
        return []

    heights = [c['bottom'] - c['top'] for c in chars if c['bottom'] > c['top']]
    tol = (statistics.median(heights) if heights else 8.0) * y_tolerance_frac

    ordered = sorted(chars, key=lambda c: c['top'])
    lines = [[ordered[0]]]
    line_top = ordered[0]['top']
    for c in ordered[1:]:
        if abs(c['top'] - line_top) <= tol:
            lines[-1].append(c)
        else:
            lines.append([c])
            line_top = c['top']

    words = []
    for line in lines:
        line_sorted = sorted(line, key=lambda c: c['x0'])
        current = []
        for c in line_sorted:
            is_space = c['text'].isspace()
            if current and not is_space:
                gap = c['x0'] - current[-1]['x1']
                if gap > x_tolerance:
                    words.append(_word_from_chars(current))
                    current = []
            if is_space:
                if current:
                    words.append(_word_from_chars(current))
                    current = []
                continue
            current.append(c)
        if current:
            words.append(_word_from_chars(current))
    return [w for w in words if w]


def _dedupe_chars(chars):
    seen = set()
    out = []
    for c in chars:
        key = (c['text'], round(c['x0'], 1), round(c['top'], 1))
        if key in seen:
            continue
        seen.add(key)
        out.append(c)
    return out


def _word_from_chars(chars):
    text = ''.join(c['text'] for c in chars)
    if not text.strip():
        return None
    return {
        'text': text,
        'x0': min(c['x0'] for c in chars),
        'x1': max(c['x1'] for c in chars),
        'y0': min(c['top'] for c in chars),
        'y1': max(c['bottom'] for c in chars),
    }
