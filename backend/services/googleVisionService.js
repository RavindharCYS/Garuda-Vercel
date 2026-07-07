// services/googleVisionService.js — Google Cloud Vision OCR (primary engine)
// Uses the simple REST API + API key (no service-account JSON required),
// which keeps deployment simple for a freelance/SMB client. Falls back to
// Tesseract (services/ocr_worker.py) automatically if this fails or is
// unconfigured — see services/ocrService.js for the selection logic.
'use strict';

const axios  = require('axios');
const fs     = require('fs');
const logger = require('../utils/logger');
const { logApiCall } = require('./apiHealth');

const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';

function isConfigured() {
  return !!process.env.GOOGLE_VISION_API_KEY;
}

/**
 * Run TEXT_DETECTION on a single image buffer via Google Vision REST API.
 * @param {Buffer} imageBuffer
 * @returns {Promise<{rawText: string, confidence: number}>}
 */
async function detectText(imageBuffer) {
  const key = process.env.GOOGLE_VISION_API_KEY;
  if (!key) throw new Error('GOOGLE_VISION_API_KEY not configured');

  const base64 = imageBuffer.toString('base64');
  const start = Date.now();

  try {
    const resp = await axios.post(`${VISION_URL}?key=${key}`, {
      requests: [{
        image: { content: base64 },
        features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
      }],
    }, { timeout: 20000 });

    logApiCall({ provider: 'google_vision', endpoint: 'images:annotate', success: true, statusCode: resp.status, responseMs: Date.now() - start });

    const annotation = resp.data?.responses?.[0]?.fullTextAnnotation;
    if (!annotation) return { rawText: '', confidence: 0 };

    // Vision doesn't return a single scalar confidence for full-text; derive
    // an approximate average from per-page word confidences when present.
    let confSum = 0, confCount = 0;
    for (const page of annotation.pages || []) {
      for (const block of page.blocks || []) {
        if (typeof block.confidence === 'number') { confSum += block.confidence * 100; confCount++; }
      }
    }
    const confidence = confCount ? Math.round((confSum / confCount) * 10) / 10 : 85; // sane default if API omits it

    return { rawText: annotation.text || '', confidence };
  } catch (err) {
    logApiCall({ provider: 'google_vision', endpoint: 'images:annotate', success: false, statusCode: err.response?.status, responseMs: Date.now() - start, error: err.message });
    logger.error('Google Vision OCR failed', { error: err.message });
    throw err;
  }
}

/** Extract text from an image file path. */
async function detectTextFromFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return detectText(buffer);
}

module.exports = { isConfigured, detectText, detectTextFromFile };
