// ============================================================
//  verify_idle_session.mjs — assertions for the client watchdog
// ------------------------------------------------------------
//  Run from frontend/:  node scripts/verify_idle_session.mjs
//
//  WHY A SECOND TIMER EXISTS AT ALL
//  The server expires a session 15 minutes after the last REQUEST.
//  This one expires it 15 minutes after the last INTERACTION, and the
//  gap between those is the whole point: AdminNewsletter.jsx polls a
//  sending campaign on a timer, and that traffic alone would hold a
//  session open on an unattended screen indefinitely. Conversely a
//  client-only timer proves nothing, since anyone holding the token
//  can decline to run our JavaScript. Both, or neither works.
//
//  isIdleExpired is the decision that signs a real person out, so it
//  is pure and tested here without a DOM, a clock or a browser.
// ============================================================

import { isIdleExpired, DEFAULT_IDLE_MS } from '../src/utils/idleSession.js';

let pass = 0;
const failures = [];
function check(label, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (ok) pass += 1;
  else failures.push(`${label}\n    got: ${JSON.stringify(got)}`);
}

const MIN = 60 * 1000;
const NOW = 1_700_000_000_000;
const idle = (agoMs, win = DEFAULT_IDLE_MS) => isIdleExpired(NOW - agoMs, NOW, win);

// ---- The window is 15 minutes, and matches the server's default ------------
check('default window is 15 minutes', DEFAULT_IDLE_MS, 15 * MIN);

// ---- The boundary ----------------------------------------------------------
check('just used, still signed in', idle(0), false);
check('14 minutes idle, still signed in', idle(14 * MIN), false);
check('one second short of 15, still signed in', idle(15 * MIN - 1000), false);
check('exactly 15 minutes, signed out', idle(15 * MIN), true);
check('an hour idle, signed out', idle(60 * MIN), true);

// A working session must NEVER expire. This is the failure that would matter
// most to a reseller mid-purchase, so state it as its own assertion.
check('activity every 10 minutes never expires', idle(10 * MIN), false);

// ---- Operator override -----------------------------------------------------
// The real window comes from the server's X-Session-Expires-In, so a longer
// SESSION_IDLE_MINUTES must widen this side too or the client would sign
// people out earlier than the server intends.
check('30-minute window: 20 minutes is fine', idle(20 * MIN, 30 * MIN), false);
check('30-minute window: 31 minutes expires', idle(31 * MIN, 30 * MIN), true);

// ---- Missing or hostile input ----------------------------------------------
// A watchdog that expires on garbage input signs out a working user for a
// reason they cannot see. Every one of these must fail SAFE (stay signed in),
// because the server's own expiry still bounds the session either way.
check('no stamp yet (first load)', isIdleExpired(0, NOW, DEFAULT_IDLE_MS), false);
check('negative stamp', isIdleExpired(-1, NOW, DEFAULT_IDLE_MS), false);
check('NaN stamp', isIdleExpired(NaN, NOW, DEFAULT_IDLE_MS), false);
check('non-numeric stamp', isIdleExpired('yesterday', NOW, DEFAULT_IDLE_MS), false);
check('null stamp', isIdleExpired(null, NOW, DEFAULT_IDLE_MS), false);
check('undefined stamp', isIdleExpired(undefined, NOW, DEFAULT_IDLE_MS), false);
check('NaN now', isIdleExpired(NOW - MIN, NaN, DEFAULT_IDLE_MS), false);
check('zero window', isIdleExpired(NOW - MIN, NOW, 0), false);
check('negative window', isIdleExpired(NOW - MIN, NOW, -1), false);
check('NaN window', isIdleExpired(NOW - MIN, NOW, NaN), false);
check('Infinity window', isIdleExpired(NOW - MIN, NOW, Infinity), false);

// A stamp in the future means the clock moved backwards — an NTP correction,
// or another tab on a machine whose time was wrong. Treated as fresh. Like
// the backend's equivalent, no explicit guard implements this: a negative
// difference cannot reach a positive window. Asserted because the behaviour
// lives in the subtraction, and only a test keeps it true.
check('stamp in the future is treated as fresh', isIdleExpired(NOW + 60 * MIN, NOW, DEFAULT_IDLE_MS), false);

check('always returns a boolean', typeof idle(60 * MIN), 'boolean');

if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n`);
  failures.forEach((f) => console.error(`  ${f}\n`));
  console.error(`${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${pass} assertions passed.`);
process.exit(0);
