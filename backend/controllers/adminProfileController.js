// ============================================================
//  adminProfileController.js — the admin's own account details
// ------------------------------------------------------------
//  This file exists because of a gap I created: admin2faController.setup()
//  refuses enrolment when sysEmail is null (enrolling without a mailbox is a
//  one-way door — see the comment there), but there was nowhere in the panel
//  to SET an email address. The gate was correct and the door behind it did
//  not exist, so 2FA could not be switched on at all.
//
//  ---- Why a live session is not enough for anything here ----
//
//  requireAdmin has already run on every route below, so the caller holds a
//  valid admin token. That is precisely the thing an attacker steals. The
//  admin's own record is the most valuable target in the panel:
//
//    * sysEmail is the RECOVERY CHANNEL. requestDisable() mails the code that
//      switches 2FA off, so whoever controls this address can eventually
//      strip the second factor. Moving it is equivalent to taking the account.
//    * sysToken is the password, which the 2FA challenge is fingerprinted
//      against (pwdRef) — changing it kills outstanding challenges.
//
//  So every write re-proves the current password, which a session token does
//  not contain, and the email change additionally proves control of a
//  mailbox. "Somebody sat down at an unlocked laptop" stops at the first gate.
//
//  ---- Status codes ----
//  400/409/422/429 only. Never 401: the frontend's client.jsx force-logs-out
//  on 401, so answering "wrong password" that way would eject the admin from
//  the form they are filling in and read as a crash. 401 belongs to
//  middleware/auth.js and means "no usable token", nothing else.
// ============================================================

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { Op } from 'sequelize';
import { SysUser } from '../models/index.js';
import {
  hashPassword,
  verifyPassword,
  isBcryptHash,
  timingSafeEqualStr,
  hashToken,
} from '../utils/crypto.js';
import {
  issueCode,
  verifyCode as verifyOtp,
  resendCooldown,
  PURPOSE,
  ACTOR,
  OTP_TTL_MS,
} from '../services/otpService.js';
import { sendEmail } from '../services/emailService.js';
import { signAdminToken, adminPublic } from './admin2faController.js';
import * as logger from '../utils/logger.js';

dotenv.config();

const SITE_NAME = process.env.MAIL_FROM_NAME || 'DATAHOOD';

// The email-change ticket is short-lived on purpose: it is the window in
// which a claimed address is pending, and the codes themselves live 10
// minutes. Fifteen leaves room to fetch the mail without leaving a
// half-finished identity change lying around for an hour.
const EMAIL_TICKET_TTL = '15m';
const EMAIL_TICKET_ROLE = 'admin_email_change';

/**
 * Verify a submitted password against the stored credential.
 *
 * Legacy rows may still hold PLAINTEXT in sysToken (the old PHP compared it
 * directly), and verifyPassword only understands bcrypt — it would throw or
 * silently return false on a non-hash. Guard the shape rather than assuming,
 * and use a timing-safe compare on the legacy branch so this endpoint does
 * not become a character-by-character oracle for the accounts that have not
 * been upgraded yet.
 */
async function passwordMatches(admin, submitted) {
  const password = String(submitted ?? '');
  if (!password) return false;
  return isBcryptHash(admin.sysToken)
    ? verifyPassword(password, admin.sysToken)
    : timingSafeEqualStr(String(admin.sysToken ?? ''), password);
}

/** Load the acting admin WITH secrets — every write here needs sysToken. */
async function loadSelf(req) {
  return SysUser.scope('withSecrets').findByPk(req.admin.sysId);
}

/** Fire-and-forget notice. A mail failure must never undo a completed change. */
function notify(address, subject, body) {
  if (!address) return;
  sendEmail({
    to: address,
    subject: `${subject} (${SITE_NAME})`,
    text: body,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px">
  <h2 style="margin:0 0 10px">${subject}</h2>
  <p>${body.replace(/\n/g, '<br/>')}</p>
</div>`,
  }).catch((e) => logger.error('Admin security notice failed to send', { error: e.message }));
}

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Deliberately permissive. A stricter regex rejects addresses that are
// perfectly valid (plus-addressing, long TLDs, unusual but legal local
// parts), and the real proof that the address works is the code we are
// about to mail to it — which no regex can substitute for.
function looksLikeEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

// ============================================================
//  READ
// ============================================================

/**
 * GET /api/auth/admin/profile   (requireAdmin)
 *
 * Everything the profile screen renders. `canEnable2fa` is computed here
 * rather than in the UI so the screen and admin2faController.setup() cannot
 * disagree about whether enrolment is possible — the button and the gate
 * read from one source.
 */
export async function getProfile(req, res) {
  try {
    const admin = await loadSelf(req);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    return res.json({
      status: 'success',
      data: {
        ...adminPublic(admin),
        // Mirrors the sysEmail gate in admin2faController.setup(). If this is
        // false, the Security screen's enrol button is a dead end.
        canEnable2fa: Boolean(admin.sysEmail),
      },
    });
  } catch (err) {
    logger.error('getProfile (admin) failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load your profile' });
  }
}

// ============================================================
//  DISPLAY DETAILS — name and phone
// ============================================================

/**
 * PUT /api/auth/admin/profile   (requireAdmin)  { currentPassword, name, phone }
 *
 * The password requirement on what look like cosmetic fields is deliberate.
 * sysName is what the panel header and the audit log show, so an attacker who
 * could rewrite it silently could disguise which account is acting. It costs
 * one field to close that, and it keeps a single rule for the whole file:
 * nothing on the admin's own record changes on the strength of a session
 * token alone.
 */
export async function updateProfile(req, res) {
  try {
    const admin = await loadSelf(req);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    if (!(await passwordMatches(admin, req.body?.currentPassword))) {
      logger.warn('Admin profile update refused: bad password', { sysId: admin.sysId });
      return res.status(422).json({ status: 'fail', msg: 'That password is not correct.' });
    }

    const name = String(req.body?.name ?? '').trim();
    const phone = String(req.body?.phone ?? '').trim();

    if (!name) {
      return res.status(422).json({ status: 'fail', msg: 'Enter a display name.' });
    }
    // sysName is VARCHAR(50); sysPhone is VARCHAR(20). Refuse over-length
    // input here rather than letting MySQL truncate it silently — a
    // half-saved phone number is worse than a rejected one.
    if (name.length > 50) {
      return res.status(422).json({ status: 'fail', msg: 'Display name must be 50 characters or fewer.' });
    }
    if (phone && !/^[0-9+\-\s()]{7,20}$/.test(phone)) {
      return res.status(422).json({ status: 'fail', msg: 'Enter a valid phone number.' });
    }

    admin.sysName = name;
    admin.sysPhone = phone || null;
    await admin.save();

    logger.info('Admin profile updated', { sysId: admin.sysId });

    return res.json({
      status: 'success',
      msg: 'Profile updated.',
      data: { admin: adminPublic(admin) },
    });
  } catch (err) {
    logger.error('updateProfile (admin) failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not update your profile' });
  }
}

// ============================================================
//  PASSWORD
// ============================================================

/**
 * POST /api/auth/admin/password   (requireAdmin)
 * body: { currentPassword, newPassword }
 *
 * Bumps sysTokenVersion, which kills every admin token issued before now —
 * INCLUDING the one that authenticated this request. A password change is
 * usually a response to a suspected compromise, and leaving the intruder's
 * seven-day token alive would make it ceremonial.
 *
 * The acting session has to survive, so a replacement token is minted from
 * the new version and returned. The client MUST adopt it: the very next
 * request made with the old token is a 401, and client.jsx turns a 401 into
 * a forced logout. Same contract as admin2faController.confirm().
 */
export async function changePassword(req, res) {
  try {
    const admin = await loadSelf(req);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    const currentPassword = String(req.body?.currentPassword ?? '');
    const newPassword = String(req.body?.newPassword ?? '');

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ status: 'fail', msg: 'Enter your current and new password.' });
    }
    if (newPassword.length < 8) {
      // Eight, not the six subscribers get. This password opens the panel
      // that can move every customer's money.
      return res.status(422).json({ status: 'fail', msg: 'New password must be at least 8 characters.' });
    }
    if (newPassword === currentPassword) {
      return res.status(422).json({ status: 'fail', msg: 'New password must be different from your current one.' });
    }

    if (!(await passwordMatches(admin, currentPassword))) {
      logger.warn('Admin password change refused: bad current password', { sysId: admin.sysId });
      return res.status(422).json({ status: 'fail', msg: 'Your current password is incorrect.' });
    }

    admin.sysToken = await hashPassword(newPassword);
    admin.sysTokenVersion = (admin.sysTokenVersion || 0) + 1;
    await admin.save();

    logger.warn('Admin password changed, other sessions evicted', { sysId: admin.sysId });

    notify(
      admin.sysEmail,
      'Admin password changed',
      `The password on your ${SITE_NAME} admin account (${admin.sysUsername}) was just changed, and every other signed-in device has been signed out.\n\n`
      + 'If this was not you, that account is compromised — contact your system administrator immediately.'
    );

    return res.json({
      status: 'success',
      msg: 'Password updated. Other devices have been signed out.',
      // Not optional for the caller: the bump above just invalidated the
      // token this request arrived with.
      data: { token: signAdminToken(admin) },
    });
  } catch (err) {
    logger.error('changePassword (admin) failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not change your password' });
  }
}

// ============================================================
//  EMAIL — the two-sided gate
// ------------------------------------------------------------
//  Changing sysEmail hands over the 2FA recovery channel, so it is the most
//  dangerous write in this file and the only one that needs more than a
//  password.
//
//    Code to the NEW address   (ADMIN_EMAIL_VERIFY)
//        proves the mailbox exists and is reachable. Without it a typo sends
//        every future recovery code into the void, and 2FA becomes
//        unremovable without a database edit.
//
//    Code to the CURRENT address (ADMIN_PROFILE_UNLOCK)
//        proves the REAL OWNER is present. This is the gate that actually
//        stops a hijacked session: the attacker can prove they control
//        attacker@evil all day, but not that they can read the mailbox the
//        account already points at.
//
//  ---- The bootstrap case, stated plainly ----
//  When sysEmail is NULL there is no current address, so the second code is
//  impossible and the gate is password-only. That is a genuinely weaker
//  moment, and it is acceptable for a specific reason: with no email there
//  is no 2FA (setup() refuses) and no recovery channel to steal, so an
//  attacker who already knows the password holds the whole account either
//  way. The two-sided gate applies from the first address onward.
//
//  ---- Why the pending address travels in a signed ticket ----
//  otp_codes has nowhere to record WHICH address a code was issued for, so a
//  bare (sysId, purpose) code would commit whatever address arrived in the
//  confirm body — a code mailed to one address could enrol another. The
//  ticket binds them cryptographically instead, and needs no new column
//  (there is already an unapplied migration waiting; adding another would
//  widen a window the operator has to close by hand).
// ============================================================

function signEmailTicket(admin, newEmail) {
  return jwt.sign(
    {
      sysId: admin.sysId,
      role: EMAIL_TICKET_ROLE,
      // The claimed address, hashed. The ticket is handed to the browser and
      // a JWT payload is readable by anyone holding it; the address is only
      // ever compared, never read back out, so a fingerprint is enough.
      emailRef: hashToken(newEmail),
      // Ties the ticket to the password it was authorised with. Change the
      // password mid-flow and the pending email change dies with it — the
      // same rule the 2FA challenge follows.
      pwdRef: hashToken(String(admin.sysToken ?? '')).slice(0, 16),
      // Records whether the two-sided gate was in force when the ticket was
      // minted. Read from the ticket rather than re-derived at confirm time
      // so a race (or a second tab) cannot downgrade a two-code change into
      // a one-code change.
      dual: Boolean(admin.sysEmail),
    },
    process.env.JWT_SECRET,
    { expiresIn: EMAIL_TICKET_TTL }
  );
}

/**
 * POST /api/auth/admin/profile/email/request   (requireAdmin)
 * body: { currentPassword, email }
 */
export async function requestEmailChange(req, res) {
  try {
    const admin = await loadSelf(req);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    if (!(await passwordMatches(admin, req.body?.currentPassword))) {
      logger.warn('Admin email change refused: bad password', { sysId: admin.sysId });
      return res.status(422).json({ status: 'fail', msg: 'That password is not correct.' });
    }

    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(422).json({ status: 'fail', msg: 'Enter an email address.' });
    if (!looksLikeEmail(email)) {
      return res.status(422).json({ status: 'fail', msg: 'Enter a valid email address.' });
    }
    if (email.length > 120) {
      return res.status(422).json({ status: 'fail', msg: 'That email address is too long.' });
    }
    if (normalizeEmail(admin.sysEmail) === email) {
      return res.status(409).json({ status: 'fail', msg: 'That is already your email address.' });
    }

    // sysEmail is UNIQUE. Catching the clash here turns a 500 from the
    // database into a sentence the admin can act on — and it happens after
    // the password check, so this cannot be used to probe which addresses
    // are registered.
    const taken = await SysUser.findOne({
      where: { sysEmail: email, sysId: { [Op.ne]: admin.sysId } },
      attributes: ['sysId'],
    });
    if (taken) {
      return res.status(409).json({
        status: 'fail',
        msg: 'Another admin account already uses that email address.',
      });
    }

    const dual = Boolean(admin.sysEmail);

    // One cooldown check per purpose, before anything is issued — otherwise
    // a blocked second send would leave the first code live and the admin
    // holding half a flow.
    for (const purpose of dual
      ? [PURPOSE.ADMIN_EMAIL_VERIFY, PURPOSE.ADMIN_PROFILE_UNLOCK]
      : [PURPOSE.ADMIN_EMAIL_VERIFY]) {
      // eslint-disable-next-line no-await-in-loop
      const cool = await resendCooldown(admin.sysId, purpose, { actorType: ACTOR.SYSUSER });
      if (cool.blocked) {
        return res.status(429).json({
          status: 'fail',
          msg: `Please wait ${cool.retryAfterSec}s before requesting another code.`,
          retryAfterSec: cool.retryAfterSec,
        });
      }
    }

    const minutes = Math.round(OTP_TTL_MS / 60000);

    const { code: newCode } = await issueCode(admin.sysId, PURPOSE.ADMIN_EMAIL_VERIFY, {
      ip: req.ip,
      actorType: ACTOR.SYSUSER,
    });

    // This send is AWAITED and its failure is fatal to the request. If the
    // new address cannot receive mail, the whole point of the exercise has
    // failed and the admin needs to know now rather than after typing a code
    // that will never arrive.
    try {
      await sendEmail({
        to: email,
        subject: `Confirm this email for your ${SITE_NAME} admin account`,
        text: `Your confirmation code is ${newCode}. It expires in ${minutes} minutes.\n\n`
          + `This address was entered as the recovery email for the ${SITE_NAME} admin account "${admin.sysUsername}". `
          + 'If you were not expecting this, ignore this email — nothing has changed.',
      });
    } catch (mailErr) {
      logger.error('Admin email-change code failed to send', {
        sysId: admin.sysId, error: mailErr.message, stack: mailErr.stack,
      });
      return res.status(502).json({
        status: 'fail',
        msg: 'We could not send a code to that address. Check it and try again.',
      });
    }

    if (dual) {
      const { code: ownerCode } = await issueCode(admin.sysId, PURPOSE.ADMIN_PROFILE_UNLOCK, {
        ip: req.ip,
        actorType: ACTOR.SYSUSER,
      });
      // Awaited too. Silently skipping this on a mail failure would drop the
      // gate that stops a hijacked session, leaving a one-code change that
      // LOOKS like a two-code one.
      try {
        await sendEmail({
          to: admin.sysEmail,
          subject: `Approve an email change on your ${SITE_NAME} admin account`,
          text: `Someone is changing the recovery email on your ${SITE_NAME} admin account `
            + `("${admin.sysUsername}") to ${email}.\n\n`
            + `Your approval code is ${ownerCode}. It expires in ${minutes} minutes.\n\n`
            + 'IF THIS WAS NOT YOU, do not share this code. Someone has access to your admin session — '
            + 'change your password immediately and contact your system administrator.',
        });
      } catch (mailErr) {
        logger.error('Admin email-change approval failed to send', {
          sysId: admin.sysId, error: mailErr.message, stack: mailErr.stack,
        });
        return res.status(502).json({
          status: 'fail',
          msg: 'We could not send the approval code to your current address. Please try again in a moment.',
        });
      }
    }

    logger.info('Admin email change requested', { sysId: admin.sysId, dual });

    return res.json({
      status: 'success',
      msg: dual
        ? `We sent a code to ${email} and an approval code to your current address. Both expire in ${minutes} minutes.`
        : `We sent a code to ${email}. It expires in ${minutes} minutes.`,
      data: {
        ticket: signEmailTicket(admin, email),
        email,
        // Tells the UI whether to render one code box or two. The server does
        // not trust this back — `dual` is re-read from the signed ticket.
        approvalRequired: dual,
        currentEmail: admin.sysEmail || null,
      },
    });
  } catch (err) {
    logger.error('requestEmailChange failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not start the email change' });
  }
}

/**
 * POST /api/auth/admin/profile/email/confirm   (requireAdmin)
 * body: { ticket, email, code, approvalCode? }
 */
export async function confirmEmailChange(req, res) {
  try {
    const admin = await loadSelf(req);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    let claims;
    try {
      claims = jwt.verify(String(req.body?.ticket ?? ''), process.env.JWT_SECRET);
    } catch {
      // Covers tampering and ordinary expiry alike. 400, not 401 — the
      // session is fine, it is the half-finished change that has gone stale.
      return res.status(400).json({
        status: 'fail',
        msg: 'This email change has expired. Please start again.',
      });
    }

    // A full admin token must not be usable as a ticket, and a ticket minted
    // for one account must not be redeemable by another.
    if (claims.role !== EMAIL_TICKET_ROLE || claims.sysId !== admin.sysId) {
      return res.status(400).json({ status: 'fail', msg: 'This email change is not valid. Please start again.' });
    }

    if (claims.pwdRef !== hashToken(String(admin.sysToken ?? '')).slice(0, 16)) {
      logger.warn('Stale admin email-change ticket rejected (password changed)', { sysId: admin.sysId });
      return res.status(400).json({
        status: 'fail',
        msg: 'Your password changed while this was in progress. Please start again.',
      });
    }

    const email = normalizeEmail(req.body?.email);
    if (!email || hashToken(email) !== claims.emailRef) {
      // The address the code was mailed to is the only one this ticket can
      // commit. Without this check a code delivered to one mailbox would
      // enrol a different address entirely.
      return res.status(400).json({
        status: 'fail',
        msg: 'This code was issued for a different email address. Please start again.',
      });
    }

    const outcome = (result) => {
      const status = result.reason === 'too_many_attempts' ? 429 : 422;
      const msg = {
        no_code: 'Request a code first.',
        expired: 'That code has expired. Please start again.',
        too_many_attempts: 'Too many incorrect attempts. Please start again.',
        mismatch: 'That code is not correct.',
      }[result.reason] || 'That code is not correct.';
      return { status, msg };
    };

    // Order matters. The APPROVAL code (current address, the real owner) is
    // checked FIRST, so an attacker holding only the new-address code cannot
    // grind the owner's code afterwards — the request stops before their own
    // code is ever spent, and each wrong guess burns one of five attempts on
    // a code they cannot read.
    if (claims.dual) {
      const approval = await verifyOtp(
        admin.sysId,
        PURPOSE.ADMIN_PROFILE_UNLOCK,
        req.body?.approvalCode,
        { actorType: ACTOR.SYSUSER }
      );
      if (!approval.ok) {
        const { status, msg } = outcome(approval);
        return res.status(status).json({ status: 'fail', msg: `Approval code: ${msg.toLowerCase()}` });
      }
    }

    const verify = await verifyOtp(
      admin.sysId,
      PURPOSE.ADMIN_EMAIL_VERIFY,
      req.body?.code,
      { actorType: ACTOR.SYSUSER }
    );
    if (!verify.ok) {
      const { status, msg } = outcome(verify);
      return res.status(status).json({ status: 'fail', msg });
    }

    // Re-check uniqueness at commit time. The request-time check was up to
    // fifteen minutes ago and another admin could have claimed the address
    // since; without this the save throws a raw constraint error and the
    // admin sees "Could not change your email" with no reason.
    const taken = await SysUser.findOne({
      where: { sysEmail: email, sysId: { [Op.ne]: admin.sysId } },
      attributes: ['sysId'],
    });
    if (taken) {
      return res.status(409).json({
        status: 'fail',
        msg: 'Another admin account claimed that email address while this was in progress.',
      });
    }

    const previous = admin.sysEmail;
    admin.sysEmail = email;
    await admin.save();

    logger.warn('Admin email address changed', { sysId: admin.sysId, hadPrevious: Boolean(previous) });

    // The old address is told AFTER the fact as well as before it. If the
    // approval code was obtained by any means we did not anticipate, this is
    // the last chance the real owner gets to notice.
    notify(
      previous,
      'Admin email address changed',
      `The recovery email on your ${SITE_NAME} admin account ("${admin.sysUsername}") was changed to ${email}.\n\n`
      + 'If this was not you, contact your system administrator immediately — recovery codes will now go to that address.'
    );

    return res.json({
      status: 'success',
      msg: 'Email address updated.',
      data: { admin: adminPublic(admin) },
    });
  } catch (err) {
    logger.error('confirmEmailChange failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not change your email address' });
  }
}
