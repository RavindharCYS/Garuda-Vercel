// server.js — Garuda Express V2.0 Backend Entry Point
'use strict';

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const path       = require('path');
const fs         = require('fs');
const rateLimit  = require('express-rate-limit');
const logger     = require('./utils/logger');

// ── Ensure DB & uploads dirs exist, run init ──────────────────────────────────
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const BULK_DIR = path.join(UPLOAD_DIR, 'bulk');
if (!fs.existsSync(BULK_DIR)) fs.mkdirSync(BULK_DIR, { recursive: true });

// Auto-init DB schema on first boot (idempotent migrations + RBAC/carrier/settings seed).
// `ready` resolves once the async Argon2 account seeding finishes — we must
// wait for it before accepting requests, or an early login could race an
// empty users table on a fresh database.
const dbInit = require('./utils/initDb');

// ── App setup ─────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 4000;

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // We serve the SPA
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:3000',
  'http://localhost:3000',
  'http://localhost:5173',
];
// Any localhost/127.0.0.1 port is allowed in development, since Vite may pick
// a different port (5174, 5175...) if 5173 is already in use, and browsers
// treat localhost and 127.0.0.1 as different origins for CORS purposes.
const localDevOriginPattern = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    if (process.env.NODE_ENV !== 'production' && localDevOriginPattern.test(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

// ── Body parsers ──────────────────────────────────────────────────────────────
// rawBody is captured here (not per-route) because this global parser runs
// first and consumes the request stream — routes/webhooks.js needs the
// original raw bytes (not the re-serialized object) to verify 17Track's
// HMAC-style signature correctly.
app.use(express.json({ limit: '15mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ── Global rate limiter ───────────────────────────────────────────────────────
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
}));

// Tighter rate limit specifically on login to slow down credential-stuffing /
// brute-force attempts (account lockout in routes/auth.js handles the rest).
app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many login attempts. Please try again later.' },
}));

// ── Request logging (Winston) ─────────────────────────────────────────────────
app.use((req, _, next) => {
  logger.http(`${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/track',         require('./routes/track'));
app.use('/api/webhooks',      require('./routes/webhooks'));
app.use('/api/shipments',     require('./routes/shipments'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/carriers',      require('./routes/carriers'));
app.use('/api/bulk-upload',   require('./routes/bulkUpload'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/profile',       require('./routes/profile'));

// ── Serve uploaded waybill files (authenticated) ──────────────────────────────
app.use('/uploads', (req, res, next) => {
  const token = req.query.token || (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).send('Unauthorized');
  try {
    require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'fallback_dev_secret_change_in_prod');
    next();
  } catch (_) {
    res.status(401).send('Unauthorized');
  }
}, express.static(UPLOAD_DIR));

// ── Serve React frontend (production) ─────────────────────────────────────────
const FRONTEND_BUILD = path.join(__dirname, '../frontend/dist');
if (fs.existsSync(FRONTEND_BUILD)) {
  app.use(express.static(FRONTEND_BUILD));
  app.get('*', (_, res) => res.sendFile(path.join(FRONTEND_BUILD, 'index.html')));
} else {
  app.get('/', (_, res) => res.json({
    service: 'Garuda Express API',
    version: '2.0.0',
    status:  'running',
    docs:    '/api/auth/login (POST), /api/track/:ge (GET)',
  }));
}

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('[Unhandled]', { error: err.message, stack: err.stack, path: req.path });
  res.status(err.status || 500).json({
    success: false,
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

// ── Background workers (tracking sync, manual queue retry, notifications,
//    audit retention, cache cleanup) — requirement spec §9 ──────────────────
const { startWorkers } = require('./services/workers');
startWorkers();

// ── Start (after DB seeding fully completes — see dbInit.ready above) ─────────
dbInit.ready
  .then(() => {
    app.listen(PORT, () => {
      logger.info(`
╔════════════════════════════════════════════╗
║   🦅  Garuda Express V2.0 API Server        ║
║   Port : ${PORT}                               ║
║   Env  : ${(process.env.NODE_ENV || 'development').padEnd(12)}                  ║
╚════════════════════════════════════════════╝
  `);
    });
  })
  .catch((err) => {
    logger.error('Fatal: database initialization failed, server not started', { error: err.message });
    process.exit(1);
  });

module.exports = app;