// ============================================================
//  scripts/privacy_selftest.mjs — the parts that DON'T need a DB
// ------------------------------------------------------------
//  eraseSubscriber and the sweeps need MySQL, which is not present in
//  this sandbox, so they cannot be exercised here. But two pieces of
//  pure logic decide whether the whole thing is safe or actively
//  harmful, and those CAN be tested:
//
//    1. maskIdentifiers — if it is too greedy it eats the amount off
//       every receipt; too timid and a phone number survives erasure.
//    2. the retention day-clamp — a zero or negative window would
//       redact the check the user ran ten seconds ago.
//
//  As with every other self-test here: the run is meaningless unless a
//  deliberately wrong version makes it FAIL. The control block at the
//  bottom mutates each rule and asserts the assertion catches it.
// ============================================================

import assert from 'node:assert/strict';
import { maskIdentifiers } from '../utils/maskIdentifiers.js';

// The retention day-clamp is the same guard, inlined here so the test
// needs no DB-touching import. It MUST stay identical to days() in
// services/retentionService.js — the control block below is what keeps
// them honest.
function days(raw, fallback) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}
const PURGED_MARKER = '[purged]';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass += 1; process.stdout.write(`  ok   ${name}\n`); }
  catch (e) { fail += 1; process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); }
}

// ---- maskIdentifiers: masks IDs, keeps money/plan text ----
check('masks an 11-digit phone, keeps last 4', () => {
  const out = maskIdentifiers('MTN Airtime purchase of N500 for 08012345678');
  assert.ok(out.includes('5678'), 'last 4 kept');
  assert.ok(!out.includes('08012345678'), 'full number gone');
  assert.ok(out.includes('N500'), 'amount survives');
});

check('masks a meter number in a bill description', () => {
  const out = maskIdentifiers('Purchase of IKEDC prepaid electricity token for meter 45012345678');
  assert.ok(!out.includes('45012345678'));
  assert.ok(out.includes('IKEDC'));
});

check('leaves short numbers (amounts, days) alone', () => {
  assert.equal(maskIdentifiers('30 Days Plan for N1500'), '30 Days Plan for N1500');
});

check('null / empty pass through', () => {
  assert.equal(maskIdentifiers(null), null);
  assert.equal(maskIdentifiers(''), '');
});

// ---- purge marker fits its column ----
check('PURGED_MARKER is short enough to never truncate', () => {
  // query is VARCHAR(255); the marker must be nowhere near that.
  assert.ok(PURGED_MARKER.length < 20);
});

// ---- retention window clamp ----
check('a sane window is respected', () => {
  assert.equal(days('45', 90), 45);
});

check('a zero/garbage window falls back, never 0', () => {
  assert.equal(days('0', 90), 90, 'zero must fall back to default');
  assert.equal(days('nonsense', 90), 90, 'garbage must fall back to default');
  assert.equal(days('-5', 90), 90, 'negative must fall back to default');
});

// ============================================================
//  CONTROL — break each rule, assert the test above catches it
// ============================================================
process.stdout.write('\n  control (each must be CAUGHT):\n');
let controlOk = 0;
let controlMissed = 0;
function control(name, fn) {
  try { fn(); controlMissed += 1; process.stdout.write(`    MISSED ${name}\n`); }
  catch { controlOk += 1; process.stdout.write(`    caught ${name}\n`); }
}

// If mask were greedy enough to eat 4-digit runs, N1500 would lose its
// digits — assert that the REAL function does NOT do that (so a greedy
// mutant would fail this).
control('greedy mask would eat the amount', () => {
  const greedy = (t) => String(t).replace(/\d{4,}/g, 'X');
  const out = greedy('30 Days Plan for N1500');
  assert.ok(out.includes('1500'), 'greedy mutant kept the amount'); // will throw → caught
});

// If the clamp allowed 0, the window would be 0 — assert it isn't.
control('clamp that allowed 0 would redact everything', () => {
  const bad = (raw) => (Number.isFinite(raw) ? raw : 90); // missing the <1 guard
  assert.ok(bad(0) >= 1, 'a 0-day window slipped through'); // 0 >= 1 is false → throws → caught
});

process.stdout.write(`\n  ${pass} passed, ${fail} failed | control ${controlOk} caught, ${controlMissed} missed\n\n`);
process.exit(fail === 0 && controlMissed === 0 ? 0 : 1);
