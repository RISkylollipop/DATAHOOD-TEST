// ============================================================
//  services/otpService.js — issue and redeem one-time codes
// ------------------------------------------------------------
//  Backs forgot-password, PIN reset, and the admin profile/2FA gates.
//  They all need the same thing: prove the person controls the account's
//  email, without relying on the session alone. Writing it once means the
//  rate limits and the anti-guessing rules cannot drift apart between
//  flows.
//
//  Codes are scoped by ACTOR as well as by purpose — see ACTOR below.
//
//  Rules enforced here, and why:
//
//   * The code is stored as a SHA-256 hash. A DB dump must not contain
//     live reset codes.
//   * Issuing a new code invalidates every earlier unconsumed code for
//     the same (account, purpose). Otherwise a user who clicks "resend"
//     three times leaves three valid codes alive, tripling an
//     attacker's guessing surface.
//   * 6 digits, 10-minute life, 5 wrong guesses. The attempt cap lives
//     in the row, not in memory, so a process restart cannot reset it —
//     the flaw the in-memory PIN lockout in utils/pin.js knowingly has.
//   * Comparison is timing-safe. Both sides are fixed-length hex, so
//     timingSafeEqualStr never has to bail out on a length mismatch.
//   * A cooldown between issues stops the endpoint being used to
//     mail-bomb a user, and stops it becoming free outbound SMTP.
// ============================================================

import crypto from 'crypto';
import { Op } from 'sequelize';
import { OtpCode } from '../models/index.js';
import { hashToken, timingSafeEqualStr } from '../utils/crypto.js';
import * as logger from '../utils/logger.js';

export const OTP_TTL_MS = 3 * 60 * 1000; // code lives 3 minutes
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 1 minute between sends
const MAX_ATTEMPTS = 3;

export const PURPOSE = {
  PASSWORD_RESET: 'password_reset',
  PIN_RESET: 'pin_reset',

  // Admin profile editing is two-gated: one code to unlock the form, a
  // SECOND to commit the change. They are separate purposes on purpose —
  // consumedAt alone stops a code being replayed as itself, but only
  // distinct purposes stop the unlock code being submitted as the commit
  // code, which would collapse two gates into one.
  ADMIN_PROFILE_UNLOCK: 'admin_profile_unlock',
  ADMIN_PROFILE_COMMIT: 'admin_profile_commit',
  // Sent to the NEW address when an admin changes their email, so a
  // hijacked session cannot silently move the account somewhere the real
  // owner cannot receive codes.
  ADMIN_EMAIL_VERIFY: 'admin_email_verify',
  // Disabling 2FA is itself a privileged action and needs a gate.
  ADMIN_2FA_DISABLE: 'admin_2fa_disable',
};

/**
 * Which table `sId` points into.
 *
 * `otp_codes.sId` originally meant "subscriber id". Issuing admin codes
 * against the same column without this would let subscriber #5 and admin
 * #5 collide — a customer's password-reset code could satisfy an admin
 * gate. Every where-clause below filters on it.
 */
export const ACTOR = {
  SUBSCRIBER: 'subscriber',
  SYSUSER: 'sysuser',
};

/**
 * A uniformly-distributed 6-digit code.
 *
 * randomInt (not Math.random) because this is a security token, and it
 * rejection-samples internally so there is no modulo bias toward the
 * low end of the range. Padded so "007431" keeps its full length.
 */
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Has this account asked for a code too recently?
 * @returns {Promise<{blocked:boolean, retryAfterSec:number}>}
 */
export async function resendCooldown(sId, purpose, { actorType = ACTOR.SUBSCRIBER } = {}) {
  const last = await OtpCode.findOne({
    where: { actorType, sId, purpose },
    order: [['createdAt', 'DESC']],
  });
  if (!last) return { blocked: false, retryAfterSec: 0 };

  const elapsed = Date.now() - new Date(last.createdAt).getTime();
  if (elapsed >= OTP_RESEND_COOLDOWN_MS) return { blocked: false, retryAfterSec: 0 };

  return {
    blocked: true,
    retryAfterSec: Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000),
  };
}

/**
 * Issue a code, superseding any earlier live one for the same purpose.
 *
 * @returns {Promise<{code:string, expiresAt:Date}>} the PLAINTEXT code —
 *   hand it straight to the mailer and never log it or return it in a
 *   response body.
 */
export async function issueCode(sId, purpose, { ip = null, actorType = ACTOR.SUBSCRIBER } = {}) {
  // Supersede outstanding codes: exactly one live code per
  // (actor, account, purpose). actorType matters here as much as in the
  // verify path — without it, issuing an admin code would consume the
  // live codes of the subscriber who happens to share that id.
  await OtpCode.update(
    { consumedAt: new Date() },
    { where: { actorType, sId, purpose, consumedAt: null } }
  );

  const code = generateCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  await OtpCode.create({
    actorType,
    sId,
    purpose,
    codeHash: hashToken(code),
    expiresAt,
    requestIp: ip,
  });

  // Deliberately records only that a code was issued — never the code.
  logger.info('OTP issued', { actorType, sId, purpose });

  return { code, expiresAt };
}

/**
 * Verify and consume a code. Single-use: a success marks it spent, so a
 * replay of the same code fails.
 *
 * Returns a `reason` rather than throwing, because the caller must map
 * each case to a specific 400/422/429 — never a 401, which would trip
 * the auto-logout in the frontend's client.js and drop the user out of
 * the very flow they are trying to complete.
 *
 * @returns {Promise<{ok:boolean, reason?:string}>}
 *   reason: 'no_code' | 'expired' | 'too_many_attempts' | 'mismatch'
 */
export async function verifyCode(sId, purpose, submitted, { actorType = ACTOR.SUBSCRIBER } = {}) {
  const row = await OtpCode.findOne({
    where: { actorType, sId, purpose, consumedAt: null },
    order: [['createdAt', 'DESC']],
  });

  if (!row) return { ok: false, reason: 'no_code' };

  if (new Date(row.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    return { ok: false, reason: 'too_many_attempts' };
  }

  const clean = String(submitted || '').trim();
  if (!timingSafeEqualStr(hashToken(clean), row.codeHash)) {
    // Count the miss before returning, so the cap holds even if the
    // client hangs up immediately after sending each guess.
    await row.increment('attempts');
    return { ok: false, reason: 'mismatch' };
  }

  row.consumedAt = new Date();
  await row.save();
  return { ok: true };
}

/**
 * Delete rows that are long dead — expired or consumed over a day ago.
 *
 * A day of retention, not zero: if a user reports "I never asked for
 * that reset email", the row that proves when and from which IP it was
 * requested still exists the next morning.
 */
export async function purgeExpired() {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return OtpCode.destroy({
    where: {
      [Op.or]: [
        { expiresAt: { [Op.lt]: cutoff } },
        { consumedAt: { [Op.lt]: cutoff } },
      ],
    },
  });
}
