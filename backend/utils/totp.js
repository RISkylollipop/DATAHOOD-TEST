// ============================================================
//  utils/totp.js — RFC 6238 authenticator codes, zero dependencies
// ------------------------------------------------------------
//  Works with Google Authenticator, Authy, 1Password, Microsoft
//  Authenticator — anything that speaks the otpauth:// URI scheme.
//
//  No new dependency, by design: node:crypto already provides
//  HMAC-SHA1, and the only other pieces are base32 (RFC 4648) and the
//  dynamic-truncation step from RFC 4226. Both are short enough to read
//  in full, which is worth more here than a package that has to be
//  trusted and kept patched.
//
//  Rules this file exists to enforce, and why each one matters:
//
//   * SHA-1 is correct here and is NOT the weakness it sounds like.
//     RFC 6238's default is HMAC-SHA1; HMAC does not inherit SHA-1's
//     collision problems, and every mainstream authenticator app
//     silently assumes SHA1/6-digits/30s. Changing any of the three
//     produces codes that no app will match.
//
//   * A code must be single-use. A TOTP code stays valid for its whole
//     30-second step, plus the drift window either side — so without a
//     record of the last accepted step, the same six digits can be
//     replayed for up to a minute and a half. verify() returns the step
//     it matched so the caller can persist it (sysusers.sysTotpLastStep)
//     and refuse anything at or below it next time.
//
//   * Comparison is timing-safe, and the drift loop runs to completion
//     rather than returning early on the first match, so the response
//     time does not reveal WHICH step matched.
//
//   * The secret is handled here in PLAINTEXT and this file deliberately
//     does not know how it is stored. Callers must encrypt it with
//     encryptSecret() from utils/crypto.js before it touches
//     sysusers.sysTotpSecret, and decrypt on the way back out.
//
//     Keeping that split is not just tidiness: utils/crypto.js pulls in
//     bcrypt, whose native binding is platform-specific, so importing it
//     here would make this pure-math module unloadable anywhere the
//     binding does not match — including the environment its RFC vectors
//     are checked in. node:crypto alone has no such problem.
// ============================================================

import crypto from 'crypto';

// Defaults every authenticator app assumes. Do not change these lightly:
// an app scanning the QR has no way to be told otherwise for SHA1/period
// beyond the URI parameters, and several popular apps ignore them.
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
// One step of drift each way (±30s) tolerates a phone clock that is
// slightly off without meaningfully widening the guessing window.
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ---------- base32 (RFC 4648, unpadded — what otpauth:// expects) ----------

/**
 * Encode bytes as unpadded base32.
 * Authenticator apps reject '=' padding in the secret parameter, so it
 * is omitted rather than stripped later.
 */
export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  // Left-align the leftover bits into a final character.
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/**
 * Decode unpadded (or padded) base32 back to bytes.
 *
 * Tolerant of what humans actually type when an app offers "enter the
 * key manually": lowercase, spaces, and the '=' padding are all accepted.
 * Anything else is a hard error — silently skipping an unknown character
 * would produce a valid-looking but wrong secret, and the failure would
 * surface much later as "my codes never work".
 */
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];

  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------- code generation ----------

/**
 * A new random secret, base32-encoded.
 *
 * 20 bytes = 160 bits, the SHA-1 block-matched length RFC 4226 §4 R6
 * recommends, and what Google Authenticator issues. Encodes to 32 chars.
 */
export function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * RFC 4226 HOTP: HMAC-SHA1 over an 8-byte big-endian counter, reduced to
 * `digits` decimal digits by dynamic truncation.
 */
export function hotp(secretBuf, counter, digits = TOTP_DIGITS) {
  const counterBuf = Buffer.alloc(8);
  // writeBigUInt64BE, not two 32-bit writes: the counter is a time step
  // and stays well inside Number.MAX_SAFE_INTEGER, but BigInt keeps the
  // high word correct without hand-rolled arithmetic.
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const digest = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();

  // Dynamic truncation (RFC 4226 §5.4): the low nibble of the last byte
  // picks the offset; the top bit of the selected word is masked off so
  // the result is unsigned regardless of platform signedness.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step counter for a given moment. */
export function stepFor(atMs = Date.now(), step = TOTP_STEP_SECONDS) {
  return Math.floor(atMs / 1000 / step);
}

/**
 * The current code for a base32 secret. Exported mainly so the enrolment
 * flow and the RFC self-test can both reach it.
 */
export function generateCode(base32Secret, { atMs = Date.now(), digits = TOTP_DIGITS, step = TOTP_STEP_SECONDS } = {}) {
  return hotp(base32Decode(base32Secret), stepFor(atMs, step), digits);
}

/**
 * Verify a submitted code.
 *
 * @param {string} base32Secret  the decrypted secret
 * @param {string} token         what the admin typed
 * @param {object} opts
 * @param {number|null} opts.lastStep  the last step already accepted for
 *   this admin. Anything at or below it is refused as a replay — this is
 *   the single most important argument here, and omitting it silently
 *   makes every code reusable for ~90 seconds.
 * @returns {{ok:boolean, step:number|null, reason?:string}}
 *   reason: 'malformed' | 'replay' | 'mismatch'
 *   On success, PERSIST `step` to sysusers.sysTotpLastStep.
 */
export function verifyCode(base32Secret, token, {
  atMs = Date.now(),
  window = TOTP_WINDOW,
  digits = TOTP_DIGITS,
  step = TOTP_STEP_SECONDS,
  lastStep = null,
} = {}) {
  const clean = String(token ?? '').replace(/\s+/g, '');
  // Length/shape check first: a non-numeric or wrong-length entry can
  // never match, and rejecting it here avoids doing HMAC work on junk.
  if (!new RegExp(`^\\d{${digits}}$`).test(clean)) {
    return { ok: false, step: null, reason: 'malformed' };
  }

  let secretBuf;
  try {
    secretBuf = base32Decode(base32Secret);
  } catch {
    return { ok: false, step: null, reason: 'malformed' };
  }
  if (secretBuf.length === 0) return { ok: false, step: null, reason: 'malformed' };

  const current = stepFor(atMs, step);
  let matched = null;

  // Runs every candidate even after a hit: returning early would leak,
  // via response time, which step matched.
  for (let drift = -window; drift <= window; drift += 1) {
    const candidateStep = current + drift;
    if (candidateStep < 0) continue;
    const expected = hotp(secretBuf, candidateStep, digits);
    if (timingSafeDigits(expected, clean) && matched === null) {
      matched = candidateStep;
    }
  }

  if (matched === null) return { ok: false, step: null, reason: 'mismatch' };

  // Replay guard. Codes from an already-accepted step (or older) are
  // refused even though they are cryptographically valid right now.
  if (lastStep !== null && lastStep !== undefined && matched <= Number(lastStep)) {
    return { ok: false, step: matched, reason: 'replay' };
  }

  return { ok: true, step: matched };
}

/**
 * Constant-time compare for two equal-length digit strings.
 * Kept local because both sides are always `digits` long here, so the
 * length-mismatch bail-out in utils/crypto.js never applies.
 */
function timingSafeDigits(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------- enrolment ----------

/**
 * The otpauth:// URI an authenticator app scans.
 *
 * The label is "Issuer:account" AND issuer is repeated as a parameter —
 * that redundancy is what the spec recommends, because older apps read
 * only one of the two and would otherwise show the account with no
 * indication of which site it belongs to.
 *
 * ISSUER IS DATAHOOD, and changing it later is not free. This string is
 * what the admin sees in Google Authenticator next to their code, forever:
 * apps snapshot it at scan time and never refresh it, so an admin who
 * enrolled under a different name keeps seeing the old one, and re-issuing
 * adds a SECOND entry rather than renaming the first. It is set correctly
 * now precisely because nothing has enrolled yet — this is the last moment
 * it can be changed for free.
 *
 * Length matters too, which is not obvious: the issuer appears twice, so
 * every character costs two bytes in a URI that has to fit in a QR symbol.
 * See utils/qrcode.js — at 154 bytes the previous value overflowed EC
 * level Q entirely.
 */
export function otpauthUrl({ secret, account, issuer = 'DATAHOOD' }) {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  // encodeURIComponent, not URLSearchParams, for the label: the colon
  // separator must survive, but spaces in a site name must not become '+'.
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/**
 * Group a secret into readable chunks for the "can't scan the QR?" text.
 * Purely cosmetic — base32Decode strips the spaces back out.
 */
export function formatSecretForDisplay(secret, groupSize = 4) {
  return String(secret).replace(new RegExp(`(.{${groupSize}})`, 'g'), '$1 ').trim();
}

// ---------- storage ----------
//
// Deliberately absent: this module does not encrypt or decrypt. Wrapping
// encryptSecret()/decryptSecret() here would drag bcrypt in via
// utils/crypto.js and make the whole file unloadable on a platform whose
// native binding does not match. Callers do it explicitly:
//
//   import { encryptSecret, decryptSecret } from '../utils/crypto.js';
//   admin.sysTotpSecret = encryptSecret(secret);        // on enrol
//   const secret = decryptSecret(admin.sysTotpSecret);  // on verify
//
// decryptSecret THROWS on a malformed envelope or a rotated
// APP_ENCRYPTION_KEY, so wrap the read in try/catch and answer "2FA needs
// re-enrolling" rather than 500ing an admin out of their own login.

// ---------- backup codes ----------

/**
 * Single-use recovery codes, for a lost or wiped phone.
 *
 * Returned in PLAINTEXT once, at enrolment — show them, then store only
 * the hashes. Format is 10 hex chars split by a hyphen for legibility;
 * randomBytes, not randomInt, because these are full-strength secrets
 * rather than 6-digit codes.
 */
export function generateBackupCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 chars
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** Normalise a typed backup code: case and hyphen are not significant. */
export function normalizeBackupCode(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-F0-9]/g, '');
}
