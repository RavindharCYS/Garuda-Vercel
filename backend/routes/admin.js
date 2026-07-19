// routes/admin.js — Admin-only endpoints: dashboard, users, password reset
// module, audit log (+ export), carriers handled in routes/carriers.js,
// system settings. Requirement spec §2 (Users), §3 (Audit), §10 (Dashboard).
'use strict';

const express    = require('express');
const PDFDocument = require('pdfkit');
const XLSX       = require('xlsx');
const db         = require('../utils/db');
const logger     = require('../utils/logger');
const { requireAuth, requireAdmin, clearPermissionCache } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { hashPassword, checkPolicy, generateTempPassword } = require('../utils/password');
const { getApiHealth } = require('../services/apiHealth');
const { queueNotification } = require('../services/notificationService');

const router = express.Router();
router.use(requireAuth, requireAdmin);

// ── Dashboard stats (requirement spec §10 — Admin Dashboard widgets) ───────────
// Supports the same filter bar as the Shipments page (date range / status /
// carrier). With no filters given, the dashboard shows TODAY's data by
// default rather than all-time totals.
router.get('/stats', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const dateFrom = req.query.date_from || today;
  const dateTo   = req.query.date_to   || today;
  const { status, carrier } = req.query;

  const conditions = ['DATE(created_at) >= DATE(?)', 'DATE(created_at) <= DATE(?)'];
  const params = [dateFrom, dateTo];
  if (status)  { conditions.push('status = ?');  params.push(status); }
  if (carrier) { conditions.push('carrier = ?'); params.push(carrier); }
  const where = `WHERE ${conditions.join(' AND ')}`;

  const total     = (await db.get(`SELECT COUNT(*) as c FROM shipments ${where}`, params)).c;
  const today_    = (await db.get("SELECT COUNT(*) as c FROM shipments WHERE DATE(created_at)=DATE('now')")).c;
  const delivered = (await db.get(`SELECT COUNT(*) as c FROM shipments ${where} AND (status='Delivered' OR tracking_status='Delivered')`, params)).c;
  const inTransit = (await db.get(`SELECT COUNT(*) as c FROM shipments ${where} AND tracking_status IN ('In Transit','Picked Up','Out for Delivery')`, params)).c;
  const pending   = (await db.get(`SELECT COUNT(*) as c FROM shipments ${where} AND status IN ('Processing')`, params)).c;
  const exception = (await db.get(`SELECT COUNT(*) as c FROM shipments ${where} AND tracking_status='Exception'`, params)).c;
  const waybillsGenerated = (await db.get(`SELECT COUNT(*) as c FROM shipments ${where} AND garuda_waybill_generated=1`, params)).c;
  const manualQueue = (await db.get(`SELECT COUNT(*) as c FROM shipments ${where} AND needs_manual_tracking=1`, params)).c;
  const todaysUploads = (await db.get("SELECT COUNT(*) as c FROM bulk_upload_jobs WHERE DATE(created_at)=DATE('now')")).c;

  const byCarrier = await db.all(`
    SELECT carrier, COUNT(*) as count FROM shipments ${where} AND carrier IS NOT NULL GROUP BY carrier ORDER BY count DESC LIMIT 15
  `, params);

  const byCountry = await db.all(`
    SELECT to_country as country, COUNT(*) as count FROM shipments ${where} AND to_country IS NOT NULL AND to_country != ''
    GROUP BY to_country ORDER BY count DESC LIMIT 15
  `, params);

  // These three widgets are intentionally fixed rolling windows (last 7
  // days / 24h) regardless of the filter bar above — they're trend views,
  // not part of the filtered snapshot.
  const last7days = await db.all(`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM shipments WHERE created_at >= DATE('now','-6 days')
    GROUP BY DATE(created_at) ORDER BY date ASC
  `);

  const employeeActivity = await db.all(`
    SELECT username, role, COUNT(*) as actions, MAX(created_at) as last_action
    FROM audit_log WHERE username IS NOT NULL AND created_at >= datetime('now','-7 days')
    GROUP BY username, role ORDER BY actions DESC LIMIT 10
  `);

  const apiHealth = await getApiHealth(24);

  res.json({
    success: true,
    filters: { date_from: dateFrom, date_to: dateTo, status: status || '', carrier: carrier || '' },
    stats: {
      total, today: today_, delivered, inTransit, pending, exception, waybillsGenerated,
      manualQueue, todaysUploads, byCarrier, byCountry, last7days, employeeActivity, apiHealth,
    },
  });
});

// ── Users CRUD (requirement spec §2) ─────────────────────────────────────────
router.get('/users', async (req, res) => {
  const users = await db.all(`
    SELECT id, username, role, name, employee_id, email, phone, branch, status,
           is_active, must_change_password, mfa_enabled, last_login_at, last_login_ip,
           failed_login_attempts, locked_until, created_at
    FROM users ORDER BY created_at DESC
  `);
  res.json({ success: true, data: users });
});

router.post('/users', async (req, res) => {
  const { username, password, role, name, employeeId, email, phone, branch } = req.body;
  if (!username || !password || !role || !name) {
    return res.status(400).json({ success: false, error: 'username, password, role and name are required' });
  }
  const policy = checkPolicy(password);
  if (!policy.ok) return res.status(400).json({ success: false, error: policy.errors.join('; ') });

  const hashed = await hashPassword(password);
  try {
    const info = await db.run(`
      INSERT INTO users (username, password, role, name, employee_id, email, phone, branch, status, created_by)
      VALUES (?,?,?,?,?,?,?,?, 'Active', ?) RETURNING id
    `, [username.trim(), hashed, role, name, employeeId || null, email || null, phone || null, branch || null, req.user.id]);

    logAudit(req, { action: 'CREATE_USER', entity: 'users', entityId: info.lastInsertRowid, newValue: { username, role, name }, actor: req.user });
    res.status(201).json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    if (/unique/i.test(err.message)) return res.status(409).json({ success: false, error: 'Username already exists' });
    throw err;
  }
});

router.put('/users/:id', async (req, res) => {
  const { name, role, is_active, email, phone, branch, status } = req.body;
  const id = req.params.id;
  const before = await db.get('SELECT * FROM users WHERE id = ?', [id]);
  if (!before) return res.status(404).json({ success: false, error: 'User not found' });

  await db.run(`
    UPDATE users SET
      name=COALESCE(?,name), role=COALESCE(?,role), is_active=COALESCE(?,is_active),
      email=COALESCE(?,email), phone=COALESCE(?,phone), branch=COALESCE(?,branch), status=COALESCE(?,status)
    WHERE id=?
  `, [name ?? null, role ?? null, is_active ?? null, email ?? null, phone ?? null, branch ?? null, status ?? null, id]);

  logAudit(req, { action: 'UPDATE_USER', entity: 'users', entityId: id, oldValue: before, newValue: req.body, actor: req.user });
  clearPermissionCache();
  res.json({ success: true });
});

router.delete('/users/:id', async (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ success: false, error: 'Cannot deactivate your own account' });
  }
  await db.run("UPDATE users SET is_active=0, status='Inactive' WHERE id=?", [req.params.id]);
  logAudit(req, { action: 'DEACTIVATE_USER', entity: 'users', entityId: req.params.id, actor: req.user });
  res.json({ success: true });
});

// ── Password Reset Module (requirement spec §2) ────────────────────────────────
// Admin-initiated reset: generates a temp password, forces change on next login.
router.post('/users/:id/reset-password', async (req, res) => {
  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ success: false, error: 'User not found' });

  const tempPassword = generateTempPassword();
  const hashed = await hashPassword(tempPassword);

  await db.run(`
    UPDATE users SET password = ?, must_change_password = 1, password_changed_at = datetime('now'),
      failed_login_attempts = 0, locked_until = NULL, status = 'Active'
    WHERE id = ?
  `, [hashed, user.id]);

  await db.run(`
    INSERT INTO password_resets (user_id, initiated_by, temp_password_hash, must_change) VALUES (?,?,?,1)
  `, [user.id, req.user.id, hashed]);

  logAudit(req, { action: 'PASSWORD_RESET', entity: 'users', entityId: user.id, status: 'success', actor: req.user });
  queueNotification({ event: 'password_reset', userId: user.id, context: { mustChange: true } });

  res.json({ success: true, tempPassword, message: 'Temporary password generated. Share it securely — it will not be shown again.' });
});

// Force the user to change their password on next login (without resetting it now).
router.post('/users/:id/force-reset', async (req, res) => {
  await db.run("UPDATE users SET must_change_password = 1 WHERE id = ?", [req.params.id]);
  logAudit(req, { action: 'FORCE_PASSWORD_RESET', entity: 'users', entityId: req.params.id, actor: req.user });
  res.json({ success: true });
});

// Unlock an account locked out by failed login attempts.
router.post('/users/:id/unlock', async (req, res) => {
  await db.run(`
    UPDATE users SET status='Active', failed_login_attempts=0, locked_until=NULL WHERE id=?
  `, [req.params.id]);
  logAudit(req, { action: 'UNLOCK_ACCOUNT', entity: 'users', entityId: req.params.id, actor: req.user });
  res.json({ success: true });
});

// ── Audit log (requirement spec §3) ─────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  const { page = 1, limit = 50, action, username, status, from, to } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);

  const where = [];
  const params = [];
  if (action)   { where.push('action = ?'); params.push(action); }
  if (username) { where.push('username LIKE ?'); params.push(`%${username}%`); }
  if (status)   { where.push('status = ?'); params.push(status); }
  if (from)     { where.push('created_at >= ?'); params.push(from); }
  if (to)       { where.push('created_at <= ?'); params.push(to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await db.all(`
    SELECT * FROM audit_log ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?
  `, [...params, parseInt(limit), offset]);

  const totalRow = await db.get(`SELECT COUNT(*) as c FROM audit_log ${whereSql}`, params);
  res.json({ success: true, total: totalRow.c, data: rows });
});

// GET /api/admin/audit/export?format=csv|excel|pdf
router.get('/audit/export', async (req, res) => {
  const format = (req.query.format || 'csv').toLowerCase();
  const rows = await db.all('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 5000');

  logAudit(req, { action: 'AUDIT_EXPORT', entity: 'audit_log', details: `format=${format}, rows=${rows.length}`, actor: req.user });

  const cols = ['id', 'created_at', 'username', 'role', 'action', 'entity', 'entity_id', 'ip_address', 'device', 'status', 'old_value', 'new_value', 'details'];

  if (format === 'excel') {
    const ws = XLSX.utils.json_to_sheet(rows.map(r => Object.fromEntries(cols.map(c => [c, r[c]]))));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Audit Log');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="audit_log.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }

  if (format === 'pdf') {
    res.setHeader('Content-Disposition', 'attachment; filename="audit_log.pdf"');
    res.setHeader('Content-Type', 'application/pdf');
    const doc = new PDFDocument({ size: 'A4', margin: 30 });
    doc.pipe(res);
    doc.fontSize(14).text('Garuda Express — Audit Log Export', { align: 'center' });
    doc.moveDown();
    doc.fontSize(8);
    rows.slice(0, 500).forEach(r => {
      doc.text(`[${r.created_at}] ${r.username || 'system'} (${r.role || '-'}) — ${r.action} on ${r.entity || '-'}${r.entity_id ? '#' + r.entity_id : ''} — ${r.status} — ${r.ip_address || ''}`);
    });
    if (rows.length > 500) doc.text(`\n…and ${rows.length - 500} more rows (use CSV/Excel export for the full set).`);
    doc.end();
    return;
  }

  // default: CSV
  const csvRows = [cols.join(',')];
  for (const r of rows) {
    csvRows.push(cols.map(c => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  res.setHeader('Content-Disposition', 'attachment; filename="audit_log.csv"');
  res.setHeader('Content-Type', 'text/csv');
  res.send(csvRows.join('\n'));
});

// ── System settings (requirement spec §12) ──────────────────────────────────────
router.get('/settings', async (req, res) => {
  const rows = await db.all('SELECT key, value FROM system_settings');
  const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
  res.json({ success: true, settings });
});

router.put('/settings', async (req, res) => {
  const updates = req.body || {};
  const sql = `
    INSERT INTO system_settings (key, value, updated_by, updated_at) VALUES (?,?,?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')
  `;
  for (const [key, value] of Object.entries(updates)) {
    await db.run(sql, [key, String(value), req.user.id]);
  }
  logAudit(req, { action: 'SETTINGS_UPDATE', entity: 'system_settings', newValue: updates, actor: req.user });
  res.json({ success: true });
});

// ── GET /api/admin/api-usage — TrackingMore & 17Track quota + our own call stats ──
// Combines each provider's own live quota numbers (remaining credits, plan
// limits) with our locally-logged call volume/success-rate (api_logs, via
// services/apiHealth.js) so the dashboard can show both "how much is left"
// and "how much we've actually been using it."
router.get('/api-usage', async (req, res) => {
  const axios = require('axios');
  const usage = { trackingmore: null, seventeentrack: null, callStats: await getApiHealth(24) };

  if (process.env.TRACKINGMORE_API_KEY) {
    try {
      const resp = await axios.get('https://api.trackingmore.com/v3/trackings/userinfo', {
        headers: { 'Tracking-Api-Key': process.env.TRACKINGMORE_API_KEY }, timeout: 8000, validateStatus: () => true,
      });
      if (resp.data?.code === 200) {
        const d = resp.data.data;
        usage.trackingmore = {
          configured: true,
          quotaRemaining: d.track_number ?? null,
          planLimit: d.plan?.upto_order ?? null,
          planRemaining: d.plan?.remaining_order ?? null,
          consumedTotal: d.plan?.consume_total ?? null,
        };
      } else {
        usage.trackingmore = { configured: true, error: resp.data?.message || 'Could not fetch quota' };
      }
    } catch (err) {
      usage.trackingmore = { configured: true, error: err.message };
    }
  } else {
    usage.trackingmore = { configured: false };
  }

  if (process.env.SEVENTEENTRACK_API_KEY) {
    try {
      const resp = await axios.post('https://api.17track.net/track/v2.4/getquota', {}, {
        headers: { '17token': process.env.SEVENTEENTRACK_API_KEY, 'Content-Type': 'application/json' }, timeout: 8000, validateStatus: () => true,
      });
      if (resp.data?.code === 0) {
        const d = resp.data.data;
        usage.seventeentrack = {
          configured: true,
          quotaTotal: d.quota_total ?? null,
          quotaUsed: d.quota_used ?? null,
          quotaRemaining: d.quota_remain ?? null,
          todayUsed: d.today_used ?? null,
          maxTrackDaily: d.max_track_daily ?? null,
        };
      } else {
        usage.seventeentrack = { configured: true, error: resp.data?.data?.errors?.[0]?.message || 'Could not fetch quota' };
      }
    } catch (err) {
      usage.seventeentrack = { configured: true, error: err.message };
    }
  } else {
    usage.seventeentrack = { configured: false };
  }

  res.json({ success: true, ...usage });
});

// ── GET /api/admin/retention-warning — pending "backup coming soon" notice ────
// Populated by services/workers.js' Retention Warning worker
// (retention_warning_days, default 30, before the retention_months cutoff).
// The Settings page polls this to show an in-app popup; acknowledging it
// (query ?ack=1) clears it so it doesn't reappear until the next day's check
// finds a new batch.
router.get('/retention-warning', async (req, res) => {
  const countRow = await db.get("SELECT value FROM system_settings WHERE key='_retention_warning_count'");
  const sampleRow = await db.get("SELECT value FROM system_settings WHERE key='_retention_warning_sample'");
  const atRow = await db.get("SELECT value FROM system_settings WHERE key='_retention_warning_at'");
  const count = parseInt(countRow?.value || '0', 10);
  const sampleRaw = sampleRow?.value;
  const at = atRow?.value || null;

  if (req.query.ack === '1') {
    await db.run("DELETE FROM system_settings WHERE key IN ('_retention_warning_count','_retention_warning_sample','_retention_warning_at')");
    return res.json({ success: true, acknowledged: true });
  }

  res.json({
    success: true,
    pending: count > 0,
    count,
    sample: sampleRaw ? JSON.parse(sampleRaw) : [],
    at,
  });
});

// ── Clear tracking cache (force fresh API call) ───────────────────────────────
router.delete('/cache/:geNumber', async (req, res) => {
  await db.run('DELETE FROM tracking_cache WHERE ge_tracking_number = ?', [req.params.geNumber]);
  logAudit(req, { action: 'CACHE_CLEAR', entity: 'tracking_cache', entityId: req.params.geNumber, actor: req.user });
  res.json({ success: true, message: 'Cache cleared' });
});

// ── GET /api/admin/export-data — full operational-data export (Settings → Danger Zone) ──
// Exports every shipment and everything derived from it — the shipments
// themselves plus tracking history/cache, bulk-upload jobs/records,
// notifications, API call logs, and the audit log — as one multi-sheet
// Excel workbook. Deliberately does NOT include users/roles/permissions/
// carriers/system_settings: those are app configuration, not "data" in the
// sense an admin means by "export everything," and users especially
// shouldn't leave the server (password hashes) even redacted by accident.
const EXPORTABLE_TABLES = [
  ['Shipments',           'shipments'],
  ['TrackingEvents',      'tracking_events'],
  ['TrackingCache',       'tracking_cache'],
  ['Notifications',       'notifications'],
  ['BulkUploadJobs',      'bulk_upload_jobs'],
  ['BulkUploadRecords',   'bulk_upload_records'],
  ['ShipmentDocuments',   'shipment_documents'],
  ['ShipmentBackups',     'shipment_backups'],
  ['ApiLogs',             'api_logs'],
  ['AuditLog',            'audit_log'],
];

router.get('/export-data', async (req, res) => {
  const wb = XLSX.utils.book_new();

  for (const [sheetName, table] of EXPORTABLE_TABLES) {
    let rows = [];
    try {
      rows = await db.all(`SELECT * FROM ${table}`);
    } catch (err) {
      logger.warn(`export-data: skipping table "${table}"`, { error: err.message });
      continue;
    }
    // A completely empty table would otherwise produce a sheet with no
    // header row at all (json_to_sheet needs at least one object to infer
    // columns) — give it a single placeholder row instead so the sheet
    // still opens cleanly and makes clear the table was empty.
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ note: 'No rows' }]);
    XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31)); // Excel sheet-name limit
  }

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const stamp = new Date().toISOString().slice(0, 10);

  logAudit(req, { action: 'EXPORT_ALL_DATA', entity: 'database', details: `tables=${EXPORTABLE_TABLES.length}`, actor: req.user });

  res.setHeader('Content-Disposition', `attachment; filename="garuda-express-export-${stamp}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── POST /api/admin/delete-all-data — wipe all operational data ──────────────
// Same table scope as the export above (business/shipment data only — never
// users/roles/permissions/carriers/system_settings, so nobody gets locked
// out and the app stays configured/usable immediately after). Requires the
// exact confirmation phrase in the body as a server-side backstop — the
// frontend's GitHub-style "type to confirm" modal is the primary guard, but
// this endpoint doesn't trust the client alone for something this
// destructive.
const DELETE_ALL_CONFIRM_PHRASE = 'DELETE ALL DATA';

// Children first, in FK-safe order, so this works whether or not a given
// table's foreign key actually cascades.
const DELETE_ALL_TABLES_IN_ORDER = [
  'shipment_documents',
  'shipment_backups',
  'tracking_events',
  'tracking_cache',
  'notifications',
  'bulk_upload_records',
  'bulk_upload_jobs',
  'api_logs',
  'shipments',
];

router.post('/delete-all-data', async (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== DELETE_ALL_CONFIRM_PHRASE) {
    return res.status(400).json({ success: false, error: `Type "${DELETE_ALL_CONFIRM_PHRASE}" exactly to confirm.` });
  }

  const counts = {};
  for (const table of DELETE_ALL_TABLES_IN_ORDER) {
    try {
      const before = await db.get(`SELECT COUNT(*) AS c FROM ${table}`);
      counts[table] = before?.c ?? 0;
      await db.run(`DELETE FROM ${table}`);
    } catch (err) {
      logger.error(`delete-all-data: failed clearing "${table}"`, { error: err.message });
      return res.status(500).json({ success: false, error: `Failed while clearing "${table}": ${err.message}`, partialCounts: counts });
    }
  }

  // Audit log is wiped last, and deliberately AFTER everything else — this
  // way the very next (and only) row in it is the record of this action
  // itself, rather than losing that trail along with the rest.
  const auditCountRow = await db.get('SELECT COUNT(*) AS c FROM audit_log');
  counts.audit_log = auditCountRow?.c ?? 0;
  await db.run('DELETE FROM audit_log');

  logAudit(req, {
    action: 'DELETE_ALL_DATA', entity: 'database', status: 'success',
    details: `Cleared all operational data. Row counts: ${JSON.stringify(counts)}`,
    actor: req.user,
  });

  res.json({ success: true, message: 'All shipment and operational data has been deleted.', counts });
});

module.exports = router;