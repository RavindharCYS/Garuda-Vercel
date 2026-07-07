// utils/initDb.js — Garuda Express V2.0 schema, migrations & seed data
// Implements all tables from the Requirement Specification (§1–§12):
// users, roles, permissions, audit_log (audit_logs view), shipments,
// tracking_events, carriers, carrier_configs, bulk_upload_jobs,
// bulk_upload_records, notifications, password_resets, login_sessions,
// shipment_documents, system_settings, api_logs.
'use strict';

const Database = require('better-sqlite3');
const path      = require('path');
const fs        = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { hashPassword } = require('./password');

const DB_DIR  = path.join(__dirname, '../db');
const DB_PATH = path.join(DB_DIR, 'garuda.db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/** Idempotently add a column to an existing table (SQLite has no IF NOT EXISTS for ALTER). */
function addColumn(table, columnDef) {
  const colName = columnDef.trim().split(/\s+/)[0];
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!existing.some(c => c.name === colName)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
    console.log(`  ↳ migrated: ${table}.${colName}`);
  }
}

console.log('🔧 Initializing Garuda Express V2.0 schema...');

// ──────────────────────────────────────────────────────────────────────────
// 1. CORE TABLES (created fresh if missing)
// ──────────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE,
    password    TEXT NOT NULL,
    role        TEXT NOT NULL CHECK(role IN ('admin','employee')),
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    is_active   INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS shipments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ge_tracking_number  TEXT UNIQUE,
    carrier             TEXT,
    carrier_tracking_number TEXT,
    from_name           TEXT,
    from_address        TEXT,
    from_city           TEXT,
    from_state          TEXT,
    from_country        TEXT,
    from_postal         TEXT,
    from_contact        TEXT,
    to_name             TEXT,
    to_address           TEXT,
    to_city             TEXT,
    to_state            TEXT,
    to_country          TEXT,
    to_postal           TEXT,
    to_contact          TEXT,
    pieces              INTEGER DEFAULT 1,
    actual_weight       REAL,
    billing_weight      REAL,
    weight_unit         TEXT DEFAULT 'kg',
    dimensions          TEXT,
    contents            TEXT,
    ship_date           TEXT,
    service_type        TEXT,
    special_instructions TEXT,
    declared_value      REAL,
    currency            TEXT DEFAULT 'INR',
    invoice_number      TEXT,
    original_waybill_file TEXT,
    ocr_raw_text        TEXT,
    ocr_confidence      REAL,
    status              TEXT DEFAULT 'Processing',
    garuda_waybill_generated INTEGER DEFAULT 0,
    created_by          INTEGER REFERENCES users(id),
    updated_by          INTEGER REFERENCES users(id),
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tracking_cache (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ge_tracking_number  TEXT NOT NULL,
    raw_response        TEXT,
    normalized          TEXT,
    provider            TEXT,
    fetched_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    action      TEXT NOT NULL,
    entity      TEXT,
    entity_id   INTEGER,
    details     TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_shipments_ge   ON shipments(ge_tracking_number);
  CREATE INDEX IF NOT EXISTS idx_shipments_ctn  ON shipments(carrier_tracking_number);
  CREATE INDEX IF NOT EXISTS idx_shipments_date ON shipments(ship_date);
`);

// ──────────────────────────────────────────────────────────────────────────
// 2. MIGRATIONS — extend existing tables for V2.0 (§1 Auth, §2 Users, §6 Shipments)
// ──────────────────────────────────────────────────────────────────────────

// users — §1 Security Improvements + §2 User Management
addColumn('users', "employee_id TEXT");
addColumn('users', "email TEXT");
addColumn('users', "phone TEXT");
addColumn('users', "branch TEXT");
addColumn('users', "status TEXT DEFAULT 'Active'"); // Active | Inactive | Locked
addColumn('users', "must_change_password INTEGER DEFAULT 0");
addColumn('users', "password_changed_at TEXT DEFAULT (datetime('now'))");
addColumn('users', "failed_login_attempts INTEGER DEFAULT 0");
addColumn('users', "locked_until TEXT");
addColumn('users', "mfa_enabled INTEGER DEFAULT 0");
addColumn('users', "mfa_secret TEXT");
addColumn('users', "last_login_at TEXT");
addColumn('users', "last_login_ip TEXT");
addColumn('users', "created_by INTEGER REFERENCES users(id)");

// audit_log — §3 Audit Logging System (full field set incl. role/IP/device/old/new/status)
addColumn('audit_log', "username TEXT");
addColumn('audit_log', "role TEXT");
addColumn('audit_log', "ip_address TEXT");
addColumn('audit_log', "device TEXT");
addColumn('audit_log', "old_value TEXT");
addColumn('audit_log', "new_value TEXT");
addColumn('audit_log', "status TEXT DEFAULT 'success'");

// shipments — §6 Shipment Data Model Redesign
addColumn('shipments', "awb_number TEXT");
addColumn('shipments', "reference_number TEXT");
addColumn('shipments', "booking_date TEXT");
addColumn('shipments', "pickup_date TEXT");
addColumn('shipments', "shipment_type TEXT");      // 'Document' | 'Non-Document'
addColumn('shipments', "length REAL");
addColumn('shipments', "width REAL");
addColumn('shipments', "height REAL");
addColumn('shipments', "carrier_id INTEGER REFERENCES carriers(id)");
addColumn('shipments', "tracking_status TEXT");     // carrier-reported live state (distinct from internal `status`)
addColumn('shipments', "last_tracking_update TEXT");
addColumn('shipments', "needs_manual_tracking INTEGER DEFAULT 0");

// shipments — Garuda Master Waybill support (sender/receiver company,
// customs/carriage value, routing codes, billing, carrier-specific extras).
// NOTE: package length/width/height are intentionally NOT duplicated here —
// the existing `length`/`width`/`height` columns above already serve that
// purpose; the application-layer field name `package_length` etc. (see
// services/waybillFieldSchema.js) maps onto these same columns in
// routes/shipments.js so there's only one source of truth in the DB.
addColumn('shipments', "sender_company TEXT");
addColumn('shipments', "receiver_company TEXT");
addColumn('shipments', "receiver_attention TEXT");
addColumn('shipments', "origin_code TEXT");
addColumn('shipments', "destination_code TEXT");
addColumn('shipments', "route_code TEXT");
addColumn('shipments', "service_code TEXT");
addColumn('shipments', "customs_value REAL");
addColumn('shipments', "carriage_value REAL");
addColumn('shipments', "billing_type TEXT");
addColumn('shipments', "account_number TEXT");
addColumn('shipments', "carrier_specific TEXT");  // JSON-encoded, see waybillFieldSchema.js

// shipments — Excel Vendor Import: `vendor` (ICL / World First — who supplied
// the shipment data) is deliberately separate from `carrier` (the actual
// courier, e.g. UPS/DHL/BlueDart). Excel-imported shipments generally don't
// specify a real carrier, so this keeps that distinction correct instead of
// overloading the carrier column with the vendor name.
addColumn('shipments', "vendor TEXT");

// Carrier detection — `carrier` (added earlier) holds the human-readable
// name (e.g. "FedEx") for admin display. These two hold the EXACT courier
// code the registering provider assigned, so future actions (manual
// refresh, webhook matching) use the exact code instead of re-guessing.
addColumn('shipments', "carrier_code TEXT");           // e.g. 'fedex' (TrackingMore) or '100003' (17Track)
addColumn('shipments', "carrier_code_provider TEXT");  // 'trackingmore' | '17track' — which one identified/registered it

// Register-once tracking model (replaces the old manual/auto + cycle +
// per-shipment interval polling system entirely): a shipment is registered
// with a provider ONE TIME at creation; from then on the provider tracks it
// on its own and pushes updates to routes/webhooks.js. No repeating job
// needed — tracking_interval_hours above is no longer read by anything.
addColumn('shipments', "tracking_registered INTEGER DEFAULT 0");
addColumn('shipments', "tracking_registered_at TEXT");
addColumn('shipments', "registration_error TEXT"); // the actual reason each provider rejected registration, shown on the shipment page instead of a generic message

// shipments — Auto Tracking (TrackingMore / 17Track). Per-shipment toggle +
// configurable sync interval, default 10 hours; the tracking sync worker
// (services/workers.js) only polls providers for shipments with
// auto_tracking_enabled = 1, respecting each shipment's own interval.
addColumn('shipments', "auto_tracking_enabled INTEGER DEFAULT 0");
// tracking_interval_hours: NULL/0 means "follow the global Tracking
// Timeframe cycles" (the new default — see system_settings.tracking_cycle_*
// below); a positive value is a per-shipment CUSTOM override in hours that
// ignores the global cycle schedule entirely. The actual default is applied
// in application code (routes/shipments.js, services/excelImport), not by
// this column's SQL-level DEFAULT, since every insert/update always passes
// an explicit value.
addColumn('shipments', "tracking_interval_hours INTEGER DEFAULT 10");

// Retention & backup (requirement: 6-month default retention for DELIVERED
// shipments only; anything not yet delivered is kept indefinitely).
addColumn('shipments', "delivered_at TEXT");           // set once, the first time tracking_status becomes 'Delivered'
addColumn('shipments', "archived INTEGER DEFAULT 0");  // 1 once backed up + removed by the retention worker

// Lag Status (requirement: flag shipments whose status hasn't moved in N
// days and aren't Delivered). Updated only when tracking_status actually
// changes value — see services/trackingService.js#recordTrackingEvents.
addColumn('shipments', "last_status_change_at TEXT");

// ──────────────────────────────────────────────────────────────────────────
// 3. NEW TABLES — RBAC, Carriers, Tracking, Bulk Upload, Notifications, Settings
// ──────────────────────────────────────────────────────────────────────────
db.exec(`
  -- §1 RBAC ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS permissions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    description TEXT
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
  );

  -- §1 Sessions / refresh tokens ----------------------------------------------
  CREATE TABLE IF NOT EXISTS login_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    ip_address        TEXT,
    device            TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at        TEXT NOT NULL,
    last_used_at      TEXT,
    revoked           INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON login_sessions(user_id);

  -- §2 Password resets ---------------------------------------------------------
  CREATE TABLE IF NOT EXISTS password_resets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    initiated_by    INTEGER REFERENCES users(id),
    temp_password_hash TEXT,
    must_change     INTEGER DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    used_at         TEXT
  );

  -- §4 Carrier Management --------------------------------------------------------
  CREATE TABLE IF NOT EXISTS carriers (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT NOT NULL UNIQUE,
    code              TEXT NOT NULL UNIQUE,
    tracking_provider TEXT DEFAULT 'trackingmore',  -- trackingmore | 17track | manual
    status            TEXT DEFAULT 'Active',        -- Active | Inactive
    api_type          TEXT DEFAULT 'api',           -- api | manual
    priority          INTEGER DEFAULT 100,
    region            TEXT DEFAULT 'International', -- International | India
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS carrier_configs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    carrier_id  INTEGER NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
    config_key  TEXT NOT NULL,
    config_value TEXT,
    UNIQUE(carrier_id, config_key)
  );

  -- §5/§9 Tracking events & API health -------------------------------------------
  CREATE TABLE IF NOT EXISTS tracking_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id     INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
    ge_tracking_number TEXT,
    event_timestamp TEXT,
    status          TEXT,
    location        TEXT,
    provider        TEXT,
    raw             TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_tracking_events_ge ON tracking_events(ge_tracking_number);

  CREATE TABLE IF NOT EXISTS api_logs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    provider      TEXT NOT NULL,     -- trackingmore | 17track | google_vision | tesseract | smtp | whatsapp
    endpoint      TEXT,
    success       INTEGER NOT NULL,
    status_code   INTEGER,
    response_ms   INTEGER,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_api_logs_provider ON api_logs(provider, created_at);

  -- §8 Bulk Upload ----------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS bulk_upload_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uploaded_by     INTEGER REFERENCES users(id),
    file_name       TEXT,
    file_type       TEXT,           -- csv | excel | zip | pdf
    total_records   INTEGER DEFAULT 0,
    success_count   INTEGER DEFAULT 0,
    failed_count    INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'Queued', -- Queued|Processing|Validated|Imported|Failed
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS bulk_upload_records (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id              INTEGER NOT NULL REFERENCES bulk_upload_jobs(id) ON DELETE CASCADE,
    row_number          INTEGER,
    raw_data            TEXT,
    detected_carrier    TEXT,
    validation_status   TEXT DEFAULT 'Pending', -- Pending|Valid|Invalid|Imported
    validation_errors   TEXT,
    validation_warnings TEXT,
    shipment_id         INTEGER REFERENCES shipments(id),
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bulk_records_job ON bulk_upload_records(job_id);

  -- §6 Shipment documents -----------------------------------------------------------
  CREATE TABLE IF NOT EXISTS shipment_documents (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
    file_name   TEXT,
    file_path   TEXT,
    file_type   TEXT,
    uploaded_by INTEGER REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- §11 Notifications ------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER REFERENCES users(id),
    channel     TEXT NOT NULL,     -- email | whatsapp
    event       TEXT NOT NULL,     -- shipment_delivered | exception_detected | bulk_upload_completed | password_reset
    recipient   TEXT,
    subject     TEXT,
    body        TEXT,
    status      TEXT DEFAULT 'Queued', -- Queued|Sent|Failed
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at     TEXT
  );

  -- Retention & Backup log — one row per shipment backed up + purged by the
  -- retention worker once it passes retention_months past delivery. Actual
  -- backup content is a JSON file on disk (backend/backups/), this table is
  -- just the index of what was backed up and where.
  CREATE TABLE IF NOT EXISTS shipment_backups (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    ge_tracking_number TEXT NOT NULL,
    backup_path        TEXT NOT NULL,
    delivered_at       TEXT,
    backed_up_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- §12 System settings -----------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS system_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by  INTEGER REFERENCES users(id)
  );
`);

// audit_logs — spec names the table in plural; expose as a view over audit_log
// so naming matches the requirement doc without disrupting existing route code.
db.exec(`DROP VIEW IF EXISTS audit_logs;`);
db.exec(`
  CREATE VIEW audit_logs AS
  SELECT id, created_at AS timestamp, user_id, username, role, action, entity, entity_id,
         ip_address, device, old_value, new_value, status, details
  FROM audit_log;
`);

// ──────────────────────────────────────────────────────────────────────────
// 4. SEED — RBAC roles & permissions (§1)
// ──────────────────────────────────────────────────────────────────────────
const PERMISSIONS = [
  ['shipments.create',        'Create shipments'],
  ['shipments.read.all',      'View all shipments'],
  ['shipments.read.own',      'View own shipments only'],
  ['shipments.update',        'Update shipments'],
  ['shipments.delete',        'Delete shipments'],
  ['bulk_upload.create',      'Upload bulk shipment batches'],
  ['bulk_upload.edit_own',    'Edit own bulk-uploaded records'],
  ['bulk_upload.view_all',    'View all bulk upload jobs'],
  ['users.manage',            'Create/edit/deactivate users'],
  ['carriers.manage',         'Manage carrier configuration'],
  ['settings.manage',         'Manage system settings'],
  ['audit.view',              'View audit logs'],
  ['audit.export',            'Export audit logs'],
  ['notifications.manage',    'Manage notification queue/config'],
];

const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (code, description) VALUES (?,?)');
PERMISSIONS.forEach(([code, desc]) => insertPerm.run(code, desc));

const insertRole = db.prepare('INSERT OR IGNORE INTO roles (name, description) VALUES (?,?)');
insertRole.run('admin', 'Full system access');
insertRole.run('employee', 'Upload-only, scoped to own shipments');

function grant(roleName, permCodes) {
  const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName);
  const linkStmt = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)');
  for (const code of permCodes) {
    const perm = db.prepare('SELECT id FROM permissions WHERE code = ?').get(code);
    if (perm) linkStmt.run(role.id, perm.id);
  }
}
grant('admin', PERMISSIONS.map(p => p[0])); // admin gets everything
grant('employee', ['shipments.create', 'shipments.read.own', 'bulk_upload.create', 'bulk_upload.edit_own']);

// ──────────────────────────────────────────────────────────────────────────
// 5. SEED — Carriers (§4) — full international + India list from spec
// ──────────────────────────────────────────────────────────────────────────
const INTL_CARRIERS = ['UPS','FedEx','DHL','Aramex','TNT','DPD','GLS','USPS','Canada Post','Royal Mail','Australia Post','Singapore Post','EMS','Yanwen','SF Express','China Post'];
const INDIA_CARRIERS = ['Blue Dart','Delhivery','DTDC','Professional Couriers','Xpressbees','Ecom Express','India Post','Shadowfax','Trackon','Ekart','Gati','TCI Express','Safexpress'];

const insertCarrier = db.prepare(`
  INSERT OR IGNORE INTO carriers (name, code, tracking_provider, status, api_type, priority, region)
  VALUES (?,?,?,?,?,?,?)
`);
let priority = 1;
for (const name of INTL_CARRIERS) {
  const code = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
  insertCarrier.run(name, code, 'trackingmore', 'Active', 'api', priority++, 'International');
}
for (const name of INDIA_CARRIERS) {
  const code = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
  insertCarrier.run(name, code, 'trackingmore', 'Active', 'api', priority++, 'India');
}

// ──────────────────────────────────────────────────────────────────────────
// 6. SEED — Default accounts (§1 spec credentials)
//    Admin Portal:    GarudaAdmin / ExploitEye@2026
//    Employee Portal: Garuda      / Garuda@2026
//    Overridable via .env — STRONGLY recommended to change after first boot.
// ──────────────────────────────────────────────────────────────────────────
const seedingComplete = (async () => {
  const adminUsername = process.env.ADMIN_USERNAME || 'GarudaAdmin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ExploitEye@2026';
  const empUsername    = process.env.EMPLOYEE_USERNAME || 'Garuda';
  const empPassword    = process.env.EMPLOYEE_PASSWORD || 'Garuda@2026';

  const adminUser = db.prepare('SELECT id FROM users WHERE username = ?').get(adminUsername);
  if (!adminUser) {
    const hashed = await hashPassword(adminPassword);
    db.prepare(`
      INSERT INTO users (username, password, role, name, employee_id, email, status, password_changed_at)
      VALUES (?, ?, 'admin', 'System Administrator', 'EMP-0001', ?, 'Active', datetime('now'))
    `).run(adminUsername, hashed, process.env.ADMIN_EMAIL || 'admin@garudaexpresscourier.com');
    console.log(`✅ Admin account created: ${adminUsername}`);
  }

  const empUser = db.prepare('SELECT id FROM users WHERE username = ?').get(empUsername);
  if (!empUser) {
    const hashed = await hashPassword(empPassword);
    db.prepare(`
      INSERT INTO users (username, password, role, name, employee_id, status, password_changed_at)
      VALUES (?, ?, 'employee', 'Staff Member', 'EMP-0002', 'Active', datetime('now'))
    `).run(empUsername, hashed);
    console.log(`✅ Employee account created: ${empUsername}`);
  }

  // Legacy v1.0 accounts (admin/employee1) — migrate if present so existing
  // installs don't lose access; harmless no-op on a fresh DB.
  const legacyAdmin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (legacyAdmin) console.log('ℹ️  Legacy "admin" account detected — still active. Consider migrating to GarudaAdmin.');

  // Seed default system settings
  const insertSetting = db.prepare('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?,?)');
  insertSetting.run('audit_retention_days', '365');
  insertSetting.run('session_timeout_minutes', String(process.env.SESSION_TIMEOUT_MINUTES || 30));
  insertSetting.run('password_expiry_days', String(process.env.PASSWORD_EXPIRY_DAYS || 90));
  insertSetting.run('ocr_engine_primary', process.env.OCR_ENGINE_PRIMARY || 'google_vision');
  insertSetting.run('ocr_gemini_enrichment', process.env.GEMINI_ENRICHMENT_ENABLED || '1');
  insertSetting.run('tracking_provider_primary', 'trackingmore');
  insertSetting.run('tracking_provider_fallback', '17track');
  insertSetting.run('notifications_email_enabled', process.env.SMTP_HOST ? '1' : '0');
  insertSetting.run('notifications_whatsapp_enabled', process.env.WHATSAPP_ENABLED || '0');

  // Tracking model: register-once + webhook (see services/trackingService.js).
  // There is no schedule to configure any more — a shipment is registered
  // with TrackingMore/17Track a single time at creation, and the provider
  // pushes updates to routes/webhooks.js from then on. The old Manual/Auto
  // toggle and Tracking Timeframe cycle settings have been removed entirely.

  // Data retention & backup. Only Delivered shipments age out; anything not
  // yet delivered is kept indefinitely regardless of how old it is.
  insertSetting.run('retention_months', '6');
  insertSetting.run('retention_warning_days', '30');

  // Lag Status: a shipment whose tracking status hasn't changed in this many
  // days (and isn't Delivered) gets flagged and included in the Lag Status report.
  insertSetting.run('lag_status_days', '7');

  // Notification recipients (Super Admin) — comma-separated email addresses /
  // phone numbers, separate from any individual user's own account contact
  // info, since these are for system-level reports (lag status, retention
  // warnings) rather than per-user shipment events.
  insertSetting.run('notify_email_recipients', '');
  insertSetting.run('notify_whatsapp_recipients', '');
  insertSetting.run('it_alert_email', ''); // app errors / worker failures get emailed here

  db.close();
  console.log('✅ Garuda Express V2.0 database initialised at', DB_PATH);
})();

// Exported so server.js (and any other caller) can await full initialization —
// including the async Argon2 account seeding above — before accepting
// requests. Fixes a startup race where a login could hit an empty users
// table in the brief window between process start and seeding completion.
module.exports = { ready: seedingComplete };