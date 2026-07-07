#!/usr/bin/env python3
"""
Top-level extraction orchestrator — picks the best available layer(s) for
a given file:

  0. Native PDF text layer (pdfplumber)   — perfect text, zero OCR error,
     for any PDF that's born-digital rather than scanned/photographed.
  1. OnnxTR (optional)                     — much more accurate than
     Tesseract on printed labels when installed/available.
  2. Tesseract                              — always available, the final
     fallback, now with layout-aware reconstruction (see ocr_layers.py).

IMPORTANT — these are not always mutually exclusive. Some real carrier
templates (confirmed on an Aramex airwaybill in this project) mix a native
text layer with an IMAGE-based section on the same page — e.g. the
tracking barcode, weight, declared value, and the formal "1 FROM (SHIPPER)
/ 2 TO (RECEIVER)" field-labeled grid are rasterized, while the plain-text
sender/receiver summary and the legal terms wall are real text. A naive
"native text exists and looks substantial → skip OCR entirely" rule
confidently returns a result that's missing exactly the fields the
image-only section carried, because a legal-boilerplate-heavy document
trivially racks up incidental hits on generic words like "shipment" or
"carrier" even when every actual DATA field came from the missing image
section. `ocr_worker.py` handles this by also running OCR and merging in
any field still null after parsing the native text — see
`extract_best_text` there for the merge logic; this module only provides
the two extraction primitives it merges between.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))          # parsers/
from pdf_native_text import extract_native_pdf_text
from ocr_layers import ocr_image_with_layout, ocr_image_with_onnxtr, count_known_word_hits

MIN_NATIVE_TEXT_CHARS = 40
MIN_NATIVE_TEXT_HITS = 2
MAX_PAGES = 3


def extract_native_only(filepath):
    """Returns the native PDF text-layer extraction if the file is a PDF
    with a usable text layer, else None. Never touches OCR.
    """
    if os.path.splitext(filepath)[1].lower() != '.pdf':
        return None
    native = extract_native_pdf_text(filepath, max_pages=4)
    hits = count_known_word_hits(native)
    if len(native.strip()) >= MIN_NATIVE_TEXT_CHARS and hits >= MIN_NATIVE_TEXT_HITS:
        return native
    return None


def extract_via_ocr(filepath):
    """Rasterizes the file (or opens it directly if it's already an image)
    and runs OnnxTR (if available) or Tesseract. Returns
    {text, engine, confidence, rotation_applied, pages_used}.
    """
    from pdf2image import convert_from_path
    from PIL import Image

    ext = os.path.splitext(filepath)[1].lower()
    if ext == '.pdf':
        pages = convert_from_path(filepath, dpi=300)[:MAX_PAGES]
    else:
        pages = [Image.open(filepath).convert('RGB')]

    page_results = []  # (hits, confidence, text, rotation, engine, page_num)
    for i, page_img in enumerate(pages):
        onnxtr_result = ocr_image_with_onnxtr(page_img)
        if onnxtr_result is not None:
            text, conf, rot = onnxtr_result
            engine = 'onnxtr'
        else:
            text, conf, rot = ocr_image_with_layout(page_img)
            engine = 'tesseract'
        hits = count_known_word_hits(text)
        page_results.append((hits, conf, text, rot, engine, i + 1))

    page_results.sort(key=lambda r: r[0], reverse=True)
    hits, conf, text, rot, engine, page_num = page_results[0]
    return {
        'text': text, 'engine': engine,
        'confidence': conf, 'rotation_applied': rot, 'pages_used': page_num,
    }


def extract_best_text(filepath):
    """Convenience wrapper for callers that just want text (no field-level
    merge) — e.g. quick inspection/debugging. Production field extraction
    goes through ocr_worker.py's hybrid merge instead, since that's the
    layer aware enough to know when native text alone left fields null.
    """
    native = extract_native_only(filepath)
    if native is not None:
        return {
            'text': native, 'engine': 'pdf_text_layer',
            'confidence': 99.0, 'rotation_applied': 0, 'pages_used': None,
        }
    return extract_via_ocr(filepath)
