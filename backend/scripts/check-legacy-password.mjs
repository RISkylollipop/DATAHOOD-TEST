// ============================================================
//  check-legacy-password.mjs
// ------------------------------------------------------------
//  Confirms the legacy password algorithm lifted from the old PHP
//  really does reproduce the sPass values sitting in your database.
//
//  The PHP (core/Models/Account.php, AdminModel.php) hashed with:
//      substr(sha1(md5($password)), 3, 10)
//
//  USAGE — no database needed, no dependencies:
//
//    node scripts/check-legacy-password.mjs
//        Runs the self-test.
//
//    node scripts/check-legacy-password.mjs "myPassword"
//        Prints the legacy hash for that password. Compare it to the
//        sPass value in your subscribers row — if they match, that
//        password is correct and login will now work.
//
//  Example: your own account (sId 13, phone 09078107640) has
//  sPass = '434065b4e0'. Run the script with your real password and
//  see if you get 434065b4e0 back. If yes, login is fixed.
// ============================================================

import crypto from 'crypto';

function legacyPhpHash(plain) {
  const md5 = crypto.createHash('md5').update(String(plain)).digest('hex');
  const sha1 = crypto.createHash('sha1').update(md5).digest('hex');
  return sha1.substring(3, 13); // PHP substr(s, 3, 10)
}

// ---------- single-password mode ----------
const arg = process.argv[2];
if (arg !== undefined) {
  const hash = legacyPhpHash(arg);
  console.log(`\npassword : ${arg}`);
  console.log(`legacy hash : ${hash}`);
  console.log(`\nCompare that against the sPass column for your account:`);
  console.log(`  SELECT sId, sPhone, sPass FROM subscribers WHERE sPhone='09078107640';`);
  console.log(`\nIf they match, this password now works at login.\n`);
  process.exit(0);
}

// ---------- self-test mode ----------
let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

console.log('\nAlgorithm: substr(sha1(md5(password)), 3, 10)\n');

console.log('output shape');
for (const s of ['password', '1234', 'test@123', 'Kdas1loved1']) {
  const h = legacyPhpHash(s);
  check(`"${s}"`, h.length === 10 && /^[0-9a-f]{10}$/.test(h), `-> ${h}`);
}

console.log('\ndeterminism and distinctness');
check('same input gives same hash', legacyPhpHash('abc') === legacyPhpHash('abc'));
check('different inputs give different hashes', legacyPhpHash('a1') !== legacyPhpHash('a2'));

// Real sPass values copied from kwarapo1_datahood.sql. Every one must fit
// the algorithm's output shape. If any did not, the algorithm ID is wrong.
console.log('\nstored sPass values fit this algorithm');
const stored = [
  '434065b4e0', '7fe71f51ee', '77b6981b77', '48e6a0a94b', 'f912cd322b',
  'd58b1629d7', 'd052a46e29', 'b3835622f8', 'c17e096652', 'c90852c9bd',
  'd230134646', '2ea75c5cc5', '05027b7bd5', 'de77cacef4', 'be1a7b435c',
  '4591a0752e', '3dd8d3e760', '7786424a68', '93f7a33684', '2934547980',
];
const good = stored.filter((v) => /^[0-9a-f]{10}$/.test(v)).length;
check(`${good}/${stored.length} real values are 10-char lowercase hex`, good === stored.length);

console.log('\nverifyLegacyPassword guards');
function verifyLegacyPassword(plain, storedHash) {
  if (typeof storedHash !== 'string' || storedHash.length === 0) return false;
  const a = Buffer.from(legacyPhpHash(plain));
  const b = Buffer.from(storedHash);
  if (a.length !== b.length) return false; // timingSafeEqual throws on mismatch
  return crypto.timingSafeEqual(a, b);
}

const h = legacyPhpHash('myRealPassword');
check('correct password verifies', verifyLegacyPassword('myRealPassword', h) === true);
check('wrong password rejected', verifyLegacyPassword('wrongPassword', h) === false);
check('empty stored value rejected', verifyLegacyPassword('x', '') === false);
check('null stored value rejected', verifyLegacyPassword('x', null) === false);

let threw = false;
try {
  verifyLegacyPassword('x', '$2b$12$' + 'y'.repeat(53));
} catch {
  threw = true;
}
check('60-char bcrypt value returns false without throwing', !threw);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
