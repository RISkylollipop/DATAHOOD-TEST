// ============================================================
//  utils/kycIdentity.js — validate + normalise reserved-account KYC
// ------------------------------------------------------------
//  Every Nigerian funding gateway now reserves an account only against a
//  verified identity: a BVN or NIN, plus the FIRST NAME, LAST NAME and
//  PHONE NUMBER as recorded against it. The gateway forwards those to
//  NIBSS/NIMC, which answers yes or no on an exact-match basis.
//
//  Why these cannot be taken from the user's profile — the mistake this
//  module exists to stop. We used to send `sFname + ' ' + sLname` and
//  `sPhone` straight from `subscribers`. Those are SIGNUP details: people
//  register here as "Tunde" when the bank holds "Babatunde", or sign up on
//  a second SIM. Both are perfectly valid accounts and both fail the
//  NIBSS match, which the gateway returns as a flat rejection. So the KYC
//  name and phone are collected SEPARATELY and default to the profile
//  only as a convenience the user can correct.
//
//  ZERO dependencies, deliberately. The rules here decide whether a real
//  person can fund their wallet, so they need a unit test that does not
//  drag in bcrypt (which cannot even load in the sandbox — see
//  scripts/verify_kyc_identity.js).
//
//  NOTHING here is persisted. See services/paymentService.js: the ID
//  number is forwarded to the gateway and never written to our database
//  or our logs. This module only shapes and checks it in memory.
// ============================================================

// BVN and NIN are BOTH exactly 11 digits, so the type can never be
// inferred from the value — the caller must state which one it is.
// Guessing would send a NIN to the `bvn` field and get a rejection that
// reads like the number itself is wrong.
export const ID_TYPES = ['bvn', 'nin'];

export function digitsOnly(v) {
  return String(v ?? '').replace(/\D/g, '');
}

/**
 * Normalise a Nigerian mobile number to 11-digit local form (0XXXXXXXXXX).
 * Accepts +2348…, 2348…, 08…, and 8… (a leading zero dropped by a
 * spreadsheet or a numeric input).
 * @returns {string} normalised number, or '' if it cannot be one
 */
export function normalizeNgPhone(v) {
  let d = digitsOnly(v);
  if (d.startsWith('234')) d = `0${d.slice(3)}`;
  else if (d.length === 10 && d.startsWith('8')) d = `0${d}`;
  // Valid NG mobile: 11 digits, 0 then 7/8/9 then any 9.
  return /^0[789]\d{9}$/.test(d) ? d : '';
}

/**
 * A person's name as a bank would hold it. Letters plus the marks that
 * legitimately appear in Nigerian names — hyphen (Ade-Ola), apostrophe
 * (N'Diaye), full stop (initials) and space (compound names).
 * Rejects digits, which is the tell for a phone number typed in the
 * wrong box.
 */
const NAME_OK = /^[A-Za-z][A-Za-z '.-]{0,49}$/;

export function normalizeName(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ');
}

export function isValidName(v) {
  const n = normalizeName(v);
  return n.length >= 2 && NAME_OK.test(n);
}

/**
 * Validate and normalise the identity block for a reserved account.
 *
 * @param {object} input  { idType, idNumber, firstName, lastName, phone }
 * @param {boolean} required  whether this gateway demands an identity at all
 * @returns {{ ok: true, value: object|null } | { ok: false, status: number, msg: string }}
 *   `value` is null when nothing is required and nothing was supplied.
 *   Errors carry the HTTP status the caller should use: 400 for a missing
 *   field, 422 for one that is present but malformed — the distinction the
 *   rest of the controllers already make.
 */
export function validateIdentity(input = {}, required = false) {
  const idType = String(input.idType ?? 'bvn').toLowerCase();
  const idNumber = digitsOnly(input.idNumber);
  const firstName = normalizeName(input.firstName);
  const lastName = normalizeName(input.lastName);
  const phone = normalizeNgPhone(input.phone);

  const anySupplied = Boolean(idNumber || firstName || lastName || input.phone);
  if (!required && !anySupplied) return { ok: true, value: null };

  if (!ID_TYPES.includes(idType)) {
    return { ok: false, status: 422, msg: 'Choose either BVN or NIN.' };
  }
  const LABEL = idType.toUpperCase();

  if (!idNumber) {
    return { ok: false, status: 400, msg: `Your ${LABEL} is required to open this account.` };
  }
  if (idNumber.length !== 11) {
    return { ok: false, status: 422, msg: `Invalid ${LABEL}. It must be exactly 11 digits.` };
  }
  if (!firstName || !lastName) {
    return {
      ok: false,
      status: 400,
      msg: `Enter the first and last name registered on your ${LABEL}.`,
    };
  }
  if (!isValidName(firstName) || !isValidName(lastName)) {
    return {
      ok: false,
      status: 422,
      msg: 'Names may contain only letters, spaces, hyphens and apostrophes.',
    };
  }
  if (!phone) {
    return {
      ok: false,
      status: input.phone ? 422 : 400,
      msg: input.phone
        ? 'That phone number is not a valid Nigerian mobile number.'
        : `Enter the phone number registered on your ${LABEL}.`,
    };
  }

  return {
    ok: true,
    value: { idType, idNumber, firstName, lastName, phone, fullName: `${firstName} ${lastName}` },
  };
}
