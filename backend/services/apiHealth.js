// services/apiHealth.js — Records every external API call outcome to the
// api_logs table. Powers the Admin Dashboard "API Health" widget and the
// Audit Logging "API Failures" action category (see requirement spec §3, §10).
'use strict';

const db     = require('../utils/db');
const { logAudit } = require('../utils/audit');

const INSERT_SQL = `
  INSERT INTO api_logs (provider, endpoint, success, status_code, response_ms, error)
  VALUES (?, ?, ?, ?, ?, ?)
`;

/** Fire-and-forget by design — telemetry must never throw or block the caller. */
async function logApiCall({ provider, endpoint = null, success, statusCode = null, responseMs = null, error = null }) {
  try {
    await db.run(INSERT_SQL, [provider, endpoint, success ? 1 : 0, statusCode, responseMs, error]);
    if (!success) {
      // Surface failures into the audit trail too, per spec's "API Failures" action.
      logAudit(null, {
        action: 'API_FAILURE', entity: provider, status: 'failure',
        details: `${endpoint || ''} ${error || ''}`.trim(),
        actor: { username: 'system' },
      });
    }
  } catch (_) {
    // never throw from telemetry
  }
}

/** Aggregate success-rate stats per provider over the last N hours (for dashboard). */
async function getApiHealth(hours = 24) {
  return db.all(`
    SELECT provider,
           COUNT(*) as total,
           SUM(success) as successes,
           ROUND(100.0 * SUM(success) / COUNT(*), 1) as success_rate,
           ROUND(AVG(response_ms), 0) as avg_response_ms
    FROM api_logs
    WHERE created_at >= datetime('now', ?)
    GROUP BY provider
    ORDER BY provider
  `, [`-${hours} hours`]);
}

module.exports = { logApiCall, getApiHealth };
