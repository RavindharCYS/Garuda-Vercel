// utils/audit.js — Centralized audit logging helper.
// Writes to the audit_log table (exposed to the app/spec as the `audit_logs`
// view — see initDb.js) with full IP / device / old-value / new-value capture.
'use strict';

const db = require('./db');
const logger = require('./logger');

const STMT = db.prepare(`
  INSERT INTO audit_log
    (user_id, username, role, action, entity, entity_id, ip_address, device, old_value, new_value, status, details)
  VALUES
    (@user_id, @username, @role, @action, @entity, @entity_id, @ip_address, @device, @old_value, @new_value, @status, @details)
`);

/**
 * Log an audit event.
 * @param {object} req - Express request (used for IP/device/user when available)
 * @param {object} opts
 * @param {string} opts.action       e.g. 'LOGIN_SUCCESS','LOGIN_FAILURE','PASSWORD_RESET','USERNAME_CHANGE',
 *                                    'SHIPMENT_CREATE','SHIPMENT_UPDATE','SHIPMENT_DELETE','BULK_UPLOAD',
 *                                    'TRACKING_SYNC','API_FAILURE','CARRIER_CHANGE', etc.
 * @param {string} [opts.entity]     table/resource name e.g. 'shipments','users','carriers'
 * @param {string|number} [opts.entityId]
 * @param {any}    [opts.oldValue]   prior value (object will be JSON.stringify'd)
 * @param {any}    [opts.newValue]   new value
 * @param {string} [opts.status]     'success' | 'failure' (default 'success')
 * @param {string} [opts.details]    free-text note
 * @param {object} [opts.actor]      override actor when req.user isn't set (e.g. failed login before auth)
 */
function logAudit(req, opts) {
  try {
    const user = opts.actor || req?.user || {};
    const ip = req?.ip || req?.headers?.['x-forwarded-for'] || req?.connection?.remoteAddress || null;
    const device = req?.headers?.['user-agent'] || null;

    STMT.run({
      user_id:    user.id ?? null,
      username:   user.username ?? opts.actorUsername ?? null,
      role:       user.role ?? null,
      action:     opts.action,
      entity:     opts.entity ?? null,
      entity_id:  opts.entityId != null ? String(opts.entityId) : null,
      ip_address: ip,
      device:     device,
      old_value:  opts.oldValue != null ? JSON.stringify(opts.oldValue) : null,
      new_value:  opts.newValue != null ? JSON.stringify(opts.newValue) : null,
      status:     opts.status || 'success',
      details:    opts.details ?? null,
    });
  } catch (err) {
    // Auditing must never break the request flow.
    logger.error('Audit log write failed', { error: err.message, action: opts?.action });
  }
}

module.exports = { logAudit };
