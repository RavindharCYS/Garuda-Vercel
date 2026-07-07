// services/waybillService.js — Garuda Express branded AWB/Waybill PDF generator
//
// PREVIOUSLY: this file only contained field-schema helpers (a stale, mis-named
// duplicate of services/waybillFieldSchema.js — see its header comment, which
// literally still says "services/waybillFieldSchema.js"). It never exported a
// `generateWaybill` function, even though routes/shipments.js has always
// imported one — that mismatch is the direct cause of the
// "generateWaybill is not a function" error on POST /api/shipments/:id/generate-waybill.
// The field-schema helpers already live correctly in waybillFieldSchema.js and
// nothing else requires this module, so it has been replaced outright with the
// actual PDF generator described below.
'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const QRCode = require('qrcode');

// ── Brand palette — mirrors frontend/src/index.css (.hero-gradient / .purple-gradient) ──
const BRAND = {
  dark: '#1a0820',
  mid: '#2d1040',
  deep: '#3d1f5c',
  purple: '#7B3FAD',
  purpleDark: '#5B2D8B',
  lavenderTint: '#F6F1FB',
  border: '#D9C8EC',
  textDark: '#1a0820',
  gray: '#6B6470',
  green: '#059669',
};

const LOGO_PATH = path.join(__dirname, '../assets/logo.png');
const PAGE = { width: 595.28, height: 841.89 }; // A4
const MARGIN = 36;

function trackingUrl(geNumber) {
  const base = (process.env.PUBLIC_TRACKING_URL || process.env.FRONTEND_URL || 'https://garudaexpress.com').replace(/\/$/, '');
  return `${base}/?track=${encodeURIComponent(geNumber)}`;
}

/** Renders a horizontal gradient rectangle. */
function gradientRect(doc, x, y, w, h, colors) {
  const grad = doc.linearGradient(x, y, x + w, y);
  colors.forEach(([offset, color]) => grad.stop(offset, color));
  doc.rect(x, y, w, h).fill(grad);
}

/** value -> trimmed string or null if blank/undefined/"null" */
function clean(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return (s === '' || s.toLowerCase() === 'null') ? null : s;
}

/**
 * Decide how to render a FROM/TO party block.
 *
 * Per spec: if the parser/OCR was able to separate name, address, and
 * contact into distinct fields, render them as clean labeled lines. If it
 * COULDN'T (one or more of those core fields is missing — a common outcome
 * on noisy OCR where everything landed in one bucket), fall back to a single
 * combined paragraph in the same box rather than showing broken-looking
 * partial/empty labeled rows.
 */
function buildPartyBlock({ name, company, attention, address, city, state, country, postal, contact }) {
  name = clean(name); company = clean(company); attention = clean(attention);
  address = clean(address); city = clean(city); state = clean(state);
  country = clean(country); postal = clean(postal); contact = clean(contact);

  const locality = [city, state, postal].filter(Boolean).join(', ');
  const canSeparate = Boolean(name) && Boolean(address);

  if (canSeparate) {
    const lines = [];
    if (attention && attention !== name) lines.push({ text: `Attn: ${attention}`, bold: false });
    lines.push({ text: name, bold: true, size: 11.5 });
    if (company && company !== name) lines.push({ text: company, bold: true });
    lines.push({ text: address, bold: false });
    if (locality) lines.push({ text: locality, bold: false });
    if (country) lines.push({ text: country.toUpperCase(), bold: true });
    if (contact) lines.push({ text: `Tel: ${contact}`, bold: false, color: BRAND.gray });
    return { structured: true, lines };
  }

  // Combined fallback — join whatever we actually have into one paragraph.
  const parts = [name, company, attention, address, locality, country, contact && `Tel: ${contact}`]
    .filter(Boolean);
  return {
    structured: false,
    paragraph: parts.length ? parts.join(' \u2022 ') : 'Details not available',
  };
}

function drawSectionLabel(doc, text, x, y, w) {
  doc.rect(x, y, w, 18).fill(BRAND.purpleDark);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(8.5)
    .text(text.toUpperCase(), x + 8, y + 5, { width: w - 16, characterSpacing: 0.6 });
}

const PARTY_BOX_MIN_H = 96;
const PARTY_BOX_MAX_H = 210; // beyond this, text is truncated with an ellipsis rather than overflowing the box

/** Measures how tall a party's content block would render at `innerW`, so
 * the From/To boxes can be sized to fit real content (a fixed height caused
 * long addresses/names to visibly spill past the box border and collide
 * with the next section — confirmed with a long-field stress test). */
function measurePartyHeight(doc, party, innerW) {
  let h = 0;
  if (party.structured) {
    for (const line of party.lines) {
      doc.font(line.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(line.size || 9.5);
      h += doc.heightOfString(line.text, { width: innerW }) + 2;
    }
  } else {
    doc.font('Helvetica').fontSize(9);
    h = doc.heightOfString(party.paragraph, { width: innerW, lineGap: 2 });
  }
  return h;
}

function drawPartyBox(doc, title, party, x, y, w, h) {
  doc.roundedRect(x, y, w, h, 4).lineWidth(1).stroke(BRAND.border);
  drawSectionLabel(doc, title, x, y, w);

  const innerX = x + 10, innerY = y + 26, innerW = w - 20, innerH = h - 32;
  doc.fillColor(BRAND.textDark);

  if (party.structured) {
    let cy = innerY;
    for (const line of party.lines) {
      if (cy >= innerY + innerH) break; // guard: never draw past the box (capped boxes truncate)
      doc.font(line.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(line.size || 9.5)
        .fillColor(line.color || BRAND.textDark)
        .text(line.text, innerX, cy, { width: innerW, height: innerY + innerH - cy, ellipsis: true });
      cy = doc.y + 2;
    }
  } else {
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.textDark)
      .text(party.paragraph, innerX, innerY, { width: innerW, height: innerH, lineGap: 2, ellipsis: true });
  }
}

function fieldLabel(v, fallback = '—') {
  const c = clean(v);
  return c === null ? fallback : c;
}

function drawDetailGrid(doc, rows, x, y, w) {
  const colW = w / 2;
  const rowH = 22;
  let cy = y;
  for (let i = 0; i < rows.length; i += 2) {
    const pair = rows.slice(i, i + 2);
    const tint = (i / 2) % 2 === 0;
    pair.forEach((cell, idx) => {
      if (!cell) return;
      const cx = x + idx * colW;
      doc.rect(cx, cy, colW, rowH).fill(tint ? BRAND.lavenderTint : '#FFFFFF');
      doc.rect(cx, cy, colW, rowH).lineWidth(0.5).stroke(BRAND.border);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND.purpleDark)
        .text(cell[0].toUpperCase(), cx + 8, cy + 4, { width: colW - 16, characterSpacing: 0.4 });
      doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.textDark)
        .text(cell[1], cx + 8, cy + 12, { width: colW - 16 });
    });
    cy += rowH;
  }
  return cy;
}

function formatWeight(shipment) {
  const w = shipment.actual_weight ?? shipment.billing_weight;
  if (w === null || w === undefined || w === '') return '—';
  return `${w} ${shipment.weight_unit || 'kg'}`;
}

function formatDimensions(shipment) {
  if (shipment.dimensions) {
    try {
      const d = typeof shipment.dimensions === 'string' ? JSON.parse(shipment.dimensions) : shipment.dimensions;
      if (d && d.l) return `${d.l} x ${d.w} x ${d.h} ${d.unit || 'cm'}`;
    } catch (_) { /* fall through to L/W/H columns below */ }
  }
  if (shipment.length || shipment.width || shipment.height) {
    return `${shipment.length || '—'} x ${shipment.width || '—'} x ${shipment.height || '—'} cm`;
  }
  return '—';
}

function formatDeclaredValue(shipment) {
  if (shipment.declared_value === null || shipment.declared_value === undefined || shipment.declared_value === '') return '—';
  return `${shipment.currency || 'INR'} ${Number(shipment.declared_value).toLocaleString()}`;
}

/**
 * Generate a Garuda Express branded waybill PDF for `shipment` (a row from
 * the shipments table — see utils/initDb.js for the full column list) and
 * write it to `outputPath`. Resolves with `outputPath` on success.
 */
async function generateWaybill(shipment, outputPath) {
  const ge = shipment.ge_tracking_number || 'PENDING';
  const url = trackingUrl(ge);

  const qrBuffer = await QRCode.toBuffer(url, {
    type: 'png', width: 240, margin: 1,
    color: { dark: BRAND.dark, light: '#FFFFFF' },
  });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
    doc.on('error', reject);

    const W = PAGE.width;
    let y = 0;

    // ── Header band ──────────────────────────────────────────────────────
    gradientRect(doc, 0, 0, W, 96, [[0, BRAND.dark], [0.55, BRAND.mid], [1, BRAND.purpleDark]]);

    if (fs.existsSync(LOGO_PATH)) {
      try { doc.image(LOGO_PATH, MARGIN, 18, { width: 58, height: 58 }); } catch (_) { /* non-fatal */ }
    }
    doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(20)
      .text('GARUDA EXPRESS', MARGIN + 68, 26);
    doc.font('Helvetica').fontSize(8.5).fillColor('rgba(255,255,255,0.75)')
      .fillColor('#D9C8EC')
      .text('International Courier & Logistics', MARGIN + 68, 50);
    doc.fontSize(7.5).fillColor('#C9AEE3')
      .text('www.garudaexpress.com', MARGIN + 68, 64);

    doc.font('Helvetica-Bold').fontSize(9).fillColor('#D9C8EC')
      .text('AIR WAYBILL', W - MARGIN - 200, 22, { width: 200, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(22).fillColor('#FFFFFF')
      .text(ge, W - MARGIN - 200, 34, { width: 200, align: 'right' });
    doc.font('Helvetica').fontSize(7.5).fillColor('#C9AEE3')
      .text(`Tracking No: ${ge}`, W - MARGIN - 200, 60, { width: 200, align: 'right' });
    doc.text('Carrier: Garuda Express', W - MARGIN - 200, 72, { width: 200, align: 'right' });

    // Accent strip
    doc.rect(0, 96, W, 4).fill(BRAND.purple);

    y = 116;

    // ── Shipment quick-facts strip ───────────────────────────────────────
    const facts = [
      ['Ship Date', fieldLabel(shipment.ship_date)],
      ['Pieces', fieldLabel(shipment.pieces, '1')],
      ['Weight', formatWeight(shipment)],
      ['Service', fieldLabel(shipment.service_type)],
    ];
    const factW = (W - MARGIN * 2) / facts.length;
    facts.forEach(([label, value], i) => {
      const fx = MARGIN + i * factW;
      doc.rect(fx, y, factW, 36).lineWidth(0.5).stroke(BRAND.border);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(BRAND.purpleDark)
        .text(label.toUpperCase(), fx + 8, y + 6, { width: factW - 16, characterSpacing: 0.4 });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND.textDark)
        .text(value, fx + 8, y + 18, { width: factW - 16 });
    });
    y += 36 + 14;

    // ── FROM / TO boxes ───────────────────────────────────────────────────
    const boxW = (W - MARGIN * 2 - 14) / 2;
    const partyInnerW = boxW - 20;

    const fromParty = buildPartyBlock({
      name: shipment.from_name, company: shipment.sender_company,
      address: shipment.from_address, city: shipment.from_city, state: shipment.from_state,
      country: shipment.from_country, postal: shipment.from_postal, contact: shipment.from_contact,
    });
    const toParty = buildPartyBlock({
      name: shipment.to_name, company: shipment.receiver_company, attention: shipment.receiver_attention,
      address: shipment.to_address, city: shipment.to_city, state: shipment.to_state,
      country: shipment.to_country, postal: shipment.to_postal, contact: shipment.to_contact,
    });

    // Box height = whichever party needs more room, clamped to a sane range
    // so one very long address can't push the rest of the document around —
    // (confirmed via stress test) it instead truncates gracefully with "…".
    const neededH = Math.max(
      measurePartyHeight(doc, fromParty, partyInnerW),
      measurePartyHeight(doc, toParty, partyInnerW)
    ) + 32;
    const boxH = Math.min(PARTY_BOX_MAX_H, Math.max(PARTY_BOX_MIN_H, neededH));

    drawPartyBox(doc, 'From (Shipper)', fromParty, MARGIN, y, boxW, boxH);
    drawPartyBox(doc, 'To (Receiver)', toParty, MARGIN + boxW + 14, y, boxW, boxH);
    y += boxH + 16;

    // ── Shipment details grid ────────────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.purpleDark)
      .text('SHIPMENT DETAILS', MARGIN, y);
    y += 14;

    const detailRows = [
      // Requirement: the customer-facing Waybill must never disclose the actual
      // carrier (UPS/DHL/etc.) or that carrier's own tracking/AWB number.
      // "Carrier" always reads "Garuda Express"; "Carrier Tracking No." shows
      // the Garuda (GE) tracking number only.
      ['Carrier', 'Garuda Express'],
      ['Carrier Tracking No.', ge],
      // NOTE: deliberately ASCII "->" rather than the Unicode "→" arrow —
      // PDFKit's standard (non-embedded) Helvetica only supports WinAnsi
      // encoding, which has no arrow glyph; it silently renders as garbage
      // (confirmed visually: "MAA !' AUH"). ASCII renders correctly everywhere.
      ['Origin / Destination', `${fieldLabel(shipment.origin_code, '—')} -> ${fieldLabel(shipment.destination_code, '—')}`],
      ['Dimensions (L x W x H)', formatDimensions(shipment)],
      ['Billing Weight', shipment.billing_weight ? `${shipment.billing_weight} ${shipment.weight_unit || 'kg'}` : formatWeight(shipment)],
      ['Reference No.', fieldLabel(shipment.reference_number || shipment.invoice_number)],
      ['Declared Value', formatDeclaredValue(shipment)],
      ['Billing Type', fieldLabel(shipment.billing_type)],
    ];
    y = drawDetailGrid(doc, detailRows, MARGIN, y, W - MARGIN * 2);
    y += 14;

    // ── Contents / Description box ───────────────────────────────────────
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(BRAND.purpleDark)
      .text('DESCRIPTION OF GOODS', MARGIN, y);
    y += 14;
    const descH = 46;
    doc.roundedRect(MARGIN, y, W - MARGIN * 2, descH, 4).lineWidth(1).stroke(BRAND.border);
    doc.font('Helvetica').fontSize(9.5).fillColor(BRAND.textDark)
      .text(fieldLabel(shipment.contents, 'No description provided'), MARGIN + 10, y + 10, {
        width: W - MARGIN * 2 - 20, height: descH - 20, ellipsis: true,
      });
    y += descH + 18;

    // ── Tracking / QR block ───────────────────────────────────────────────
    const qrSize = 78;
    doc.roundedRect(MARGIN, y, W - MARGIN * 2, qrSize + 20, 4).fill(BRAND.lavenderTint);
    doc.image(qrBuffer, MARGIN + 14, y + 11, { width: qrSize, height: qrSize });
    doc.font('Helvetica-Bold').fontSize(11).fillColor(BRAND.textDark)
      .text('Scan to track your shipment', MARGIN + qrSize + 32, y + 16);
    doc.font('Helvetica').fontSize(9).fillColor(BRAND.gray)
      .text(url, MARGIN + qrSize + 32, y + 34, { width: W - MARGIN * 2 - qrSize - 46 });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(BRAND.purpleDark)
      .text(`Tracking No: ${ge}`, MARGIN + qrSize + 32, y + 54);
    y += qrSize + 20 + 24;

    // ── Signatures ────────────────────────────────────────────────────────
    const sigW = (W - MARGIN * 2 - 14) / 2;
    [
      ['Shipper Signature & Date', MARGIN],
      ['Received by Garuda Express', MARGIN + sigW + 14],
    ].forEach(([label, sx]) => {
      doc.moveTo(sx, y + 26).lineTo(sx + sigW, y + 26).lineWidth(0.75).stroke(BRAND.gray);
      doc.font('Helvetica').fontSize(8.5).fillColor(BRAND.gray).text(label, sx, y + 30);
    });
    y += 60;

    // ── Footer ────────────────────────────────────────────────────────────
    const footerY = PAGE.height - 40;
    doc.rect(0, footerY, W, 40).fill(BRAND.dark);
    doc.font('Helvetica').fontSize(7.5).fillColor('#C9AEE3')
      .text(
        'This waybill is generated electronically by Garuda Express and is non-negotiable. ' +
        'Carriage is subject to the originating carrier\u2019s standard terms and conditions.',
        MARGIN, footerY + 13, { width: W - MARGIN * 2, align: 'center' }
      );

    doc.end();
  });
}

module.exports = { generateWaybill, trackingUrl };