// ============================================================
//  scripts/verify_session_idle.js — assertions for the idle window
// ------------------------------------------------------------
//  Run: node scripts/verify_session_idle.js     (exit 0 = all pass)
//
//  WHAT IS BEING PROVED
//  The requirement is "login times out after 15 minutes if inactive".
//  A JWT can only carry an ABSOLUTE expiry, so idleness is built from
//  two moving parts, and each has a failure mode that looks fine:
//
//    1. The window must actually be 15 minutes. It was not: both login
//       sites read `process.env.JWT_EXPIRES_IN || '15m'`, and
//       .env.example ships JWT_EXPIRES_IN=7d — so every install that
//       copied it had week-long sessions while the code appeared to
//       say 15 minutes.
//    2. An active session must be re-minted before its token dies.
//       Renew too late and a working user is thrown out mid-task;
//       renew on every request and a client that races two calls can
//       store the older token and shorten its own session.
//
//  No server, no database, no network: these are pure decisions plus
//  real signed tokens verified with a local secret.
// ============================================================

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-a-real-key';

import jwt from 'jsonwebtoken';
import {
  idleTtlSeconds, signSessionToken, shouldRenew, SESSION_HEADERS,
} from '../utils/sessionToken.js';

// NOTE ON THE LINE ABOVE THE IMPORTS: `import` is hoisted, so that assignment
// actually runs AFTER both modules are evaluated. It is still correct here
// only because sessionToken.js reads JWT_SECRET at call time rather than at
// module load — the same property that lets the env assertions below work at
// all. Set it again here so the file does not depend on the reader knowing
// that, and so a future import that DOES read env at load still sees it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-a-real-key';

let pass = 0;
const failures = [];

function check(label, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (ok) pass += 1;
  else failures.push(`${label}\n    got: ${JSON.stringify(got)}`);
}

// ---- The window is 15 minutes ---------------------------------------------
delete process.env.SESSION_IDLE_MINUTES;
check('default window is 15 minutes', idleTtlSeconds(), 900);

// The regression that made this file necessary. JWT_EXPIRES_IN must have no
// influence at all on a session's life.
process.env.JWT_EXPIRES_IN = '7d';
check('JWT_EXPIRES_IN cannot lengthen a session', idleTtlSeconds(), 900);
const t = jwt.decode(signSessionToken({ sId: 1, role: 'user', tv: 0 }));
check('a signed token lives 15 minutes, not 7 days', t.exp - t.iat, 900);
delete process.env.JWT_EXPIRES_IN;

// Operator override, and the guards around it. A nonsense value must fall
// back rather than produce a session that expires instantly (or never).
process.env.SESSION_IDLE_MINUTES = '30';
check('operator can widen the window', idleTtlSeconds(), 1800);
process.env.SESSION_IDLE_MINUTES = '0';
check('zero falls back', idleTtlSeconds(), 900);
process.env.SESSION_IDLE_MINUTES = '-5';
check('negative falls back', idleTtlSeconds(), 900);
process.env.SESSION_IDLE_MINUTES = 'fifteen';
check('non-numeric falls back', idleTtlSeconds(), 900);
process.env.SESSION_IDLE_MINUTES = '';
check('empty falls back', idleTtlSeconds(), 900);
delete process.env.SESSION_IDLE_MINUTES;

// Read at call time, not frozen at import. Every assertion above depends on
// this being true, so state it outright.
process.env.SESSION_IDLE_MINUTES = '20';
check('env is re-read per call', idleTtlSeconds(), 1200);
delete process.env.SESSION_IDLE_MINUTES;

// ---- The token carries what the middleware checks -------------------------
// A session token minted without `tv` reads as version 0 and dies the moment
// that account's token version is ever bumped — a silent expiry that would
// look like this very feature misbehaving.
const claims = jwt.decode(signSessionToken({ sId: 82, role: 'user', tv: 3 }));
check('claims survive signing', claims.sId, 82);
check('role survives signing', claims.role, 'user');
check('token version survives signing', claims.tv, 3);
check('token verifies against the secret',
  jwt.verify(signSessionToken({ sId: 1, role: 'user', tv: 0 }), process.env.JWT_SECRET).sId, 1);

// ---- When to slide the window forward -------------------------------------
const iat = 1_700_000_000;
const exp = iat + 900; // a 15-minute token
const at = (secs) => shouldRenew({ iat, exp }, iat + secs);

check('fresh token is not renewed', at(0), false);
check('at 4 minutes, not yet', at(4 * 60), false);
// 1/3 of 15 minutes. Renewing at ~5 minutes means an active session renews
// about three times an hour instead of once per request.
check('at 5 minutes, renew', at(5 * 60), true);
check('at 5 minutes minus a second, not yet', at(5 * 60 - 1), false);
check('at 14 minutes, renew', at(14 * 60), true);

// Every renewal must leave MORE life than it consumed, or an active session
// would still die: the replacement is a full window, so any renewal before
// expiry keeps the session alive indefinitely while requests continue.
check('renewal happens with time to spare', at(5 * 60) && 5 * 60 < 900, true);

// ---- Malformed and hostile input ------------------------------------------
// shouldRenew runs on every authenticated request. Throwing here would take
// down the request it was called to help.
check('missing iat', shouldRenew({ exp }, iat + 600), false);
check('missing exp', shouldRenew({ iat }, iat + 600), false);
check('null decoded', shouldRenew(null, iat), false);
check('undefined decoded', shouldRenew(undefined, iat), false);
check('empty object', shouldRenew({}, iat), false);
check('non-numeric claims', shouldRenew({ iat: 'a', exp: 'b' }, iat), false);
check('exp equal to iat', shouldRenew({ iat, exp: iat }, iat + 10), false);
check('exp before iat', shouldRenew({ iat, exp: iat - 100 }, iat + 10), false);
// A token dated in the future means the signer and the reader disagree about
// the time. It must not be renewed — that would re-anchor the session to the
// wrong clock. No explicit guard implements this (a negative age cannot reach
// a positive fraction of a positive lifetime), which is exactly why it is
// asserted: the behaviour is a property of the comparison, and only a test
// keeps it true if that comparison is ever rewritten.
//
// The skew here is 10 minutes, deliberately LARGER than the 5-minute renewal
// threshold. A smaller one passes against a comparison that has lost the sign
// entirely (|-60s| is still under the threshold, so it answers "no" for the
// wrong reason) — the assertion looked green while proving nothing.
check('token 10 minutes in the future is left alone', shouldRenew({ iat, exp }, iat - 600), false);
check('token 1 minute in the future is left alone', shouldRenew({ iat, exp }, iat - 60), false);
check('always returns a boolean', typeof at(600), 'boolean');

// ---- The CORS contract ----------------------------------------------------
// These names are exported so server.js cannot drift from the writer. If the
// allow-list misses X-Session-Token, the browser withholds it from script and
// every session dies at 15 minutes flat no matter how active the user is.
check('renewal header is exported', SESSION_HEADERS.includes('X-Session-Token'), true);
check('expiry hint is exported', SESSION_HEADERS.includes('X-Session-Expires-In'), true);

// ---- Report ----------------------------------------------------------------
// console is correct here: this is an operator-run CLI, not the server.
if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n`);
  failures.forEach((f) => console.error(`  ${f}\n`));
  console.error(`${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${pass} assertions passed.`);
process.exit(0);
