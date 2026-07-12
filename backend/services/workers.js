// services/workers.js — Background workers (requirement spec §9)
// Uses node-cron (kept from v1.0) instead of BullMQ/Redis — see README for
// the production-scale migration note. Each worker is intentionally small
// and independent so a failure in one never blocks the others.
'use strict';

const fs      = require('fs');
const path    = require('path');
const cron    = require('node-cron');
const db      = require('../utils/db');
const logger  = require('../utils/logger');
const { registerForTracking, manualRefresh } = require('./trackingService');
const { processQueue, notifySystemRecipients, notifyITError } = require('./notificationService');

let started = false;

async function getSetting(key, fallback) {
  const row = await db.get('SELECT value FROM system_settings WHERE key = ?', [key]);
  return row?.value ?? fallback;
}
async function setSetting(key, value) {
  await db.run(`
    INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `, [key, value]);
}

function startWorkers() {
  if (started) return; // avoid double-registration on hot reloads
  started = true;

  // ── Registration Retry Worker — every 15 min, retries the ONE-TIME
  // registration handshake for shipments that don't have it yet (network
  // blip, provider outage, etc. at creation time). This is NOT a tracking
  // poll — it doesn't ask for status updates, it just makes sure every
  // eligible shipment eventually gets registered with a provider so THEY can
  // push updates to routes/webhooks.js. Once registered, a shipment never
  // needs this worker again. ───────────────────────────────────────────────
  cron.schedule('*/15 * * * *', async () => {
    try {
      const pending = await db.all(`
        SELECT id, ge_tracking_number FROM shipments
        WHERE auto_tracking_enabled = 1
          AND carrier_tracking_number IS NOT NULL
          AND tracking_registered = 0
          AND (tracking_status IS NULL OR tracking_status != 'Delivered')
        LIMIT 100
      `);

      let registered = 0;
      for (const s of pending) {
        const result = await registerForTracking(s.id);
        if (result.success) registered++;
      }
      if (pending.length) logger.info(`[Worker:RegistrationRetry] ${registered}/${pending.length} shipment(s) registered`);
    } catch (err) {
      logger.error('[Worker:RegistrationRetry] failed', { error: err.message });
      await notifyITError('Tracking registration retry worker failed', err.message).catch(() => {});
    }
  });

  // ── Tracking Catch-Up Worker — every 30 min, pulls current results for
  // registered shipments that haven't received an update in a while. This
  // exists because webhooks can only reach a PUBLICLY reachable URL —
  // TrackingMore/17Track's servers cannot push to localhost during local
  // development, and even in production the webhook URL has to actually be
  // pasted into both providers' dashboards (Settings page shows the exact
  // URLs) before pushes start arriving at all. Until that's done — or as a
  // safety net for any missed push — this worker keeps things moving by
  // pulling instead of waiting. It stops re-checking a shipment once it's
  // Delivered. This is deliberately NOT the old cycle/interval system: it
  // doesn't run on a fixed schedule per shipment, has no admin-facing
  // toggle, and its only job is to backfill what a webhook would have
  // delivered if it could reach this server. ────────────────────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const stale = await db.all(`
        SELECT ge_tracking_number, last_tracking_update FROM shipments
        WHERE tracking_registered = 1
          AND carrier_tracking_number IS NOT NULL
          AND (tracking_status IS NULL OR tracking_status != 'Delivered')
          AND (last_tracking_update IS NULL OR datetime(last_tracking_update) <= datetime('now', '-25 minutes'))
        LIMIT 100
      `);

      let updated = 0;
      for (const s of stale) {
        const result = await manualRefresh(s.ge_tracking_number);
        if (result.success) updated++;
      }
      if (stale.length) logger.info(`[Worker:TrackingCatchUp] checked ${stale.length}, updated ${updated}`);
    } catch (err) {
      logger.error('[Worker:TrackingCatchUp] failed', { error: err.message });
      await notifyITError('Tracking catch-up worker failed', err.message).catch(() => {});
    }
  });

  // ── Lag Status Worker — once daily at 06:00 server time. Flags shipments
  // whose status hasn't changed in system_settings.lag_status_days (default
  // 7) and aren't Delivered, then emails/WhatsApps a report to the
  // configured notify_email_recipients / notify_whatsapp_recipients. ───────
  cron.schedule('0 6 * * *', async () => {
    try {
      const lagDays = parseInt(await getSetting('lag_status_days', '7'), 10) || 7;
      const lagged = await db.all(`
        SELECT ge_tracking_number, tracking_status, to_name, to_country,
               COALESCE(last_status_change_at, created_at) AS since
        FROM shipments
        WHERE (tracking_status IS NULL OR tracking_status != 'Delivered')
          AND archived = 0
          AND datetime(COALESCE(last_status_change_at, created_at)) <= datetime('now', ?)
        ORDER BY since ASC
        LIMIT 500
      `, [`-${lagDays} days`]);

      if (lagged.length) {
        const lines = lagged.slice(0, 50).map(s =>
          `${s.ge_tracking_number} — stuck at "${s.tracking_status || 'Information Received'}" since ${String(s.since).slice(0,10)} (${s.to_name || 'unknown recipient'}, ${s.to_country || ''})`
        );
        const subject = `Lag Status Report — ${lagged.length} shipment(s) stuck ${lagDays}+ days`;
        const body = `The following shipments have shown no status change in ${lagDays}+ days and are not yet Delivered:\n\n${lines.join('\n')}` +
          (lagged.length > 50 ? `\n\n…and ${lagged.length - 50} more.` : '');
        await notifySystemRecipients({ event: 'lag_status_report', subject, body });
        logger.info(`[Worker:LagStatus] reported ${lagged.length} lagging shipment(s)`);
      }
    } catch (err) {
      logger.error('[Worker:LagStatus] failed', { error: err.message });
      await notifyITError('Lag Status worker failed', err.message).catch(() => {});
    }
  });

  // ── Retention Warning Worker — once daily at 07:00. Warns
  // retention_warning_days (default 30) before a Delivered shipment would be
  // backed up + purged, so an admin sees it coming rather than being
  // surprised. Fires the email/WhatsApp report once, and leaves a flag for
  // the Settings page to show an in-app popup on next visit. ───────────────
  cron.schedule('0 7 * * *', async () => {
    try {
      const retentionMonths = parseInt(await getSetting('retention_months', '6'), 10) || 6;
      const warningDays = parseInt(await getSetting('retention_warning_days', '30'), 10) || 30;

      // Dynamic "+N months"/"+N days" date math is written per-dialect: SQLite's
      // date('now', '+' || ? || ' days') string-modifier style has no direct
      // Postgres equivalent, so Postgres gets its own interval-arithmetic query.
      const upcomingSql = db.isPg
        ? `
          SELECT ge_tracking_number, delivered_at FROM shipments
          WHERE archived = 0 AND delivered_at IS NOT NULL
            AND (delivered_at::date + (?::text || ' months')::interval) <= (CURRENT_DATE + (?::text || ' days')::interval)
            AND (delivered_at::date + (?::text || ' months')::interval) > CURRENT_DATE
        `
        : `
          SELECT ge_tracking_number, delivered_at FROM shipments
          WHERE archived = 0 AND delivered_at IS NOT NULL
            AND date(delivered_at, '+' || ? || ' months') <= date('now', '+' || ? || ' days')
            AND date(delivered_at, '+' || ? || ' months') > date('now')
        `;
      const upcoming = await db.all(upcomingSql, [retentionMonths, warningDays, retentionMonths]);

      if (upcoming.length) {
        await setSetting('_retention_warning_count', String(upcoming.length));
        await setSetting('_retention_warning_sample', JSON.stringify(upcoming.slice(0, 20).map(s => s.ge_tracking_number)));
        await setSetting('_retention_warning_at', new Date().toISOString());

        const subject = `Backup warning: ${upcoming.length} shipment(s) reach the ${retentionMonths}-month retention limit within ${warningDays} days`;
        const body = `These delivered shipments will be backed up and removed from the live system within the next ${warningDays} days, per your ${retentionMonths}-month retention setting:\n\n` +
          upcoming.slice(0, 50).map(s => `${s.ge_tracking_number} — delivered ${String(s.delivered_at).slice(0,10)}`).join('\n');
        await notifySystemRecipients({ event: 'retention_warning', subject, body });
        logger.info(`[Worker:RetentionWarning] warned about ${upcoming.length} shipment(s)`);
      }
    } catch (err) {
      logger.error('[Worker:RetentionWarning] failed', { error: err.message });
      await notifyITError('Retention warning worker failed', err.message).catch(() => {});
    }
  });

  // ── Retention & Backup Worker — once daily at 02:00. Only Delivered
  // shipments age out; anything not yet delivered stays in the live system
  // indefinitely regardless of age, per the requirement. Each shipment is
  // written to a JSON backup file BEFORE being removed from the live table. ──
  cron.schedule('0 2 * * *', async () => {
    try {
      const retentionMonths = parseInt(await getSetting('retention_months', '6'), 10) || 6;
      const dueSql = db.isPg
        ? `
          SELECT * FROM shipments
          WHERE archived = 0 AND delivered_at IS NOT NULL
            AND (delivered_at::date + (?::text || ' months')::interval) <= CURRENT_DATE
        `
        : `
          SELECT * FROM shipments
          WHERE archived = 0 AND delivered_at IS NOT NULL
            AND date(delivered_at, '+' || ? || ' months') <= date('now')
        `;
      const due = await db.all(dueSql, [retentionMonths]);

      if (!due.length) return;

      const backupDir = path.join(__dirname, '../backups', new Date().toISOString().slice(0, 7)); // backend/backups/YYYY-MM/
      if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

      let purged = 0;
      for (const shipment of due) {
        try {
          const backupPath = path.join(backupDir, `${shipment.ge_tracking_number}.json`);
          const events = await db.all('SELECT * FROM tracking_events WHERE shipment_id = ?', [shipment.id]);
          fs.writeFileSync(backupPath, JSON.stringify({ shipment, trackingEvents: events }, null, 2));

          await db.run(`
            INSERT INTO shipment_backups (ge_tracking_number, backup_path, delivered_at) VALUES (?, ?, ?)
          `, [shipment.ge_tracking_number, backupPath, shipment.delivered_at]);

          // bulk_upload_records.shipment_id has no ON DELETE CASCADE — detach
          // it first so the FK constraint (foreign_keys=ON) doesn't block
          // the delete below.
          await db.run('UPDATE bulk_upload_records SET shipment_id = NULL WHERE shipment_id = ?', [shipment.id]);
          await db.run('DELETE FROM shipments WHERE id = ?', [shipment.id]); // cascades tracking_events, shipment_documents
          purged++;
        } catch (err) {
          logger.error('[Worker:RetentionBackup] failed for one shipment', { ge: shipment.ge_tracking_number, error: err.message });
        }
      }
      if (purged) logger.info(`[Worker:RetentionBackup] backed up + purged ${purged} shipment(s) past ${retentionMonths}-month retention`);
    } catch (err) {
      logger.error('[Worker:RetentionBackup] failed', { error: err.message });
      await notifyITError('Retention/backup worker failed', err.message).catch(() => {});
    }
  });

  // ── Notification Worker — every 2 min, flushes the queue. ───────────────────
  cron.schedule('*/2 * * * *', async () => {
    try {
      const n = await processQueue(50);
      if (n) logger.info(`[Worker:Notifications] processed ${n} queued notification(s)`);
    } catch (err) {
      logger.error('[Worker:Notifications] failed', { error: err.message });
    }
  });

  // ── Audit Retention Worker — once daily at 03:00, purges audit_log rows
  // older than system_settings.audit_retention_days (default 365). ───────────
  cron.schedule('0 3 * * *', async () => {
    try {
      const days = parseInt(await getSetting('audit_retention_days', '365'), 10);
      const info = await db.run(`DELETE FROM audit_log WHERE created_at < datetime('now', ?)`, [`-${days} days`]);
      if (info.changes) logger.info(`[Worker:AuditRetention] purged ${info.changes} row(s) older than ${days} days`);
    } catch (err) {
      logger.error('[Worker:AuditRetention] failed', { error: err.message });
    }
  });

  // ── Stale Cache Cleanup — every 6h (carried over from v1.0). ─────────────────
  cron.schedule('0 */6 * * *', async () => {
    try {
      const info = await db.run(`DELETE FROM tracking_cache WHERE fetched_at < datetime('now', '-6 hours')`);
      if (info.changes) logger.info(`[Worker:CacheCleanup] cleared ${info.changes} stale cache row(s)`);
    } catch (err) {
      logger.error('[Worker:CacheCleanup] failed', { error: err.message });
    }
  });

  logger.info('✅ Background workers started (tracking registration retry, tracking catch-up, lag status, retention/backup, notifications, audit retention, cache cleanup)');
}

module.exports = { startWorkers };
