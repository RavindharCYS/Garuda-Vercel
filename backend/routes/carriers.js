// routes/carriers.js — Carrier Management Module (requirement spec §4)
'use strict';

const express = require('express');
const db      = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

// GET /api/carriers — list all (any authenticated user can view, for dropdowns)
router.get('/', async (req, res) => {
  const { region, status } = req.query;
  const conditions = [], params = [];
  if (region) { conditions.push('region = ?'); params.push(region); }
  if (status) { conditions.push('status = ?'); params.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = await db.all(`SELECT * FROM carriers ${where} ORDER BY region, priority`, params);
  res.json({ success: true, data: rows });
});

// GET /api/carriers/:id
router.get('/:id', async (req, res) => {
  const row = await db.get('SELECT * FROM carriers WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ success: false, error: 'Carrier not found' });
  const configs = await db.all('SELECT config_key, config_value FROM carrier_configs WHERE carrier_id = ?', [row.id]);
  res.json({ success: true, data: { ...row, configs: Object.fromEntries(configs.map(c => [c.config_key, c.config_value])) } });
});

// POST /api/carriers — create
router.post('/', requirePermission('carriers.manage'), async (req, res) => {
  const { name, code, tracking_provider, api_type, priority, region } = req.body;
  if (!name || !code) return res.status(400).json({ success: false, error: 'name and code are required' });

  try {
    const info = await db.run(`
      INSERT INTO carriers (name, code, tracking_provider, status, api_type, priority, region)
      VALUES (?,?,?, 'Active', ?, ?, ?) RETURNING id
    `, [name, code.toUpperCase(), tracking_provider || 'trackingmore', api_type || 'api', priority || 100, region || 'International']);

    logAudit(req, { action: 'CARRIER_CREATE', entity: 'carriers', entityId: info.lastInsertRowid, newValue: req.body, actor: req.user });
    res.status(201).json({ success: true, id: info.lastInsertRowid });
  } catch (err) {
    if (/unique/i.test(err.message)) return res.status(409).json({ success: false, error: 'Carrier name or code already exists' });
    throw err;
  }
});

// PUT /api/carriers/:id — update
router.put('/:id', requirePermission('carriers.manage'), async (req, res) => {
  const before = await db.get('SELECT * FROM carriers WHERE id = ?', [req.params.id]);
  if (!before) return res.status(404).json({ success: false, error: 'Carrier not found' });

  const { name, tracking_provider, status, api_type, priority, region } = req.body;
  await db.run(`
    UPDATE carriers SET
      name=COALESCE(?,name), tracking_provider=COALESCE(?,tracking_provider),
      status=COALESCE(?,status), api_type=COALESCE(?,api_type),
      priority=COALESCE(?,priority), region=COALESCE(?,region)
    WHERE id=?
  `, [name ?? null, tracking_provider ?? null, status ?? null, api_type ?? null, priority ?? null, region ?? null, req.params.id]);

  logAudit(req, { action: 'CARRIER_UPDATE', entity: 'carriers', entityId: req.params.id, oldValue: before, newValue: req.body, actor: req.user });
  res.json({ success: true });
});

// DELETE /api/carriers/:id — soft-deactivate (never hard-delete; shipments may reference it)
router.delete('/:id', requirePermission('carriers.manage'), async (req, res) => {
  await db.run("UPDATE carriers SET status = 'Inactive' WHERE id = ?", [req.params.id]);
  logAudit(req, { action: 'CARRIER_DEACTIVATE', entity: 'carriers', entityId: req.params.id, actor: req.user });
  res.json({ success: true });
});

// PUT /api/carriers/:id/config — set carrier-specific config (e.g. slug overrides, custom API keys)
router.put('/:id/config', requirePermission('carriers.manage'), async (req, res) => {
  const updates = req.body || {};
  const sql = `
    INSERT INTO carrier_configs (carrier_id, config_key, config_value) VALUES (?,?,?)
    ON CONFLICT(carrier_id, config_key) DO UPDATE SET config_value = excluded.config_value
  `;
  for (const [key, value] of Object.entries(updates)) await db.run(sql, [req.params.id, key, String(value)]);
  logAudit(req, { action: 'CARRIER_CONFIG_UPDATE', entity: 'carriers', entityId: req.params.id, newValue: updates, actor: req.user });
  res.json({ success: true });
});

module.exports = router;
