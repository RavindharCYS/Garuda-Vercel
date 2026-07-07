// routes/auth.js — Login / logout / me / refresh / change-password
// Implements requirement spec §1: Argon2 hashing w/ transparent bcrypt
// migration, account lockout, refresh-token rotation, password-expiry
// enforcement, MFA-ready hooks, and full login audit trail.
'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const db      = require('../utils/db');
const logger  = require('../utils/logger');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { hashPassword, verifyPassword, checkPolicy, isPasswordExpired } = require('../utils/password');

const router = express.Router();
const SECRET         = process.env.JWT_SECRET || 'fallback_dev_secret_change_in_prod';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || `${SECRET}_refresh`;
const ACCESS_EXPIRES_IN  = process.env.JWT_EXPIRES_IN || '30m';
const REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const REFRESH_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;

const MAX_FAILED_ATTEMPTS = parseInt(process.env.MAX_FAILED_LOGIN_ATTEMPTS || '5', 10);
const LOCKOUT_MINUTES      = parseInt(process.env.LOCKOUT_MINUTES || '15', 10);

function signAccessToken(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role, name: user.name, type: 'access' }, SECRET, { expiresIn: ACCESS_EXPIRES_IN });
}

function issueRefreshToken(user, req) {
  const raw = crypto.randomBytes(40).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_MS).toISOString();

  db.prepare(`
    INSERT INTO login_sessions (user_id, refresh_token_hash, ip_address, device, expires_at)
    VALUES (?,?,?,?,?)
  `).run(user.id, tokenHash, req.ip, req.headers['user-agent'] || null, expiresAt);

  // Embed the raw value in a signed JWT so the client only ever sees an opaque token,
  // while the server can still validate against the hashed copy in login_sessions.
  return jwt.sign({ id: user.id, raw, type: 'refresh' }, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES_IN });
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: 'Username and password required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());

  if (!user) {
    logAudit(req, { action: 'LOGIN_FAILURE', entity: 'users', status: 'failure', details: `Unknown username: ${username}`, actor: { username } });
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  // ── Account status checks ──────────────────────────────────────────────
  if (!user.is_active || user.status === 'Inactive') {
    logAudit(req, { action: 'LOGIN_FAILURE', entity: 'users', entityId: user.id, status: 'failure', details: 'Account inactive', actor: user });
    return res.status(403).json({ success: false, error: 'Account is inactive. Contact your administrator.' });
  }
  if (user.status === 'Locked' || (user.locked_until && new Date(user.locked_until) > new Date())) {
    logAudit(req, { action: 'LOGIN_FAILURE', entity: 'users', entityId: user.id, status: 'failure', details: 'Account locked', actor: user });
    return res.status(423).json({ success: false, error: 'Account is locked due to repeated failed login attempts. Contact your administrator.' });
  }

  // ── Password verification (transparent bcrypt -> argon2 migration) ───────
  const { valid, needsRehash } = await verifyPassword(user.password, password);

  if (!valid) {
    const attempts = (user.failed_login_attempts || 0) + 1;
    const willLock = attempts >= MAX_FAILED_ATTEMPTS;
    db.prepare(`
      UPDATE users SET failed_login_attempts = ?, status = ?, locked_until = ?
      WHERE id = ?
    `).run(attempts, willLock ? 'Locked' : user.status, willLock ? new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString() : null, user.id);

    logAudit(req, { action: 'LOGIN_FAILURE', entity: 'users', entityId: user.id, status: 'failure',
      details: willLock ? `Account locked after ${attempts} failed attempts` : `Failed attempt ${attempts}/${MAX_FAILED_ATTEMPTS}`, actor: user });

    if (willLock) return res.status(423).json({ success: false, error: `Account locked after ${attempts} failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.` });
    return res.status(401).json({ success: false, error: 'Invalid credentials' });
  }

  // ── Success: reset failure counter, silently rehash legacy bcrypt → argon2 ──
  const updates = { failed_login_attempts: 0, locked_until: null, last_login_at: new Date().toISOString(), last_login_ip: req.ip };
  if (needsRehash) updates.password = await hashPassword(password);

  db.prepare(`
    UPDATE users SET failed_login_attempts=@failed_login_attempts, locked_until=@locked_until,
      last_login_at=@last_login_at, last_login_ip=@last_login_ip
      ${needsRehash ? ', password=@password' : ''}
    WHERE id = @id
  `).run({ ...updates, id: user.id });

  // ── Password expiry check ──────────────────────────────────────────────
  const expired = isPasswordExpired(user.password_changed_at);

  const accessToken  = signAccessToken(user);
  const refreshToken = issueRefreshToken(user, req);

  logAudit(req, { action: 'LOGIN_SUCCESS', entity: 'users', entityId: user.id, status: 'success', actor: user });

  res.json({
    success: true,
    token: accessToken,
    refreshToken,
    mustChangePassword: !!user.must_change_password || expired,
    mfaEnabled: !!user.mfa_enabled, // MFA verification endpoint not yet built — hook is here for future TOTP rollout
    user: { id: user.id, username: user.username, role: user.role, name: user.name, employeeId: user.employee_id },
  });
});

// POST /api/auth/refresh — rotate refresh token, issue a new access token
router.post('/refresh', (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(400).json({ success: false, error: 'refreshToken required' });

  let payload;
  try { payload = jwt.verify(refreshToken, REFRESH_SECRET); }
  catch (_) { return res.status(401).json({ success: false, error: 'Invalid or expired refresh token' }); }

  const tokenHash = crypto.createHash('sha256').update(payload.raw).digest('hex');
  const session = db.prepare('SELECT * FROM login_sessions WHERE user_id = ? AND refresh_token_hash = ? AND revoked = 0').get(payload.id, tokenHash);
  if (!session || new Date(session.expires_at) < new Date()) {
    return res.status(401).json({ success: false, error: 'Session expired — please log in again' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
  if (!user || !user.is_active || user.status !== 'Active') {
    return res.status(401).json({ success: false, error: 'Account is not active' });
  }

  // Rotate: revoke old session, issue a new refresh + access token pair
  db.prepare('UPDATE login_sessions SET revoked = 1, last_used_at = datetime(\'now\') WHERE id = ?').run(session.id);
  const newAccessToken  = signAccessToken(user);
  const newRefreshToken = issueRefreshToken(user, req);

  res.json({ success: true, token: newAccessToken, refreshToken: newRefreshToken });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare(`
    SELECT id, username, role, name, employee_id, email, phone, branch, status,
           must_change_password, mfa_enabled, last_login_at, created_at
    FROM users WHERE id = ?
  `).get(req.user.id);
  res.json({ success: true, user });
});

// POST /api/auth/change-password — employee self-service (spec §2 Employee Self-Service)
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: 'currentPassword and newPassword required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  const { valid } = await verifyPassword(user.password, currentPassword);
  if (!valid) return res.status(401).json({ success: false, error: 'Current password is incorrect' });

  const policy = checkPolicy(newPassword);
  if (!policy.ok) return res.status(400).json({ success: false, error: policy.errors.join('; ') });

  const hashed = await hashPassword(newPassword);
  db.prepare(`
    UPDATE users SET password = ?, must_change_password = 0, password_changed_at = datetime('now') WHERE id = ?
  `).run(hashed, user.id);

  logAudit(req, { action: 'PASSWORD_CHANGE', entity: 'users', entityId: user.id, status: 'success', actor: req.user });
  res.json({ success: true, message: 'Password updated successfully' });
});

// POST /api/auth/logout — revoke the current refresh session if provided
router.post('/logout', requireAuth, (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, REFRESH_SECRET);
      const tokenHash = crypto.createHash('sha256').update(payload.raw).digest('hex');
      db.prepare('UPDATE login_sessions SET revoked = 1 WHERE user_id = ? AND refresh_token_hash = ?').run(payload.id, tokenHash);
    } catch (_) { /* ignore invalid token on logout */ }
  }
  logAudit(req, { action: 'LOGOUT', entity: 'users', entityId: req.user.id, status: 'success', actor: req.user });
  res.json({ success: true });
});

module.exports = router;
