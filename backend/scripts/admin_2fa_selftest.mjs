// ============================================================
//  admin_2fa_selftest.mjs — behavioural tests for admin 2FA
// ------------------------------------------------------------
//  Run:
//    node --experimental-loader ./scripts/test_stubs.mjs \
//         scripts/admin_2fa_selftest.mjs
//
//  Not part of the app. bcrypt and models/index.js are stubbed by the
//  loader (see test_stubs.mjs for why and for what the stubs must get
//  right); the CONTROLLER ITSELF is loaded unmodified.
//
//  These tests are written adversarially on purpose. The happy path —
//  "correct code lets you in" — is the least interesting thing here and
//  would pass against an implementation with no security at all. What is
//  actually asserted is what an attacker would try:
//    * can a half-authenticated challenge reach an admin route?
//    * can a full admin token be replayed into the 2FA verify route?
//    * does the same six digits work twice?
//    * does a backup code work twice?
//    * does a password change kill outstanding challenges?
//    * can 2FA be turned off with only a hijacked session?
// ============================================================

import assert from 'assert';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-selftest-only';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY
  || '0123456789abcdef0123456789abcdef';

globalThis.__DB__ = { sysusers: new Map(), otpcodes: new Map(), otpSeq: 0, saveCount: 0 };

const tfa = await import('../controllers/admin2faController.js');
const { adminLogin } = await import('../controllers/authController.js');
const { requireAdmin } = await import('../middleware/auth.js');
const { encryptSecret, hashPassword } = await import('../utils/crypto.js');
const { generateCode, stepFor, generateSecret } = await import('../utils/totp.js');
const { hashToken } = await import('../utils/crypto.js');

let pass = 0;
const fails = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; }
  catch (e) { fails.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

// ---------- harness ----------

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

const PASSWORD = 'correct horse battery staple';
let SEED_HASH = null;

async function seedAdmin(overrides = {}) {
  globalThis.__DB__.sysusers.clear();
  globalThis.__DB__.otpcodes.clear();
  SEED_HASH = SEED_HASH || await hashPassword(PASSWORD);
  const secret = overrides.__secret || generateSecret();
  const row = {
    sysId: 1,
    sysName: 'Root Admin',
    sysUsername: 'root',
    sysRole: 'superadmin',
    sysEmail: 'admin@kwarapolydata.com.ng',
    sysPhone: null,
    sysToken: SEED_HASH,
    sysTotpSecret: null,
    sysTotpEnabled: 0,
    sysTotpConfirmedAt: null,
    sysTotpLastStep: null,
    sysBackupCodes: null,
    sysTokenVersion: 0,
    sysStatus: 0, // 0 = ACTIVE in the legacy schema; non-zero is blocked
    ...overrides,
  };
  delete row.__secret;
  globalThis.__DB__.sysusers.set(1, row);
  return { row, secret };
}

/** Enable 2FA the way the app does, and hand back the live secret. */
async function seedEnrolled(extra = {}) {
  const secret = generateSecret();
  await seedAdmin({ sysTotpSecret: encryptSecret(secret), sysTotpEnabled: 1, ...extra });
  return secret;
}

/**
 * Re-enrol the EXISTING row without clearing it, so state left behind by a
 * previous disable (stale backup codes in particular) is still there to be
 * caught. seedEnrolled wipes the table and would hide exactly that.
 */
async function seedEnrolledPreservingRow() {
  const secret = generateSecret();
  const row = globalThis.__DB__.sysusers.get(1);
  row.sysTotpSecret = encryptSecret(secret);
  row.sysTotpEnabled = 1;
  row.sysTotpLastStep = null;
  return secret;
}

const stored = () => globalThis.__DB__.sysusers.get(1);

// ============================================================
//  1. THE CHALLENGE TOKEN — the load-bearing claim
// ============================================================

await check('admin login with 2FA returns a challenge, NOT a session token', async () => {
  await seedEnrolled();
  const res = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.twoFactorRequired, true);
  assert.ok(res.body.challenge, 'no challenge issued');
  // The whole point: no usable credential may appear in this response.
  assert.strictEqual(res.body.token, undefined, 'a session token leaked before the second factor');
});

await check('the challenge does NOT carry role admin', async () => {
  await seedEnrolled();
  const res = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, res);
  const decoded = jwt.decode(res.body.challenge);
  assert.notStrictEqual(decoded.role, 'admin', 'challenge would be accepted as a full admin token');
  assert.strictEqual(decoded.role, tfa.CHALLENGE_ROLE);
});

// This is the test that decides whether 2FA is real or decorative. If
// requireAdmin ever accepts the challenge role, an attacker with only the
// password skips the code prompt entirely and calls the admin API.
await check('requireAdmin REJECTS the challenge token (2FA is not decorative)', async () => {
  await seedEnrolled();
  const login = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, login);
  const res = mockRes();
  let reached = false;
  await requireAdmin(
    { headers: { authorization: `Bearer ${login.body.challenge}` } },
    res,
    () => { reached = true; }
  );
  assert.strictEqual(reached, false, 'CRITICAL: challenge token reached an admin route');
  assert.strictEqual(res.statusCode, 403);
});

await check('an admin WITHOUT 2FA still logs straight in', async () => {
  await seedAdmin();
  const res = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, res);
  assert.ok(res.body.token, '2FA-less admins must not be locked out');
  assert.strictEqual(res.body.twoFactorRequired, undefined);
  assert.strictEqual(jwt.decode(res.body.token).role, 'admin');
});

await check('a wrong password never mints a challenge', async () => {
  await seedEnrolled();
  const res = mockRes();
  await adminLogin({ body: { username: 'root', password: 'wrong' }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 401);
  assert.ok(!res.body.challenge, 'challenge issued without a correct password');
});

// ============================================================
//  1b. TOKEN REVOCATION AND BLOCKED ACCOUNTS
// ------------------------------------------------------------
//  Admin JWTs live 7 days. Until sysTokenVersion existed they could not be
//  withdrawn inside that window, which made "enable 2FA because I think
//  someone is in my account" a no-op against the session already in the
//  account. sysStatus, meanwhile, was written by the legacy Block User
//  button and read by absolutely nothing.
//
//  POLARITY: sysStatus 0 = ACTIVE, non-zero = blocked. Backwards from the
//  usual instinct, and the live super-admin row is 0 — asserting the other
//  way round would lock out the only administrator.
// ============================================================

/** Sign in and return the admin token, for accounts without 2FA. */
async function loginForToken() {
  const res = await mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, res);
  return res.body.token;
}

/** Run requireAdmin against a token; report whether next() was reached. */
async function callAsAdmin(token) {
  const res = mockRes();
  let reached = false;
  await requireAdmin({ headers: { authorization: `Bearer ${token}` } }, res, () => { reached = true; });
  return { reached, res };
}

await check('an admin token carries the account token version', async () => {
  await seedAdmin({ sysTokenVersion: 4 });
  const token = await loginForToken();
  assert.strictEqual(jwt.decode(token).tv, 4,
    'token minted without a tv claim — it reads as version 0 and dies on the first bump');
});

await check('REVOCATION: bumping sysTokenVersion kills an existing admin token', async () => {
  await seedAdmin();
  const token = await loginForToken();
  assert.strictEqual((await callAsAdmin(token)).reached, true, 'fresh token should work');

  stored().sysTokenVersion = 1; // e.g. password reset, or 2FA just enabled
  const after = await callAsAdmin(token);
  assert.strictEqual(after.reached, false,
    'CRITICAL: an admin token survived a token-version bump — admin sessions are irrevocable');
  assert.strictEqual(after.res.statusCode, 401);
});

await check('enabling 2FA evicts other admin sessions', async () => {
  // The whole reason an admin reaches for 2FA in a hurry is that they think
  // someone else is signed in. If that session keeps working, the second
  // factor is guarding a door the intruder is already through.
  await seedAdmin();
  const stolen = await loginForToken();
  assert.strictEqual((await callAsAdmin(stolen)).reached, true);

  const setupRes = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, setupRes);
  const secret = (await import('../utils/crypto.js')).decryptSecret(stored().sysTotpSecret);
  const confirmRes = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code: generateCode(secret) } }, confirmRes);
  assert.strictEqual(confirmRes.statusCode, 200, 'enrolment should have succeeded');

  assert.strictEqual((await callAsAdmin(stolen)).reached, false,
    'CRITICAL: the pre-existing session survived 2FA being enabled');
});

await check('...and hands the acting admin a working replacement token', async () => {
  // Without this the admin who just enabled 2FA is logged out by their own
  // next request — while the once-only backup codes are still on screen.
  await seedAdmin();
  const setupRes = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, setupRes);
  const secret = (await import('../utils/crypto.js')).decryptSecret(stored().sysTotpSecret);
  const confirmRes = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code: generateCode(secret) } }, confirmRes);

  const fresh = confirmRes.body?.data?.token;
  assert.ok(fresh, 'confirm did not return a replacement token');
  assert.strictEqual((await callAsAdmin(fresh)).reached, true,
    'the replacement token does not actually work');
});

await check('a BLOCKED admin cannot log in (sysStatus non-zero)', async () => {
  await seedAdmin({ sysStatus: 1 });
  const res = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 403);
  assert.ok(!res.body.token, 'a blocked admin was handed a session token');
});

await check('a blocked admin cannot use a token minted before the block', async () => {
  await seedAdmin();
  const token = await loginForToken();
  stored().sysStatus = 1;
  const after = await callAsAdmin(token);
  assert.strictEqual(after.reached, false, 'blocking an admin left their live session working');
  assert.strictEqual(after.res.statusCode, 403);
});

await check('sysStatus 0 is ACTIVE, not blocked (legacy polarity)', async () => {
  // Guards against someone "fixing" the check to `=== 1` on instinct. The
  // one production admin row ships as 0; inverting this locks it out.
  await seedAdmin({ sysStatus: 0 });
  const res = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200, 'sysStatus 0 must be treated as ACTIVE');
  assert.ok(res.body.token);
});

// The reverse direction: a real admin token must not be redeemable here.
// Otherwise the verify route becomes a way to launder a token past nothing.
//
// The forged token carries CORRECT fingerprints on purpose. An earlier
// version of this test omitted them, so it was killed by the credRef check
// and never exercised the role check at all — a mutant that made
// openChallenge accept role 'admin' survived it. Isolate one control at a
// time or the test name is a lie.
await check('verify REFUSES a full admin token even with valid fingerprints', async () => {
  await seedEnrolled();
  const admin = stored();
  const adminToken = jwt.sign(
    {
      sysId: 1,
      role: 'admin',
      pwdRef: tfa.credRef(admin.sysToken),
      tfaRef: tfa.credRef(admin.sysTotpSecret),
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: adminToken, code: '000000' }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 400, 'a full admin token was accepted as a 2FA challenge');
});

await check('verify REFUSES a challenge signed with the wrong key', async () => {
  await seedEnrolled();
  const forged = jwt.sign({ sysId: 1, role: tfa.CHALLENGE_ROLE }, 'not-the-real-secret', { expiresIn: '5m' });
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: forged, code: '000000' }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 400);
});

await check('verify REFUSES an expired challenge', async () => {
  const secret = await seedEnrolled();
  const admin = stored();
  const expired = jwt.sign(
    { sysId: 1, role: tfa.CHALLENGE_ROLE, pwdRef: tfa.credRef(admin.sysToken), tfaRef: tfa.credRef(admin.sysTotpSecret) },
    process.env.JWT_SECRET,
    { expiresIn: '-1s' }
  );
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: expired, code: generateCode(secret) }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 400, 'an expired challenge was redeemed');
});

// ---------- credential fingerprints ----------

await check('changing the PASSWORD kills an outstanding challenge', async () => {
  const secret = await seedEnrolled();
  const login = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, login);

  // Compromise response: the admin changes their password.
  stored().sysToken = await hashPassword('a brand new password');

  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: login.body.challenge, code: generateCode(secret) }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 400, 'a challenge survived the password change it should have died with');
  assert.ok(!res.body.token);
});

await check('re-enrolling the AUTHENTICATOR kills an outstanding challenge', async () => {
  const secret = await seedEnrolled();
  const login = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, login);

  stored().sysTotpSecret = encryptSecret(generateSecret());

  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: login.body.challenge, code: generateCode(secret) }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 400);
});

// ============================================================
//  2. CODE VERIFICATION
// ============================================================

await check('a correct code exchanges the challenge for a real admin token', async () => {
  const secret = await seedEnrolled();
  const login = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, login);

  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: login.body.challenge, code: generateCode(secret) }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(jwt.decode(res.body.data.token).role, 'admin');
  assert.strictEqual(res.body.data.usedBackupCode, false);
});

// THE replay guard. Without a persisted lastStep the same six digits are
// valid for the whole ~90s drift window, which is the difference between
// a shoulder-surfed code being useless and being a working credential.
await check('REPLAY: the same code cannot be used twice', async () => {
  const secret = await seedEnrolled();
  const code = generateCode(secret);

  const first = mockRes();
  const l1 = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l1);
  await tfa.verifyLogin({ body: { challenge: l1.body.challenge, code }, ip: '1.2.3.4' }, first);
  assert.strictEqual(first.statusCode, 200, 'first use should succeed');

  const l2 = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l2);
  const second = mockRes();
  await tfa.verifyLogin({ body: { challenge: l2.body.challenge, code }, ip: '1.2.3.4' }, second);
  assert.strictEqual(second.statusCode, 422, 'CRITICAL: a used code was accepted again');
  assert.ok(!second.body.data, 'replayed code issued a token');
});

await check('the accepted step is PERSISTED (not just held in memory)', async () => {
  const secret = await seedEnrolled();
  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: l.body.challenge, code: generateCode(secret) }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(stored().sysTotpLastStep, stepFor(Date.now()),
    'sysTotpLastStep was not written — the replay guard is inert across restarts');
});

await check('a wrong code is refused', async () => {
  await seedEnrolled();
  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: l.body.challenge, code: '000000' }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 422);
  assert.ok(!res.body.data);
});

// otpService.js:143 is explicit that 401 trips the frontend auto-logout in
// client.js and drops the user out of the flow they are completing.
await check('NO failure path returns 401 (it would trip the frontend auto-logout)', async () => {
  await seedEnrolled();
  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const bad = [
    { challenge: l.body.challenge, code: '000000' },
    { challenge: l.body.challenge, code: '' },
    { challenge: l.body.challenge },
    { challenge: 'garbage', code: '123456' },
    { code: '123456' },
    {},
  ];
  for (const body of bad) {
    const res = mockRes();
    // eslint-disable-next-line no-await-in-loop
    await tfa.verifyLogin({ body, ip: '1.2.3.4' }, res);
    assert.notStrictEqual(res.statusCode, 401, `401 returned for ${JSON.stringify(body)}`);
    assert.ok(res.statusCode === 400 || res.statusCode === 422, `unexpected ${res.statusCode}`);
  }
});

await check('malformed input never throws a 500', async () => {
  await seedEnrolled();
  for (const body of [{ challenge: 123, code: {} }, { challenge: null, code: [] }, { challenge: {}, code: null }]) {
    const res = mockRes();
    // eslint-disable-next-line no-await-in-loop
    await tfa.verifyLogin({ body, ip: '1.2.3.4' }, res);
    assert.notStrictEqual(res.statusCode, 500, `500 for ${JSON.stringify(body)}`);
  }
});

// ============================================================
//  3. ENROLMENT — two phases, and the gap between them
// ============================================================

await check('setup stores the secret but does NOT enable 2FA', async () => {
  await seedAdmin();
  const res = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.ok(res.body.data.qrDataUrl.startsWith('data:image/svg+xml;base64,'), 'no QR returned');
  // Decode rather than trust the prefix: a data URL that does not actually
  // carry an SVG renders as a broken image, and the admin cannot enrol.
  assert.ok(
    Buffer.from(res.body.data.qrDataUrl.split(',')[1], 'base64').toString('utf8').startsWith('<svg'),
    'QR data URL does not decode to an SVG'
  );
  assert.ok(res.body.data.manualKey, 'no manual-entry key for the camera-less path');
  assert.ok(stored().sysTotpSecret, 'secret not stored');
  assert.strictEqual(Number(stored().sysTotpEnabled), 0,
    'CRITICAL: 2FA enabled before a code was ever proven — a mis-scan locks the admin out');
});

await check('the stored secret is ENCRYPTED, never plaintext', async () => {
  await seedAdmin();
  const res = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, res);
  const manual = res.body.data.manualKey.replace(/\s/g, '');
  assert.ok(!String(stored().sysTotpSecret).includes(manual),
    'the base32 secret is recoverable straight from the column');
  assert.strictEqual(String(stored().sysTotpSecret).split(':').length, 3, 'not an iv:tag:ct envelope');
});

await check('confirm with a live code enables 2FA and returns backup codes once', async () => {
  await seedAdmin();
  const setupRes = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, setupRes);
  const secret = setupRes.body.data.manualKey.replace(/\s/g, '');

  const res = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code: generateCode(secret) } }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(Number(stored().sysTotpEnabled), 1);
  assert.strictEqual(res.body.data.backupCodes.length, 10);
});

await check('confirm with a WRONG code leaves 2FA off', async () => {
  await seedAdmin();
  await tfa.setup({ admin: { sysId: 1 } }, mockRes());
  const res = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code: '000000' } }, res);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(Number(stored().sysTotpEnabled), 0);
});

// The code typed to finish enrolment is a used code, and stays valid for up
// to ~90s afterwards. If confirm() does not burn its step, anyone who read
// that code over the admin's shoulder can log in with it. Found by mutation
// testing: removing the burn in confirm() survived the whole suite, because
// the only replay test covered the LOGIN path.
await check('REPLAY: the code that completed enrolment cannot then log you in', async () => {
  await seedAdmin();
  const setupRes = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, setupRes);
  const secret = setupRes.body.data.manualKey.replace(/\s/g, '');
  const code = generateCode(secret);

  const confirmRes = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code } }, confirmRes);
  assert.strictEqual(confirmRes.statusCode, 200, 'enrolment should succeed');
  assert.strictEqual(stored().sysTotpLastStep, stepFor(Date.now()),
    'confirm() did not record the step it consumed');

  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: l.body.challenge, code }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 422, 'the enrolment code was replayed into a session');
});

// Same property in the other direction: confirm() must not accept a code
// that was already consumed.
await check('REPLAY: a code consumed at login cannot re-confirm an enrolment', async () => {
  await seedAdmin();
  const setupRes = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, setupRes);
  const secret = setupRes.body.data.manualKey.replace(/\s/g, '');
  const code = generateCode(secret);

  const first = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code } }, first);
  assert.strictEqual(first.statusCode, 200);

  // Roll back only the enabled flag, as if the row were restored from a
  // stale backup, and try the same code again.
  stored().sysTotpEnabled = 0;
  const res = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code } }, res);
  assert.strictEqual(res.statusCode, 422, 'a spent code re-confirmed enrolment');
});

await check('backup codes are stored HASHED, not recoverable from the row', async () => {
  await seedAdmin();
  const setupRes = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, setupRes);
  const secret = setupRes.body.data.manualKey.replace(/\s/g, '');
  const res = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code: generateCode(secret) } }, res);

  const raw = String(stored().sysBackupCodes);
  for (const code of res.body.data.backupCodes) {
    assert.ok(!raw.includes(code), `backup code ${code} is stored in the clear`);
    assert.ok(!raw.includes(code.replace('-', '')), `backup code ${code} stored unhyphenated in the clear`);
  }
  assert.strictEqual(JSON.parse(raw).length, 10);
});

// Re-enrolling while 2FA is live would let a hijacked session quietly move
// the second factor onto the attacker's own phone.
await check('setup is REFUSED while 2FA is already enabled', async () => {
  await seedEnrolled();
  const before = stored().sysTotpSecret;
  const res = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, res);
  assert.strictEqual(res.statusCode, 409);
  assert.strictEqual(stored().sysTotpSecret, before, 'the live secret was overwritten');
});

await check('confirm is refused when no setup is pending', async () => {
  await seedAdmin();
  const res = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code: '123456' } }, res);
  assert.strictEqual(res.statusCode, 409);
});

// ============================================================
//  4. BACKUP CODES
// ============================================================

async function enrolWithBackups() {
  await seedAdmin();
  const setupRes = mockRes();
  await tfa.setup({ admin: { sysId: 1 } }, setupRes);
  const secret = setupRes.body.data.manualKey.replace(/\s/g, '');
  const confirmRes = mockRes();
  await tfa.confirm({ admin: { sysId: 1 }, body: { code: generateCode(secret) } }, confirmRes);
  return { secret, codes: confirmRes.body.data.backupCodes };
}

await check('a backup code signs you in', async () => {
  const { codes } = await enrolWithBackups();
  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: l.body.challenge, code: codes[3] }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.data.usedBackupCode, true);
});

await check('SINGLE USE: a backup code cannot be used twice', async () => {
  const { codes } = await enrolWithBackups();
  const l1 = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l1);
  const first = mockRes();
  await tfa.verifyLogin({ body: { challenge: l1.body.challenge, code: codes[0] }, ip: '1.2.3.4' }, first);
  assert.strictEqual(first.statusCode, 200);

  const l2 = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l2);
  const second = mockRes();
  await tfa.verifyLogin({ body: { challenge: l2.body.challenge, code: codes[0] }, ip: '1.2.3.4' }, second);
  assert.strictEqual(second.statusCode, 422, 'CRITICAL: a spent backup code was accepted again');
  assert.strictEqual(JSON.parse(stored().sysBackupCodes).length, 9, 'exactly one code should be consumed');
});

await check('using one backup code does not invalidate the others', async () => {
  const { codes } = await enrolWithBackups();
  const l1 = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l1);
  await tfa.verifyLogin({ body: { challenge: l1.body.challenge, code: codes[0] }, ip: '1.2.3.4' }, mockRes());

  const l2 = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l2);
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: l2.body.challenge, code: codes[1] }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200, 'a second, different backup code should still work');
});

await check('backup codes tolerate the formatting a human types', async () => {
  const { codes } = await enrolWithBackups();
  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const res = mockRes();
  // lowercase, spaced, hyphen dropped — all of which people do
  const mangled = ` ${codes[2].toLowerCase().replace('-', '')} `;
  await tfa.verifyLogin({ body: { challenge: l.body.challenge, code: mangled }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200, 'a correct code was rejected over formatting');
});

// A rotated APP_ENCRYPTION_KEY makes the secret unreadable. The admin must
// still be able to get in with a backup code — those are bcrypt hashes and
// do not depend on that key. Otherwise a key rotation is a permanent lockout.
await check('RECOVERY: backup codes still work when the secret cannot be decrypted', async () => {
  const { codes } = await enrolWithBackups();
  stored().sysTotpSecret = 'not:a:valid-envelope'; // simulates a rotated key

  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: l.body.challenge, code: codes[5] }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200, 'a key rotation permanently locks the admin out');
  assert.strictEqual(res.body.data.usedBackupCode, true);
});

await check('an unreadable secret does not 500 the login route', async () => {
  await seedEnrolled();
  stored().sysTotpSecret = 'garbage';
  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const res = mockRes();
  await tfa.verifyLogin({ body: { challenge: l.body.challenge, code: '123456' }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 422, `expected a explanatory 422, got ${res.statusCode}`);
  assert.match(res.body.msg, /backup code/i, 'the message must point at the way back in');
});

// ============================================================
//  5. DISABLE — must be harder than enabling
// ============================================================

await check('disable REFUSES a session alone (password required)', async () => {
  await seedEnrolled();
  const res = mockRes();
  await tfa.disable({ admin: { sysId: 1 }, body: { otp: '123456' }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(Number(stored().sysTotpEnabled), 1, 'CRITICAL: 2FA disabled with no password');
});

// Supplies a VALID OTP so the password check is the ONLY thing that can
// refuse this. The earlier version of this test sent a junk OTP, so it was
// killed by the OTP check and a mutant that deleted the password check
// entirely survived it.
await check('disable REFUSES a wrong password even with a valid OTP', async () => {
  await seedEnrolled();
  const { issueCode, PURPOSE, ACTOR } = await import('../services/otpService.js');
  const { code } = await issueCode(1, PURPOSE.ADMIN_2FA_DISABLE, { actorType: ACTOR.SYSUSER });

  const res = mockRes();
  await tfa.disable({ admin: { sysId: 1 }, body: { password: 'wrong', otp: code }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(Number(stored().sysTotpEnabled), 1,
    'CRITICAL: 2FA disabled with a wrong password');
});

// The password alone is not enough either — it is the factor most likely to
// be already compromised in the scenario 2FA exists to survive.
await check('disable REFUSES the right password with no emailed OTP', async () => {
  await seedEnrolled();
  const res = mockRes();
  await tfa.disable({ admin: { sysId: 1 }, body: { password: PASSWORD }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 422);
  assert.strictEqual(Number(stored().sysTotpEnabled), 1, 'CRITICAL: 2FA disabled with password only');
});

await check('disable SUCCEEDS with password + emailed OTP, and wipes every artefact', async () => {
  // enrolWithBackups, NOT seedEnrolled: the artefact-wiping assertions below
  // are vacuous against an account that never had backup codes. A mutant
  // that removed the wipe survived exactly that mistake.
  const { codes } = await enrolWithBackups();
  assert.strictEqual(JSON.parse(stored().sysBackupCodes).length, 10, 'precondition: codes exist');
  assert.ok(stored().sysTotpSecret, 'precondition: a secret exists');

  // Drive the real issueCode path, then read the code out of the stub DB
  // rather than the mail — issuing it any other way would test the harness.
  const { issueCode, PURPOSE, ACTOR } = await import('../services/otpService.js');
  const { code } = await issueCode(1, PURPOSE.ADMIN_2FA_DISABLE, { actorType: ACTOR.SYSUSER });

  const res = mockRes();
  await tfa.disable({ admin: { sysId: 1 }, body: { password: PASSWORD, otp: code }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
  assert.strictEqual(Number(stored().sysTotpEnabled), 0);
  assert.strictEqual(stored().sysTotpSecret, null, 'the secret was left behind');
  assert.strictEqual(stored().sysBackupCodes, null,
    'backup codes for a removed secret must not linger — they would still authenticate on re-enrol');
  assert.strictEqual(stored().sysTotpLastStep, null);

  // And prove it behaviourally: an old backup code must not survive a
  // disable/re-enrol cycle as a live credential.
  const secret2 = await seedEnrolledPreservingRow();
  const l = mockRes();
  await adminLogin({ body: { username: 'root', password: PASSWORD }, ip: '1.2.3.4' }, l);
  const replay = mockRes();
  await tfa.verifyLogin({ body: { challenge: l.body.challenge, code: codes[0] }, ip: '1.2.3.4' }, replay);
  assert.strictEqual(replay.statusCode, 422,
    'a backup code from BEFORE the disable still authenticates after re-enrolling');
  assert.ok(secret2);
});

await check('the disable OTP is scoped to the SYSUSER actor', async () => {
  await seedEnrolled();
  const { issueCode, PURPOSE, ACTOR } = await import('../services/otpService.js');
  // A subscriber with the same numeric id requests a code.
  const { code } = await issueCode(1, PURPOSE.ADMIN_2FA_DISABLE, { actorType: ACTOR.SUBSCRIBER });
  const res = mockRes();
  await tfa.disable({ admin: { sysId: 1 }, body: { password: PASSWORD, otp: code }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 422, 'a subscriber-scoped code disabled an ADMIN second factor');
  assert.strictEqual(Number(stored().sysTotpEnabled), 1);
});

await check('an account with no email cannot disable 2FA online', async () => {
  await seedEnrolled({ sysEmail: null });
  const res = mockRes();
  await tfa.requestDisable({ admin: { sysId: 1 }, ip: '1.2.3.4' }, res);
  assert.strictEqual(res.statusCode, 409, 'a code was sent with no out-of-band channel to send it to');
});

// ============================================================
//  6. STATUS
// ============================================================

await check('status reports enrolment, remaining codes and readability', async () => {
  const { codes } = await enrolWithBackups();
  const res = mockRes();
  await tfa.status({ admin: { sysId: 1 } }, res);
  assert.strictEqual(res.body.data.enabled, true);
  assert.strictEqual(res.body.data.backupCodesRemaining, codes.length);
  assert.strictEqual(res.body.data.secretReadable, true);
  assert.strictEqual(res.body.data.canDisableOnline, true);
});

await check('status surfaces an unreadable secret instead of hiding it', async () => {
  await seedEnrolled();
  stored().sysTotpSecret = 'not:a:envelope';
  const res = mockRes();
  await tfa.status({ admin: { sysId: 1 } }, res);
  assert.strictEqual(res.body.data.secretReadable, false,
    'a rotated key stays invisible until the admin is locked out at next login');
});

await check('status never leaks the secret or the backup-code hashes', async () => {
  await enrolWithBackups();
  const res = mockRes();
  await tfa.status({ admin: { sysId: 1 } }, res);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(stored().sysTotpSecret), 'the encrypted secret is in the response');
  assert.ok(!body.includes('$2b$'), 'backup-code hashes are in the response');
});

console.log(`\n  ${pass} assertions passed${fails.length ? `, ${fails.length} FAILED` : ''}`);
if (fails.length) console.log(`  failed: ${fails.join(' | ')}`);
