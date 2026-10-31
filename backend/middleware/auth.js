// ============================================================
//  Auth Middleware — JWT verification for users and admins
// ============================================================

import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import { Subscriber, SysUser } from '../models/index.js';
import { renewIfStale } from '../utils/sessionToken.js';
import * as logger from '../utils/logger.js';

dotenv.config();

/**
 * Verify a JWT and attach the decoded payload to req.auth.
 * Accepts "Authorization: Bearer <token>" (and legacy "Token <token>").
 */
function extractToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  if (!header) return null;
  return header.replace(/^Bearer\s+/i, '').replace(/^Token\s+/i, '').trim();
}

/**
 * Require a logged-in USER (subscriber).
 */
export async function requireUser(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ status: 'fail', msg: 'Authorization token is required.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'user') {
      return res.status(403).json({ status: 'fail', msg: 'User access required.' });
    }
    const user = await Subscriber.findByPk(decoded.sId);
    if (!user) {
      return res.status(401).json({ status: 'fail', msg: 'Account not found.' });
    }
    // SECURITY-AUDIT H2: token revocation. Every token carries the token
    // version it was minted at (`tv`). Bumping sTokenVersion on the account
    // (logout-all, password reset, suspected compromise) instantly makes
    // every older token fail this check — even though it hasn't expired yet.
    // Tokens minted before this feature have no `tv`; treat them as 0.
    if ((decoded.tv ?? 0) !== (user.sTokenVersion || 0)) {
      logger.info('Session rejected: token version mismatch', {
        sId: user.sId, tokenTv: decoded.tv ?? 0, accountTv: user.sTokenVersion || 0,
      });
      return res.status(401).json({ status: 'fail', msg: 'Session expired. Please log in again.' });
    }
    // ---------- Blocked account, checked on every request ----------
    //
    // Belt-and-braces behind the login gate. Blocking via
    // userController.changeStatus also bumps sTokenVersion, so the check above
    // already kills live sessions — but that coupling is easy to break: any
    // future path that sets sRegStatus = 1 and forgets the bump would leave a
    // suspended user fully operational until their token expired. Reading the
    // status directly means the block cannot be half-applied.
    //
    // `=== 1` only. See authController.login for why `!== 0` would lock out
    // legitimate legacy accounts.
    //
    // 403, not 401: the token is valid, so a 401 would make the frontend
    // report a dead session and silently log them out with no explanation.
    if (Number(user.sRegStatus) === 1) {
      logger.warn('Request refused: account is blocked', { sId: user.sId });
      return res.status(403).json({
        status: 'fail',
        msg: 'This account has been suspended. Please contact support.',
      });
    }
    req.auth = { sId: user.sId, role: 'user' };
    req.user = user;
    // Slide the 15-minute idle window forward. AFTER every check above, so a
    // session about to be rejected is never handed a fresh token. The claims
    // must match what login mints — `tv` especially, since a renewal that
    // dropped it would read as version 0 and die at the next bump.
    renewIfStale(res, decoded, { sId: user.sId, role: 'user', tv: user.sTokenVersion || 0 });
  } catch (err) {
    // ONLY jwt.verify and findByPk can land here, and the answer differs:
    // an expired or forged token is a genuine 401, but a database failure is
    // ours and must not be dressed up as the user's session going bad.
    if (err.name === 'TokenExpiredError') {
      logger.info('Session rejected: token expired', { expiredAt: err.expiredAt });
      return res.status(401).json({ status: 'fail', msg: 'Session expired. Please log in again.' });
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      // No token value in the log line — it is a live credential.
      logger.warn('Session rejected: token invalid', { reason: err.message });
      return res.status(401).json({ status: 'fail', msg: 'Invalid or expired token.' });
    }
    // Anything else (DB down, driver error) is a server fault. Returning 401
    // here would silently sign every user out during an outage — the client
    // wipes the token on 401 — turning a blip into a mass logout.
    logger.error('requireUser failed', { error: err.message, stack: err.stack });
    return next(err);
  }
  // OUTSIDE the try on purpose. next() runs the rest of the stack
  // synchronously, so a downstream throw used to unwind back into the catch
  // above and be reported as "Invalid or expired token" — a real bug in a
  // controller masquerading as a dead session, which also wiped the token.
  return next();
}

/**
 * Require a logged-in ADMIN (sysuser).
 */
export async function requireAdmin(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ status: 'fail', msg: 'Admin authorization required.' });
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'admin') {
      return res.status(403).json({ status: 'fail', msg: 'Admin access required.' });
    }
    const admin = await SysUser.findByPk(decoded.sysId);
    if (!admin) {
      return res.status(401).json({ status: 'fail', msg: 'Admin account not found.' });
    }
    // Token revocation, mirroring requireUser above. Admin tokens live 7
    // days, so without this an admin who enables 2FA *because* they suspect
    // someone is in their account leaves that someone signed in for the rest
    // of the week — the second factor only guards the front door, and the
    // attacker is already inside. Bumping sysTokenVersion evicts them.
    // Tokens minted before this feature carry no `tv`; treat them as 0.
    if ((decoded.tv ?? 0) !== (admin.sysTokenVersion || 0)) {
      return res.status(401).json({ status: 'fail', msg: 'Session expired. Please log in again.' });
    }
    // Blocked admins. NOTE THE POLARITY: 0 is ACTIVE and anything else is
    // blocked. That is the legacy convention (core/Models/Account.php refuses
    // login on `sysStatus <> 0`), and it is backwards from the usual
    // 1-means-enabled instinct — the live super-admin row is 0. Until now
    // this column was never read anywhere, so the legacy "Block User" button
    // wrote a value that did precisely nothing.
    if (Number(admin.sysStatus) !== 0) {
      return res.status(403).json({ status: 'fail', msg: 'This admin account is not active.' });
    }
    req.auth = { sysId: admin.sysId, role: 'admin', sysRole: admin.sysRole };
    req.admin = admin;
    // Same sliding window as requireUser. Note the claims deliberately EXCLUDE
    // sysRole: signAdminToken never put it in the token either, and the role
    // used for authorisation is read from the database row on every request.
    // Baking it into a token would let a demoted admin keep their old powers
    // until it expired.
    renewIfStale(res, decoded, { sysId: admin.sysId, role: 'admin', tv: admin.sysTokenVersion || 0 });
  } catch (err) {
    // Same three-way split as requireUser: expired, tampered, or our fault.
    if (err.name === 'TokenExpiredError') {
      logger.info('Admin session rejected: token expired', { expiredAt: err.expiredAt });
      return res.status(401).json({ status: 'fail', msg: 'Session expired. Please log in again.' });
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      logger.warn('Admin session rejected: token invalid', { reason: err.message });
      return res.status(401).json({ status: 'fail', msg: 'Invalid or expired admin token.' });
    }
    logger.error('requireAdmin failed', { error: err.message, stack: err.stack });
    return next(err);
  }
  return next(); // outside the try — see the note in requireUser
}

/**
 * Optional auth — attaches req.auth if a valid token is present, but
 * does NOT block the request if absent. Used by the public blacklist
 * submission endpoint so we can tag WHO submitted (user vs anonymous).
 *
 * SECURITY: this performs the SAME revocation and status checks as
 * requireUser/requireAdmin, and never trusts the JWT payload alone.
 *
 * It used to do `jwt.verify` and attach `decoded` unchanged. That was a
 * privilege hole, because blacklistController grants INSTANT approval to
 * `req.auth.role === 'admin'`: a revoked token (sysTokenVersion bumped
 * after a compromise), a blocked admin (sysStatus <> 0), or a token for
 * a deleted account all still counted as an admin here, on a route that
 * needs no authentication at all. The stricter middlewares' checks are
 * worth nothing if a second, laxer door opens onto the same privilege.
 *
 * A token that fails any check is treated as ANONYMOUS rather than
 * rejected — the endpoint is public by design, so the submission still
 * goes through, it just lands as 'pending' like any other.
 */
export async function optionalAuth(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (decoded.role === 'admin') {
      const admin = await SysUser.findByPk(decoded.sysId);
      if (admin
        && (decoded.tv ?? 0) === (admin.sysTokenVersion || 0)
        // Polarity is inverted by legacy convention: 0 is ACTIVE.
        && Number(admin.sysStatus) === 0) {
        req.auth = { sysId: admin.sysId, role: 'admin', sysRole: admin.sysRole };
        req.admin = admin;
      }
      return next();
    }

    if (decoded.role === 'user') {
      const user = await Subscriber.findByPk(decoded.sId);
      // sRegStatus is checked here for the same reason sysStatus is checked in
      // the admin branch above: this middleware promises the SAME checks as
      // requireUser, and requireUser now refuses a blocked account. Without
      // this line a suspended user's submission would still be attributed to
      // their account on a route that needs no login at all — the laxer door
      // onto the same identity.
      if (user
        && (decoded.tv ?? 0) === (user.sTokenVersion || 0)
        && Number(user.sRegStatus) !== 1) {
        req.auth = { sId: user.sId, role: 'user' };
        req.user = user;
      }
      return next();
    }
    // Any other role: anonymous.
  } catch (err) {
    // Ignore — treat as anonymous. No token detail in the log line.
    logger.info('optionalAuth: ignoring invalid token');
  }
  return next();
}
