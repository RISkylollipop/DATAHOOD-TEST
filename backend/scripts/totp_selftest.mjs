// Throwaway harness: RFC 4648 base32 + RFC 6238 TOTP published vectors.
// Not part of the app. Run: node scripts/totp_selftest.mjs
import assert from 'assert';
import {
  base32Encode, base32Decode, hotp, generateCode, verifyCode,
  generateSecret, otpauthUrl, generateBackupCodes, normalizeBackupCode,
  stepFor, TOTP_WINDOW,
} from '../utils/totp.js';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass += 1; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); process.exitCode = 1; }
};

// ---------- RFC 4648 §10 base32 test vectors ----------
const B32 = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'],
             ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
for (const [plain, encoded] of B32) {
  check(`base32Encode(${JSON.stringify(plain)}) === ${encoded}`, () => {
    assert.strictEqual(base32Encode(Buffer.from(plain, 'utf8')), encoded);
  });
  check(`base32Decode(${encoded}) roundtrips`, () => {
    assert.strictEqual(base32Decode(encoded).toString('utf8'), plain);
  });
}

// ---------- RFC 6238 Appendix B test vectors (SHA1, 8 digits) ----------
// Seed is the ASCII string "12345678901234567890".
const SEED = base32Encode(Buffer.from('12345678901234567890', 'utf8'));
const VECTORS = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];
for (const [t, expected] of VECTORS) {
  check(`RFC6238 T=${t} -> ${expected}`, () => {
    assert.strictEqual(generateCode(SEED, { atMs: t * 1000, digits: 8 }), expected);
  });
}

// hotp directly, via the same vectors' counter values
check('hotp counter matches generateCode', () => {
  assert.strictEqual(hotp(base32Decode(SEED), Math.floor(59 / 30), 8), '94287082');
});

// ---------- padding / tolerance ----------
check('base32Decode accepts padding, lowercase and spaces', () => {
  assert.strictEqual(base32Decode('mzxw6ytb oi==').toString('utf8'), 'foobar');
});
check('base32Decode rejects an invalid character', () => {
  assert.throws(() => base32Decode('MZXW6YTB1'), /Invalid base32/);
});

// ---------- verifyCode behaviour ----------
const secret = generateSecret();
const now = 1_700_000_000_000;

check('accepts the current code', () => {
  const t = generateCode(secret, { atMs: now });
  assert.strictEqual(verifyCode(secret, t, { atMs: now }).ok, true);
});
check('accepts one step of drift either way', () => {
  const prev = generateCode(secret, { atMs: now - 30_000 });
  const next = generateCode(secret, { atMs: now + 30_000 });
  assert.strictEqual(verifyCode(secret, prev, { atMs: now }).ok, true);
  assert.strictEqual(verifyCode(secret, next, { atMs: now }).ok, true);
});
// Boundary, not just "something far away". The window is +/-1, so the FIRST
// step outside it is 2 (60s). Testing 90s instead would still pass with the
// window silently widened to +/-2 — which would keep every code alive for
// 150s and triple the brute-force surface. Caught by mutation testing.
check('rejects exactly two steps of drift (the +/-1 boundary)', () => {
  const past = generateCode(secret, { atMs: now - 60_000 });
  const future = generateCode(secret, { atMs: now + 60_000 });
  assert.strictEqual(verifyCode(secret, past, { atMs: now }).ok, false, 'T-2 must fail');
  assert.strictEqual(verifyCode(secret, future, { atMs: now }).ok, false, 'T+2 must fail');
  const old = generateCode(secret, { atMs: now - 90_000 });
  assert.strictEqual(verifyCode(secret, old, { atMs: now }).ok, false, 'T-3 must fail');
});
check('the configured window is +/-1', () => {
  assert.strictEqual(TOTP_WINDOW, 1);
});
check('rejects a wrong code with reason mismatch', () => {
  assert.strictEqual(verifyCode(secret, '000000', { atMs: now }).reason, 'mismatch');
});
check('rejects malformed input without throwing', () => {
  for (const bad of ['', null, undefined, 'abcdef', '12345', '1234567', '12-34-56']) {
    assert.strictEqual(verifyCode(secret, bad, { atMs: now }).reason, 'malformed', String(bad));
  }
});
// Authenticator apps render the code as "123 456" and people copy the space
// in. Stripping it is deliberate (totp.js:184), so a spaced-but-correct code
// must AUTHENTICATE, and a spaced-but-wrong one must read 'mismatch' rather
// than 'malformed' — the shape was fine, the digits were not.
check('tolerates the spacing authenticator apps display', () => {
  const t = generateCode(secret, { atMs: now });
  const spaced = `${t.slice(0, 3)} ${t.slice(3)}`;
  assert.strictEqual(verifyCode(secret, spaced, { atMs: now }).ok, true, spaced);
  assert.strictEqual(verifyCode(secret, '12 34 56', { atMs: now }).reason, 'mismatch');
});
check('returns the matched step so the caller can persist it', () => {
  const t = generateCode(secret, { atMs: now });
  assert.strictEqual(verifyCode(secret, t, { atMs: now }).step, stepFor(now));
});

// THE replay guard — the whole reason sysTotpLastStep exists.
check('REPLAY: same code refused once its step is recorded', () => {
  const t = generateCode(secret, { atMs: now });
  const first = verifyCode(secret, t, { atMs: now, lastStep: null });
  assert.strictEqual(first.ok, true, 'first use should pass');
  const second = verifyCode(secret, t, { atMs: now, lastStep: first.step });
  assert.strictEqual(second.ok, false, 'second use MUST fail');
  assert.strictEqual(second.reason, 'replay');
});
check('REPLAY: a stale-but-in-window code is refused after a newer one', () => {
  const prev = generateCode(secret, { atMs: now - 30_000 });
  const res = verifyCode(secret, prev, { atMs: now, lastStep: stepFor(now) });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'replay');
});
check('REPLAY: the NEXT step still works after one is consumed', () => {
  const consumed = stepFor(now);
  const later = generateCode(secret, { atMs: now + 30_000 });
  assert.strictEqual(verifyCode(secret, later, { atMs: now + 30_000, lastStep: consumed }).ok, true);
});
check('a wrong secret does not verify', () => {
  const t = generateCode(secret, { atMs: now });
  assert.strictEqual(verifyCode(generateSecret(), t, { atMs: now }).ok, false);
});
check('malformed stored secret returns malformed, not a throw', () => {
  assert.strictEqual(verifyCode('!!!!', '123456', { atMs: now }).reason, 'malformed');
  assert.strictEqual(verifyCode('', '123456', { atMs: now }).reason, 'malformed');
});

// ---------- enrolment surface ----------
check('generateSecret is 32 base32 chars and decodes to 20 bytes', () => {
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.strictEqual(base32Decode(secret).length, 20);
});
check('secrets are not repeated', () => {
  const s = new Set(Array.from({ length: 50 }, () => generateSecret()));
  assert.strictEqual(s.size, 50);
});
check('otpauth URL is well-formed and app-compatible', () => {
  const url = otpauthUrl({ secret, account: 'admin@kwarapolydata.com.ng' });
  assert.ok(url.startsWith('otpauth://totp/'), url);
  const u = new URL(url);
  assert.strictEqual(u.searchParams.get('secret'), secret);
  assert.strictEqual(u.searchParams.get('issuer'), 'DATAHOOD');
  assert.strictEqual(u.searchParams.get('algorithm'), 'SHA1');
  assert.strictEqual(u.searchParams.get('digits'), '6');
  assert.strictEqual(u.searchParams.get('period'), '30');
  // The label must survive as "Issuer:account", not be mangled.
  assert.ok(decodeURIComponent(url.split('?')[0].replace('otpauth://totp/', ''))
    === 'DATAHOOD:admin@kwarapolydata.com.ng');
});
// The issuer is repeated in the URI (label + param), so its length is
// doubled inside a payload that must fit a QR symbol. utils/qrcode.js
// caps at version 10; assert the headroom rather than discover it in
// production when an admin with a long email cannot enrol.
check('otpauth URI stays well inside QR capacity', () => {
  const long = otpauthUrl({ secret, account: 'a.very.long.administrator.address@kwarapolydata.com.ng' });
  assert.ok(long.length < 180, `otpauth URI is ${long.length} bytes, too close to the v10 ceiling`);
});

// ---------- backup codes ----------
check('backup codes are unique, formatted, and normalise back', () => {
  const codes = generateBackupCodes(10);
  assert.strictEqual(new Set(codes).size, 10);
  for (const c of codes) {
    assert.match(c, /^[0-9A-F]{5}-[0-9A-F]{5}$/, c);
    assert.strictEqual(normalizeBackupCode(c.toLowerCase()), c.replace('-', ''));
    assert.strictEqual(normalizeBackupCode(` ${c} `), c.replace('-', ''));
  }
});

console.log(`\n  ${pass} assertions passed${process.exitCode ? ' (with failures above)' : ''}`);
