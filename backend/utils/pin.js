// ============================================================
//  Transaction PIN verification + brute-force lockout
// ------------------------------------------------------------
//  SECURITY-AUDIT C3: the transaction PIN is short (≈4 digits =
//  10,000 combos). Without a per-account throttle an attacker who
//  has a session token could grind every combination. This adds a
//  per-subscriber lockout: after N wrong PINs the account's PIN is
//  locked for a cooldown window, regardless of IP.
//
//  The counter is in-process memory. That is sufficient for a
//  single Node process (the default PM2 fork mode). If you later
//  run multiple worker processes / multiple servers, move this to
//  a shared store (Redis / a DB column) so the lockout is global.
//
//  This module also CENTRALISES PIN checking (previously duplicated
//  in every purchase controller) so the legacy-plaintext→bcrypt
//  upgrade and the lockout live in exactly one place.
//
//  DELIBERATE DIVERGENCE FROM LEGACY: the old PHP had a per-user PIN
//  bypass — subscribers.sPinStatus = 1 meant "skip the PIN prompt", and
//  the checkout page posted a dummy '0000' instead (see the legacy
//  mobile/home/index.php). This rewrite does not honour that flag: every
//  purchase requires the real PIN. Do not "restore" it as a missing
//  feature. Users who had the bypass on may still be sitting on the
//  '1234' column default, which is why Profile → Security reports their
//  PIN as unset and prompts them to choose one.
// ============================================================

import { hashPassword, verifyPassword, isBcryptHash } from './crypto.js';
import * as logger from './logger.js';

const MAX_ATTEMPTS = 5;              // wrong PINs allowed…
const LOCK_MS = 15 * 60 * 1000;      // …before a 15-minute lockout
const attempts = new Map();          // sId -> { count, firstAt, lockedUntil }

function now() {
  return Date.now();
}

function getState(sId) {
  return attempts.get(sId) || { count: 0, firstAt: 0, lockedUntil: 0 };
}

/**
 * Is this account currently locked out of PIN entry?
 * @returns {{locked:boolean, retryAfterSec:number}}
 */
export function pinLockStatus(sId) {
  const s = getState(sId);
  if (s.lockedUntil && s.lockedUntil > now()) {
    return { locked: true, retryAfterSec: Math.ceil((s.lockedUntil - now()) / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

function recordFailure(sId) {
  const s = getState(sId);
  const t = now();
  // Reset the window if the last window fully elapsed.
  if (!s.firstAt || t - s.firstAt > LOCK_MS) {
    s.count = 0;
    s.firstAt = t;
  }
  s.count += 1;
  if (s.count >= MAX_ATTEMPTS) {
    s.lockedUntil = t + LOCK_MS;
    logger.warn('Transaction PIN locked after repeated failures', { sId });
  }
  attempts.set(sId, s);
}

function clearFailures(sId) {
  if (attempts.has(sId)) attempts.delete(sId);
}

/**
 * Verify a subscriber's transaction PIN with lockout + legacy upgrade.
 *
 * @returns {Promise<{ok:boolean, locked?:boolean, retryAfterSec?:number}>}
 *   - { locked: true, retryAfterSec } when the account is in cooldown
 *   - { ok: true } on a correct PIN (also clears the failure counter)
 *   - { ok: false } on a wrong PIN (also records the failure)
 */
export async function verifyUserPin(user, pinPlain) {
  const sId = user.sId;

  const lock = pinLockStatus(sId);
  if (lock.locked) {
    return { ok: false, locked: true, retryAfterSec: lock.retryAfterSec };
  }

  const stored = String(user.sPin);
  let ok = false;
  if (isBcryptHash(stored)) {
    ok = await verifyPassword(String(pinPlain), stored);
  } else {
    // Legacy plaintext integer PIN — upgrade to bcrypt on first correct entry.
    ok = stored === String(pinPlain);
    if (ok) {
      user.sPin = await hashPassword(String(pinPlain));
      await user.save();
      logger.info('Upgraded legacy transaction PIN to bcrypt', { sId });
    }
  }

  if (ok) {
    clearFailures(sId);
    return { ok: true };
  }
  recordFailure(sId);
  return { ok: false };
}
