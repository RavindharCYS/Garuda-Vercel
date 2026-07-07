// services/notificationService.js — Notifications (requirement spec §11)
// Email is fully wired via nodemailer/SMTP. WhatsApp is "ready" — the Graph
// API call structure is in place but stays inert (logged only) until
// WHATSAPP_ENABLED=1 and the Graph API env vars are supplied, since most
// freelance/SMB clients won't have WhatsApp Business API access on day one.
'use strict';

const db     = require('../utils/db');
const logger = require('../utils/logger');
const { logApiCall } = require('./apiHealth');

let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { /* optional until npm install */ }

function getSetting(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch (_) { return fallback; }
}

function getTransport() {
  if (!nodemailer || !process.env.SMTP_HOST) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

// ── Event → template mapping ────────────────────────────────────────────────
const TEMPLATES = {
  shipment_delivered: (ctx) => ({
    subject: `Your shipment ${ctx.geNumber} has been delivered`,
    body: `Good news! Shipment ${ctx.geNumber} was delivered${ctx.location ? ` at ${ctx.location}` : ''} on ${ctx.deliveredAt || 'today'}.`,
  }),
  exception_detected: (ctx) => ({
    subject: `Action needed: shipment ${ctx.geNumber} has an exception`,
    body: `An exception was reported for shipment ${ctx.geNumber}: ${ctx.detail || 'please check the tracking page for details.'}`,
  }),
  bulk_upload_completed: (ctx) => ({
    subject: `Bulk upload complete — ${ctx.imported} imported, ${ctx.skipped} skipped`,
    body: `Your bulk upload job #${ctx.jobId} finished. ${ctx.imported} shipment(s) were imported successfully, ${ctx.skipped} were skipped (see the import queue for details).`,
  }),
  password_reset: (ctx) => ({
    subject: `Your Garuda Express password was reset`,
    body: `Your password was reset by an administrator. ${ctx.mustChange ? 'You will be asked to set a new password on next login.' : ''}`,
  }),
};

/**
 * Queue a notification for an event. Resolves recipient(s) from the user
 * record's email (and phone for WhatsApp), writes a `notifications` row,
 * and attempts immediate delivery (best-effort — failures stay `Queued`
 * with an error message for the Notification Worker to retry).
 */
async function queueNotification({ event, userId, context = {} }) {
  const template = TEMPLATES[event];
  if (!template) { logger.warn('Unknown notification event', { event }); return; }

  const user = userId ? db.prepare('SELECT email, phone, name FROM users WHERE id = ?').get(userId) : null;
  const { subject, body } = template(context);

  const emailEnabled = getSetting('notifications_email_enabled', '0') === '1';
  const whatsappEnabled = getSetting('notifications_whatsapp_enabled', '0') === '1';

  const results = [];
  if (emailEnabled && user?.email) {
    results.push(await sendAndRecord({ userId, channel: 'email', event, recipient: user.email, subject, body }));
  }
  if (whatsappEnabled && user?.phone) {
    results.push(await sendAndRecord({ userId, channel: 'whatsapp', event, recipient: user.phone, subject, body }));
  }
  if (!results.length) {
    // Still log it as queued for audit visibility even if no channel is configured/enabled.
    db.prepare(`
      INSERT INTO notifications (user_id, channel, event, recipient, subject, body, status, error)
      VALUES (?, 'email', ?, ?, ?, ?, 'Queued', 'No enabled channel or recipient contact on file')
    `).run(userId, event, user?.email || null, subject, body);
  }
  return results;
}

async function sendAndRecord({ userId, channel, event, recipient, subject, body }) {
  const insert = db.prepare(`
    INSERT INTO notifications (user_id, channel, event, recipient, subject, body, status)
    VALUES (?,?,?,?,?,?, 'Queued')
  `);
  const info = insert.run(userId, channel, event, recipient, subject, body);
  const notifId = info.lastInsertRowid;

  try {
    if (channel === 'email') await sendEmail(recipient, subject, body);
    else if (channel === 'whatsapp') await sendWhatsApp(recipient, body);

    db.prepare("UPDATE notifications SET status='Sent', sent_at=datetime('now') WHERE id=?").run(notifId);
    return { id: notifId, status: 'Sent' };
  } catch (err) {
    db.prepare("UPDATE notifications SET status='Failed', error=? WHERE id=?").run(err.message, notifId);
    logger.error('Notification send failed', { channel, recipient, error: err.message });
    return { id: notifId, status: 'Failed', error: err.message };
  }
}

async function sendEmail(to, subject, text) {
  const transport = getTransport();
  if (!transport) throw new Error('SMTP not configured');
  const start = Date.now();
  try {
    await transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    logApiCall({ provider: 'smtp', endpoint: 'sendMail', success: true, responseMs: Date.now() - start });
  } catch (err) {
    logApiCall({ provider: 'smtp', endpoint: 'sendMail', success: false, responseMs: Date.now() - start, error: err.message });
    throw err;
  }
}

/**
 * WhatsApp-ready: real Graph API call structure, gated behind WHATSAPP_ENABLED.
 * When disabled (default), this just logs — no network call, no crash, no
 * cost — so a client without WhatsApp Business API access still gets a
 * fully working app out of the box (matches spec §11's "ready" language).
 */
async function sendWhatsApp(toPhone, message) {
  if (process.env.WHATSAPP_ENABLED !== '1') {
    logger.info('[WhatsApp:stub] would send', { toPhone, message });
    return;
  }
  const axios = require('axios');
  const start = Date.now();
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: toPhone, type: 'text', text: { body: message } },
      { headers: { Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}` }, timeout: 10000 }
    );
    logApiCall({ provider: 'whatsapp', endpoint: 'messages', success: true, responseMs: Date.now() - start });
  } catch (err) {
    logApiCall({ provider: 'whatsapp', endpoint: 'messages', success: false, responseMs: Date.now() - start, error: err.message });
    throw err;
  }
}

/** Retry all Queued/Failed notifications — used by the Notification Worker cron. */
async function processQueue(limit = 50) {
  const pending = db.prepare("SELECT * FROM notifications WHERE status IN ('Queued','Failed') ORDER BY created_at LIMIT ?").all(limit);
  for (const n of pending) {
    try {
      if (n.channel === 'email') await sendEmail(n.recipient, n.subject, n.body);
      else if (n.channel === 'whatsapp') await sendWhatsApp(n.recipient, n.body);
      db.prepare("UPDATE notifications SET status='Sent', sent_at=datetime('now') WHERE id=?").run(n.id);
    } catch (err) {
      db.prepare("UPDATE notifications SET status='Failed', error=? WHERE id=?").run(err.message, n.id);
    }
  }
  return pending.length;
}

/**
 * System-level notifications (Lag Status reports, retention warnings) that
 * aren't tied to any one user's account — recipients come straight from the
 * Settings page's notify_email_recipients / notify_whatsapp_recipients
 * (comma-separated), not a user row's email/phone.
 */
async function notifySystemRecipients({ event, subject, body }) {
  const emailEnabled = getSetting('notifications_email_enabled', '0') === '1';
  const whatsappEnabled = getSetting('notifications_whatsapp_enabled', '0') === '1';
  const emailRecipients = getSetting('notify_email_recipients', '').split(',').map(s => s.trim()).filter(Boolean);
  const whatsappRecipients = getSetting('notify_whatsapp_recipients', '').split(',').map(s => s.trim()).filter(Boolean);

  const results = [];
  if (emailEnabled) {
    for (const to of emailRecipients) results.push(await sendAndRecord({ userId: null, channel: 'email', event, recipient: to, subject, body }));
  }
  if (whatsappEnabled) {
    for (const to of whatsappRecipients) results.push(await sendAndRecord({ userId: null, channel: 'whatsapp', event, recipient: to, subject, body }));
  }
  if (!results.length) {
    db.prepare(`
      INSERT INTO notifications (user_id, channel, event, recipient, subject, body, status, error)
      VALUES (NULL, 'email', ?, NULL, ?, ?, 'Queued', 'No enabled channel or recipients configured in Settings')
    `).run(event, subject, body);
  }
  return results;
}

/**
 * Application-error alert straight to the IT mailbox configured on the
 * Settings page (it_alert_email) — independent of notifications_email_enabled,
 * since IT should hear about outages even if end-user notifications are off.
 */
async function notifyITError(subject, detail) {
  const itEmail = getSetting('it_alert_email', '');
  if (!itEmail) return; // not configured — nothing to do
  const body = `An application error was detected in Garuda Express:\n\n${subject}\n\n${detail || ''}\n\nTime: ${new Date().toISOString()}`;
  try {
    await sendAndRecord({ userId: null, channel: 'email', event: 'system_error', recipient: itEmail, subject: `[Garuda Express] ${subject}`, body });
  } catch (_) { /* best-effort — don't let alerting itself throw */ }
}

module.exports = { queueNotification, notifySystemRecipients, notifyITError, processQueue, sendEmail, sendWhatsApp };