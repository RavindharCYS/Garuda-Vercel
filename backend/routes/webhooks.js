// routes/webhooks.js — receives push notifications from TrackingMore and
// 17Track. This is the ENTIRE mechanism by which tracking_status and
// tracking_events get updated now — there is no polling/cycle worker.
//
// External one-time setup (done once, in each provider's own dashboard, not
// via our API):
//   TrackingMore: Settings -> Webhook -> paste this server's
//     https://<your-domain>/api/webhooks/trackingmore
//   17Track: https://api.17track.net/admin/settings -> Webhook -> paste
//     https://<your-domain>/api/webhooks/17track
// (Also shown, read-only, on the Settings page in the admin app.)
'use strict';

const express = require('express');
const { processWebhookUpdate, mapTrackingMoreStatus, map17TrackStatus, verifyTrackingMoreSignature } = require('../services/trackingService');
const logger = require('../utils/logger');

const router = express.Router();

// ── POST /api/webhooks/trackingmore ───────────────────────────────────────────
// Payload shape per TrackingMore docs: { code, message, data: {...}, verify: { timestamp, signature } }
// Signature: SHA256(rawBody + '/' + TRACKINGMORE_API_KEY), per their docs'
// worked example. req.rawBody is captured by the global express.json()
// verify hook in server.js.
router.post('/trackingmore', (req, res) => {
  try {
    const signature = req.body?.verify?.signature;
    if (signature && !verifyTrackingMoreSignature(req.rawBody, signature)) {
      logger.warn('[Webhook:TrackingMore] signature mismatch — processing anyway but flagging for review');
    }

    const payload = req.body;
    const data = payload?.data;
    if (!data?.tracking_number) {
      return res.status(400).json({ success: false, error: 'Missing tracking_number in payload' });
    }

    const events = (data.origin_info?.trackinfo || []).map(e => ({
      timestamp: e.checkpoint_date, status: e.tracking_detail, location: e.location || '',
    })).reverse();

    const result = processWebhookUpdate({
      provider: 'trackingmore',
      trackingNumber: data.tracking_number,
      currentStatus: mapTrackingMoreStatus(data.delivery_status),
      events,
    });

    logger.info('[Webhook:TrackingMore] received', { trackingNumber: data.tracking_number, matched: result.success });
    res.json({ success: true }); // always 200 quickly — TrackingMore doesn't need our internal match result
  } catch (err) {
    logger.error('[Webhook:TrackingMore] processing error', { error: err.message });
    res.status(200).json({ success: true }); // still 200 so the provider doesn't retry-storm us over our own bug
  }
});

// ── POST /api/webhooks/17track ────────────────────────────────────────────────
// Payload shape per 17Track docs: { event: 'TRACKING_UPDATED'|'TRACKING_STOPPED', data: {...} }
// NOTE: 17Track's docs show a "sign" header on pushes but don't specify the
// exact signing algorithm the way TrackingMore's docs do (worked example,
// SHA256 formula). Rather than guess and silently "verify" against a made-up
// formula, we process the payload as-is and just log the header for now —
// wire up real verification here once 17Track's exact algorithm is confirmed
// from their dashboard/support.
router.post('/17track', (req, res) => {
  try {
    const signature = req.headers['sign'];
    if (signature) logger.info('[Webhook:17Track] signature header present (not verified — see comment above)');

    const payload = req.body;
    if (payload?.event !== 'TRACKING_UPDATED') {
      // TRACKING_STOPPED or anything else — nothing to update, just acknowledge.
      return res.json({ success: true });
    }

    const data = payload.data;
    const trackInfo = data?.track_info;
    const provider = trackInfo?.tracking?.providers?.[0];
    const events = (provider?.events || []).map(e => ({
      timestamp: e.time_iso, status: e.description, location: e.location || '',
    })).reverse();

    if (!data?.number) {
      return res.status(400).json({ success: false, error: 'Missing number in payload' });
    }

    const result = processWebhookUpdate({
      provider: '17track',
      trackingNumber: data.number,
      currentStatus: map17TrackStatus(trackInfo?.latest_status?.status),
      events,
    });

    logger.info('[Webhook:17Track] received', { trackingNumber: data.number, matched: result.success });
    res.json({ success: true });
  } catch (err) {
    logger.error('[Webhook:17Track] processing error', { error: err.message });
    res.status(200).json({ success: true });
  }
});

module.exports = router;