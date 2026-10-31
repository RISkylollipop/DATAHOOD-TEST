// ============================================================
//  Profile Security Controller — password + transaction PIN
// ------------------------------------------------------------
//  Everything here runs behind requireUser, so the caller is already
//  authenticated. That is NOT enough on its own: a stolen laptop with
//  a live session must not be able to change the password or the PIN.
//  So each sensitive action re-proves something the session alone
//  cannot supply — the current password, the current PIN, or a code
//  mailed to the address on file.
//
//  Endpoints:
//    GET  /profile/security            -> what is set, what is not
//    POST /profile/change-password     { currentPassword, newPassword }
//    POST /profile/set-pin             { password, pin }         (first time)
//    POST /profile/change-pin          { currentPin, newPin }
//    POST /profile/pin/request-reset   {}            -> mails a code
//    POST /profile/pin/reset           { code, newPin }
//
//  ---- Status codes ----
//  Business failures are 400/422/429 throughout. A 401 here would be
//  actively harmful: client.js force-logs-out on 401, so telling a user
//  "wrong current password" with a 401 would eject them from the page
//  and look like a crash. 401 stays reserved for a dead/absent token,
//  which is middleware/auth.js's job, not this file's.
//
//  ---- The '1234' problem ----
//  Subscriber.sPin defaults to the literal string '1234', so an account
//  that has never set a PIN has a known one. pinSet() answers "has this
//  user chosen their own PIN?" by testing the stored value against that
//  default — NOT by reading sPinStatus, which the legacy PHP uses for
//  something else entirely: 0 = PIN required at checkout, 1 = PIN
//  DISABLED (a bypass flag flipped from "Enable/Disable" in the old
//  profile page). Writing it to mean "user set a PIN" would mark real
//  accounts' PINs as turned off and is exactly the kind of silent data
//  corruption that survives months unnoticed. So this code never writes
//  the column; pinSet is derived from the PIN value itself.
// ============================================================

import { hashPassword, verifyPassword, isBcryptHash } from '../utils/crypto.js';
import { verifyUserPin, pinLockStatus } from '../utils/pin.js';
import { sendEmail } from '../services/emailService.js';
import {
  issueCode,
  verifyCode,
  resendCooldown,
  PURPOSE,
  OTP_TTL_MS,
} from '../services/otpService.js';
import * as logger from '../utils/logger.js';

const SITE_NAME = process.env.MAIL_FROM_NAME || 'KwaraPolyData';
const DEFAULT_PIN = '1234'; // the legacy column default — never a "set" PIN

/** A PIN must be exactly 4 digits: PinModal collects 4 boxes. */
function invalidPin(pin) {
  const s = String(pin ?? '');
  if (!/^\d{4}$/.test(s)) return 'PIN must be exactly 4 digits.';
  // Refusing 1234 is not theatre: it is this table's column default, so
  // allowing it would let a user "set" a PIN that is indistinguishable
  // from never having set one.
  if (s === DEFAULT_PIN) return 'That PIN is too common. Please choose a different one.';
  if (/^(\d)\1{3}$/.test(s)) return 'Avoid four identical digits. Please choose a different PIN.';
  return null;
}

/**
 * Has this user actually chosen a PIN, as opposed to inheriting the
 * column default? The stored value is a bcrypt hash (post-upgrade) or
 * legacy plaintext. Compare against the default either way — a bcrypt
 * hash of '1234' is NOT a set PIN, and a plaintext '1234' is not either.
 * sPinStatus is deliberately not consulted: in the legacy schema it is a
 * PIN-disabled bypass flag, not a "PIN exists" flag (see header comment).
 */
async function pinSet(user) {
  const stored = String(user.sPin || '');
  if (!stored) return false;
  if (isBcryptHash(stored)) {
    return !(await verifyPassword(DEFAULT_PIN, stored));
  }
  return stored !== DEFAULT_PIN;
}

/** Fire-and-forget security notice. A mail failure must never undo the change. */
function notify(user, subject, line) {
  if (!user.sEmail) return;
  sendEmail({
    to: user.sEmail,
    subject: `${subject} (${SITE_NAME})`,
    text: `Hi ${user.sFname || 'there'}, ${line} If this was not you, contact support immediately.`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h2 style="margin:0 0 10px">${subject}</h2>
  <p>Hi <strong>${user.sFname || 'there'}</strong>, ${line}</p>
  <p style="color:#a10">If this was not you, contact support immediately.</p>
</div>`,
  }).catch((e) => logger.error('Security notice email failed', { sId: user.sId, error: e.message }));
}

// ---------- GET /api/profile/security ----------

/** What the security page needs to render, and nothing more. */
export async function getSecurityStatus(req, res) {
  try {
    const user = req.user;
    const lock = pinLockStatus(user.sId);
    return res.json({
      status: 'success',
      data: {
        pinSet: await pinSet(user),
        // Lets the UI grey out PIN entry with a countdown instead of
        // letting the user burn attempts that cannot succeed.
        pinLocked: lock.locked,
        pinRetryAfterSec: lock.retryAfterSec,
        // Reset codes go here; showing it stops "which address?" support tickets.
        resetEmail: user.sEmail || null,
        canResetPinByEmail: !!user.sEmail,
      },
    });
  } catch (err) {
    logger.error('getSecurityStatus failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load your security settings.' });
  }
}

// ---------- POST /api/profile/change-password ----------

export async function changePassword(req, res) {
  try {
    const user = req.user;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ status: 'fail', msg: 'Enter your current and new password.' });
    }
    if (String(newPassword).length < 6) {
      return res.status(422).json({ status: 'fail', msg: 'New password must be at least 6 characters.' });
    }
    if (String(newPassword) === String(currentPassword)) {
      return res.status(422).json({ status: 'fail', msg: 'New password must be different from your current one.' });
    }

    // Re-prove the password: a live session alone must not be enough.
    const ok = isBcryptHash(user.sPass)
      ? await verifyPassword(currentPassword, user.sPass)
      : String(user.sPass) === String(currentPassword);
    if (!ok) {
      logger.warn('Password change refused — wrong current password', { sId: user.sId });
      // 422, not 401: this is a wrong field, not a dead session.
      return res.status(422).json({ status: 'fail', msg: 'Your current password is incorrect.' });
    }

    user.sPass = await hashPassword(newPassword);
    // Sign out everywhere else. If the change was prompted by a suspected
    // compromise, leaving the intruder's session alive defeats the point.
    user.sTokenVersion = (user.sTokenVersion || 0) + 1;
    await user.save();

    logger.info('Password changed from profile', { sId: user.sId });
    notify(user, 'Password Changed', 'your password was just changed and you have been signed out on other devices.');

    return res.json({
      status: 'success',
      // The caller's own token is now stale too — the UI must re-authenticate.
      msg: 'Password updated. Please sign in again with your new password.',
      reauth: true,
    });
  } catch (err) {
    logger.error('changePassword failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not change your password.' });
  }
}

// ---------- POST /api/profile/set-pin ----------

/** First-time PIN creation. Authorised by the account password. */
export async function setPin(req, res) {
  try {
    const user = req.user;
    const { password, pin } = req.body;

    if (await pinSet(user)) {
      // Route them to change-pin, which requires the CURRENT pin. Otherwise
      // this endpoint would be a password-only way to overwrite a known PIN.
      return res.status(409).json({
        status: 'fail',
        msg: 'You already have a PIN. Use "Change PIN", or reset it by email if you have forgotten it.',
      });
    }
    if (!password) {
      return res.status(400).json({ status: 'fail', msg: 'Enter your account password to set a PIN.' });
    }
    const bad = invalidPin(pin);
    if (bad) return res.status(422).json({ status: 'fail', msg: bad });

    const ok = isBcryptHash(user.sPass)
      ? await verifyPassword(password, user.sPass)
      : String(user.sPass) === String(password);
    if (!ok) {
      return res.status(422).json({ status: 'fail', msg: 'Your password is incorrect.' });
    }

    user.sPin = await hashPassword(String(pin));
    // sPinStatus is NOT touched: in the legacy schema it means "PIN
    // disabled at checkout", so writing it here would switch the PIN off.
    await user.save();

    logger.info('Transaction PIN set', { sId: user.sId });
    notify(user, 'Transaction PIN Set', 'a transaction PIN was just set on your account.');

    return res.json({ status: 'success', msg: 'Transaction PIN set.' });
  } catch (err) {
    logger.error('setPin failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not set your PIN.' });
  }
}

// ---------- POST /api/profile/change-pin ----------

export async function changePin(req, res) {
  try {
    const user = req.user;
    const { currentPin, newPin } = req.body;

    if (!currentPin || !newPin) {
      return res.status(400).json({ status: 'fail', msg: 'Enter your current and new PIN.' });
    }
    const bad = invalidPin(newPin);
    if (bad) return res.status(422).json({ status: 'fail', msg: bad });
    if (String(currentPin) === String(newPin)) {
      return res.status(422).json({ status: 'fail', msg: 'New PIN must be different from your current one.' });
    }

    // Reuses the shared guard so this endpoint is covered by the same
    // lockout as every purchase — otherwise it would be an unthrottled
    // oracle for grinding the PIN.
    const check = await verifyUserPin(user, String(currentPin));
    if (check.locked) {
      return res.status(429).json({
        status: 'fail',
        msg: `Too many incorrect PIN attempts. Try again in ${Math.ceil(check.retryAfterSec / 60)} minute(s).`,
        retryAfterSec: check.retryAfterSec,
      });
    }
    if (!check.ok) {
      return res.status(422).json({ status: 'fail', msg: 'Your current PIN is incorrect.' });
    }

    user.sPin = await hashPassword(String(newPin));
    // sPinStatus is NOT touched — see setPin() for why.
    await user.save();

    logger.info('Transaction PIN changed', { sId: user.sId });
    notify(user, 'Transaction PIN Changed', 'your transaction PIN was just changed.');

    return res.json({ status: 'success', msg: 'Transaction PIN updated.' });
  } catch (err) {
    logger.error('changePin failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not change your PIN.' });
  }
}

// ---------- POST /api/profile/pin/request-reset ----------

/**
 * Forgot the PIN. Proof of control moves to the email on file, because the
 * user by definition cannot supply the current PIN.
 *
 * No enumeration concern here (the session already identifies the account),
 * so unlike forgot-password this can report a missing email honestly.
 */
export async function requestPinReset(req, res) {
  try {
    const user = req.user;
    if (!user.sEmail) {
      return res.status(422).json({
        status: 'fail',
        msg: 'No email address on your account. Please contact support to reset your PIN.',
      });
    }

    const cool = await resendCooldown(user.sId, PURPOSE.PIN_RESET);
    if (cool.blocked) {
      return res.status(429).json({
        status: 'fail',
        msg: `Please wait ${cool.retryAfterSec}s before requesting another code.`,
        retryAfterSec: cool.retryAfterSec,
      });
    }

    const { code } = await issueCode(user.sId, PURPOSE.PIN_RESET, { ip: req.ip });
    const minutes = Math.round(OTP_TTL_MS / 60000);

    try {
      await sendEmail({
        to: user.sEmail,
        subject: `PIN Reset Code (${SITE_NAME})`,
        text: `Hi ${user.sFname || 'there'},\n\nYour PIN reset code is: ${code}\n\n`
          + `It expires in ${minutes} minutes. If you did not request this, ignore this email — `
          + `your PIN has not changed.\n\n${SITE_NAME} Team`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h2 style="margin:0 0 10px">Reset Your Transaction PIN</h2>
  <p>Hi <strong>${user.sFname || 'there'}</strong>, use this code to set a new PIN:</p>
  <div style="background:#f0f0f0;padding:15px;text-align:center;font-size:28px;font-weight:bold;letter-spacing:6px;border-radius:8px">${code}</div>
  <p style="margin-top:14px">It expires in <strong>${minutes} minutes</strong>.</p>
  <p style="color:#555">If you did not request this, ignore this email — your PIN has not changed.</p>
</div>`,
      });
    } catch (mailErr) {
      logger.error('PIN reset email failed to send', { sId: user.sId, error: mailErr.message, stack: mailErr.stack });
      return res.status(502).json({
        status: 'fail',
        msg: 'We could not send the email just now. Please try again in a moment.',
      });
    }

    return res.json({
      status: 'success',
      msg: `We sent a 6-digit code to ${user.sEmail}. It expires in ${minutes} minutes.`,
    });
  } catch (err) {
    logger.error('requestPinReset failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not start the PIN reset.' });
  }
}

// ---------- POST /api/profile/pin/reset ----------

export async function resetPin(req, res) {
  try {
    const user = req.user;
    const { code, newPin } = req.body;

    if (!code || !newPin) {
      return res.status(400).json({ status: 'fail', msg: 'Enter the code and your new PIN.' });
    }
    const bad = invalidPin(newPin);
    if (bad) return res.status(422).json({ status: 'fail', msg: bad });

    const check = await verifyCode(user.sId, PURPOSE.PIN_RESET, code);
    if (!check.ok) {
      switch (check.reason) {
        case 'no_code':
          return res.status(400).json({ status: 'fail', msg: 'No active code. Please request a new one.' });
        case 'expired':
          return res.status(400).json({ status: 'fail', msg: 'That code has expired. Please request a new one.' });
        case 'too_many_attempts':
          return res.status(429).json({ status: 'fail', msg: 'Too many incorrect attempts. Please request a new code.' });
        default:
          return res.status(422).json({ status: 'fail', msg: 'Incorrect code. Please check and try again.' });
      }
    }

    user.sPin = await hashPassword(String(newPin));
    // sPinStatus is NOT touched — see setPin() for why.
    await user.save();

    logger.info('Transaction PIN reset via email code', { sId: user.sId });
    notify(user, 'Transaction PIN Reset', 'your transaction PIN was just reset using an email code.');

    return res.json({ status: 'success', msg: 'Transaction PIN updated.' });
  } catch (err) {
    logger.error('resetPin failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not reset your PIN.' });
  }
}
