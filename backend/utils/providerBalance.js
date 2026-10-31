// ============================================================
//  Provider wallet balance — URL, auth and response parsing
// ------------------------------------------------------------
//  Split out of providerController so it can be tested without a
//  database or a network: every function here is pure.
//
//  WHY THIS EXISTS AT ALL. The balance endpoint used to be GUESSED —
//  `new URL('/api/user/', baseUrl)` — which assumes every vendor on
//  earth exposes the wallet at /api/user/ on the same host as the
//  purchase API. Maskawasub does not, so its card read "Unavailable"
//  with no way for an operator to correct it: there was no field to
//  put the right path in.
//
//  So the wallet is now a CATEGORY like any other. One `wallet` row
//  per vendor, its baseUrl being the balance endpoint verbatim, sitting
//  beside that vendor's airtime/data/cable rows in the same screen.
//  Guessing stays only as the last resort, for an install that has not
//  added the rows yet.
// ============================================================

// Categories where "the default one" is a meaningful idea: a purchase must
// pick exactly ONE provider to fulfil it, so each is looked up as
// (category, status:active, isDefault:true).
//
// `wallet` is not like that, and this is the shape of the whole feature. A
// wallet row answers "how much credit do I hold with this vendor" — a question
// about EVERY vendor at once, which is why the overview shows one card per
// provider. Flagging one row default would imply the others are secondary, and
// a future findOne({ isDefault: true }) written by analogy with the purchase
// lookups would quietly show one card and hide the rest.
//
// Lives here rather than in the controller so it can be verified without a
// database connection.
const NO_DEFAULT_CATEGORIES = new Set(['wallet']);

export const noDefaultCategories = () => [...NO_DEFAULT_CATEGORIES];

export function allowsDefault(category) {
  return !NO_DEFAULT_CATEGORIES.has(String(category || ''));
}

/**
 * Coerce a provider's balance field into a number.
 *
 * Vendors are inconsistent about this: some send a JSON number, some a
 * string, and some a formatted string — "12,345.67", "N12,345.67",
 * "₦12,345". Number("12,345") is NaN, so a bare parseFloat/Number on the
 * raw value silently reported a healthy float wallet as unparseable.
 *
 * Returns null for anything that is not a usable figure, so the caller can
 * tell "the vendor said zero" (a real, actionable balance — top up) from
 * "we could not find a balance in this response" (a config or IP problem).
 * Those two must never collapse into the same card.
 */
export function toAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  // Keep digits, one decimal point and a leading minus; drop currency
  // symbols, thousands separators and stray whitespace.
  const cleaned = v.replace(/[^\d.-]/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Find the balance in a parsed provider response.
 *
 * The three legacy shapes (WalletBalance.php:44-55) come first so behaviour
 * for already-working vendors is unchanged; the `data`-wrapped variants
 * follow, because several Nigerian aggregators nest everything under `data`.
 * Order is significance, not preference — the first field that yields a
 * usable number wins.
 */
export function parseBalance(payload) {
  if (payload === null || typeof payload !== 'object') return null;
  const candidates = [
    payload.user?.wallet_balance,
    payload.wallet_balance,
    payload.balance,
    payload.user?.balance,
    payload.data?.wallet_balance,
    payload.data?.balance,
    payload.data?.user?.wallet_balance,
  ];
  for (const c of candidates) {
    const n = toAmount(c);
    if (n !== null) return n;
  }
  return null;
}

/**
 * The Authorization header for a balance call.
 *
 * Honours the row's own `authStyle`, which the previous version ignored
 * entirely: it sniffed the hostname for two known Basic-auth vendors and
 * sent `Token …` to everyone else. So an operator who correctly picked
 * "Basic" in the admin dropdown still had a Token header sent, and the
 * dropdown was decoration.
 *
 * The hostname sniff survives ONLY as a fallback for rows left on the
 * default 'token' — those are pre-existing rows nobody has revisited, and
 * removing the sniff would break them on upgrade.
 */
export function balanceAuthHeader({ authStyle, apiKey, baseUrl }) {
  const key = String(apiKey ?? '');
  const style = String(authStyle || 'token').toLowerCase();
  if (style === 'bearer') return `Bearer ${key}`;
  if (style === 'basic') return `Basic ${key}`;
  if (style === 'custom') return key; // pre-formatted by the operator
  const host = String(baseUrl || '');
  if (/n3tdata|bilalsadasub/i.test(host)) return `Basic ${key}`;
  return `Token ${key}`;
}

/**
 * Work out which URL to ask for a balance.
 *
 * @param walletUrl      baseUrl of the vendor's `wallet` row, if it has one
 * @param fallbackBaseUrl the row being viewed (a category URL like
 *                        https://host/api/data/) — used for its ORIGIN only
 * @returns {{url: string, source: 'wallet-row'|'wallet-row-relative'|'guessed'}|null}
 */
export function resolveBalanceUrl({ walletUrl, fallbackBaseUrl }) {
  const wallet = String(walletUrl || '').trim();
  const fallback = String(fallbackBaseUrl || '').trim();

  if (wallet) {
    // Absolute: use it exactly as typed. No path juggling, no appending —
    // whatever the operator pasted from the vendor's docs is the endpoint.
    if (/^https?:\/\//i.test(wallet)) return { url: wallet, source: 'wallet-row' };
    // Relative ("/api/user/", "user/"): resolve against the sibling's origin,
    // which is the whole reason a bare path is worth accepting here.
    if (fallback) {
      try {
        return { url: new URL(wallet, fallback).href, source: 'wallet-row-relative' };
      } catch { /* fall through to the guess */ }
    }
  }

  if (!fallback) return null;
  // Last resort, and the old behaviour: assume /api/user/ on the same origin.
  try {
    return { url: new URL('/api/user/', fallback).href, source: 'guessed' };
  } catch {
    return { url: fallback.replace(/\/?$/, '/') + 'api/user/', source: 'guessed' };
  }
}

/**
 * The form of a balance URL that is safe to show an operator or write to a log.
 *
 * Error messages name the URL, because "no balance field in the response" is
 * unactionable without knowing which endpoint answered. But some vendors
 * authenticate by query string, so an operator may well have pasted
 * `…/balance?token=LIVE_KEY` into Base URL — and that string would then reach
 * the admin screen, the log file, and any screenshot attached to a support
 * message. Path only: enough to tell two endpoints apart, carrying nothing
 * that could be replayed.
 */
export function displayUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`;
  } catch {
    // Not parseable as a URL: cut at the first ? so a query string can never
    // survive, rather than returning the raw string and hoping.
    return s.split('?')[0];
  }
}

/**
 * Classify a non-JSON body.
 *
 * An HTML page where JSON belongs is almost always a provider IP allowlist
 * rejecting the server: Premiumsub answers an unlisted IP with an "Access
 * denied" HTML page carrying HTTP 200, so the only symptom was a JSON parse
 * error about an unexpected "<". Naming it saves the next person the hour
 * that cost, because nothing about "Unexpected token" suggests whitelisting.
 */
export function describeNonJson(body) {
  const s = String(body || '').trim();
  if (!s) return 'Provider returned an empty response.';
  if (/^<(!doctype|html|\?xml)/i.test(s) || /<html[\s>]/i.test(s)) {
    return 'Provider returned a web page instead of JSON — usually an IP '
      + 'allowlist rejecting this server. Add the server IP in your vendor dashboard.';
  }
  return 'Provider response was not JSON.';
}
