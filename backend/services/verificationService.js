// ============================================================
//  Verification Service — identity lookups (NIN, BVN, Passport,
//  Driver's License, Voter's Card, Phone)
// ------------------------------------------------------------
//  Provider-agnostic, exactly like providerService.js. The
//  endpoint + key come from the `providers` table (category
//  'nin' / 'bvn' or a generic 'identity' provider), NEVER
//  hardcoded. When you get a real verifynin.ng (or other) API
//  key, drop it into the admin panel — no code change needed.
//
//  Each verification type maps to a "slug" the admin can point
//  at a path/action on the provider. Because different KYC
//  providers name their fields differently, normalizeResult()
//  maps a wide range of common response keys into ONE shape the
//  rest of the app (and the PDF slip) can rely on.
//
//  NOTE: outbound network is blocked in the build sandbox, so
//  these calls cannot be exercised here. Use the admin
//  "Test connection" button on your own server to confirm the
//  provider responds before going live.
// ============================================================

// Uses Node 18+ global fetch.

/**
 * The six identity types verifynin.ng supports. Each has a
 * human label, the input field name, and whether a photo is
 * expected in the result (drives the PDF slip layout).
 */
export const VERIFICATION_TYPES = {
  nin: { label: 'National Identity Number (NIN)', input: 'nin', digits: 11, hasPhoto: true },
  bvn: { label: 'Bank Verification Number (BVN)', input: 'bvn', digits: 11, hasPhoto: true },
  passport: { label: 'International Passport', input: 'passport_number', digits: null, hasPhoto: true },
  dl: { label: "Driver's License", input: 'license_number', digits: null, hasPhoto: true },
  voters: { label: "Voter's Card (VIN)", input: 'vin', digits: null, hasPhoto: false },
  phone: { label: 'Phone Number', input: 'phone', digits: 11, hasPhoto: false },
};

/**
 * Normalize a provider's raw response into ONE shape the app uses.
 * KYC providers vary wildly in field naming, so we probe many keys.
 * @returns {object} { fullName, firstName, lastName, middleName, dob,
 *                     gender, phone, address, state, lga, photoBase64, extras }
 */
function normalizeResult(raw, type) {
  const d = raw?.data || raw?.result || raw || {};

  const pick = (...keys) => {
    for (const k of keys) {
      if (d[k] !== undefined && d[k] !== null && d[k] !== '') return d[k];
    }
    return null;
  };

  const firstName = pick('firstName', 'first_name', 'firstname', 'fName');
  const lastName = pick('lastName', 'last_name', 'lastname', 'surname', 'lName');
  const middleName = pick('middleName', 'middle_name', 'middlename', 'mName');
  const fullName =
    pick('fullName', 'full_name', 'name') ||
    [firstName, middleName, lastName].filter(Boolean).join(' ').trim() ||
    null;

  // Photo may arrive as base64 under many names; strip any data-URL prefix.
  let photoBase64 = pick('photo', 'photoBase64', 'image', 'picture', 'photograph', 'base64Image');
  if (photoBase64 && typeof photoBase64 === 'string') {
    photoBase64 = photoBase64.replace(/^data:image\/\w+;base64,/, '');
  }

  return {
    type,
    fullName,
    firstName,
    lastName,
    middleName,
    dob: pick('dateOfBirth', 'date_of_birth', 'dob', 'birthdate'),
    gender: pick('gender', 'sex'),
    phone: pick('phone', 'phoneNumber', 'phone_number', 'mobile', 'msisdn'),
    address: pick('address', 'residential_address', 'residentialAddress'),
    state: pick('state', 'stateOfOrigin', 'state_of_origin'),
    lga: pick('lga', 'lgaOfOrigin', 'lga_of_origin', 'localGovernment'),
    photoBase64: photoBase64 || null,
    // Keep the full raw payload minus the (large) photo for auditing.
    extras: (() => {
      const { photo, image, picture, photograph, base64Image, ...rest } = d;
      return rest;
    })(),
  };
}

/**
 * Run an identity verification through the configured provider.
 * @param {object} opts { host, apiKey, authStyle, extraConfig, type, query }
 *   host       - provider base URL
 *   apiKey     - decrypted key
 *   authStyle  - 'token' | 'bearer' | 'basic'
 *   extraConfig- parsed JSON: may hold per-type path overrides { paths: { nin: 'vnin', ... } }
 *   type       - one of VERIFICATION_TYPES keys
 *   query      - the ID number / phone the user entered
 * @returns {Promise<{status:'success'|'fail', msg?, data?, raw?}>}
 */
export async function verifyIdentity(opts) {
  const { host, apiKey, authStyle = 'token', extraConfig = {}, type, query } = opts;
  const meta = VERIFICATION_TYPES[type];
  if (!meta) return { status: 'fail', msg: 'Unsupported verification type.' };

  // Resolve the endpoint. Admin can override the path per type via
  // extraConfig.paths, else we append the type slug to the base URL.
  const paths = extraConfig.paths || {};
  const pathSlug = paths[type] || type;
  const url = host.replace(/\/?$/, '/') + String(pathSlug).replace(/^\//, '');

  // Auth header style — matches how the other services branch.
  let authHeader;
  if (authStyle === 'bearer') authHeader = `Bearer ${apiKey}`;
  else if (authStyle === 'basic') authHeader = `Basic ${apiKey}`;
  else authHeader = `Token ${apiKey}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authHeader },
      body: JSON.stringify({ [meta.input]: String(query), type }),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.json().catch(() => ({}));

    // Success is signalled differently across providers — probe common flags.
    const flag = raw.status ?? raw.Status ?? raw.success;
    const ok =
      res.ok &&
      (flag === true ||
        flag === 'success' ||
        flag === 'successful' ||
        flag === 'verified' ||
        raw.verified === true ||
        (raw.data && (raw.data.firstName || raw.data.fullName || raw.data.name)));

    if (ok) {
      return { status: 'success', data: normalizeResult(raw, type), raw };
    }
    return {
      status: 'fail',
      msg: raw.msg || raw.message || raw.error || 'Could not verify. Please check the number and try again.',
      raw,
    };
  } catch (err) {
    // A hung verification provider must not hold the request open — the
    // caller has already reserved the fee and needs a definite answer.
    const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return {
      status: 'fail',
      msg: timedOut
        ? 'The verification service did not respond in time. Please try again.'
        : 'Server Connection Error',
      error: err.message,
      timedOut,
    };
  }
}
