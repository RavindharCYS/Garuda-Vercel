// middleware/auth.js — JWT auth, RBAC permission checks, session/lockout awareness
'use strict';

const jwt    = require('jsonwebtoken');
const db     = require('../utils/db');
const logger = require('../utils/logger');

const SECRET = process.env.JWT_SECRET || 'fallback_dev_secret_change_in_prod';

// Cache permission codes per role in-process (roles rarely change; admin endpoint
// to edit role_permissions should call clearPermissionCache()).
let _permCache = null;
function loadPermissions() {
  if (_permCache) return _permCache;
  const rows = db.prepare(`
    SELECT r.name as role, p.code as permission
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
  `).all();
  _permCache = {};
  for (const row of rows) {
    (_permCache[row.role] ||= new Set()).add(row.permission);
  }
  return _permCache;
}
function clearPermissionCache() { _permCache = null; }

function roleHasPermission(role, code) {
  const perms = loadPermissions();
  return !!(perms[role] && perms[role].has(code));
}

/**
 * Middleware: requires a valid JWT access token.
 * Token can be in Authorization: Bearer <token> header.
 * Also enforces account status (must be Active, not locked) on every request
 * by re-checking the DB row — cheap given SQLite is local/embedded.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.cookies?.token;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, SECRET);
    if (payload.type && payload.type !== 'access') {
      return res.status(401).json({ success: false, error: 'Invalid token type' });
    }

    const user = db.prepare('SELECT id, username, role, name, status, is_active FROM users WHERE id = ?').get(payload.id);
    if (!user || !user.is_active || user.status === 'Locked' || user.status === 'Inactive') {
      return res.status(401).json({ success: false, error: 'Account is not active' });
    }

    req.user = { id: user.id, username: user.username, role: user.role, name: user.name };
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/** Middleware: requires admin role. Must be used AFTER requireAuth. */
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }
  next();
}

/**
 * Middleware factory: requires a specific RBAC permission code.
 * Falls back gracefully — if a role has no rows in role_permissions
 * (cache miss/misconfiguration), admins are always allowed through.
 */
function requirePermission(code) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ success: false, error: 'Authentication required' });
    if (req.user.role === 'admin') return next(); // admins implicitly pass — also seeded explicitly
    if (roleHasPermission(req.user.role, code)) return next();
    logger.warn('Permission denied', { user: req.user.username, role: req.user.role, code });
    return res.status(403).json({ success: false, error: `Missing permission: ${code}` });
  };
}

module.exports = { requireAuth, requireAdmin, requirePermission, roleHasPermission, clearPermissionCache };
