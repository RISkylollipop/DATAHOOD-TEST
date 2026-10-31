// ============================================================
//  useSiteSettings — public site config, fetched once per page load.
// ------------------------------------------------------------
//  GET /api/settings/public is unauthenticated (see routes/catalog.js),
//  so this works on the login screen as well as inside the app. That
//  matters: a user who cannot log in is exactly the user who most needs
//  to reach support.
//
//  The result is cached at module scope and in-flight requests are
//  de-duplicated, because several components mount this at once
//  (Layout, Wallet, Support) and the settings row changes about never.
// ============================================================

import { useState, useEffect } from 'react';
import { api } from '../api/client';

let cache = null;      // resolved settings object
let inFlight = null;   // shared promise while a fetch is running

function load() {
  if (cache) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = api
    .get('/settings/public')
    .then((res) => {
      cache = (res && res.data) || {};
      return cache;
    })
    .catch(() => ({}))          // degrade quietly — never break a page over branding
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Force the next read to hit the network (used after an admin settings save). */
export function invalidateSiteSettings() {
  cache = null;
}

export function useSiteSettings() {
  const [settings, setSettings] = useState(cache);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    let alive = true;
    if (cache) { setSettings(cache); setLoading(false); return undefined; }
    load().then((s) => {
      if (!alive) return;
      setSettings(s);
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  return { settings: settings || {}, loading };
}

// ── Normalisation helpers ───────────────────────────────────

/**
 * Nigerian numbers get entered every possible way: 08031234567,
 * +2348031234567, 234 803 123 4567, 8031234567. wa.me and tel: both
 * want unpunctuated international digits, so normalise to 234XXXXXXXXXX.
 * Anything that does not look Nigerian is passed through as digits
 * rather than mangled — the platform could add a foreign line later.
 */
export function toInternational(raw) {
  if (!raw) return '';
  const d = String(raw).replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('234')) return d;
  if (d.startsWith('0') && d.length === 11) return `234${d.slice(1)}`;
  if (d.length === 10) return `234${d}`;
  return d;
}

/** Display form: 0803 123 4567 — how a Nigerian customer expects to read it. */
export function formatLocalPhone(raw) {
  if (!raw) return '';
  const intl = toInternational(raw);
  if (intl.startsWith('234') && intl.length === 13) {
    const local = `0${intl.slice(3)}`;
    return `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`;
  }
  return String(raw).trim();
}

function asUrl(raw, base) {
  if (!raw) return '';
  const v = String(raw).trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  return base + v.replace(/^@/, '').replace(/^\/+/, '');
}

/**
 * Display form for a Telegram handle. The column holds any of
 * `kwarapoly`, `@kwarapoly`, `t.me/kwarapoly` or the full https URL,
 * so strip whatever prefix is present down to the bare handle and put
 * exactly one `@` back on.
 */
export function telegramHandle(raw) {
  if (!raw) return '';
  const bare = String(raw).trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^@+/, '')
    .replace(/\/+$/, '');
  return bare ? `@${bare}` : '';
}

/**
 * Turn a settings row into the list of channels that are actually
 * configured. A blank column means "we do not offer this" — rendering
 * an empty WhatsApp button is worse than rendering nothing, because it
 * looks like support exists and then goes nowhere.
 */
export function supportChannels(s = {}) {
  const out = [];
  const wa = toInternational(s.whatsapp);
  const tel = toInternational(s.phone);

  if (wa) {
    out.push({
      key: 'whatsapp',
      label: 'WhatsApp',
      value: formatLocalPhone(s.whatsapp),
      href: `https://wa.me/${wa}`,
      external: true,
      hint: 'Fastest reply — send your transaction reference',
    });
  }
  if (tel) {
    out.push({
      key: 'phone',
      label: 'Call us',
      value: formatLocalPhone(s.phone),
      href: `tel:+${tel}`,
      hint: 'Standard call rates apply',
    });
  }
  if (s.email) {
    out.push({
      key: 'email',
      label: 'Email',
      value: String(s.email).trim(),
      href: `mailto:${String(s.email).trim()}`,
      hint: 'Best for receipts and documents',
    });
  }
  if (s.whatsappgroup) {
    out.push({
      key: 'whatsappgroup',
      label: 'WhatsApp group',
      value: 'Join the community',
      href: asUrl(s.whatsappgroup, 'https://chat.whatsapp.com/'),
      external: true,
      hint: 'Downtime notices and new plan announcements',
    });
  }
  if (s.telegram) {
    out.push({
      key: 'telegram',
      label: 'Telegram',
      value: telegramHandle(s.telegram),
      href: asUrl(s.telegram, 'https://t.me/'),
      external: true,
      hint: 'Channel updates',
    });
  }
  return out;
}

/** Social links are presentational only — kept apart from support routes. */
export function socialLinks(s = {}) {
  const out = [];
  if (s.facebook) out.push({ key: 'facebook', label: 'Facebook', href: asUrl(s.facebook, 'https://facebook.com/') });
  if (s.twitter) out.push({ key: 'twitter', label: 'X (Twitter)', href: asUrl(s.twitter, 'https://x.com/') });
  if (s.instagram) out.push({ key: 'instagram', label: 'Instagram', href: asUrl(s.instagram, 'https://instagram.com/') });
  return out;
}

/**
 * The single best channel to point someone at from inline copy
 * ("contact support" links). WhatsApp first because that is how
 * Nigerian customers actually reach a VTU vendor; email is the
 * fallback; the Support page itself is the last resort so the link
 * is never dead.
 */
export function primarySupportHref(s = {}) {
  const list = supportChannels(s);
  const pick = list.find((c) => c.key === 'whatsapp') || list.find((c) => c.key === 'email') || list[0];
  return pick ? pick.href : '/support';
}
