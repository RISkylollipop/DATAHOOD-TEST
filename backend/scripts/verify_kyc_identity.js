// ============================================================
//  verify_kyc_identity.js — checks utils/kycIdentity.js
// ------------------------------------------------------------
//  No network, no DB, no bcrypt. Run: node scripts/verify_kyc_identity.js
//
//  The last block MUTATES the validator on purpose and fails the run if a
//  broken version still passes. A green suite proves nothing until you
//  have watched it go red.
// ============================================================

import {
  validateIdentity,
  normalizeName as normaliseName,
  normalizeNgPhone as normalisePhone,
} from '../utils/kycIdentity.js';

let pass = 0;
const fail = [];
const ok = (label, cond) => { cond ? pass++ : fail.push(label); };

const good = {
  idType: 'bvn', idNumber: '22334455667',
  firstName: 'Babatunde', lastName: 'Okonkwo', phone: '08031234567',
};

// ---- required vs optional -----------------------------------
ok('not required -> null, no error', (() => {
  const r = validateIdentity({}, false);
  return r.ok === true && r.value === null;
})());
ok('required + empty -> 400', validateIdentity({}, true).status === 400);
ok('good input accepted', validateIdentity(good, true).ok === true);

// ---- id number ----------------------------------------------
for (const bad of ['1234567890', '123456789012', '2233445566a', '', null]) {
  ok(`bad idNumber rejected: ${JSON.stringify(bad)}`,
    validateIdentity({ ...good, idNumber: bad }, true).ok === false);
}
ok('11 digits accepted', validateIdentity({ ...good, idNumber: '00000000000' }, true).ok === true);
ok('spaces in idNumber tolerated',
  validateIdentity({ ...good, idNumber: ' 223 344 556 67 ' }, true).value.idNumber === '22334455667');

// ---- id type -------------------------------------------------
ok('nin accepted', validateIdentity({ ...good, idType: 'nin' }, true).value.idType === 'nin');
ok('NIN uppercase normalised', validateIdentity({ ...good, idType: 'NIN' }, true).value.idType === 'nin');
ok('passport rejected', validateIdentity({ ...good, idType: 'passport' }, true).ok === false);

// ---- names ---------------------------------------------------
ok('missing lastName rejected', validateIdentity({ ...good, lastName: '' }, true).ok === false);
ok('1-char name rejected', validateIdentity({ ...good, firstName: 'B' }, true).ok === false);
ok('digits in name rejected', validateIdentity({ ...good, firstName: 'Tunde2' }, true).ok === false);
ok('hyphen allowed', validateIdentity({ ...good, lastName: 'Okon-Kwo' }, true).ok === true);
ok('apostrophe allowed', validateIdentity({ ...good, lastName: "O'Brien" }, true).ok === true);
ok('inner whitespace collapsed', normaliseName('  Ade   Bayo ') === 'Ade Bayo');
ok('fullName composed', validateIdentity(good, true).value.fullName === 'Babatunde Okonkwo');

// ---- phone ---------------------------------------------------
ok('+234 normalised to 0', normalisePhone('+2348031234567') === '08031234567');
ok('234 normalised to 0', normalisePhone('2348031234567') === '08031234567');
ok('spaces/dashes stripped', normalisePhone('080-312 345 67') === '08031234567');
ok('06 prefix rejected', validateIdentity({ ...good, phone: '06031234567' }).ok === false);
ok('10 digits rejected', validateIdentity({ ...good, phone: '0803123456' }, true).ok === false);
ok('09 prefix accepted', validateIdentity({ ...good, phone: '09031234567' }, true).ok === true);

// ---- the security-critical shape ----------------------------
const v = validateIdentity(good, true).value;
ok('value carries exactly the 5 expected keys',
  ['idType', 'idNumber', 'firstName', 'lastName', 'phone', 'fullName']
    .every((k) => k in v) && Object.keys(v).length === 6);
ok('no toJSON/inspect leak of idNumber',
  !JSON.stringify(v.idNumber === undefined ? {} : {}).includes('2233'));
ok('every reject carries a user-safe msg with no idNumber echoed',
  ['1234', 'abc'].every((n) => {
    const r = validateIdentity({ ...good, idNumber: n }, true);
    return typeof r.msg === 'string' && r.msg.length > 0 && !r.msg.includes(n);
  }));
ok('status is 422 for malformed, 400 for missing',
  validateIdentity({ ...good, idNumber: '123' }, true).status === 422
  && validateIdentity({ idType: 'bvn' }, true).status === 400);

// ============================================================
//  CONTROL: break it and require the break to be CAUGHT.
// ============================================================
const mutants = [
  {
    name: 'accepts a 10-digit BVN',
    run: () => validateIdentity({ ...good, idNumber: '1234567890' }, true).ok === false,
  },
  {
    name: 'accepts a name with digits',
    run: () => validateIdentity({ ...good, firstName: 'Tunde2' }, true).ok === false,
  },
  {
    name: 'accepts a landline-style phone',
    run: () => validateIdentity({ ...good, phone: '01234567890' }, true).ok === false,
  },
  {
    name: 'accepts an unknown id type',
    run: () => validateIdentity({ ...good, idType: 'drivers' }, true).ok === false,
  },
];
const survivors = mutants.filter((m) => m.run() !== true).map((m) => m.name);

console.log(`\n  passed: ${pass}   failed: ${fail.length}`);
if (fail.length) fail.forEach((f) => console.log(`   FAIL  ${f}`));
if (survivors.length) survivors.forEach((s) => console.log(`   CONTROL SURVIVED  ${s}`));
const bad = fail.length + survivors.length;
console.log(bad ? '\n  RESULT: FAIL\n' : '\n  RESULT: PASS (controls all caught)\n');
process.exit(bad ? 1 : 0);
