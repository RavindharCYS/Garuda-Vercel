#!/usr/bin/env python3
"""
Layers 1-2 of the extraction pipeline: OCR for scanned/photographed pages
(native PDF text layer extraction — Layer 0 — lives in pdf_native_text.py
and is tried first by text_extraction.py; this module is only reached for
pages that genuinely have no usable text layer).

Layer 1 — OnnxTR (optional)
---------------------------
OnnxTR is an ONNX-runtime port of docTR's detection+recognition models —
meaningfully more accurate than Tesseract on printed labels, and (just as
importantly) gives WORD-level bounding boxes, so its output can go through
the same `layout_reconstruct` column-aware reordering as the native-text
layer instead of trusting a flat reading order. It's an optional, lazily-
imported dependency: if it's not installed, or its model weights can't be
downloaded (first run only — they're fetched from a GitHub release and
cached locally after that), this layer is skipped and Layer 2 (Tesseract)
runs instead. Nothing here hard-fails a deployment that doesn't have it.

Layer 2 — Tesseract (always available, final fallback)
--------------------------------------------------------
Two concrete fixes vs. the previous version of this worker:
  1. DPI raised 200 → 300, and a light contrast/sharpen pass added before
     OCR — both straightforwardly improve recognition accuracy on small
     printed labels.
  2. Word-level bounding boxes (`image_to_data`) are now run through
     `layout_reconstruct` instead of using `image_to_string`'s flat
     reading order — the same column-bleed fix applied to the native-text
     layer, now also covering genuinely scanned/photographed labels.
"""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))          # parsers/
from layout_reconstruct import reconstruct_reading_order, tesseract_data_to_boxes, onnxtr_page_to_boxes

KNOWN_WORDS = [
    'kg', 'tracking', 'ship', 'origin', 'fedex', 'ups', 'dhl', 'waybill',
    'from', 'date', 'dims', 'actwgt', 'trk', 'billing', 'desc',
    'ship date', 'trk#', 'ship to', 'origin id', 'weight', 'pieces',
    'contents', 'sender', 'consignee', 'recipient', 'express',
]


def count_known_word_hits(text):
    low = text.lower()
    return sum(1 for w in KNOWN_WORDS if w in low)


# ── Layer 2: Tesseract, with layout-aware reconstruction ────────────────────

def preprocess_for_ocr(img):
    """Light, generic preprocessing — grayscale + autocontrast + a mild
    sharpen — before handing the image to Tesseract. Conservative on
    purpose: aggressive binarization helped some samples and hurt others
    in testing, whereas this combination was a net improvement across the
    board without needing per-carrier tuning.
    """
    from PIL import ImageOps, ImageFilter
    gray = img.convert('L')
    gray = ImageOps.autocontrast(gray, cutoff=1)
    gray = gray.filter(ImageFilter.SHARPEN)
    return gray


def best_rotation(img):
    import pytesseract
    best_hits, best_rot, best_text = -1, 0, ""
    for rot in [0, 90, 180, 270]:
        rotated = img.rotate(rot, expand=True) if rot else img
        txt = pytesseract.image_to_string(rotated, config='--psm 6 --oem 3')
        hits = count_known_word_hits(txt)
        if hits > best_hits:
            best_hits, best_rot, best_text = hits, rot, txt
    return best_rot, best_text, best_hits


def ocr_image_with_layout(img):
    """Returns (text, confidence, rotation_applied) for one image, using
    word-level boxes + layout_reconstruct instead of flat reading order.
    """
    import pytesseract

    pre = preprocess_for_ocr(img)
    rot, _, _ = best_rotation(pre)
    final_img = pre.rotate(rot, expand=True) if rot else pre

    data = pytesseract.image_to_data(final_img, output_type=pytesseract.Output.DICT, config='--psm 1 --oem 3')
    boxes = tesseract_data_to_boxes(data, min_conf=0)
    confs = [int(c) for c in data['conf'] if str(c).isdigit() and int(c) >= 0]
    confidence = round(sum(confs) / len(confs), 1) if confs else 0.0

    if boxes:
        text = reconstruct_reading_order(boxes, page_width=final_img.width)
    else:
        text = pytesseract.image_to_string(final_img, config='--psm 1 --oem 3')
    return text, confidence, rot


# ── Layer 1: OnnxTR (optional) ───────────────────────────────────────────────

_onnxtr_predictor = None
_onnxtr_load_failed = False


import time

_ONNXTR_FAILURE_MARKER = '/tmp/.onnxtr_model_unavailable'
_ONNXTR_FAILURE_TTL_SECONDS = 3600  # re-attempt after an hour, in case network access changes


def _onnxtr_recently_failed():
    try:
        return (time.time() - os.path.getmtime(_ONNXTR_FAILURE_MARKER)) < _ONNXTR_FAILURE_TTL_SECONDS
    except OSError:
        return False


def _mark_onnxtr_failed():
    try:
        with open(_ONNXTR_FAILURE_MARKER, 'w') as f:
            f.write(str(time.time()))
    except OSError:
        pass


def _get_onnxtr_predictor():
    global _onnxtr_predictor, _onnxtr_load_failed
    if _onnxtr_predictor is not None or _onnxtr_load_failed:
        return _onnxtr_predictor
    # ocr_worker.py runs as a fresh subprocess per file (see server.js /
    # ocrService.js) — the in-process _onnxtr_load_failed flag above only
    # helps within a single file's processing, not across files. Without
    # this marker, every single request in a network-restricted deployment
    # would separately re-attempt and wait out the same failing download.
    if _onnxtr_recently_failed():
        _onnxtr_load_failed = True
        return None
    import io
    import contextlib
    # OnnxTR's model download path prints progress/fallback messages
    # directly to stdout (confirmed: "Downloading https://... Failed
    # download. Trying https -> http instead...") rather than through
    # Python logging. Left unsuppressed, that text lands BEFORE this
    # worker's actual JSON output on stdout and breaks every caller that
    # parses stdout as JSON (services/ocrService.js does exactly that).
    # This must hold whether the download succeeds, fails, or partially
    # completes — so both stdout and stderr are redirected for the
    # entire load attempt, not just wrapped in a try/except.
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            from onnxtr.models import ocr_predictor
            _onnxtr_predictor = ocr_predictor(
                det_arch='fast_base', reco_arch='crnn_vgg16_bn',
                assume_straight_pages=False,  # these labels arrive at arbitrary rotations
            )
    except Exception:
        _onnxtr_load_failed = True
        _onnxtr_predictor = None
        _mark_onnxtr_failed()
    return _onnxtr_predictor


def ocr_image_with_onnxtr(img):
    """Returns (text, confidence, rotation_applied) or None if OnnxTR isn't
    available (not installed, or its model weights couldn't be fetched —
    e.g. no internet access on first run in this particular environment).
    Callers must fall back to ocr_image_with_layout() when this returns None.
    """
    predictor = _get_onnxtr_predictor()
    if predictor is None:
        return None
    import io
    import contextlib
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            import numpy as np
            arr = np.array(img.convert('RGB'))
            result = predictor([arr])
            page = result.pages[0]
            boxes = onnxtr_page_to_boxes(page, page_width=img.width, page_height=img.height)
            if not boxes:
                return None
            text = reconstruct_reading_order(boxes, page_width=img.width)
            word_confs = [
                w.confidence
                for block in page.blocks for line in block.lines for w in line.words
            ]
            confidence = round(100.0 * sum(word_confs) / len(word_confs), 1) if word_confs else 0.0
            rotation = round(getattr(page, 'orientation', {}).get('value', 0) or 0) if hasattr(page, 'orientation') else 0
            return text, confidence, rotation
    except Exception:
        return None
