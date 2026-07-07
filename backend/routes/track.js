// routes/track.js — Public tracking (GE numbers only)
// Backend-only, per Auto Tracking requirement: a user's tracking lookup must
// never itself trigger a live TrackingMore/17Track API call — it only reads
// whatever the Auto Tracking worker has already synced into our DB. Live
// provider calls happen exclusively via services/workers.js (on each
// shipment's own schedule) or an admin's manual refresh
// (POST /api/shipments/:id/tracking/refresh).
'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const { getStoredTracking } = require('../services/trackingService');
const { isValidGENumber } = require('../utils/generateGE');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 30,
  message: { success: false, error: 'Too many requests. Please try again in 15 minutes.' }
});

// GET /api/track/:geNumber
router.get('/:geNumber', limiter, async (req, res) => {
  const ge = req.params.geNumber.trim().toUpperCase().replace(/[\s\-]/g, '');

  if (!isValidGENumber(ge)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid tracking number.',
      hint: 'Garuda Express tracking numbers are GE followed by 7 digits. Example: GE2847391'
    });
  }

  try {
    const result = await getStoredTracking(ge);
    res.json(result);
  } catch (err) {
    console.error('[Track]', err.message);
    res.status(500).json({ success: false, error: 'Tracking service temporarily unavailable.' });
  }
});

module.exports = router;