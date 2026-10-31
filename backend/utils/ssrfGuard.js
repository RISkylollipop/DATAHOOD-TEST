// ============================================================
//  ssrfGuard — validate an outbound URL before we fetch it
// ------------------------------------------------------------
//  WHY
//
//  Several places fetch a URL that came out of the database rather
//  than out of the code: provider `baseUrl` rows, the wallet-balance
//  endpoint, webhook callbacks. Those rows are written by an admin,
//  so this is not a hole an ordinary user can reach — but it means a
//  single compromised admin session (or a mistyped paste) turns the
//  API server into a proxy for whatever the attacker names, and the
//  balance call attaches a DECRYPTED provider API key to the request.
//  Pointing it at their own host exfiltrates the key in one click.
//
//  It is also the classic path to cloud metadata (169.254.169.254)
//  and to anything else reachable from inside the VPS but not from
//  the internet — the database, Redis, an admin panel on localhost.
//
//  WHAT THIS DOES AND DOES NOT PROTECT
//
//  It rejects non-HTTP(S) schemes, credentials embedded in the URL,
//  and hostnames that are literal private/loopback/link-local IPs.
//  It does NOT resolve DNS, so a hostname that resolves to a private
//  address still passes (DNS rebinding). Blocking that properly needs
//  resolution + pinning at connect time, which Node's fetch does not
//  expose. Documented rather than pretended away — the layer that
//  actually stops it is that only authenticated admins can write
//  these rows at all.
// ============================================================

// Literal IPv4 in any of the ranges that must never be an outbound
// target. Matched on the parsed hostname, not the raw string, so
// http://user@evil.com/ and http://127.0.0.1./ don't slip past.
const PRIVATE_V4 = [
  /^127\./,                     // loopback
  /^10\./,                      // RFC1918
  /^192\.168\./,                // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^169\.254\./,                // link-local — cloud metadata lives here
  /^0\./,                       // "this host"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

// IPv6 forms that mean loopback, unspecified, or unique-local. The
// hostname from URL parsing keeps the brackets off but lowercases.
const PRIVATE_V6 = [
  '::1', '::', '0:0:0:0:0:0:0:1',
];

function isPrivateHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, ''); // trailing dot = same host
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (PRIVATE_V6.includes(h)) return true;
  // fc00::/7 (unique local) and fe80::/10 (link local)
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const v4 = mapped ? mapped[1] : h;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    return PRIVATE_V4.some((re) => re.test(v4));
  }
  return false;
}

/**
 * Validate a URL we are about to fetch server-side.
 *
 * @param {unknown} raw
 * @param {{requireHttps?: boolean}} [opts]
 *   requireHttps defaults to true in production and false elsewhere,
 *   because a local provider sandbox on plain http is a normal thing
 *   to develop against and refusing it would push people to disable
 *   the guard entirely.
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 *   `reason` is for the LOG and for an admin-facing message. It names
 *   the rule broken, never the resolved address.
 */
export function checkOutboundUrl(raw, { requireHttps } = {}) {
  const https = requireHttps ?? (process.env.NODE_ENV === 'production');
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return { ok: false, reason: 'not a valid absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:, gopher:, data:, ftp: — every one of these has been a
    // real SSRF primitive at some point.
    return { ok: false, reason: `scheme ${url.protocol} is not allowed (use https)` };
  }
  if (https && url.protocol !== 'https:') {
    return { ok: false, reason: 'plain http is not allowed in production (use https)' };
  }
  if (url.username || url.password) {
    // Credentials in a URL are both a leak (they land in logs) and a
    // classic parser-confusion trick: http://real.com@evil.com/.
    return { ok: false, reason: 'URL must not contain embedded credentials' };
  }
  if (isPrivateHost(url.hostname)) {
    return { ok: false, reason: 'host is a private, loopback or link-local address' };
  }
  return { ok: true, url };
}

export default { checkOutboundUrl };
