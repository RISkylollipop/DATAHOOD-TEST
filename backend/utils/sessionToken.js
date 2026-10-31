// ============================================================
//  utils/sessionToken.js — one definition of "how long a session lives"
// ------------------------------------------------------------
//  Requirement: a login times out after 15 minutes of INACTIVITY.
//
//  Inactivity, not age. Those are different timeouts and only one of
//  them is what was asked for:
//
//    absolute  — the token dies 15 minutes after login, full stop.
//                Signs a user out mid-purchase because they were
//                *using* the site, which is the opposite of the point.
//    idle      — the token dies 15 minutes after the LAST request.
//                Someone who walks away is signed out; someone who is
//                working is not.
//
//  A JWT can only express an absolute expiry, so idleness is built by
//  giving each token a 15-minute life and MINTING A FRESH ONE while
//  the holder is active. Keep working and you always hold a token
//  issued in the last few minutes; stop for 15 and the one you hold
//  expires with nothing to replace it.
//
//  WHY THIS IS NOT SIMPLY `expiresIn: '15m'` AT THE LOGIN SITES:
//  they read `process.env.JWT_EXPIRES_IN || '15m'`, and .env.example
//  ships JWT_EXPIRES_IN=7d — so on any install that copied it, the
//  default never applies and sessions last a week. The idle window is
//  therefore its own setting, and session tokens do not consult
//  JWT_EXPIRES_IN at all. One knob, one meaning.
//
//  NOT A SUBSTITUTE FOR THE CLIENT-SIDE IDLE CHECK. Renewal here is
//  driven by HTTP requests, and a request is not proof of a human:
//  AdminNewsletter.jsx polls a sending campaign on a timer, which
//  would hold a session open on an unattended screen. The frontend
//  watches real interaction (frontend/src/utils/idleSession.js) and
//  signs out independently. Two mechanisms, because each covers what
//  the other cannot see — the server cannot see a person, and the
//  client cannot be trusted.
// ============================================================

import jwt from 'jsonwebtoken';

/** Read a positive integer env var, falling back when absent or nonsense. */
function intEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Idle window in SECONDS. 15 minutes unless the operator says otherwise. */
export function idleTtlSeconds() {
  // Read at call time, not at import time: tests and scripts set env after
  // importing, and a value frozen at module load would ignore them.
  return intEnv('SESSION_IDLE_MINUTES', 15) * 60;
}

/**
 * How stale a token must be before it is worth re-minting, as a fraction of
 * the window. At 1/3 of 15 minutes a token is replaced after ~5 minutes of
 * use, so an active session renews at most ~3 times an hour per client
 * instead of once per request.
 *
 * Renewing on EVERY request would work and be simpler, but it means a new
 * token on every page of a dashboard — more signing than needed, and a
 * client that races two requests can store the older of two valid tokens
 * and shorten its own session.
 */
const RENEW_AFTER_FRACTION = 1 / 3;

/**
 * Sign a session token. The ONLY way a user or admin session is minted.
 *
 * @param {object} payload  role + identity + `tv` (token version). `tv` is
 *   not optional in practice: auth middleware compares it to the account's
 *   current version, so a token minted without one reads as version 0 and
 *   dies the moment that account's version is ever bumped.
 */
export function signSessionToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: idleTtlSeconds() });
}

/**
 * Should this token be replaced yet?
 *
 * Pure, and exported so it can be tested without minting anything: given the
 * `iat`/`exp` a token already carries, decide whether enough of its life has
 * been used to be worth a fresh one.
 *
 * @param {object} decoded  verified JWT payload (needs iat and exp)
 * @param {number} nowSec   current unix time in seconds
 */
export function shouldRenew(decoded, nowSec) {
  const iat = Number(decoded?.iat);
  const exp = Number(decoded?.exp);
  if (!Number.isFinite(iat) || !Number.isFinite(exp) || exp <= iat) return false;

  const lifetime = exp - iat;
  const age = nowSec - iat;
  // A token dated in the FUTURE (a clock disagreement between whatever signed
  // it and whatever is reading it) is left alone rather than re-anchored to
  // the wrong clock — that falls out of the arithmetic below, since a
  // negative age can never reach a positive fraction of a positive lifetime.
  // There is no explicit `age < 0` guard because it would be unreachable, and
  // an unreachable guard reads like protection while providing none.
  // jwt.verify already refuses such a token once skew exceeds its tolerance.
  return age >= lifetime * RENEW_AFTER_FRACTION;
}

/**
 * Slide the session forward if it is time to.
 *
 * Called from auth middleware AFTER every check has passed — the account
 * exists, the token version matches, the admin is not blocked. Renewing
 * before those checks would hand out a fresh token to a session that is
 * about to be rejected.
 *
 * The new token goes in a RESPONSE HEADER rather than the body, because
 * every endpoint in the app has its own body shape and none of them should
 * have to know about session plumbing. The header must be listed in the
 * CORS `exposedHeaders` allow-list or the browser will not let the frontend
 * read it — a cross-origin response carries the header, and script access to
 * it is denied by default, so the renewal would be silently dropped and
 * every session would expire at 15 minutes flat. (The frontend and backend
 * are deployed separately here, so this is the normal case, not an edge one.)
 *
 * Never throws: a failure to renew must not fail the request the caller
 * actually made. The worst case is the holder keeps their current token and
 * renews on the next request.
 */
export function renewIfStale(res, decoded, claims) {
  try {
    const nowSec = Math.floor(Date.now() / 1000);
    if (!shouldRenew(decoded, nowSec)) return;
    const token = signSessionToken(claims);
    res.set('X-Session-Token', token);
    // Lets the client show "you will be signed out at ..." without decoding
    // the JWT, and keeps the two sides' idea of the window in step even if
    // SESSION_IDLE_MINUTES is changed on the server.
    res.set('X-Session-Expires-In', String(idleTtlSeconds()));
  } catch {
    // Deliberately silent: this is a best-effort refresh on a request that
    // has already been authorised, and the log line would fire on every
    // request if the cause were configuration.
  }
}

/** Header names, exported so the CORS config cannot drift from the writer. */
export const SESSION_HEADERS = ['X-Session-Token', 'X-Session-Expires-In'];
