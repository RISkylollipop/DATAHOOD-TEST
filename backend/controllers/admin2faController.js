// ============================================================
//  admin2faController.js — authenticator-app 2FA for admin accounts
// ------------------------------------------------------------
//  Three surfaces:
//    ENROL   (session required)  setup -> confirm -> backup codes
//    LOGIN   (no session yet)    password -> challenge -> code -> token
//    DISABLE (session required)  emailed OTP + password
//
//  THE LOAD-BEARING DECISION IS THE CHALLENGE TOKEN.
//
//  When an admin with 2FA enabled passes the password check, they must not
//  receive an ordinary admin JWT — that token is already enough to reach
//  every admin route, so handing it over before the second factor makes 2FA
//  decorative: an attacker with a stolen password ignores the prompt and
//  calls the API directly. Instead they get a token whose `role` is
//  CHALLENGE_ROLE, which requireAdmin rejects (it demands role === 'admin'),
//  scoped to one login attempt and expiring in minutes.
//
//  Everything else here follows from that:
//   * The challenge carries `pwdRef`, a fingerprint of the password hash it
//     was minted against. Change the password and outstanding challenges
//     die, so a challenge captured before a compromise-response password
//     change cannot still be redeemed after it.
//   * The challenge carries `tfaRef` likewise for the 2FA secret, so
//     re-enrolling invalidates challenges tied to the old authenticator.
//   * decryptSecret THROWS on a rotated APP_ENCRYPTION_KEY. Uncaught that
//     is a 500 on the login route — an admin locked out of their own panel
//     by an unreadable secret, with no explanation. Every read is wrapped
//     and answers "re-enrol" instead.
//   * TOTP replay: utils/totp.js returns the step it matched, and the
//     accepted step is persisted to sysTotpLastStep. Without that the same
//     six digits work for the whole ~90s drift window.
// ============================================================

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { SysUser } from '../models/index.js';
import {
  generateSecret,
  verifyCode as verifyTotp,
  otpauthUrl,
  formatSecretForDisplay,
  generateBackupCodes,
  normalizeBackupCode,
} from '../utils/totp.js';
import { qrToSvg } from '../utils/qrcode.js';
import {
  encryptSecret,
  decryptSecret,
  hashPassword,
  verifyPassword,
  isBcryptHash,
  hashToken,
} from '../utils/crypto.js';
import {
  issueCode,
  verifyCode as verifyOtp,
  resendCooldown,
  PURPOSE,
  ACTOR,
} from '../services/otpService.js';
import { sendEmail } from '../services/emailService.js';
import { signSessionToken } from '../utils/sessionToken.js';
import { audit, auditAsync } from '../utils/auditLog.js';
import * as logger from '../utils/logger.js';

dotenv.config();

// A role no other middleware accepts. requireAdmin checks
// `decoded.role !== 'admin'` and 403s, which is exactly what we want: this
// token can reach the 2FA verify route and nothing else.
const CHALLENGE_ROLE = 'admin_2fa_pending';

// Short on purpose. This is the window in which a stolen password is one
// factor away from a session, so it should be long enough to open an
// authenticator app and no longer.
const CHALLENGE_TTL = '5m';

/**
 * Fingerprint a stored credential so a challenge can be invalidated when
 * the credential changes. Truncated hash, never the value itself — the JWT
 * payload is readable by anyone holding the token.
 */
function credRef(value) {
  return hashToken(String(value || '')).slice(0, 16);
}

function signChallenge(admin) {
  return jwt.sign(
    {
      sysId: admin.sysId,
      role: CHALLENGE_ROLE,
      pwdRef: credRef(admin.sysToken),
      tfaRef: credRef(admin.sysTotpSecret),
    },
    process.env.JWT_SECRET,
    { expiresIn: CHALLENGE_TTL }
  );
}

function signAdminToken(admin) {
  // signSessionToken, not a local expiresIn: this is a SESSION token and its
  // life is the 15-minute idle window that auth middleware slides forward.
  // It used to read `process.env.JWT_EXPIRES_IN || '15m'`, which meant the
  // 15 minutes never applied — .env.example ships JWT_EXPIRES_IN=7d.
  return signSessionToken(
    // `tv` must be present on EVERY admin token. requireAdmin compares it
    // against sysTokenVersion, so a token minted without it reads as version
    // 0 and stops working the moment that admin's version is ever bumped.
    { sysId: admin.sysId, role: 'admin', tv: admin.sysTokenVersion || 0 }
  );
}

function adminPublic(admin) {
  return {
    sysId: admin.sysId,
    name: admin.sysName,
    username: admin.sysUsername,
    role: admin.sysRole,
    email: admin.sysEmail || null,
    phone: admin.sysPhone || null,
    totpEnabled: Number(admin.sysTotpEnabled) === 1,
  };
}

/**
 * Read and decrypt a stored TOTP secret.
 *
 * Returns null rather than throwing when the envelope cannot be opened —
 * which happens for real when APP_ENCRYPTION_KEY is rotated or the row is
 * truncated. The caller must treat null as "2FA is unusable, let them in
 * via a recovery path or ask them to re-enrol", NOT as "wrong code".
 */
function readSecret(admin) {
  if (!admin.sysTotpSecret) return null;
  try {
    const plain = decryptSecret(admin.sysTotpSecret);
    return plain || null;
  } catch (err) {
    // Deliberately does not log the ciphertext or the key state.
    logger.error('TOTP secret could not be decrypted', {
      sysId: admin.sysId,
      error: err.message, stack: err.stack,
    });
    return null;
  }
}

// ============================================================
//  ENROLMENT — two phases, and the gap between them is the point
// ------------------------------------------------------------
//  setup() mints a secret, stores it encrypted, and leaves
//  sysTotpEnabled at 0. confirm() requires a live code from the
//  authenticator before flipping the flag.
//
//  Storing the secret and enabling in one step would lock an admin out of
//  their own panel on a mis-scan: the server would demand codes from an
//  authenticator that never actually received the secret, and the only way
//  back in is a DB edit. The unconfirmed secret sitting in the row is inert
//  — nothing reads it while sysTotpEnabled is 0.
// ============================================================

/**
 * POST /api/auth/admin/2fa/setup   (requireAdmin)
 *
 * Generates a fresh secret and returns the QR + manual-entry key.
 * Safe to call repeatedly: each call REPLACES an unconfirmed secret, which
 * is what an admin who scanned into the wrong app needs.
 */
export async function setup(req, res) {
  try {
    const admin = await SysUser.scope('withSecrets').findByPk(req.admin.sysId);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    // Re-enrolling while 2FA is live would let anyone holding a hijacked
    // session quietly swap the second factor onto their own phone. Make
    // them disable it first, which costs an emailed OTP + the password.
    if (Number(admin.sysTotpEnabled) === 1) {
      return res.status(409).json({
        status: 'fail',
        msg: 'Two-factor authentication is already enabled. Disable it first to re-enrol a new device.',
      });
    }

    // Enrolling without a mailbox is a ONE-WAY DOOR, so it is refused here
    // rather than at removal time. disable() requires an emailed OTP and
    // requestDisable() 409s permanently when sysEmail is null — so an admin
    // who enrols without one keeps 2FA until they either produce a code from
    // the phone or spend the ten backup codes, after which the only remaining
    // path is someone editing the database. The UI hides the button for the
    // same reason, but the API is directly callable and this is the gate that
    // actually holds.
    if (!admin.sysEmail) {
      return res.status(409).json({
        status: 'fail',
        msg: 'Add an email address to this account before enabling two-factor authentication. Without one it could not be switched off again if you lost your phone.',
      });
    }

    const secret = generateSecret();
    const account = admin.sysEmail || admin.sysUsername;
    const uri = otpauthUrl({ secret, account });

    admin.sysTotpSecret = encryptSecret(secret);
    admin.sysTotpConfirmedAt = null;
    admin.sysTotpLastStep = null;
    await admin.save();

    logger.info('Admin 2FA setup started', { sysId: admin.sysId });

    // SVG rather than a PNG: no image pipeline, no binary in the JSON, and
    // it stays sharp on the high-DPI phone screens this is about to be
    // photographed from. Handed over as a base64 data URL so the client can
    // put it in an <img src> instead of injecting markup into the document —
    // an <img> cannot execute script even if this string is ever wrong.
    const qrSvg = qrToSvg(uri, { scale: 6 });
    const qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(qrSvg, 'utf8').toString('base64')}`;

    return res.json({
      status: 'success',
      data: {
        qrDataUrl,
        // For the manual-entry path when a camera won't cooperate.
        manualKey: formatSecretForDisplay(secret),
        account,
      },
    });
  } catch (err) {
    logger.error('Admin 2FA setup failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not start two-factor setup' });
  }
}

/**
 * POST /api/auth/admin/2fa/confirm   (requireAdmin)  { code }
 *
 * Verifies a live code against the pending secret, enables 2FA, and
 * returns the backup codes ONCE.
 */
export async function confirm(req, res) {
  try {
    const admin = await SysUser.scope('withSecrets').findByPk(req.admin.sysId);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    if (Number(admin.sysTotpEnabled) === 1) {
      return res.status(409).json({ status: 'fail', msg: 'Two-factor authentication is already enabled' });
    }

    const secret = readSecret(admin);
    if (!secret) {
      return res.status(409).json({
        status: 'fail',
        msg: 'No pending two-factor setup was found. Start the setup again.',
      });
    }

    const result = verifyTotp(secret, req.body?.code, { lastStep: admin.sysTotpLastStep });
    if (!result.ok) {
      // 422, never 401: a 401 here trips the frontend's auto-logout in
      // client.js and throws the admin out of the flow they are completing.
      return res.status(422).json({
        status: 'fail',
        msg: result.reason === 'malformed'
          ? 'Enter the 6-digit code from your authenticator app'
          : 'That code is not correct. Check your phone clock and try the current code.',
      });
    }

    // Plaintext exactly once, in this response. Only the hashes persist, so
    // a database read cannot recover them.
    const backupCodes = generateBackupCodes(10);
    const hashed = await Promise.all(
      backupCodes.map((c) => hashPassword(normalizeBackupCode(c)))
    );

    admin.sysTotpEnabled = 1;
    admin.sysTotpConfirmedAt = new Date();
    admin.sysTotpLastStep = result.step; // burn the confirming code
    admin.sysBackupCodes = JSON.stringify(hashed);
    // Evict every OTHER admin session for this account.
    //
    // Admins usually reach for 2FA precisely because they think somebody is
    // already in the account. Without this, that somebody keeps their stolen
    // token for the rest of its seven days and never sees a code prompt —
    // the new second factor guards a door they are already through.
    //
    // The acting session must survive, so a replacement token is minted from
    // the NEW version and returned below. The caller has to adopt it; the
    // very next admin request made with the old token gets a 401, and on this
    // screen a 401 wipes the token and unmounts the component that is holding
    // the only copy of the backup codes.
    admin.sysTokenVersion = (admin.sysTokenVersion || 0) + 1;
    await admin.save();

    logger.info('Admin 2FA enabled, other sessions evicted', { sysId: admin.sysId });

    if (admin.sysEmail) {
      // Security-event notice. If this arrives unexpectedly, the account is
      // already compromised and the admin needs to know now.
      sendEmail({
        to: admin.sysEmail,
        subject: 'Two-factor authentication enabled',
        text: `Two-factor authentication was just enabled on your DATAHOOD admin account (${admin.sysUsername}).\n\nIf this was not you, contact your system administrator immediately.`,
      }).catch((e) => logger.error('2FA enable notice failed to send', { error: e.message }));
    }

    return res.json({
      status: 'success',
      msg: 'Two-factor authentication is now enabled',
      // `token` is not optional for the client: the bump above just killed
      // the one it authenticated this request with.
      data: { backupCodes, token: signAdminToken(admin), admin: adminPublic(admin) },
    });
  } catch (err) {
    logger.error('Admin 2FA confirm failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not enable two-factor authentication' });
  }
}

// ============================================================
//  LOGIN — redeeming a challenge for a real session
// ------------------------------------------------------------
//  Reached with NO session: the caller holds only the challenge minted by
//  adminLogin after a correct password. Everything is re-derived from the
//  database on each call; nothing is trusted from the token body beyond
//  the signature and the two credential fingerprints.
// ============================================================

/**
 * Validate a challenge token and load the admin it names.
 * Returns { admin } or { error: {code, msg} } — never throws for bad input.
 */
async function openChallenge(rawChallenge) {
  if (typeof rawChallenge !== 'string' || !rawChallenge) {
    return { error: { code: 400, msg: 'Your sign-in session is missing. Please log in again.' } };
  }

  let decoded;
  try {
    decoded = jwt.verify(rawChallenge, process.env.JWT_SECRET);
  } catch {
    // Covers both tampering and ordinary expiry. 400 rather than 401 so the
    // frontend shows "start again" instead of bouncing through auto-logout.
    return { error: { code: 400, msg: 'Your sign-in session has expired. Please log in again.' } };
  }

  // The whole point of the distinct role. A full admin token must not be
  // usable here — if it were, this route would be a way to launder an
  // already-valid session past nothing at all.
  if (decoded.role !== CHALLENGE_ROLE) {
    return { error: { code: 400, msg: 'Your sign-in session is not valid. Please log in again.' } };
  }

  const admin = await SysUser.scope('withSecrets').findByPk(decoded.sysId);
  if (!admin) {
    return { error: { code: 400, msg: 'Your sign-in session is not valid. Please log in again.' } };
  }

  // Credential fingerprints. A challenge minted before a password change or
  // a 2FA re-enrol is dead — which is exactly what an admin responding to a
  // suspected compromise expects "change the password" to mean.
  if (decoded.pwdRef !== credRef(admin.sysToken) || decoded.tfaRef !== credRef(admin.sysTotpSecret)) {
    logger.warn('Stale 2FA challenge rejected', { sysId: admin.sysId });
    return { error: { code: 400, msg: 'Your credentials changed. Please log in again.' } };
  }

  if (Number(admin.sysTotpEnabled) !== 1) {
    return { error: { code: 400, msg: 'Two-factor authentication is not enabled on this account.' } };
  }

  return { admin };
}

/**
 * Consume a single-use backup code.
 *
 * Compares against every stored hash even after a match, then removes the
 * one that matched. Bailing early on a hit would leak, through response
 * time, roughly where in the list the code sat.
 */
async function consumeBackupCode(admin, submitted) {
  const normalized = normalizeBackupCode(submitted);
  if (!normalized) return false;

  let stored;
  try {
    stored = JSON.parse(admin.sysBackupCodes || '[]');
  } catch {
    stored = [];
  }
  if (!Array.isArray(stored) || stored.length === 0) return false;

  let matchIndex = -1;
  for (let i = 0; i < stored.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await verifyPassword(normalized, stored[i]);
    if (ok && matchIndex === -1) matchIndex = i;
  }
  if (matchIndex === -1) return false;

  stored.splice(matchIndex, 1);
  admin.sysBackupCodes = JSON.stringify(stored);
  return true;
}

/**
 * POST /api/auth/admin/2fa/verify   (no session)  { challenge, code }
 *
 * Accepts either a 6-digit authenticator code or a backup code, and on
 * success issues the real admin token.
 */
export async function verifyLogin(req, res) {
  try {
    const { admin, error } = await openChallenge(req.body?.challenge);
    if (error) return res.status(error.code).json({ status: 'fail', msg: error.msg });

    const submitted = String(req.body?.code ?? '').trim();
    if (!submitted) {
      return res.status(422).json({ status: 'fail', msg: 'Enter your 6-digit code' });
    }

    const secret = readSecret(admin);
    let usedBackup = false;

    if (secret) {
      const result = verifyTotp(secret, submitted, { lastStep: admin.sysTotpLastStep });
      if (result.ok) {
        // Burn the step BEFORE issuing the token. utils/totp.js is explicit
        // that omitting lastStep makes the same six digits reusable for the
        // whole ~90s drift window.
        admin.sysTotpLastStep = result.step;
      } else {
        usedBackup = await consumeBackupCode(admin, submitted);
        if (!usedBackup) {
          logger.warn('Admin 2FA code rejected', { sysId: admin.sysId, reason: result.reason });
          return res.status(422).json({
            status: 'fail',
            msg: 'That code is not correct. Use the current code from your authenticator app, or a backup code.',
          });
        }
      }
    } else {
      // The secret exists but will not decrypt — a rotated APP_ENCRYPTION_KEY,
      // typically. The authenticator cannot help now, so backup codes are the
      // only way back in. They are bcrypt hashes and do not depend on that key.
      usedBackup = await consumeBackupCode(admin, submitted);
      if (!usedBackup) {
        return res.status(422).json({
          status: 'fail',
          msg: 'Your two-factor secret could not be read on the server. Use a backup code to sign in, then re-enrol your authenticator app.',
        });
      }
    }

    await admin.save();

    if (usedBackup) {
      let remaining = 0;
      try { remaining = JSON.parse(admin.sysBackupCodes || '[]').length; } catch { remaining = 0; }
      logger.warn('Admin signed in with a backup code', { sysId: admin.sysId, remaining });

      if (admin.sysEmail) {
        sendEmail({
          to: admin.sysEmail,
          subject: 'Backup code used to sign in',
          text: `A backup code was just used to sign in to your DATAHOOD admin account (${admin.sysUsername}). ${remaining} backup code(s) remain.\n\nIf this was not you, change your password immediately.`,
        }).catch((e) => logger.error('Backup-code notice failed to send', { error: e.message }));
      }
    }

    logger.info('Admin 2FA verified', { sysId: admin.sysId, usedBackup });

    return res.json({
      status: 'success',
      data: {
        token: signAdminToken(admin),
        admin: adminPublic(admin),
        usedBackupCode: usedBackup,
      },
    });
  } catch (err) {
    logger.error('Admin 2FA verify failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not verify your code' });
  }
}

// ============================================================
//  DISABLE — deliberately harder than enabling
// ------------------------------------------------------------
//  Turning 2FA off removes the protection that a stolen session token
//  cannot bypass, so a hijacked session must not be enough on its own.
//  Two extra factors are required: the account password (which the session
//  token does not contain) and an emailed OTP (which needs the mailbox).
//  The email also functions as an alarm — an admin who did not ask for this
//  finds out that someone is inside their session.
// ============================================================

/**
 * POST /api/auth/admin/2fa/disable/request   (requireAdmin)
 * Mails a one-time code to the admin's verified address.
 */
export async function requestDisable(req, res) {
  try {
    const admin = await SysUser.findByPk(req.admin.sysId);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    if (Number(admin.sysTotpEnabled) !== 1) {
      return res.status(409).json({ status: 'fail', msg: 'Two-factor authentication is not enabled' });
    }
    if (!admin.sysEmail) {
      // No mailbox means no out-of-band factor, so there is no safe way to
      // do this over the API. A DB edit by someone with server access is the
      // correct remaining path, and that is a much higher bar than a stolen
      // session token.
      return res.status(409).json({
        status: 'fail',
        msg: 'This account has no verified email address, so two-factor authentication cannot be disabled online. Contact your system administrator.',
      });
    }

    const cooldown = await resendCooldown(admin.sysId, PURPOSE.ADMIN_2FA_DISABLE, {
      actorType: ACTOR.SYSUSER,
    });
    if (cooldown.blocked) {
      return res.status(429).json({
        status: 'fail',
        msg: `Please wait ${cooldown.retryAfterSec}s before requesting another code.`,
      });
    }

    const { code } = await issueCode(admin.sysId, PURPOSE.ADMIN_2FA_DISABLE, {
      ip: req.ip,
      actorType: ACTOR.SYSUSER,
    });

    await sendEmail({
      to: admin.sysEmail,
      subject: 'Code to disable two-factor authentication',
      text: `Your code to disable two-factor authentication on your DATAHOOD admin account is ${code}. It expires in 10 minutes.\n\nIf you did not request this, someone may have access to your account. Change your password immediately and do NOT share this code.`,
    });

    return res.json({
      status: 'success',
      msg: 'We sent a code to your registered email address',
    });
  } catch (err) {
    logger.error('Admin 2FA disable request failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not send the code' });
  }
}

/**
 * POST /api/auth/admin/2fa/disable   (requireAdmin)  { password, otp }
 */
export async function disable(req, res) {
  try {
    const admin = await SysUser.scope('withSecrets').findByPk(req.admin.sysId);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    if (Number(admin.sysTotpEnabled) !== 1) {
      return res.status(409).json({ status: 'fail', msg: 'Two-factor authentication is not enabled' });
    }

    const password = String(req.body?.password ?? '');
    if (!password) {
      return res.status(422).json({ status: 'fail', msg: 'Enter your password' });
    }

    // Legacy rows may still hold a plaintext password; verifyPassword only
    // understands bcrypt, so guard the shape rather than letting it throw.
    const passwordOk = isBcryptHash(admin.sysToken)
      ? await verifyPassword(password, admin.sysToken)
      : password === admin.sysToken;

    if (!passwordOk) {
      logger.warn('Admin 2FA disable refused: bad password', { sysId: admin.sysId });
      // Someone holding this admin's SESSION but not their password is trying to
      // strip the second factor. That is a stolen-token signature, and it is the
      // reason this refusal gets a durable row and not just a log line.
      auditAsync({
        req,
        action: 'admin.2fa_disable',
        targetType: 'sysuser',
        targetId: admin.sysId,
        outcome: 'fail',
        detail: { reason: 'bad_password' },
      });
      // 422 not 401 — the session is fine, the password was wrong. A 401
      // would log them out mid-flow.
      return res.status(422).json({ status: 'fail', msg: 'That password is not correct' });
    }

    const otpResult = await verifyOtp(
      admin.sysId,
      PURPOSE.ADMIN_2FA_DISABLE,
      req.body?.otp,
      { actorType: ACTOR.SYSUSER }
    );
    if (!otpResult.ok) {
      const status = otpResult.reason === 'too_many_attempts' ? 429 : 422;
      const msg = {
        no_code: 'Request a code first.',
        expired: 'That code has expired. Request a new one.',
        too_many_attempts: 'Too many incorrect attempts. Request a new code.',
        mismatch: 'That code is not correct.',
      }[otpResult.reason] || 'That code is not correct.';
      return res.status(status).json({ status: 'fail', msg });
    }

    admin.sysTotpEnabled = 0;
    admin.sysTotpSecret = null;
    admin.sysTotpConfirmedAt = null;
    admin.sysTotpLastStep = null;
    admin.sysBackupCodes = null; // codes for a removed secret must not linger
    await admin.save();

    logger.warn('Admin 2FA disabled', { sysId: admin.sysId });

    // Awaited, not fire-and-forget: this action has no ledger row, no balance
    // change and no other durable trace, so the record IS the point (see the
    // note on audit() vs auditAsync in utils/auditLog.js). The notification
    // email below is the other half — one tells the admin now, one tells an
    // investigator in three months.
    await audit({
      req,
      action: 'admin.2fa_disable',
      targetType: 'sysuser',
      targetId: admin.sysId,
      detail: { backupCodesCleared: true },
    });

    sendEmail({
      to: admin.sysEmail,
      subject: 'Two-factor authentication disabled',
      text: `Two-factor authentication was just disabled on your DATAHOOD admin account (${admin.sysUsername}).\n\nIf this was not you, change your password immediately and re-enable two-factor authentication.`,
    }).catch((e) => logger.error('2FA disable notice failed to send', { error: e.message }));

    return res.json({
      status: 'success',
      msg: 'Two-factor authentication has been disabled',
      data: { admin: adminPublic(admin) },
    });
  } catch (err) {
    logger.error('Admin 2FA disable failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not disable two-factor authentication' });
  }
}

/**
 * GET /api/auth/admin/2fa/status   (requireAdmin)
 * Lets the settings screen render without a second round trip.
 */
export async function status(req, res) {
  try {
    const admin = await SysUser.scope('withSecrets').findByPk(req.admin.sysId);
    if (!admin) return res.status(404).json({ status: 'fail', msg: 'Account not found' });

    let backupCodesRemaining = 0;
    try { backupCodesRemaining = JSON.parse(admin.sysBackupCodes || '[]').length; } catch { backupCodesRemaining = 0; }

    return res.json({
      status: 'success',
      data: {
        enabled: Number(admin.sysTotpEnabled) === 1,
        confirmedAt: admin.sysTotpConfirmedAt || null,
        backupCodesRemaining,
        // Surfaces the rotated-key case in the UI instead of leaving the
        // admin to discover it at their next login.
        secretReadable: Number(admin.sysTotpEnabled) === 1 ? readSecret(admin) !== null : true,
        canDisableOnline: Boolean(admin.sysEmail),
      },
    });
  } catch (err) {
    logger.error('Admin 2FA status failed', { sysId: req.admin?.sysId, error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load two-factor status' });
  }
}

export { CHALLENGE_ROLE, signChallenge, signAdminToken, adminPublic, readSecret, credRef };
