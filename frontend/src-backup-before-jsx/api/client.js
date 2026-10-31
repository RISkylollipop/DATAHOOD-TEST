// ============================================================
//  API client — thin fetch wrapper (no axios, per project pref).
//  Attaches the JWT, parses JSON, throws a normalized error with
//  the backend's { status, msg } shape, and exposes a blob helper
//  for the verified-slip PDF download.
// ============================================================

import { API_BASE } from '../config';

const TOKEN_KEY = 'datahood_token';

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

async function handle(res) {
  let body = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : {}; } catch { body = { msg: text }; }
  if (!res.ok || body.status === 'fail') {
    const err = new Error(body.msg || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    // Auto-logout on auth failure.
    if (res.status === 401) {
      setToken('');
      if (!window.location.pathname.startsWith('/login')) {
        window.dispatchEvent(new CustomEvent('datahood:unauthorized'));
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
};
