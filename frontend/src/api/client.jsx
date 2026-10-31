// ============================================================
//  API client — thin fetch wrapper (no axios, per project pref).
//  Attaches the JWT, parses JSON, throws a normalized error with
//  the backend's { status, msg } shape, and exposes a blob helper
//  for the verified-slip PDF download.
// ============================================================

import { API_BASE } from '../config';

const TOKEN_KEY = 'noblesmega_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(extra = {}) {
  const h = { ...extra };
  const t = getToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/**
 * Is the stored token already past its expiry, by this machine's clock?
 *
 * NOT a security check — the payload is read without verifying the signature,
 * and the server re-checks everything regardless. This exists only so the app
 * does not boot a signed-in dashboard around a token that is plainly dead,
 * fire a handful of doomed requests, and turn a routine timeout into a screen
 * full of red toasts.
 *
 * `graceMs` is deliberately generous. `exp` was written against the SERVER's
 * clock and compared here against the BROWSER's, so a user whose clock runs
 * fast would otherwise be refused a token the server would have accepted
 * happily — a self-inflicted logout with no possible explanation. Five
 * minutes swallows ordinary skew while still catching the case this was
 * written for, a token that expired over an hour ago.
 *
 * Unreadable or unexpiring tokens answer FALSE: when in doubt, let the
 * request go and let the server be the judge.
 */
export function isTokenExpired(graceMs = 5 * 60 * 1000) {
  const t = getToken();
  if (!t) return false;
  try {
    const payload = t.split('.')[1];
    if (!payload) return false;
    // base64url -> base64, then pad to a multiple of 4 for atob.
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const exp = Number(JSON.parse(json).exp);
    if (!Number.isFinite(exp) || exp <= 0) return false;
    return Date.now() > exp * 1000 + graceMs;
  } catch {
    return false;
  }
}

// Login screens where a 401 is an EXPECTED answer ("wrong password"), not a
// dead session. Both must be listed: '/admin/login'.startsWith('/login') is
// false, so exempting only '/login' meant a single fumbled admin password
// returned 401 from adminLogin, tripped the auto-logout below, and silently
// destroyed the session of whoever was already signed in on that browser.
const LOGIN_PATHS = ['/login', '/admin/login'];

/**
 * Adopt a slid-forward session token.
 *
 * The backend gives every session a 15-minute life and re-mints it once a
 * third of that is used up (backend/utils/sessionToken.js), which is how
 * "15 minutes of inactivity" is expressed in a JWT that can only carry an
 * absolute expiry. Miss the header and the token in storage simply ages out
 * — the session dies 15 minutes after login no matter how busy the user is.
 *
 * Called for failed responses too: the renewal rides on any authorised
 * request, and a 422 from a business rule is still an active session.
 */
const IDLE_MS_KEY = 'noblesmega_session_idle_ms';

/**
 * The server's idle window, in ms, as it last reported it — or 0 if it never
 * has. Lets the client-side watchdog use the operator's real
 * SESSION_IDLE_MINUTES instead of assuming the 15-minute default, so the two
 * halves cannot drift apart when that setting is changed on the server.
 */
// Plausibility bounds for a stored idle window. A value outside these is not
// a window we ever wrote, so it is discarded rather than honoured.
//
// This is not defensive decoration — it is a real failure that shipped. The
// value is a MILLISECOND count written from a SECONDS header, and any build
// that stored the raw seconds leaves `900` behind in localStorage. Read back
// as milliseconds that is a 0.9-SECOND session: the idle watchdog's first
// 30-second tick decides the user is gone and signs them out, about half a
// minute after every login, forever, because localStorage survives the fix.
// Clearing the key here is what heals an already-poisoned browser without
// asking the user to wipe their site data.
const MIN_IDLE_MS = 60 * 1000;          // a one-minute session is never intended
const MAX_IDLE_MS = 24 * 60 * 60 * 1000; // nor a multi-day one

export function getSessionIdleMs() {
  const n = Number(localStorage.getItem(IDLE_MS_KEY));
  if (Number.isFinite(n) && n >= MIN_IDLE_MS && n <= MAX_IDLE_MS) return n;
  // Absent is normal (nothing to do); present-but-impossible is corruption,
  // so drop it and let the caller fall back to the 15-minute default.
  if (localStorage.getItem(IDLE_MS_KEY) !== null) {
    try { localStorage.removeItem(IDLE_MS_KEY); } catch { /* private mode */ }
  }
  return 0;
}

function adoptRenewedToken(res) {
  try {
    // The header is in SECONDS; storage is in MILLISECONDS. Converting on the
    // way in is the whole contract of this key, and the range check mirrors
    // getSessionIdleMs so a malformed or mis-united header is never stored.
    const secs = Number(res.headers.get('X-Session-Expires-In'));
    if (Number.isFinite(secs) && secs > 0) {
      const ms = secs * 1000;
      if (ms >= MIN_IDLE_MS && ms <= MAX_IDLE_MS) {
        localStorage.setItem(IDLE_MS_KEY, String(ms));
      }
    }
    const fresh = res.headers.get('X-Session-Token');
    // Only overwrite when one already exists. A renewal arriving after
    // logout (a request already in flight when the user signed out) would
    // otherwise write the session back into storage.
    if (fresh && getToken()) setToken(fresh);
  } catch {
    // Header access can throw on an opaque response. A missed renewal costs
    // the user nothing until the next one, and the request itself must not
    // fail over session plumbing.
  }
}

async function handle(res) {
  adoptRenewedToken(res);
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : {}; } catch { body = { msg: text }; }
  if (!res.ok || body.status === 'fail') {
    const err = new Error(body.msg || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    // Auto-logout on auth failure.
    if (res.status === 401) {
      const onLoginScreen = LOGIN_PATHS.some((p) => window.location.pathname.startsWith(p));
      if (!onLoginScreen) {
        // Tell the login screen why it is being shown. Without this the user
        // is dropped onto a bare sign-in form with no account of what just
        // happened — which is how an ordinary 15-minute timeout came to look
        // like the app breaking. 'expired' rather than 'idle': every 401 ends
        // the session, but only the client-side watchdog knows it was
        // inactivity, and guessing wrong puts a false explanation on screen.
        try { sessionStorage.setItem('noblesmega_logout_reason', 'expired'); } catch { /* ignore */ }
        setToken('');
        window.dispatchEvent(new CustomEvent('noblesmega:unauthorized'));
      }
    }
    throw err;
  }
  return body;
}

export const api = {
  get: (path, params) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return fetch(`${API_BASE}${path}${qs}`, { headers: authHeaders() }).then(handle);
  },
  post: (path, data) =>
    fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data || {}),
    }).then(handle),
  put: (path, data) =>
    fetch(`${API_BASE}${path}`, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data || {}),
    }).then(handle),
  patch: (path, data) =>
    fetch(`${API_BASE}${path}`, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data || {}),
    }).then(handle),
  del: (path) =>
    fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: authHeaders() }).then(handle),

  // Download a binary (PDF slip). Triggers a browser save.
  download: async (path, filename) => {
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
    adoptRenewedToken(res); // downloads bypass handle(), so renew here too
    if (!res.ok) {
      const t = await res.text();
      let msg = 'Download failed.';
      try { msg = JSON.parse(t).msg || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },

  /**
   * Download a file that requires a POST with body (e.g., a password).
   * The backend responds with an attachment, and this triggers a browser save.
   */
  downloadPost: async (path, data, filename) => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data || {}),
    });
    adoptRenewedToken(res);
    if (!res.ok) {
      const t = await res.text();
      let body = {};
      try { body = JSON.parse(t); } catch {}
      const err = new Error(body.msg || `Download failed (${res.status})`);
      err.status = res.status;
      err.body = body;
      // Deliberately NOT repeating handle()'s auto-logout branch here. The
      // endpoints reached through this helper answer business failures with
      // 422, so a 401 can only mean a dead token — and the next ordinary
      // api call will hit handle() and eject the session once, in one place.
      throw err;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
