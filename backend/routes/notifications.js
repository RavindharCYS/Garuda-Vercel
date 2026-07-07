// routes/notifications.js — Admin view/retry of the notification queue (requirement spec §11)
'use strict';

const express = require('express');
const db      = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { processQueue } = require('../services/notificationService');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth, requirePermission('notifications.manage'));

// GET /api/notifications — list recent notifications, optional ?status= filter
router.get('/', (req, res) => {
  const { status, page = 1, limit = 50 } = req.query;
  const where = status ? 'WHERE status = ?' : '';
  const params = status ? [status] : [];
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const rows = db.prepare(`
    SELECT n.*, u.username FROM notifications n LEFT JOIN users u ON u.id = n.user_id
    ${where} ORDER BY n.created_at DESC LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), offset);
  const total = db.prepare(`SELECT COUNT(*) as c FROM notifications ${where}`).get(...params).c;
  res.json({ success: true, total, data: rows });
});

// POST /api/notifications/retry — flush the Queued/Failed queue now
router.post('/retry', async (req, res) => {
  const n = await processQueue(100);
  logAudit(req, { action: 'NOTIFICATIONS_RETRY', entity: 'notifications', details: `${n} processed`, actor: req.user });
  res.json({ success: true, processed: n });
});

module.exports = router;
