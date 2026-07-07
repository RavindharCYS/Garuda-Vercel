// utils/password.js — Argon2 hashing with transparent legacy-bcrypt migration
// and password policy enforcement (Garuda Express security upgrade).
'use strict';

const argon2  = require('argon2');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');

const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
};

const POLICY = {
  minLength: 10,
  requireUpper: true,
  requireLower: true,
  requireNumber: true,
  requireSymbol: true,
  expiryDays: parseInt(process.env.PASSWORD_EXPIRY_DAYS || '90', 10),
  historyCount: 5, // not reused in last N passwords (best-effort, see password_history table)
};

/** Hash a plaintext password with Argon2id. */
async function hashPassword(plain) {
  return argon2.hash(plain, ARGON2_OPTS);
}

/**
 * Verify a plaintext password against a stored hash.
 * Supports legacy bcrypt hashes (from v1.0) transparently — if the hash is
 * bcrypt and matches, returns { valid: true, needsRehash: true } so the
 * caller can silently upgrade the stored hash to Argon2id.
 */
async function verifyPassword(stored, plain) {
  if (!stored) return { valid: false, needsRehash: false };

  if (stored.startsWith('$argon2')) {
    try {
      const valid = await argon2.verify(stored, plain);
      return { valid, needsRehash: false };
    } catch (_) {
      return { valid: false, needsRehash: false };
    }
  }

  // Legacy bcrypt hash ($2a$ / $2b$ / $2y$) — verify then flag for upgrade.
  if (/^\$2[aby]\$/.test(stored)) {
    const valid = bcrypt.compareSync(plain, stored);
    return { valid, needsRehash: valid };
  }

  return { valid: false, needsRehash: false };
}

/** Validate password against the org policy. Returns { ok, errors[] }. */
function checkPolicy(plain) {
  const errors = [];
  if (!plain || plain.length < POLICY.minLength) errors.push(`Must be at least ${POLICY.minLength} characters`);
  if (POLICY.requireUpper && !/[A-Z]/.test(plain)) errors.push('Must contain an uppercase letter');
  if (POLICY.requireLower && !/[a-z]/.test(plain)) errors.push('Must contain a lowercase letter');
  if (POLICY.requireNumber && !/[0-9]/.test(plain)) errors.push('Must contain a number');
  if (POLICY.requireSymbol && !/[^A-Za-z0-9]/.test(plain)) errors.push('Must contain a symbol');
  return { ok: errors.length === 0, errors };
}

/** Generate a strong, policy-compliant temporary password (e.g. for resets). */
function generateTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const nums  = '23456789';
  const syms  = '!@#$%&*?';
  const pick  = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(set.length)]).join('');
  const raw   = pick(upper, 3) + pick(lower, 5) + pick(nums, 3) + pick(syms, 2);
  // Shuffle
  return raw.split('').sort(() => crypto.randomInt(3) - 1).join('');
}

function isPasswordExpired(passwordChangedAt) {
  if (!passwordChangedAt) return false;
  const expiry = new Date(passwordChangedAt).getTime() + POLICY.expiryDays * 24 * 60 * 60 * 1000;
  return Date.now() > expiry;
}

module.exports = { hashPassword, verifyPassword, checkPolicy, generateTempPassword, isPasswordExpired, POLICY };
