// ============================================================
//  Rate limiters — brute-force protection (SECURITY-AUDIT C3)
// ------------------------------------------------------------
//  A single global limiter (in server.js) is not enough: it is
//  not per-account and is easily out-run by an attacker who
//  rotates IPs or targets one victim. These add STRICT, targeted
//  limits on the sensitive auth endpoints.
//
//  NOTE on proxies: behind Nginx / cPanel these limiters need
//  `app.set('trust proxy', 1)` (set in server.js) so the real
//  client IP is used as the key instead of the proxy's IP.
// ============================================================

import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';

// Shared handler so every limiter returns a clean JSON 429 (no stack,
// nothing sensitive) and logs nothing to console.
function tooMany(res) {
  return res.status(429).json({
    status: 'fail',
    msg: 'Too many attempts. Please wait a few minutes and try again.',
  });
}

// Key by real client IP + the identifier being attacked (email/phone/username),
// so one victim account can't be ground down from many IPs, and one IP can't
// grind many accounts. Falls back to IP-only when no identifier is supplied.
function ipPlusIdentifier(field) {
  return (req) => {
    const id = String((req.body && req.body[field]) || '').trim().toLowerCase();
    return `${req.ip}|${id}`;
  };
}

// User login: 8 attempts / 15 min per (IP + identifier).
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipPlusIdentifier('identifier'),
  handler: (req, res) => tooMany(res),
});

// Admin login: tighter — 5 attempts / 15 min per (IP + username).
export const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipPlusIdentifier('username'),
  handler: (req, res) => tooMany(res),
});

// Registration: 15 new accounts / hour per IP (blunt signup abuse).
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => tooMany(res),
});

// ------------------------------------------------------------
//  Password reset
// ------------------------------------------------------------
//  Two separate concerns, so two separate limiters:
//
//  forgotPasswordLimiter guards the SEND. Each call mails a real person
//  and spends SMTP quota, so this is the mail-bomb control. Keyed by
//  (IP + identifier) so one attacker cannot flood one victim's inbox,
//  and one IP cannot walk a list of addresses. The service layer also
//  enforces a 60s per-account cooldown; this is the outer bound.
export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6, // 6 reset emails per hour per (IP + account)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipPlusIdentifier('identifier'),
  handler: (req, res) => res.status(429).json({
    status: 'fail',
    msg: 'Too many reset requests. Please wait a while before trying again.',
  }),
});

//  resetAttemptLimiter guards the GUESS. A 6-digit code is 1,000,000
//  combinations — trivially brute-forceable at HTTP speed if unbounded.
//  otpService caps attempts per code (5) and expires codes after 10
//  minutes; this stops the cheap bypass of that cap, which is to keep
//  requesting fresh codes and spending 5 guesses on each.
export const resetAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipPlusIdentifier('identifier'),
  handler: (req, res) => tooMany(res),
});

// ------------------------------------------------------------
//  Authenticated PIN reset
// ------------------------------------------------------------
//  Same job as resetAttemptLimiter, but for routes that run AFTER
//  requireUser. Keying on sId rather than (IP + identifier) matters
//  here: those routes carry no `identifier` field, so the IP-based
//  key would collapse to one shared bucket — and Nigerian mobile
//  carriers put thousands of subscribers behind a single CGNAT
//  address. One user resetting their PIN would throttle strangers.
//
//  Falls back to IP only if req.user is somehow absent, which would
//  mean requireUser did not run — fail closed rather than unlimited.
export const pinResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.sId ? `sid:${req.user.sId}` : `ip:${req.ip}`),
  handler: (req, res) => tooMany(res),
});

// ------------------------------------------------------------
//  Admin 2FA code submission
// ------------------------------------------------------------
//  A TOTP code is 1,000,000 combinations, but unlike an emailed OTP it
//  CANNOT be attempt-capped in its own row — there is no row. The code is
//  derived from a shared secret, so the only ceiling on guessing is this
//  limiter. That makes it load-bearing rather than defence-in-depth.
//
//  The window matters: at 30 attempts per 15 minutes an attacker guessing
//  blind against the ~3 codes live at any moment needs an implausible
//  amount of sustained traffic. Remove this and the same attack takes
//  under a day.
//
//  Keyed on the ACCOUNT, not the challenge and not the IP.
//
//  An earlier version keyed on a hash of the challenge token and claimed
//  that "cannot be sidestepped by rotating IPs". That claim was FALSE, and
//  the way it was false is worth remembering: every password submission
//  mints a brand-new challenge (new iat, new signature), so a fresh
//  challenge meant a fresh empty bucket. An attacker who already holds the
//  password could re-login for another 30 guesses as often as they liked,
//  capped only by adminLoginLimiter — which is keyed `ip|username` and so
//  falls to IP rotation. The two limiters covered for each other on paper
//  and neither actually held the line.
//
//  Keying on sysId from the challenge body fixes that: the bucket follows
//  the ACCOUNT UNDER ATTACK, so re-issuing challenges and rotating IPs both
//  buy nothing. jwt.decode (not verify) is correct here — this only needs a
//  grouping key, the signature is checked properly later in openChallenge,
//  and a forged/garbage token simply lands in the malformed bucket below.
//
//  The cost of an account-keyed bucket is that an attacker who knows a
//  username can lock that admin out of 2FA for 15 minutes. That is
//  accepted: it requires the password too (a challenge is only minted
//  after a correct one), and a temporary lockout is a far better failure
//  than a bypass.
export const admin2faLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Authenticated management routes (setup/confirm/disable) — the session
    // already names the account.
    if (req.admin?.sysId) return `2fa:sys:${req.admin.sysId}`;

    const ch = req.body?.challenge;
    if (typeof ch === 'string' && ch.length > 0) {
      try {
        const claims = jwt.decode(ch);
        if (claims?.sysId) return `2fa:sys:${claims.sysId}`;
      } catch {
        // fall through to the malformed bucket
      }
      // Undecodable but present: bucket by content hash so a flood of junk
      // cannot consume a real account's allowance. Hashed because the raw
      // challenge is a bearer credential and limiter keys surface in memory
      // dumps and debug output.
      return `2fa:bad:${createHash('sha256').update(ch).digest('hex').slice(0, 32)}`;
    }
    return `2fa:ip:${req.ip}`;
  },
  handler: (req, res) => tooMany(res),
});

// ------------------------------------------------------------
//  Admin profile writes
// ------------------------------------------------------------
//  Covers the admin's own account details: password change, and the two
//  emailed codes that authorise an email change.
//
//  This surface is an oracle in two directions and needs a ceiling for both.
//  Every write re-checks the current password, so without a limit these
//  routes are an unthrottled password-guessing endpoint that happens to sit
//  behind a session — which is exactly what an attacker holding a stolen
//  token has. And the email-change request mails a code on each call, so an
//  unbounded loop is free outbound mail aimed at whatever address the caller
//  names.
//
//  Keyed on sysId, not IP, for the same reason as pinResetLimiter: these run
//  after requireAdmin so the account is known, and Nigerian carriers put many
//  subscribers behind one CGNAT address — an IP key would let one admin
//  throttle another. Falls back to IP only if req.admin is somehow absent,
//  which would mean requireAdmin did not run: fail closed, not unlimited.
//
//  20 per 15 minutes is generous for a human correcting a typo and useless
//  for grinding an 8-character password.
export const adminProfileLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.admin?.sysId ? `adminprofile:sys:${req.admin.sysId}` : `adminprofile:ip:${req.ip}`),
  handler: (req, res) => tooMany(res),
});

// ------------------------------------------------------------
//  Auth reserve — why this exists
// ------------------------------------------------------------
//  The global limiter in server.js counts EVERY /api request against
//  one per-IP budget. That coupling caused a real outage: a runaway
//  refetch loop on the admin plans page burned the whole 1200-request
//  window on GETs, and the next thing to be refused was /auth/login.
//  The operator was locked out of the app by a bug in a page they had
//  already navigated away from, and the 429 they saw ("Too many
//  requests") pointed at the wrong limiter entirely.
//
//  Fix: the global limiter now SKIPS /auth/*, and these routes get
//  their own budget instead. Read traffic can still exhaust itself,
//  but it can no longer spend the credit that logging in needs.
//
//  This sits BEHIND the strict per-account limiters above — it is a
//  per-IP backstop against auth flooding, not the brute-force control.
//  Generous on purpose: Nigerian mobile carriers put many subscribers
//  behind one CGNAT address, so a tight per-IP ceiling here would lock
//  out a whole carrier pool at once.
export const authTrafficLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120, // ~8/min sustained per IP across all /auth routes
  standardHeaders: true,
  legacyHeaders: false,
  // Distinct wording from both the global limiter and tooMany(), so a 429
  // in a report identifies which limiter fired without needing the logs.
  handler: (req, res) => res.status(429).json({
    status: 'fail',
    msg: 'Too many sign-in requests from this network. Please wait a few minutes and try again.',
  }),
});

// ------------------------------------------------------------
//  Newsletter signup
// ------------------------------------------------------------
//  The subscribe box on the landing page is unauthenticated and mails a
//  confirmation to whatever address is typed into it. That is a mail
//  cannon pointed at strangers: anyone can enter someone else's address,
//  and without a limit, a script can enter thousands.
//
//  It matters more here than it looks, because the marketing list and the
//  transactional mail share ONE sending reputation. Mail a few hundred
//  people who never asked, collect the spam complaints, and the domain
//  gets throttled — at which point password resets and receipts stop
//  arriving too. The blast radius of abusing this form is the whole
//  platform's email, not just the newsletter.
//
//  Keyed by (IP + email) so one address cannot be bombed from one IP, and
//  paired with a per-address cooldown in the controller so rotating IPs
//  does not defeat it either.
export const newsletterSignupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipPlusIdentifier('email'),
  handler: (req, res) => res.status(429).json({
    status: 'fail',
    msg: 'Too many signup attempts. Please wait a while and try again.',
  }),
});

//  Confirm/unsubscribe carry a token in the URL. The tokens are long
//  enough that guessing is not the threat; this is just a backstop against
//  someone hammering the endpoints. Generous, and IP-keyed, because these
//  are links people click from their inbox — sometimes twice, sometimes
//  from a mail client that prefetches them.
export const newsletterTokenLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => tooMany(res),
});

//  Sending a campaign is the single most expensive, least reversible
//  button in the admin panel: it reaches every confirmed address at once
//  and cannot be recalled. The limit is deliberately small — an operator
//  has no legitimate reason to start six sends in an hour, and a
//  double-click that goes out twice looks, from the recipient's side,
//  exactly like spam.
export const newsletterSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.admin?.sysId ? `nlsend:sys:${req.admin.sysId}` : `nlsend:ip:${req.ip}`),
  handler: (req, res) => res.status(429).json({
    status: 'fail',
    msg: 'Too many campaigns started recently. Please wait before sending another.',
  }),
});

// ------------------------------------------------------------
//  Blacklist submission
// ------------------------------------------------------------
//  POST /blacklist/submit needs no authentication, writes a row, and
//  emails the admin for every pending submission. Unlimited, that is a
//  mail cannon pointed at the operator's own inbox and a review queue
//  anyone can bury — and a buried queue is where a real fraud report
//  goes unnoticed.
//
//  NOT keyed on the submitted value, deliberately unlike
//  newsletterSignupLimiter. There the threat was bombing ONE address, so
//  the key included the address. Here the abuse is volume of DISTINCT
//  values, so keying on the value hands every new value a fresh bucket
//  and limits nothing at all.
//
//  Keyed on the ACCOUNT when one is present, IP only when anonymous —
//  the pinResetLimiter/privacyLimiter reasoning. Nigerian mobile carriers
//  put very large numbers of subscribers behind one CGNAT address, so a
//  pure IP key means ten reports an hour shared across a whole network,
//  and one busy vendor silently locks out every other user on their
//  carrier. Anonymous traffic has no better key available.
//
//  Admins skip it entirely: the panel's "Add to blacklist" form posts to
//  this same endpoint, and an operator working through a fraud list should
//  not be cut off mid-cleanup. Trusting req.auth.role here is only safe
//  because optionalAuth now re-checks revocation, sysStatus and existence
//  before attaching that role — see middleware/auth.js.
export const blacklistSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.auth?.role === 'admin',
  keyGenerator: (req) => (req.auth?.sId
    ? `blsubmit:sid:${req.auth.sId}`
    : `blsubmit:ip:${req.ip}`),
  handler: (req, res) => res.status(429).json({
    status: 'fail',
    msg: 'Too many reports submitted recently. Please wait a while before sending another.',
  }),
});

// ------------------------------------------------------------
//  Data export / account erasure
// ------------------------------------------------------------
//  Both routes sit behind requireUser and re-check the password, so this
//  is not the brute-force control. It exists for two other reasons.
//
//  Export assembles every transaction, ledger entry and verification the
//  account has ever produced and serialises them in one response. For a
//  heavy vendor that is a genuinely expensive query, and an unthrottled
//  endpoint a logged-in client can call in a loop is a way to take the
//  database down using nothing but a valid session.
//
//  Erasure is irreversible, so the ceiling is a guard against a retry
//  loop or a double-submitted form doing something a user cannot undo.
//
//  Keyed on the account for the same CGNAT reason as pinResetLimiter:
//  keying on IP would let one vendor's exports throttle every other
//  subscriber sharing their mobile carrier's address.
export const privacyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user?.sId ? `privacy:sid:${req.user.sId}` : `privacy:ip:${req.ip}`),
  handler: (req, res) => res.status(429).json({
    status: 'fail',
    msg: 'Too many requests. Please wait a while before trying again.',
  }),
});
