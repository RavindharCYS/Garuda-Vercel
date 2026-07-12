// routes/profile.js — Employee Self-Service (requirement spec §2)
// Note: password change itself lives at POST /api/auth/change-password
// (kept there since it's auth-adjacent); this file covers profile fields
// and the user's own login/audit history.
'use strict';

const express = require('express');
const db      = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/profile — current user's full profile
router.get('/', async (req, res) => {
  const user = await db.get(`
    SELECT id, username, role, name, employee_id, email, phone, branch, status,
           mfa_enabled, last_login_at, last_login_ip, created_at
    FROM users WHERE id = ?
  `, [req.user.id]);
  res.json({ success: true, data: user });
});

// PUT /api/profile — update own contact info (name/email/phone — NOT role/status/username)
router.put('/', async (req, res) => {
  const { name, email, phone } = req.body;
  const before = await db.get('SELECT name, email, phone FROM users WHERE id = ?', [req.user.id]);

  await db.run(`
    UPDATE users SET name=COALESCE(?,name), email=COALESCE(?,email), phone=COALESCE(?,phone) WHERE id=?
  `, [name ?? null, email ?? null, phone ?? null, req.user.id]);

  logAudit(req, { action: 'PROFILE_UPDATE', entity: 'users', entityId: req.user.id, oldValue: before, newValue: { name, email, phone }, actor: req.user });
  res.json({ success: true });
});

// GET /api/profile/login-history — own login audit trail only
router.get('/login-history', async (req, res) => {
  const rows = await db.all(`
    SELECT created_at, action, ip_address, device, status FROM audit_log
    WHERE user_id = ? AND action IN ('LOGIN_SUCCESS','LOGIN_FAILURE','LOGOUT')
    ORDER BY created_at DESC LIMIT 100
  `, [req.user.id]);
  res.json({ success: true, data: rows });
});

module.exports = router;
