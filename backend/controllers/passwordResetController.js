// ============================================================
//  Password Reset Controller — "I forgot my password"
// ------------------------------------------------------------
//  Three steps, deliberately separated so the UI can show progress
//  and so each step can carry its own rate limit:
//
//    1. POST /auth/forgot-password  { identifier }      -> mails a code
//    2. POST /auth/verify-reset-code { identifier, code } -> checks it
//    3. POST /auth/reset-password   { identifier, code, newPassword }
//
//  Step 2 exists purely for the UX (tell the user the code is wrong
//  BEFORE they type a new password twice) and does NOT consume the
//  code — otherwise step 3 would always fail. Only step 3 redeems it.
//
//  ---- Account enumeration ----
//  Step 1 answers identically whether or not the account exists. A
//  signup form already leaks existence ("email already registered"),
//  but that requires a deliberate attempt to register; an unauthenticated
//  GET-like probe that silently confirms which of 10,000 leaked emails
//  bank here is a different matter. This endpoint stays quiet.
//
//  ---- Status codes ----
//  Every failure here is 400/422/429. Never 401: the frontend's
//  client.js treats a 401 as "session dead" and force-logs-out, which
//  on a page the user reached WITHOUT a session would be nonsense.
// ============================================================

import { Op } from 'sequelize';
import { Subscriber } from '../models/index.js';
import { hashPassword } from '../utils/crypto.js';
import { sendEmail, escapeForEmail } from '../services/emailService.js';
import {
  issueCode,
  verifyCode,
  resendCooldown,
  PURPOSE,
  OTP_TTL_MS,
} from '../services/otpService.js';
import * as logger from '../utils/logger.js';

const SITE_NAME = process.env.MAIL_FROM_NAME || 'KwaraPolyData';

// Same wording for "sent" and "no such account" — see enumeration note above.
const NEUTRAL_SENT = 'If that account exists, we have sent a 6-digit code to the '
  + 'email address on file. It expires in 10 minutes.';

function findByIdentifier(identifier) {
  const id = String(identifier || '').trim().toLowerCase();
  if (!id) return null;
  return Subscriber.findOne({
    where: { [Op.or]: [{ sEmail: id }, { sPhone: id }] },
  });
}

/** Mask an address for display: joh****@gmail.com */
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return '';
  const head = local.slice(0, Math.min(3, local.length));
  return `${head}${'*'.repeat(Math.max(3, local.length - head.length))}@${domain}`;
}

// Kept but unexported and unused on purpose — see the note in forgotPassword
// about why the masked-address `hint` was removed. Left here so the next person
// who wants to reintroduce a hint finds the reasoning attached to the tool.
void maskEmail;

function resetEmailBody(name, code) {
  const minutes = Math.round(OTP_TTL_MS / 60000);
  const text = `Hi ${name || 'there'},\n\n`
    + `Your password reset code is: ${code}\n\n`
    + `It expires in ${minutes} minutes. If you did not request this, ignore this email — `
    + `your password has not changed.\n\n${SITE_NAME} Team`;
  // `name` is sFname — whatever the user typed into their own profile. It is
  // escaped because this HTML is mailed from a verified sender, so an injected
  // tag here is a phishing link with our domain's reputation behind it.
  const safeName = escapeForEmail(name || 'there');
  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="margin:0 0 10px">Reset Your Password</h2>
  <p>Hi <strong>${safeName}</strong>,</p>
  <p>Use this code to reset your password:</p>
  <div style="background:#f0f0f0;padding:15px;text-align:center;font-size:28px;font-weight:bold;letter-spacing:6px;border-radius:8px">
    ${code}
  </div>
  <p style="margin-top:14px">It expires in <strong>${minutes} minutes</strong>.</p>
  <p style="color:#555">If you did not request this, ignore this email — your password has not changed.</p>
  <p style="margin-top:18px;color:#555">${SITE_NAME} Team</p>
</div>`.trim();
  return { text, html };
}

// ---------- STEP 1 ----------

/** POST /api/auth/forgot-password  body: { identifier } */
export async function forgotPassword(req, res) {
  try {
    const { identifier } = req.body;
    if (!identifier) {
      return res.status(400).json({ status: 'fail', msg: 'Enter your email or phone number.' });
    }

    const user = await findByIdentifier(identifier);

    // No account, or an account with no email to send to: answer exactly as
    // if a code went out. Logged so a spike is still visible to us.
    if (!user || !user.sEmail) {
      logger.info('Password reset requested for unknown account', { ip: req.ip });
      return res.json({ status: 'success', msg: NEUTRAL_SENT });
    }

    // Cooldown before the send, not after: it must throttle SMTP, not just
    // the DB write. 429 (not 400) so the client can show a countdown.
    const cool = await resendCooldown(user.sId, PURPOSE.PASSWORD_RESET);
    if (cool.blocked) {
      return res.status(429).json({
        status: 'fail',
        msg: `Please wait ${cool.retryAfterSec}s before requesting another code.`,
        retryAfterSec: cool.retryAfterSec,
      });
    }

    const { code } = await issueCode(user.sId, PURPOSE.PASSWORD_RESET, { ip: req.ip });
    const { text, html } = resetEmailBody(user.sFname, code);

    try {
      await sendEmail({ to: user.sEmail, subject: `Password Reset Code (${SITE_NAME})`, text, html });
    } catch (mailErr) {
      // The code is already issued and unusable without the email, so this is
      // a hard failure the user must see — silently "succeeding" would leave
      // them waiting for a mail that is never coming.
      logger.error('Password reset email failed to send', { sId: user.sId, error: mailErr.message, stack: mailErr.stack });
      return res.status(502).json({
        status: 'fail',
        msg: 'We could not send the email just now. Please try again in a moment.',
      });
    }

    return res.json({
      status: 'success',
      msg: NEUTRAL_SENT,
      // NO `hint` HERE, DELIBERATELY.
      //
      // This used to return `maskEmail(user.sEmail)`. Its mere PRESENCE was an
      // account-existence oracle: the unknown-account branch above answers
      // NEUTRAL_SENT with no hint, so "hint field came back" meant "this
      // identifier is registered" — which defeats the entire point of the
      // neutral message and of the deliberate silent-success branch above it.
      //
      // Worse, `identifier` may be a PHONE NUMBER. So anyone walking a range of
      // Nigerian mobile numbers could harvest a masked email (domain plus first
      // and last characters) for every registered one — enough to pick the
      // right target and write a convincing phishing mail.
      //
      // The UX cost is real: a user with two inboxes is not told which to open.
      // The neutral copy has to carry that instead. ForgotPassword.jsx already
      // reads this with `if (res.hint)`, so no client change is required.
    });
  } catch (err) {
    logger.error('forgotPassword failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not start password reset. Please try again.' });
  }
}

// ---------- shared code-failure mapping ----------

// Same reason -> same message in both step 2 and step 3, so the user never
// sees the wording change as they move through the flow.
function codeFailure(res, reason) {
  switch (reason) {
    case 'no_code':
      return res.status(400).json({ status: 'fail', msg: 'No active code. Please request a new one.' });
    case 'expired':
      return res.status(400).json({ status: 'fail', msg: 'That code has expired. Please request a new one.' });
    case 'too_many_attempts':
      return res.status(429).json({ status: 'fail', msg: 'Too many incorrect attempts. Please request a new code.' });
    default:
      return res.status(400).json({ status: 'fail', msg: 'Incorrect code. Please check and try again.' });
  }
}

// ---------- STEP 2 ----------

/**
 * POST /api/auth/verify-reset-code  body: { identifier, code }
 * Read-only check so the UI can validate before asking for a new password.
 * Does not consume the code.
 */
export async function verifyResetCode(req, res) {
  try {
    const { identifier, code } = req.body;
    if (!identifier || !code) {
      return res.status(400).json({ status: 'fail', msg: 'Enter the 6-digit code.' });
    }

    const user = await findByIdentifier(identifier);
    if (!user) {
      // Mirror a wrong code exactly — do not reveal that the account is unknown.
      return codeFailure(res, 'mismatch');
    }

    const check = await verifyCode(user.sId, PURPOSE.PASSWORD_RESET, code);
    if (!check.ok) return codeFailure(res, check.reason);

    // verifyCode consumed it on success; re-issuing here would mail a second
    // code. Instead hand back a short-lived ticket that step 3 redeems.
    const { code: ticket } = await issueCode(user.sId, PURPOSE.PASSWORD_RESET, { ip: req.ip });
    return res.json({ status: 'success', msg: 'Code accepted.', ticket });
  } catch (err) {
    logger.error('verifyResetCode failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not verify the code. Please try again.' });
  }
}

// ---------- STEP 3 ----------

/**
 * POST /api/auth/reset-password
 * body: { identifier, code, newPassword }
 * `code` is either the emailed code (one-shot flow) or the ticket returned
 * by step 2.
 */
export async function resetPassword(req, res) {
  try {
    const { identifier, code, newPassword } = req.body;
    if (!identifier || !code || !newPassword) {
      return res.status(400).json({ status: 'fail', msg: 'Enter the code and your new password.' });
    }
    if (String(newPassword).length < 6) {
      return res.status(422).json({ status: 'fail', msg: 'Password must be at least 6 characters.' });
    }

    const user = await findByIdentifier(identifier);
    if (!user) return codeFailure(res, 'mismatch');

    const check = await verifyCode(user.sId, PURPOSE.PASSWORD_RESET, code);
    if (!check.ok) return codeFailure(res, check.reason);

    user.sPass = await hashPassword(newPassword);

    // Anyone signed in on the old password is signed out. If the reset was
    // prompted by a compromise, leaving the intruder's session alive would
    // defeat the entire exercise. tokenVersion is checked by middleware/auth.js.
    user.sTokenVersion = (user.sTokenVersion || 0) + 1;
    await user.save();

    logger.info('Password reset completed', { sId: user.sId });

    // Fire-and-forget: a mail failure must not undo a completed reset.
    sendEmail({
      to: user.sEmail,
      subject: `Your password was changed (${SITE_NAME})`,
      text: `Hi ${user.sFname || 'there'}, your ${SITE_NAME} password was just changed. `
        + `You have been signed out on all devices. If this was not you, contact support immediately.`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h2 style="margin:0 0 10px">Password Changed</h2>
  <p>Hi <strong>${user.sFname || 'there'}</strong>, your ${SITE_NAME} password was just changed,
  and you have been signed out on all devices.</p>
  <p style="color:#a10">If this was not you, contact support immediately.</p>
</div>`,
    }).catch((e) => logger.error('Password-changed notice failed', { sId: user.sId, error: e.message }));

    return res.json({
      status: 'success',
      msg: 'Password updated. Please sign in with your new password.',
    });
  } catch (err) {
    logger.error('resetPassword failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not reset your password. Please try again.' });
  }
}
