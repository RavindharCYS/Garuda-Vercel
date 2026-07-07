// utils/db.js — Singleton SQLite connection
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DB_DIR  = path.join(__dirname, '../db');
const DB_PATH = path.join(DB_DIR, 'garuda.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
