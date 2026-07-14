// utils/initDb.js — Garuda Express V2.0 schema, migrations & seed data
//
// Two independent code paths, chosen automatically by utils/db.js's dialect:
//   - SQLite (development): incremental CREATE TABLE + idempotent ADD COLUMN
//     migrations, preserved exactly as this project always worked, so an
//     existing dev db/garuda.db keeps working across pulls.
//   - Postgres (production): a single fresh, final-form schema (this is a
//     new production database every time — there's no legacy Postgres
//     install to migrate), using SERIAL ids and TIMESTAMPTZ for the columns
//     that are always system-generated (created_at/updated_at/etc). Columns
//     that hold free-form dates from OCR/user input/Excel imports (ship_date,
//     booking_date, pickup_date...) stay TEXT in both dialects, since those
//     values aren't always well-formed dates.
//
// Both paths seed the same RBAC roles/permissions, carrier list, and default
// admin/employee accounts, and both export `{ ready }` — a promise server.js
// awaits before accepting requests.
'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const db = require('./db');
const { hashPassword } = require('./password');

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

const INTL_CARRIERS = ['UPS','FedEx','DHL','Aramex','TNT','DPD','GLS','USPS','Canada Post','Royal Mail','Australia Post','Singapore Post','EMS','Yanwen','SF Express','China Post'];
const INDIA_CARRIERS = ['Blue Dart','Delhivery','DTDC','Professional Couriers','Xpressbees','Ecom Express','India Post','Shadowfax','Trackon','Ekart','Gati','TCI Express','Safexpress'];

/** Seed RBAC roles/permissions, the carrier list, default accounts, and default system_settings. Dialect-agnostic (uses the db.js query API). */
async function seedCommon() {
  for (const [code, desc] of PERMISSIONS) {
    await db.run('INSERT OR IGNORE INTO permissions (code, description) VALUES (?,?)', [code, desc]);
  }
  await db.run("INSERT OR IGNORE INTO roles (name, description) VALUES (?,?)", ['admin', 'Full system access']);
  await db.run("INSERT OR IGNORE INTO roles (name, description) VALUES (?,?)", ['employee', 'Upload-only, scoped to own shipments']);

  async function grant(roleName, permCodes) {
    const role = await db.get('SELECT id FROM roles WHERE name = ?', [roleName]);
    for (const code of permCodes) {
      const perm = await db.get('SELECT id FROM permissions WHERE code = ?', [code]);
      if (perm) await db.run('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?,?)', [role.id, perm.id]);
    }
  }
  await grant('admin', PERMISSIONS.map(p => p[0])); // admin gets everything
  await grant('employee', ['shipments.create', 'shipments.read.own', 'bulk_upload.create', 'bulk_upload.edit_own']);

  let priority = 1;
  for (const name of INTL_CARRIERS) {
    const code = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
    await db.run(`
      INSERT OR IGNORE INTO carriers (name, code, tracking_provider, status, api_type, priority, region)
      VALUES (?,?,?,?,?,?,?)
    `, [name, code, 'trackingmore', 'Active', 'api', priority++, 'International']);
  }
  for (const name of INDIA_CARRIERS) {
    const code = name.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 8);
    await db.run(`
      INSERT OR IGNORE INTO carriers (name, code, tracking_provider, status, api_type, priority, region)
      VALUES (?,?,?,?,?,?,?)
    `, [name, code, 'trackingmore', 'Active', 'api', priority++, 'India']);
  }

  // ── Default accounts (§1 spec credentials) ─────────────────────────────
  //    Admin Portal:    GarudaAdmin / ExploitEye@2026
  //    Employee Portal: Garuda      / Garuda@2026
  //    Overridable via .env — STRONGLY recommended to change after first boot.
  const adminUsername = process.env.ADMIN_USERNAME || 'GarudaAdmin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'ExploitEye@2026';
  const empUsername    = process.env.EMPLOYEE_USERNAME || 'Garuda';
  const empPassword    = process.env.EMPLOYEE_PASSWORD || 'Garuda@2026';

  const adminUser = await db.get('SELECT id FROM users WHERE username = ?', [adminUsername]);
  if (!adminUser) {
    const hashed = await hashPassword(adminPassword);
    await db.run(`
      INSERT INTO users (username, password, role, name, employee_id, email, status, password_changed_at)
      VALUES (?, ?, 'admin', 'System Administrator', 'EMP-0001', ?, 'Active', datetime('now'))
    `, [adminUsername, hashed, process.env.ADMIN_EMAIL || 'admin@garudaexpresscourier.com']);
    console.log(`✅ Admin account created: ${adminUsername}`);
  }

  const empUser = await db.get('SELECT id FROM users WHERE username = ?', [empUsername]);
  if (!empUser) {
    const hashed = await hashPassword(empPassword);
    await db.run(`
      INSERT INTO users (username, password, role, name, employee_id, status, password_changed_at)
      VALUES (?, ?, 'employee', 'Staff Member', 'EMP-0002', 'Active', datetime('now'))
    `, [empUsername, hashed]);
    console.log(`✅ Employee account created: ${empUsername}`);
  }

  // Legacy v1.0 account (admin) — migrate if present so existing installs
  // don't lose access; harmless no-op on a fresh DB.
  const legacyAdmin = await db.get('SELECT id FROM users WHERE username = ?', ['admin']);
  if (legacyAdmin) console.log('ℹ️  Legacy "admin" account detected — still active. Consider migrating to GarudaAdmin.');

  const insertSetting = async (key, value) => db.run('INSERT OR IGNORE INTO system_settings (key, value) VALUES (?,?)', [key, value]);
  await insertSetting('audit_retention_days', '365');
  await insertSetting('session_timeout_minutes', String(process.env.SESSION_TIMEOUT_MINUTES || 30));
  await insertSetting('password_expiry_days', String(process.env.PASSWORD_EXPIRY_DAYS || 90));
  await insertSetting('ocr_engine_primary', process.env.OCR_ENGINE_PRIMARY || 'google_vision');
  await insertSetting('ocr_gemini_enrichment', process.env.GEMINI_ENRICHMENT_ENABLED || '1');
  await insertSetting('tracking_provider_primary', 'trackingmore');
  await insertSetting('tracking_provider_fallback', '17track');
  await insertSetting('notifications_email_enabled', process.env.SMTP_HOST ? '1' : '0');
  await insertSetting('notifications_whatsapp_enabled', process.env.WHATSAPP_ENABLED || '0');
  await insertSetting('retention_months', '6');
  await insertSetting('retention_warning_days', '30');
  await insertSetting('lag_status_days', '7');
  await insertSetting('notify_email_recipients', '');
  await insertSetting('notify_whatsapp_recipients', '');
  await insertSetting('it_alert_email', '');
}

// ── SQLite (development) path — same incremental CREATE + ADD COLUMN
// migrations this project has always used. Uses better-sqlite3 directly
// (via db.raw) so PRAGMA table_info() works for the idempotent-ALTER check. ──
async function initSqlite() {
  const raw = db.raw;

  function addColumn(table, columnDef) {
    const colName = columnDef.trim().split(/\s+/)[0];
    const existing = raw.prepare(`PRAGMA table_info(${table})`).all();
    if (!existing.some(c => c.name === colName)) {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
      console.log(`  ↳ migrated: ${table}.${colName}`);
    }
  }

  console.log('🔧 Initializing Garuda Express V2.0 schema (SQLite/dev)...');

  raw.exec(`
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

  // users — §1 Security Improvements + §2 User Management
  addColumn('users', "employee_id TEXT");
  addColumn('users', "email TEXT");
  addColumn('users', "phone TEXT");
  addColumn('users', "branch TEXT");
  addColumn('users', "status TEXT DEFAULT 'Active'");
  addColumn('users', "must_change_password INTEGER DEFAULT 0");
  addColumn('users', "password_changed_at TEXT DEFAULT (datetime('now'))");
  addColumn('users', "failed_login_attempts INTEGER DEFAULT 0");
  addColumn('users', "locked_until TEXT");
  addColumn('users', "mfa_enabled INTEGER DEFAULT 0");
  addColumn('users', "mfa_secret TEXT");
  addColumn('users', "last_login_at TEXT");
  addColumn('users', "last_login_ip TEXT");
  addColumn('users', "created_by INTEGER REFERENCES users(id)");

  // audit_log — §3 Audit Logging System
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
  addColumn('shipments', "shipment_type TEXT");
  addColumn('shipments', "length REAL");
  addColumn('shipments', "width REAL");
  addColumn('shipments', "height REAL");
  addColumn('shipments', "carrier_id INTEGER REFERENCES carriers(id)");
  addColumn('shipments', "tracking_status TEXT");
  addColumn('shipments', "last_tracking_update TEXT");
  addColumn('shipments', "needs_manual_tracking INTEGER DEFAULT 0");
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
  addColumn('shipments', "carrier_specific TEXT");
  addColumn('shipments', "vendor TEXT");
  addColumn('shipments', "carrier_code TEXT");
  addColumn('shipments', "carrier_code_provider TEXT");
  addColumn('shipments', "tracking_registered INTEGER DEFAULT 0");
  addColumn('shipments', "tracking_registered_at TEXT");
  addColumn('shipments', "registration_error TEXT");
  addColumn('shipments', "auto_tracking_enabled INTEGER DEFAULT 0");
  addColumn('shipments', "tracking_interval_hours INTEGER DEFAULT 10");
  addColumn('shipments', "delivered_at TEXT");
  addColumn('shipments', "archived INTEGER DEFAULT 0");
  addColumn('shipments', "last_status_change_at TEXT");

  raw.exec(`
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

    CREATE TABLE IF NOT EXISTS password_resets (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      initiated_by    INTEGER REFERENCES users(id),
      temp_password_hash TEXT,
      must_change     INTEGER DEFAULT 1,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      used_at         TEXT
    );

    CREATE TABLE IF NOT EXISTS carriers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL UNIQUE,
      code              TEXT NOT NULL UNIQUE,
      tracking_provider TEXT DEFAULT 'trackingmore',
      status            TEXT DEFAULT 'Active',
      api_type          TEXT DEFAULT 'api',
      priority          INTEGER DEFAULT 100,
      region            TEXT DEFAULT 'International',
      created_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS carrier_configs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      carrier_id  INTEGER NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
      config_key  TEXT NOT NULL,
      config_value TEXT,
      UNIQUE(carrier_id, config_key)
    );

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

    -- One-time cleanup for databases that already accumulated duplicate rows
    -- (every webhook/sync-pending call used to unconditionally re-insert the
    -- shipment's whole event history — see services/trackingService.js —
    -- which is how some shipments ended up with 300+ rows for ~10 real
    -- events). Keeps the earliest row per distinct event, discards the rest.
    -- No-op once a database is already clean.
    DELETE FROM tracking_events
    WHERE id NOT IN (
      SELECT MIN(id) FROM tracking_events
      GROUP BY ge_tracking_number, event_timestamp, status, location
    );

    -- Going forward, recordTrackingEvents() in trackingService.js inserts
    -- with "INSERT OR IGNORE", which this constraint turns into a no-op on
    -- the exact same event instead of a duplicate row.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tracking_events_unique
      ON tracking_events(ge_tracking_number, event_timestamp, status, location);

    CREATE TABLE IF NOT EXISTS api_logs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      provider      TEXT NOT NULL,
      endpoint      TEXT,
      success       INTEGER NOT NULL,
      status_code   INTEGER,
      response_ms   INTEGER,
      error         TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_api_logs_provider ON api_logs(provider, created_at);

    CREATE TABLE IF NOT EXISTS bulk_upload_jobs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      uploaded_by     INTEGER REFERENCES users(id),
      file_name       TEXT,
      file_type       TEXT,
      total_records   INTEGER DEFAULT 0,
      success_count   INTEGER DEFAULT 0,
      failed_count    INTEGER DEFAULT 0,
      status          TEXT DEFAULT 'Queued',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at    TEXT
    );

    CREATE TABLE IF NOT EXISTS bulk_upload_records (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id              INTEGER NOT NULL REFERENCES bulk_upload_jobs(id) ON DELETE CASCADE,
      row_number          INTEGER,
      raw_data            TEXT,
      detected_carrier    TEXT,
      validation_status   TEXT DEFAULT 'Pending',
      validation_errors   TEXT,
      validation_warnings TEXT,
      shipment_id         INTEGER REFERENCES shipments(id),
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_records_job ON bulk_upload_records(job_id);

    CREATE TABLE IF NOT EXISTS shipment_documents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
      file_name   TEXT,
      file_path   TEXT,
      file_type   TEXT,
      uploaded_by INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER REFERENCES users(id),
      channel     TEXT NOT NULL,
      event       TEXT NOT NULL,
      recipient   TEXT,
      subject     TEXT,
      body        TEXT,
      status      TEXT DEFAULT 'Queued',
      error       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS shipment_backups (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      ge_tracking_number TEXT NOT NULL,
      backup_path        TEXT NOT NULL,
      delivered_at       TEXT,
      backed_up_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by  INTEGER REFERENCES users(id)
    );
  `);

  raw.exec(`DROP VIEW IF EXISTS audit_logs;`);
  raw.exec(`
    CREATE VIEW audit_logs AS
    SELECT id, created_at AS timestamp, user_id, username, role, action, entity, entity_id,
           ip_address, device, old_value, new_value, status, details
    FROM audit_log;
  `);

  await seedCommon();
  console.log('✅ Garuda Express V2.0 database initialised (SQLite/dev)');
}

// ── Postgres (production) path — final-form schema in one pass. ─────────────
async function initPostgres() {
  console.log('🔧 Initializing Garuda Express V2.0 schema (Postgres/production)...');

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                    SERIAL PRIMARY KEY,
      username              TEXT NOT NULL UNIQUE,
      password              TEXT NOT NULL,
      role                  TEXT NOT NULL CHECK(role IN ('admin','employee')),
      name                  TEXT NOT NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_active             INTEGER NOT NULL DEFAULT 1,
      employee_id           TEXT,
      email                 TEXT,
      phone                 TEXT,
      branch                TEXT,
      status                TEXT DEFAULT 'Active',
      must_change_password  INTEGER DEFAULT 0,
      password_changed_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      failed_login_attempts INTEGER DEFAULT 0,
      locked_until          TIMESTAMPTZ,
      mfa_enabled           INTEGER DEFAULT 0,
      mfa_secret            TEXT,
      last_login_at         TIMESTAMPTZ,
      last_login_ip         TEXT,
      created_by            INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS shipments (
      id                  SERIAL PRIMARY KEY,
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
      to_address          TEXT,
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
      created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      awb_number             TEXT,
      reference_number       TEXT,
      booking_date           TEXT,
      pickup_date            TEXT,
      shipment_type          TEXT,
      length                 REAL,
      width                  REAL,
      height                 REAL,
      carrier_id             INTEGER,
      tracking_status        TEXT,
      last_tracking_update   TIMESTAMPTZ,
      needs_manual_tracking  INTEGER DEFAULT 0,
      sender_company         TEXT,
      receiver_company       TEXT,
      receiver_attention     TEXT,
      origin_code            TEXT,
      destination_code       TEXT,
      route_code             TEXT,
      service_code           TEXT,
      customs_value          REAL,
      carriage_value         REAL,
      billing_type           TEXT,
      account_number         TEXT,
      carrier_specific       TEXT,
      vendor                 TEXT,
      carrier_code           TEXT,
      carrier_code_provider  TEXT,
      tracking_registered    INTEGER DEFAULT 0,
      tracking_registered_at TIMESTAMPTZ,
      registration_error     TEXT,
      auto_tracking_enabled  INTEGER DEFAULT 0,
      tracking_interval_hours INTEGER DEFAULT 10,
      delivered_at           TIMESTAMPTZ,
      archived               INTEGER DEFAULT 0,
      last_status_change_at  TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_shipments_ge   ON shipments(ge_tracking_number);
    CREATE INDEX IF NOT EXISTS idx_shipments_ctn  ON shipments(carrier_tracking_number);
    CREATE INDEX IF NOT EXISTS idx_shipments_date ON shipments(ship_date);

    CREATE TABLE IF NOT EXISTS tracking_cache (
      id                  SERIAL PRIMARY KEY,
      ge_tracking_number  TEXT NOT NULL,
      raw_response        TEXT,
      normalized          TEXT,
      provider            TEXT,
      fetched_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id),
      action      TEXT NOT NULL,
      entity      TEXT,
      entity_id   TEXT,
      details     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      username    TEXT,
      role        TEXT,
      ip_address  TEXT,
      device      TEXT,
      old_value   TEXT,
      new_value   TEXT,
      status      TEXT DEFAULT 'success'
    );

    CREATE TABLE IF NOT EXISTS roles (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id          SERIAL PRIMARY KEY,
      code        TEXT NOT NULL UNIQUE,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id       INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
      PRIMARY KEY (role_id, permission_id)
    );

    CREATE TABLE IF NOT EXISTS login_sessions (
      id                 SERIAL PRIMARY KEY,
      user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      refresh_token_hash TEXT NOT NULL,
      ip_address         TEXT,
      device             TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at         TIMESTAMPTZ NOT NULL,
      last_used_at       TIMESTAMPTZ,
      revoked            INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON login_sessions(user_id);

    CREATE TABLE IF NOT EXISTS password_resets (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      initiated_by        INTEGER REFERENCES users(id),
      temp_password_hash  TEXT,
      must_change         INTEGER DEFAULT 1,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      used_at             TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS carriers (
      id                SERIAL PRIMARY KEY,
      name              TEXT NOT NULL UNIQUE,
      code              TEXT NOT NULL UNIQUE,
      tracking_provider TEXT DEFAULT 'trackingmore',
      status            TEXT DEFAULT 'Active',
      api_type          TEXT DEFAULT 'api',
      priority          INTEGER DEFAULT 100,
      region            TEXT DEFAULT 'International',
      created_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS carrier_configs (
      id           SERIAL PRIMARY KEY,
      carrier_id   INTEGER NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
      config_key   TEXT NOT NULL,
      config_value TEXT,
      UNIQUE(carrier_id, config_key)
    );

    CREATE TABLE IF NOT EXISTS tracking_events (
      id                  SERIAL PRIMARY KEY,
      shipment_id         INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
      ge_tracking_number  TEXT,
      event_timestamp     TEXT,
      status              TEXT,
      location            TEXT,
      provider            TEXT,
      raw                 TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(ge_tracking_number, event_timestamp, status, location)
    );
    CREATE INDEX IF NOT EXISTS idx_tracking_events_ge ON tracking_events(ge_tracking_number);

    CREATE TABLE IF NOT EXISTS api_logs (
      id           SERIAL PRIMARY KEY,
      provider     TEXT NOT NULL,
      endpoint     TEXT,
      success      INTEGER NOT NULL,
      status_code  INTEGER,
      response_ms  INTEGER,
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_api_logs_provider ON api_logs(provider, created_at);

    CREATE TABLE IF NOT EXISTS bulk_upload_jobs (
      id             SERIAL PRIMARY KEY,
      uploaded_by    INTEGER REFERENCES users(id),
      file_name      TEXT,
      file_type      TEXT,
      total_records  INTEGER DEFAULT 0,
      success_count  INTEGER DEFAULT 0,
      failed_count   INTEGER DEFAULT 0,
      status         TEXT DEFAULT 'Queued',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at   TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS bulk_upload_records (
      id                  SERIAL PRIMARY KEY,
      job_id              INTEGER NOT NULL REFERENCES bulk_upload_jobs(id) ON DELETE CASCADE,
      row_number          INTEGER,
      raw_data            TEXT,
      detected_carrier    TEXT,
      validation_status   TEXT DEFAULT 'Pending',
      validation_errors   TEXT,
      validation_warnings TEXT,
      shipment_id         INTEGER REFERENCES shipments(id),
      created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_bulk_records_job ON bulk_upload_records(job_id);

    CREATE TABLE IF NOT EXISTS shipment_documents (
      id           SERIAL PRIMARY KEY,
      shipment_id  INTEGER REFERENCES shipments(id) ON DELETE CASCADE,
      file_name    TEXT,
      file_path    TEXT,
      file_type    TEXT,
      uploaded_by  INTEGER REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id),
      channel     TEXT NOT NULL,
      event       TEXT NOT NULL,
      recipient   TEXT,
      subject     TEXT,
      body        TEXT,
      status      TEXT DEFAULT 'Queued',
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at     TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS shipment_backups (
      id                  SERIAL PRIMARY KEY,
      ge_tracking_number  TEXT NOT NULL,
      backup_path         TEXT NOT NULL,
      delivered_at        TIMESTAMPTZ,
      backed_up_at        TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_by  INTEGER REFERENCES users(id)
    );

    DROP VIEW IF EXISTS audit_logs;
    CREATE VIEW audit_logs AS
      SELECT id, created_at AS timestamp, user_id, username, role, action, entity, entity_id,
             ip_address, device, old_value, new_value, status, details
      FROM audit_log;
  `);

  await seedCommon();
  console.log('✅ Garuda Express V2.0 database initialised (Postgres/production)');
}

const ready = (db.isPg ? initPostgres() : initSqlite()).catch((err) => {
  console.error('❌ Database initialization failed:', err);
  throw err;
});

// Exported so server.js (and any other caller) can await full initialization —
// including the async Argon2 account seeding — before accepting requests.
// Fixes a startup race where a login could hit an empty users table in the
// brief window between process start and seeding completion.
module.exports = { ready };