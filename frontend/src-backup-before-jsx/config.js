// ============================================================
//  App configuration + static reference data.
// ------------------------------------------------------------
//  API BASE RESOLUTION — read this before changing it.
//
//  This used to be `REACT_APP_API_URL || 'http://localhost:5000/api'`.
//  There is no frontend/.env in the repo, so every production build
//  silently baked in the localhost fallback. On a desktop that looks
//  fine (localhost:5000 really is the dev backend); on a phone,
//  `localhost` is the PHONE, nothing answers, and fetch rejects
//  before leaving the device — surfacing as "Login failed / failed
//  to fetch". A missing env var must never be able to do that again.
//
//  THIS DEPLOYMENT IS SPLIT, so the env var is not optional. Per
//  DEPLOYMENT.md the frontend is a static build on
//  kwarapolydata.com.ng while the API is a separate Node app on
//  api.kwarapolydata.com.ng. VITE_API_URL must be set at build
//  time, and the FRONTEND origin must appear in the backend's
//  CLIENT_ORIGINS or CORS rejects the browser.
//
//  Resolution order below, and why each step exists:
//    1. window.__API_BASE__ — runtime override, see below.
//    2. the build-time env var — the normal production path.
//    3. localhost:5000 — ONLY when actually served from localhost,
//       so a dev machine needs no .env at all.
//    4. same-origin '/api' — last resort. Not right for a split
//       deploy (it hits the static host, whose SPA .htaccess
//       rewrite answers /api/* with index.html, so calls die on
//       "Unexpected token '<'"). It is still a better failure than
//       localhost: it fails identically on every device instead of
//       working on the build machine and nowhere else.
//
//  RUNTIME OVERRIDE — window.__API_BASE__ wins over the build-time
//  var. One inline script in index.html repoints a deployed bundle
//  with no rebuild. It exists because the outage above could only
//  be fixed by rebuilding, which is a bad property for a value
//  that is pure deployment config.
//
//  NOTE ON process.env UNDER VITE: this still reads REACT_APP_API_URL
//  because vite.config.js inlines it via `define`, mapping
//  VITE_API_URL onto it. That keeps this file bundler-agnostic —
//  do not "fix" it to import.meta.env without updating that define.
// ============================================================

function resolveApiBase() {
  // Set on the host, read at page load — no rebuild needed.
  if (typeof window !== 'undefined' && window.__API_BASE__) {
    return String(window.__API_BASE__).replace(/\/$/, '');
  }

  const configured = process.env.REACT_APP_API_URL;
  if (configured) return configured.replace(/\/$/, '');

  // Local dev: the Express backend runs on its own port.
  if (typeof window !== 'undefined') {
    const { hostname } = window.location;
    if (hostname === 'localhost' || hostname === '127.0.0.1') {
      return 'http://localhost:5000/api';
    }
  }

  // Deployed: same origin. Relative, so it inherits the page's
  // protocol and host — no mixed-content block, no CORS.
  return '/api';
}

export const API_BASE = resolveApiBase();

// The 4 selectable color themes (must match src/styles/theme.css).
export const THEMES = [
  { id: 'emerald', name: 'Emerald', color: '#0b6b3a' },
  { id: 'indigo', name: 'Indigo', color: '#4338ca' },
  { id: 'sunset', name: 'Sunset', color: '#e0533d' },
  { id: 'ocean', name: 'Ocean', color: '#0e7490' },
];

// User tiers (sType).
export const TIERS = { 1: 'User', 2: 'Agent', 3: 'Vendor' };

// Nigerian electricity DisCos (not in a dedicated DB table — the
// backend accepts the provider slug as-is and forwards to the
// fulfillment provider).
export const DISCOS = [
  { id: 'ikeja-electric', name: 'Ikeja Electric (IKEDC)' },
  { id: 'eko-electric', name: 'Eko Electric (EKEDC)' },
  { id: 'abuja-electric', name: 'Abuja Electric (AEDC)' },
  { id: 'ibadan-electric', name: 'Ibadan Electric (IBEDC)' },
  { id: 'enugu-electric', name: 'Enugu Electric (EEDC)' },
  { id: 'port-harcourt-electric', name: 'Port Harcourt Electric (PHEDC)' },
  { id: 'kaduna-electric', name: 'Kaduna Electric (KAEDCO)' },
  { id: 'kano-electric', name: 'Kano Electric (KEDCO)' },
  { id: 'jos-electric', name: 'Jos Electric (JEDC)' },
  { id: 'benin-electric', name: 'Benin Electric (BEDC)' },
  { id: 'yola-electric', name: 'Yola Electric (YEDC)' },
];

export const METER_TYPES = [
  { id: 'prepaid', name: 'Prepaid' },
  { id: 'postpaid', name: 'Postpaid' },
];

// Cable providers. `id` maps to the DB `cableprovider` tinyint used by the
// cableplans table. Order confirmed from the legacy dump (kwarapo1_datahood.sql):
// 1=GOTV, 2=DSTV, 3=Startimes (e.g. "GOtv Max" rows carry cableprovider=1,
// the Startimes "Nova" row carries 3).
export const CABLE_PROVIDERS = [
  { id: 1, slug: 'gotv', name: 'GOTV' },
  { id: 2, slug: 'dstv', name: 'DSTV' },
  { id: 3, slug: 'startimes', name: 'Startimes' },
];

// Identity verification types (mirrors the backend VERIFICATION_TYPES).
export const NIGERIAN_STATES = [
  'Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno',
  'Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT','Gombe','Imo',
  'Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa',
  'Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara',
];

// Generate a client-side unique transaction reference.
export function makeRef(prefix) {
  return `${prefix}${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

export function formatNaira(n) {
  const v = Number(n || 0);
  return '₦' + v.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatDate(d) {
  if (!d) return '—';
  try {
    return new Date(d).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return String(d);
  }
}

// ============================================================
//  Network display + phone validation helpers
// ------------------------------------------------------------
//  9MOBILE is branded "T2" in the UI, but the DB value stays
//  9MOBILE. networkLabel() translates only at the presentation
//  layer — never rename the DB row.
// ============================================================
export function networkLabel(name) {
  const k = String(name || '').toUpperCase();
  if (k === '9MOBILE' || k === 'ETISALAT') return 'T2';
  return name;
}

// Rewrite any network name embedded in free text (e.g. a transaction
// description like "9MOBILE Airtime purchase…") to the T2 brand. Keeps
// the rest of the text untouched. DB values are never changed — display only.
export function brandText(text) {
  return String(text || '')
    .replace(/9MOBILE/gi, 'T2')
    .replace(/ETISALAT/gi, 'T2');
}

// Display names for the funding gateways. Presentation only: which
// gateways exist, which are active, and which need a BVN all come from
// GET /payment/accounts, because the browser guessing that is what made
// every Monnify account generation fail on a BVN it never needed.
const GATEWAY_NAMES = {
  monnify: 'Monnify',
  paymentpoint: 'PaymentPoint',
  palmpay: 'PalmPay',
};

// A user may hold reserved accounts at several gateways at once, so the
// gateway has to be named wherever those accounts are listed. An empty
// id means a legacy account whose gateway was never recorded.
export function gatewayLabel(id) {
  const k = String(id || '').toLowerCase();
  if (!k) return 'Bank transfer';
  return GATEWAY_NAMES[k] || k[0].toUpperCase() + k.slice(1);
}

// Authoritative 4-digit prefix → network map. Mirrors the backend
// verifyPhoneNumber() lists in dataController.js / airtimeController.js.
// Keys are the DB network names (uppercased) so they line up with the
// `network` value returned by /catalog/networks.
export const NETWORK_PREFIXES = {
  MTN: ['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'],
  GLO: ['0805', '0807', '0705', '0815', '0811', '0905'],
  AIRTEL: ['0802', '0808', '0708', '0812', '0701', '0902', '0907', '0901', '0904', '0912'],
  '9MOBILE': ['0809', '0818', '0817', '0909', '0908'],
};

// Detect the network from an 11-digit (0-leading) phone number.
// Returns the DB network name (e.g. "9MOBILE") or null if unknown.
export function detectNetwork(phone) {
  const p = String(phone || '').replace(/\D/g, '');
  if (p.length < 4) return null;
  const prefix4 = p.slice(0, 4);
  for (const [name, prefixes] of Object.entries(NETWORK_PREFIXES)) {
    if (prefixes.includes(prefix4)) return name;
  }
  return null;
}

// Realtime phone validation for the purchase forms.
// `expectedNetwork` is the DB network name currently selected (optional).
// Returns { valid, complete, detected, label, msg }.
//   complete  -> 11 digits entered (whether or not it matches)
//   detected  -> DB network name detected from the prefix (or null)
//   label     -> display label for the detected network (T2 for 9MOBILE)
export function validatePhone(phone, expectedNetwork) {
  const p = String(phone || '').replace(/\D/g, '');
  const complete = p.length === 11 && p.startsWith('0');
  const detected = detectNetwork(p);
  const label = detected ? networkLabel(detected) : null;

  if (!p) return { valid: false, complete: false, detected: null, label: null, msg: '' };
  if (!p.startsWith('0')) {
    return { valid: false, complete, detected, label, msg: 'Number must start with 0.' };
  }
  if (p.length < 11) {
    return { valid: false, complete: false, detected, label, msg: '' };
  }
  if (p.length > 11) {
    return { valid: false, complete: false, detected, label, msg: 'Number is too long.' };
  }
  if (!detected) {
    return { valid: false, complete, detected, label, msg: 'Unrecognised number prefix.' };
  }
  if (expectedNetwork && detected !== String(expectedNetwork).toUpperCase()) {
    return {
      valid: false,
      complete,
      detected,
      label,
      msg: `This looks like a ${label} number, not ${networkLabel(expectedNetwork)}.`,
    };
  }
  return { valid: true, complete, detected, label, msg: `${label} number` };
}
