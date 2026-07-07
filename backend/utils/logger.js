// utils/logger.js — Centralized Winston logger
'use strict';

const winston = require('winston');
const path    = require('path');
const fs      = require('fs');

const LOG_DIR = path.join(__dirname, '../logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: path.join(LOG_DIR, 'error.log'), level: 'error', maxsize: 5_000_000, maxFiles: 5 }),
    new winston.transports.File({ filename: path.join(LOG_DIR, 'combined.log'), maxsize: 5_000_000, maxFiles: 5 }),
  ],
});

// Pretty console output outside production
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ level, message, timestamp, ...meta }) => {
        const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
        return `[${timestamp}] ${level}: ${message}${extra}`;
      })
    ),
  }));
} else {
  logger.add(new winston.transports.Console({ format: winston.format.simple() }));
}

module.exports = logger;
