#!/usr/bin/env python3
"""
Layout-aware text reconstruction — shared by every text-extraction engine
(native PDF text layer via pdfplumber, Tesseract OCR, OnnxTR OCR).

Problem this solves
--------------------
Plain top-to-bottom reading order breaks on AWB labels because most
carriers lay out the form as two (sometimes three) side-by-side column
blocks at the SAME vertical height — e.g. FedEx's sender name/address
block on the left and the SHIP DATE / ACTWGT / CAD / DIMS metadata block
on the right. A naive "read every word left-to-right, top-to-bottom in
one pass" reader interleaves both blocks, producing garbage like
"MARIYAMMAL KUMARAN SHIP DATE: 22APR25" on one line. This is the root
cause behind most of the "column bleed" / "strip_trailing_metadata"
workarounds that previously had to live downstream, inside every
carrier's regex parser, patching the symptom instead of the cause.

Algorithm
---------
1. Detect vertical "gutters" — x-ranges with no text anywhere on the
   page/image — wide enough to be a real column boundary rather than
   ordinary inter-word spacing, and only where text exists on BOTH
   sides of the gap (so a ragged-right margin at the page edge never
   gets treated as a column split).
2. Split all boxes into column groups using those gutters.
3. Within each column independently, cluster boxes into text lines by
   y-position (same line if their vertical centers are within one
   line-height of each other), sort each line left-to-right, and order
   lines top-to-bottom.
4. Emit columns in left-to-right order, separated by a blank line. This
   reproduces "read the whole left block, then the whole right block" —
   the same order a human follows on these labels, and the same order
   confirmed against every carrier's clean reference text used in this
   project (FedEx, DHL, UPS, Aramex samples all read this way).

This module has ZERO third-party dependencies — it operates on plain
dicts so it can be fed boxes from pdfplumber words, pytesseract
image_to_data, or OnnxTR's Document geometry with a one-line adapter
each (see the `*_to_boxes` helpers at the bottom).
"""
import statistics

__all__ = [
    'reconstruct_reading_order',
    'pdfplumber_words_to_boxes',
    'tesseract_data_to_boxes',
    'onnxtr_page_to_boxes',
]


def reconstruct_reading_order(boxes, page_width=None, gutter_frac=0.025):
    """
    boxes: list of dicts {'text': str, 'x0': float, 'y0': float, 'x1': float, 'y1': float}
        Coordinates may be in any consistent unit (pixels, points, or
        0-1 normalized) — only relative comparisons matter, since gutter
        width is computed as a fraction of page_width.
    page_width: total width in the same unit as the box coordinates.
        Inferred from the boxes themselves if not given.
    gutter_frac: minimum gap width, as a fraction of page_width, to be
        considered a real column boundary (default 2.5%).

    Returns the reconstructed text as a single string, '\\n' between
    lines within a column and '\\n\\n' between columns.
    """
    boxes = [b for b in boxes if b.get('text', '').strip()]
    if not boxes:
        return ''
    if page_width is None:
        page_width = max(b['x1'] for b in boxes)
    if not page_width or page_width <= 0:
        page_width = 1.0

    columns = _split_into_columns(boxes, page_width, gutter_frac)
    blocks = [_lines_from_boxes(col) for col in columns]
    return '\n\n'.join(b for b in blocks if b)


def _global_line_bands(boxes):
    """Cluster boxes into horizontal row-bands by y-position ONLY (ignores
    x entirely). Used as the first pass of column detection — see
    _split_into_columns — so a single stray wide element on one row (e.g.
    a barcode string that happens to span the gutter) can't single-
    handedly defeat gutter detection the way a literal "must be 100%
    empty across the whole page" check would.
    """
    heights = [b['y1'] - b['y0'] for b in boxes if b['y1'] > b['y0']]
    tol = (statistics.median(heights) if heights else 10.0) * 0.6
    ordered = sorted(boxes, key=lambda b: (b['y0'] + b['y1']) / 2.0)
    bands = [[ordered[0]]]
    band_y = (ordered[0]['y0'] + ordered[0]['y1']) / 2.0
    for b in ordered[1:]:
        cy = (b['y0'] + b['y1']) / 2.0
        if abs(cy - band_y) <= tol:
            bands[-1].append(b)
            band_y = sum((x['y0'] + x['y1']) / 2.0 for x in bands[-1]) / len(bands[-1])
        else:
            bands.append([b])
            band_y = cy
    return bands


def _find_real_gutters(boxes, bands, page_width, gutter_frac, max_gutter_occupancy=0.12):
    """Page-wide candidate column-boundary x-ranges (see module docstring).
    Returns a list of (g0, g1) gutter ranges, merged and filtered, or []
    if the page doesn't look multi-column at all.
    """
    n_bins = 240
    bin_w = page_width / n_bins
    if bin_w <= 0 or len(bands) < 2:
        return []

    occ_count = [0] * n_bins
    for band in bands:
        band_occ = [False] * n_bins
        for b in band:
            i0 = max(0, min(n_bins - 1, int(b['x0'] / bin_w)))
            i1 = max(0, min(n_bins - 1, int(b['x1'] / bin_w)))
            for i in range(i0, i1 + 1):
                band_occ[i] = True
        for i, occ in enumerate(band_occ):
            if occ:
                occ_count[i] += 1
    n_bands = len(bands)
    occ_frac = [c / n_bands for c in occ_count]

    min_gutter_bins = max(1, int(round((gutter_frac * page_width) / bin_w)))

    gutters = []
    run_start = None
    for i, frac in enumerate(occ_frac + [1.0]):  # sentinel flushes a trailing run
        is_gutter = frac <= max_gutter_occupancy
        if is_gutter and run_start is None:
            run_start = i
        elif not is_gutter and run_start is not None:
            if i - run_start >= min_gutter_bins:
                gutters.append((run_start * bin_w, i * bin_w))
            run_start = None
    if not gutters:
        return []

    # A gutter only counts as a column boundary if there's real text on
    # BOTH sides of it — otherwise it's just empty margin at a page edge,
    # not a split between two logical blocks.
    real_gutters = []
    for g0, g1 in gutters:
        has_left = any(b['x1'] <= g0 + 1e-6 for b in boxes)
        has_right = any(b['x0'] >= g1 - 1e-6 for b in boxes)
        if has_left and has_right:
            real_gutters.append((g0, g1))
    if not real_gutters:
        return []

    return _merge_thin_columns(real_gutters, page_width)


def _split_into_columns(boxes, page_width, gutter_frac, max_gutter_occupancy=0.12):
    bands = _global_line_bands(boxes)
    real_gutters = _find_real_gutters(boxes, bands, page_width, gutter_frac, max_gutter_occupancy)
    if not real_gutters:
        return [boxes]

    bounds = [0.0] + [((g0 + g1) / 2.0) for g0, g1 in real_gutters] + [page_width + 1.0]

    # A within-ROW gap only counts as a column split if it's comparably
    # wide to a real page-wide gutter — NOT merely "wide compared to
    # ordinary word spacing". This is the key fix for a failure mode
    # confirmed on a real FedEx sample: "5 YISHUN INDUSTRIAL STREET 1" is
    # one continuous address line whose trailing "1" happens to sit past
    # the midpoint of a wide page-wide gutter (because the line is long),
    # but the gap between "STREET" and "1" *on that specific row* is only
    # a couple of points — ordinary word spacing, not a real column break.
    # Splitting columns per-row (instead of assigning each word
    # independently by its absolute x-position) keeps a line like this
    # intact and in the column its majority of words belong to.
    min_split_gap = max(
        min(g1 - g0 for g0, g1 in real_gutters) * 0.4,
        0.03 * page_width,
    )

    columns = [[] for _ in range(len(bounds) - 1)]
    for band in bands:
        row_sorted = sorted(band, key=lambda b: b['x0'])
        fragments = [[row_sorted[0]]]
        for b in row_sorted[1:]:
            gap = b['x0'] - fragments[-1][-1]['x1']
            if gap >= min_split_gap:
                fragments.append([b])
            else:
                fragments[-1].append(b)
        for frag in fragments:
            center = (min(b['x0'] for b in frag) + max(b['x1'] for b in frag)) / 2.0
            col_idx = 0
            for i in range(len(bounds) - 1):
                if bounds[i] <= center < bounds[i + 1]:
                    col_idx = i
                    break
            columns[col_idx].append(frag)

    return [_flatten_fragment_column(col) for col in columns if col]


def _flatten_fragment_column(fragment_rows):
    """`fragment_rows`: list of fragments (each a list of boxes, already
    x-sorted, one fragment per row that landed in this column). Returns a
    flat list of boxes suitable for `_lines_from_boxes` — safe because
    each fragment already is exactly one visual line's worth of content
    for this column, so normal y-clustering in `_lines_from_boxes` will
    reassemble them in the same row order.
    """
    flat = []
    for frag in fragment_rows:
        flat.extend(frag)
    return flat


# A "column" narrower than this fraction of the page width is treated as
# noise rather than a real block — e.g. a single rare character (a lone
# street number, a stray barcode digit) sitting in an otherwise-empty
# x-range on just one row can register as its own gutter-bounded sliver.
# Without this merge step that character gets peeled off into its own
# spurious one-word "column" and printed in the wrong place relative to
# the line it actually belongs to (confirmed on a real FedEx sample: the
# trailing "1" of "5 YISHUN INDUSTRIAL STREET 1" was being separated from
# "STREET" this way). Two gutters separated by a sliver this thin are
# merged into one wider gutter instead.
_MIN_COLUMN_WIDTH_FRAC = 0.05


def _merge_thin_columns(real_gutters, page_width):
    if len(real_gutters) < 2:
        return real_gutters
    ordered = sorted(real_gutters, key=lambda g: g[0])
    merged = [ordered[0]]
    for g in ordered[1:]:
        prev = merged[-1]
        col_width = g[0] - prev[1]
        if col_width < _MIN_COLUMN_WIDTH_FRAC * page_width:
            merged[-1] = (prev[0], max(prev[1], g[1]))
        else:
            merged.append(g)
    return merged


def _lines_from_boxes(boxes):
    if not boxes:
        return ''
    heights = [b['y1'] - b['y0'] for b in boxes if b['y1'] > b['y0']]
    # Tolerance for "same line": a bit more than half the median word
    # height, so slight baseline jitter (common in OCR boxes) doesn't
    # split one visual line into two.
    tol = (statistics.median(heights) if heights else 10.0) * 0.6

    ordered = sorted(boxes, key=lambda b: (b['y0'] + b['y1']) / 2.0)
    lines = []
    current = [ordered[0]]
    current_y = (ordered[0]['y0'] + ordered[0]['y1']) / 2.0
    for b in ordered[1:]:
        cy = (b['y0'] + b['y1']) / 2.0
        if abs(cy - current_y) <= tol:
            current.append(b)
            # Running average keeps the line's reference y stable even
            # as more boxes are folded in.
            current_y = sum((x['y0'] + x['y1']) / 2.0 for x in current) / len(current)
        else:
            lines.append(current)
            current = [b]
            current_y = cy
    lines.append(current)

    out_lines = []
    for line in lines:
        line_sorted = sorted(line, key=lambda b: b['x0'])
        out_lines.append(' '.join(b['text'] for b in line_sorted))
    return '\n'.join(out_lines)


# ── Adapters: convert each engine's native word/box format to our shape ─────

def pdfplumber_words_to_boxes(words):
    """`words` = page.extract_words(...) output from pdfplumber."""
    return [
        {'text': w['text'], 'x0': w['x0'], 'y0': w['top'], 'x1': w['x1'], 'y1': w['bottom']}
        for w in words if w.get('text', '').strip()
    ]


def tesseract_data_to_boxes(data, min_conf=0):
    """`data` = pytesseract.image_to_data(..., output_type=Output.DICT) output."""
    boxes = []
    n = len(data.get('text', []))
    for i in range(n):
        txt = (data['text'][i] or '').strip()
        if not txt:
            continue
        try:
            conf = int(float(data['conf'][i]))
        except (ValueError, TypeError):
            conf = -1
        if conf < min_conf:
            continue
        x, y = data['left'][i], data['top'][i]
        w, h = data['width'][i], data['height'][i]
        boxes.append({'text': txt, 'x0': x, 'y0': y, 'x1': x + w, 'y1': y + h})
    return boxes


def onnxtr_page_to_boxes(page, page_width=1.0, page_height=1.0):
    """`page` = one `Page` object from an OnnxTR `Document.pages` result.
    OnnxTR geometry is relative (0-1); we scale by the supplied pixel
    dimensions so this can share the same gutter-width-as-fraction-of-
    page logic as the pixel-based engines (page_width default of 1.0
    works fine too, since reconstruct_reading_order only cares about
    *fractions* of page_width — scaling is cosmetic).
    """
    boxes = []
    for block in page.blocks:
        for line in block.lines:
            for word in line.words:
                (x0, y0), (x1, y1) = word.geometry
                txt = (word.value or '').strip()
                if not txt:
                    continue
                boxes.append({
                    'text': txt,
                    'x0': x0 * page_width, 'y0': y0 * page_height,
                    'x1': x1 * page_width, 'y1': y1 * page_height,
                })
    return boxes
