// ============================================================
//  Privacy Controller — the user's own access + erasure rights
// ------------------------------------------------------------
//  Two endpoints, both behind requireUser, both re-proving the
//  password. The session being valid is not enough for either: a
//  borrowed unlocked phone must not be able to download the whole
//  account or delete it. This mirrors changePassword's stance exactly
//  — sensitive, irreversible actions re-authenticate.
//
//  Status codes follow this codebase's rule: business failures are
//  400/422/429. A 401 would make client.js force-log-out, turning
//  "wrong password" into what looks like a crash. 401 is reserved for
//  a dead token, which is middleware/auth.js's job.
//
//  The heavy lifting — what to include, what to strip, what to keep for
//  the accounting — lives in services/privacyService.js so that the
//  admin-initiated delete and this self-service delete share one
//  implementation and cannot drift apart.
// ============================================================

import { verifyPassword, isBcryptHash } from '../utils/crypto.js';
import { buildExportBundle, eraseSubscriber } from '../services/privacyService.js';
import * as logger from '../utils/logger.js';

// Re-prove the password against either a bcrypt hash or a legacy
// plaintext row (the same tolerance changePassword uses).
async function passwordMatches(user, plain) {
  if (!plain) return false;
  return isBcryptHash(user.sPass)
    ? verifyPassword(plain, user.sPass)
    : String(user.sPass) === String(plain);
}

// ---------- POST /api/profile/data-export ----------
//  POST, not GET: it carries the password in the body. A GET would put
//  it in the query string, which lands in access logs and browser
//  history. The response is still a file download.
//
//  Downloaded as an attachment. Content-Disposition with a filename so
//  the browser saves "datahood-my-data.json" rather than rendering a
//  wall of JSON in a tab.
export async function exportMyData(req, res) {
  try {
    const user = req.user;
    const password = req.body?.password;

    if (!(await passwordMatches(user, password))) {
      logger.warn('Data export refused — wrong password', { sId: user.sId });
      return res.status(422).json({ status: 'fail', msg: 'Please confirm your password to download your data.' });
    }

    const bundle = await buildExportBundle(user.sId);
    if (!bundle) {
      return res.status(404).json({ status: 'fail', msg: 'Account not found.' });
    }

    logger.info('Data export produced', { sId: user.sId });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="datahood-my-data.json"');
    // Pretty-printed: the recipient is a person opening it, not a parser.
    return res.send(JSON.stringify(bundle, null, 2));
  } catch (err) {
    logger.error('exportMyData failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not prepare your data export. Please try again.' });
  }
}

// ---------- POST /api/profile/delete-account ----------
//  body: { password, confirm }
//
//  `confirm` must be the exact word DELETE. The password stops someone
//  else doing it; the typed word stops the account owner doing it by
//  reflex. Both, because the two failure modes are different people.
export async function deleteMyAccount(req, res) {
  try {
    const user = req.user;
    const { password, confirm } = req.body || {};

    if (String(confirm || '').trim().toUpperCase() !== 'DELETE') {
      return res.status(422).json({
        status: 'fail',
        msg: 'Type DELETE to confirm you want to permanently close your account.',
      });
    }
    if (!(await passwordMatches(user, password))) {
      logger.warn('Account deletion refused — wrong password', { sId: user.sId });
      return res.status(422).json({ status: 'fail', msg: 'Your password is incorrect.' });
    }

    const result = await eraseSubscriber(user.sId, { reason: 'user-request' });

    if (!result.ok && result.reason === 'balance-remaining') {
      // Not an error the user did wrong — money is owed to them. Refuse
      // and tell them how to get it out, rather than silently keeping it.
      return res.status(422).json({
        status: 'fail',
        code: 'balance-remaining',
        msg: `Your wallet still holds N${result.balance.toLocaleString('en-NG')}. Please withdraw or spend it before closing your account, so we are not left holding funds we can no longer return to you.`,
      });
    }
    if (!result.ok) {
      return res.status(500).json({ status: 'fail', msg: 'Could not close your account. Please contact support.' });
    }

    // The token this request arrived on is now invalid (eraseSubscriber
    // bumped sTokenVersion). The client should drop it and show the
    // logged-out state; there is nothing left to return to.
    return res.json({
      status: 'success',
      msg: 'Your account has been closed and your personal details erased. Thank you for using DATAHOOD.',
    });
  } catch (err) {
    logger.error('deleteMyAccount failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not close your account. Please try again.' });
  }
}
