// ============================================================
//  Crypto Utilities — password hashing + key encryption
// ------------------------------------------------------------
//  TWO different needs, TWO different techniques:
//
//  1. PASSWORDS (user + admin) -> bcrypt HASH.
//     One-way. You never need the original back; you only ever
//     compare. This is the correct, secure choice.
//
//  2. PROVIDER API KEYS / PAYMENT SECRETS -> AES-256 ENCRYPTION.
//     These must be sent back to Monnify/Maskawasub/etc, so they
//     have to be REVERSIBLE. Hashing them would make them useless
//     (a hash can't be turned back into the key). So we encrypt at
//     rest and decrypt only in memory when a request is made.
//     The master key lives in .env (APP_ENCRYPTION_KEY), never DB.
// ============================================================

import bcrypt from 'bcrypt';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const SALT_ROUNDS = 12;

// ---------- Passwords (bcrypt) ----------

/**
 * Hash a plaintext password (user or admin). Use at signup/password-change.
 */
export async function hashPassword(plain) {
  return await bcrypt.hash(plain, SALT_ROUNDS);
}

/**
 * Compare a login attempt against the stored bcrypt hash.
 */
export async function verifyPassword(plain, hash) {
  return await bcrypt.compare(plain, hash);
}

/**
 * Spend the same CPU a real password check would, and throw the result away.
 *
 * WHY THIS EXISTS
 *
 * A login that returns early because no such account exists answers in about
 * a millisecond. A login against a real account with the wrong password has
 * to run bcrypt at cost 12 first — roughly 300ms. That difference is trivially
 * measurable over the network, which turns the login endpoint into an account
 * enumerator: an attacker learns which phone numbers and emails are registered
 * here without ever guessing a password. On a platform where the identifier is
 * a Nigerian mobile number (a small, densely-populated, enumerable space) that
 * is a list worth having, and it feeds straight into phishing.
 *
 * Callers must `await` this on EVERY path that answers "invalid login details"
 * without having already run bcrypt — the unknown-account path, and a failed
 * legacy-hash check (which is only sha1+md5 and therefore fast).
 *
 * Implemented as a hash rather than a compare against a dummy digest so there
 * is no fabricated constant to get wrong: an invalid stored hash makes
 * bcrypt.compare() return false immediately and do no work at all, which would
 * silently reintroduce the exact leak this is here to close. hash() and
 * compare() both run 2^cost Blowfish key-setup rounds, and SALT_ROUNDS matches
 * the cost embedded in every hash we store, so the work is equivalent.
 *
 * This does not make login constant-time — DB lookup time still varies. It
 * removes the one difference that is large enough to read reliably.
 */
export async function burnPasswordWork(plain) {
  try {
    await bcrypt.hash(String(plain ?? ''), SALT_ROUNDS);
  } catch {
    // Never let the decoy affect the outcome; the caller is already
    // returning a failure.
  }
}

/**
 * Detect legacy (non-bcrypt) password values so we can transparently
 * upgrade old accounts on their next successful login.
 * The old PHP stored short random strings — bcrypt hashes always start
 * with $2a$/$2b$/$2y$ and are 60 chars.
 */
export function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value) && value.length === 60;
}

/**
 * Reproduce the LEGACY PHP password hash exactly.
 *
 *   PHP:  substr(sha1(md5($password)), 3, 10)
 *
 * Found in core/Models/Account.php (register, login, password reset) and
 * AdminModel.php. It md5's the password, sha1's that hex string, then takes
 * 10 characters starting at offset 3 — producing values like '434065b4e0',
 * which is exactly what sits in your subscribers.sPass column today.
 *
 * This is NOT secure (unsalted, truncated to 40 bits) which is precisely
 * why we move to bcrypt. But every pre-existing account is stored this way,
 * so login must recognise it ONCE to verify the user, then immediately
 * re-save the password as bcrypt.
 *
 * Never use this to store anything new.
 */
export function legacyPhpHash(plain) {
  const md5 = crypto.createHash('md5').update(String(plain)).digest('hex');
  const sha1 = crypto.createHash('sha1').update(md5).digest('hex');
  return sha1.substring(3, 13); // PHP substr(str, 3, 10) => 10 chars from index 3
}

/**
 * Constant-time compare of a login attempt against a legacy hash.
 * Returns false (never throws) on length mismatch, empty or non-string input.
 */
export function verifyLegacyPassword(plain, stored) {
  if (typeof stored !== 'string' || stored.length === 0) return false;
  const a = Buffer.from(legacyPhpHash(plain));
  const b = Buffer.from(stored);
  if (a.length !== b.length) return false; // timingSafeEqual throws on mismatch
  return crypto.timingSafeEqual(a, b);
}

/**
 * Constant-time string comparison. Used when the stored admin password is
 * still legacy PLAINTEXT (the old PHP compared `sysToken=:password` directly).
 */
export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ---------- Provider keys / payment secrets (AES-256-GCM) ----------

const ALGO = 'aes-256-gcm';

function getMasterKey() {
  const key = process.env.APP_ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('APP_ENCRYPTION_KEY must be set to a 32+ char secret in .env');
  }
  // Derive a 32-byte key deterministically from the env secret.
  return crypto.createHash('sha256').update(key).digest();
}

/**
 * Encrypt a sensitive value (API key, payment secret) for storage.
 * Returns a single string: iv:authTag:ciphertext (all base64).
 */
export function encryptSecret(plaintext) {
  if (plaintext == null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getMasterKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join(':');
}

/**
 * Decrypt a stored secret back to its original value (only in memory,
 * only when about to call the provider).
 */
export function decryptSecret(stored) {
  if (!stored) return '';
  const [ivB64, tagB64, dataB64] = stored.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted secret');
  }
  const decipher = crypto.createDecipheriv(ALGO, getMasterKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ---------- PII at rest (AES-256-GCM, legacy-tolerant) ----------
//
// SECURITY-AUDIT H3: NIN/BVN/passport numbers, full names and the raw
// provider result (which includes a photo) are sensitive personal data.
// We encrypt them at rest with the SAME AES-256-GCM scheme as provider
// keys, but reads must tolerate rows written BEFORE encryption existed
// (plaintext) so old history/slips still open.

// A value we wrote looks like `iv:authTag:ciphertext` — three non-empty
// base64 segments. This is a cheap shape check, not a security check;
// decryptPII still fully authenticates via the GCM tag.
function looksEncrypted(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  return parts.every((p) => p.length > 0 && /^[A-Za-z0-9+/=]+$/.test(p));
}

/**
 * Encrypt a PII field for storage. null/'' pass straight through so we
 * don't store the string "encrypted-empty".
 */
export function encryptPII(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  return encryptSecret(plaintext);
}

/**
 * Decrypt a stored PII field. If the value isn't in our encrypted shape
 * (a legacy plaintext row), return it unchanged. If it looks encrypted
 * but fails authentication, we surface the error to the caller.
 */
export function decryptPII(stored) {
  if (stored == null || stored === '') return stored;
  if (!looksEncrypted(stored)) return stored; // legacy plaintext
  return decryptSecret(stored);
}

// ---------- API tokens (secure random) ----------

/**
 * Generate a cryptographically secure API token / reference.
 */
export function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hash a token for storage when you only need to VERIFY it later
 * (e.g. password-reset tokens, email-verification tokens). One-way SHA-256.
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
