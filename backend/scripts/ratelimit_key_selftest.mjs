// ============================================================
//  admin2faLimiter key-generator self-test
// ------------------------------------------------------------
//  This function is load-bearing. TOTP codes cannot be attempt-capped in
//  their own row the way an emailed OTP can — there is no row, the code is
//  derived from a shared secret — so this limiter IS the ceiling on
//  guessing. A keying mistake here does not fail loudly; it silently widens
//  the brute-force window, which is exactly the bug this file exists to
//  catch a regression of.
//
//  The specific defect being locked out: the original keyed on a hash of
//  the challenge token, so every re-login minted a fresh challenge and
//  therefore a FRESH EMPTY BUCKET. The property that matters is that two
//  DIFFERENT challenges for the SAME account share one bucket.
//
//  Run: node scripts/ratelimit_key_selftest.mjs
// ============================================================

import assert from 'assert';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-keygen-only';

// Capture the keyGenerator without standing up Express: read the REAL source,
// rewrite only the express-rate-limit import into a factory that hands back
// the config object it was given, and evaluate that.
//
// The rewritten source is written to a temp file NEXT TO the original rather
// than evaluated from a data: URL. A data: module has no filesystem parent, so
// bare specifiers ('crypto' is fine, 'jsonwebtoken' is not) fail to resolve.
// Living inside backend/ keeps node_modules resolution working, and the
// relative depth is irrelevant here because the module imports nothing local.
const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'middleware', 'rateLimit.js');
let src = fs.readFileSync(srcPath, 'utf8');

assert.ok(
  /import rateLimit from 'express-rate-limit';/.test(src),
  'import line changed shape — this harness needs updating, do not trust a pass'
);
src = src.replace(
  "import rateLimit from 'express-rate-limit';",
  'const rateLimit = (opts) => opts;'
);

const tmpPath = path.join(here, '..', `.ratelimit_keygen_${process.pid}.tmp.mjs`);
let mod;
try {
  fs.writeFileSync(tmpPath, src, 'utf8');
  mod = await import(`file://${tmpPath.replace(/\\/g, '/')}`);
} finally {
  try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
}

const keyOf = mod.admin2faLimiter.keyGenerator;
assert.strictEqual(typeof keyOf, 'function', 'keyGenerator not exported as a function');

const challengeFor = (sysId, extra = {}) =>
  jwt.sign({ sysId, role: 'admin_2fa_pending', ...extra }, process.env.JWT_SECRET, { expiresIn: '5m' });

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed += 1; }
  catch (e) { failures.push(`${name}: ${e.message}`); }
};

check('THE BUG: two different challenges for the same admin share one bucket', () => {
  const a = keyOf({ body: { challenge: challengeFor(7) }, ip: '1.1.1.1' });
  // A second login a second later mints a different token (different iat).
  const b = keyOf({ body: { challenge: challengeFor(7, { nonce: 'x' }) }, ip: '9.9.9.9' });
  assert.strictEqual(a, b,
    'CRITICAL: re-logging in yields a fresh bucket — the attempt cap can be reset at will');
});

check('rotating IPs does not change the bucket', () => {
  const ch = challengeFor(7);
  assert.strictEqual(
    keyOf({ body: { challenge: ch }, ip: '1.1.1.1' }),
    keyOf({ body: { challenge: ch }, ip: '2.2.2.2' })
  );
});

check('different admins get different buckets', () => {
  assert.notStrictEqual(
    keyOf({ body: { challenge: challengeFor(7) }, ip: '1.1.1.1' }),
    keyOf({ body: { challenge: challengeFor(8) }, ip: '1.1.1.1' })
  );
});

check('an authenticated session keys on its own sysId', () => {
  assert.strictEqual(keyOf({ admin: { sysId: 42 }, body: {}, ip: '1.1.1.1' }), '2fa:sys:42');
});

check('the session wins over a supplied challenge (body is attacker-controlled)', () => {
  assert.strictEqual(
    keyOf({ admin: { sysId: 42 }, body: { challenge: challengeFor(7) }, ip: '1.1.1.1' }),
    '2fa:sys:42'
  );
});

check('garbage challenges cannot consume a real account bucket', () => {
  const junk = keyOf({ body: { challenge: 'not-a-jwt' }, ip: '1.1.1.1' });
  assert.ok(junk.startsWith('2fa:bad:'), `expected a malformed bucket, got ${junk}`);
  assert.ok(!junk.includes('sys:'), 'malformed token landed in an account bucket');
});

check('the raw challenge never appears in the key', () => {
  const ch = challengeFor(7);
  assert.ok(!keyOf({ body: { challenge: ch }, ip: '1.1.1.1' }).includes(ch.slice(0, 24)));
});

check('no challenge and no session falls back to IP', () => {
  assert.strictEqual(keyOf({ body: {}, ip: '3.3.3.3' }), '2fa:ip:3.3.3.3');
});

check('an unsigned/forged token still buckets by account, not by IP', () => {
  // jwt.decode does not verify — deliberate. A forged token is rejected later
  // by openChallenge; here it only needs to group, and grouping a forgery
  // with the account it names is the safe direction.
  const forged = jwt.sign({ sysId: 7 }, 'the-wrong-secret');
  assert.strictEqual(keyOf({ body: { challenge: forged }, ip: '1.1.1.1' }), '2fa:sys:7');
});

console.log();
if (failures.length) {
  console.log(`  ${failures.length} FAILED:`);
  for (const f of failures) console.log(`    ${f}`);
  console.log(`  ${passed} passed`);
  process.exit(1);
}
console.log(`  ${passed} assertions passed`);
