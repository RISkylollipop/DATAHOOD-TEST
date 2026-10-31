// ============================================================
//  Which providers get a wallet-balance card on the admin overview
// ------------------------------------------------------------
//  Plain .js, not .jsx, on purpose: this rule decides whether an
//  operator can see the credit they hold with each vendor, and a
//  function living inside a JSX file cannot be run by node — the
//  build sandbox has no JSX parser, so it would ship unverified.
//  See scripts/verify_provider_balance.js in the backend.
// ============================================================

// Categories that fulfil a purchase. Used only for the legacy fallback
// below; a wallet row is the right answer now.
const FULFILLMENT = ['airtime', 'data', 'cable', 'electricity'];

// Vendor names are matched case- and whitespace-insensitively, because the
// SERVER already does. Its sibling lookup is `where: { name }` in MySQL under
// utf8mb4_unicode_ci, and a _ci collation makes `=` case-insensitive — so
// "maskawasub" finds the key saved on "Maskawasub". A JS Set does not. Matching
// exactly here while the server matched loosely meant a wallet row typed with
// different capitalisation had its card silently withheld even though the
// balance behind it would have fetched perfectly.
const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Pick the provider rows to render a balance card for.
 *
 * A `wallet` row is the explicit answer: its Base URL is the vendor's balance
 * endpoint, and EVERY such row gets a card. That is why the category has no
 * default — "how much credit do I hold" is a question about all vendors at
 * once, not about a chosen one.
 *
 * A card appears only once the vendor has an API key SOMEWHERE, on any row of
 * the same name: the server falls back across siblings, because a vendor
 * issues one key for all its services. Without a key the request can only
 * fail, and a red "Unavailable" on a fresh install reads as a broken feature
 * rather than an unconfigured one. The page's empty state says what to do.
 *
 * `status` is deliberately NOT consulted. No purchase path looks up a wallet
 * row, so active/inactive means nothing for this category, and the seeded rows
 * arrive inactive — gating on it would hide every card immediately after
 * migration, which is the exact failure this change exists to remove.
 *
 * Falls back to fulfilment rows for an install with no wallet rows yet,
 * deduped by NAME so Maskawasub (one row per category, one shared key) appears
 * once rather than four times.
 */
export function balanceCardProviders(providers) {
  const rows = Array.isArray(providers) ? providers : [];
  const keyedVendors = new Set(
    rows.filter((p) => p?.hasApiKey).map((p) => norm(p.name)),
  );

  // EVERY wallet row gets a card, including one that cannot fetch yet. A row the
  // operator deliberately created must never disappear without saying why:
  // filtering the unconfigured ones out meant adding a wallet row produced no
  // card and no message, which is indistinguishable from the feature being
  // broken. `needs` names the missing piece so the card can say it.
  const wallets = rows.filter((p) => p?.category === 'wallet');
  if (wallets.length) {
    return wallets.map((p) => ({
      ...p,
      needs: !p.baseUrl ? 'url' : (!keyedVendors.has(norm(p.name)) ? 'key' : null),
    }));
  }

  const out = [];
  const seen = new Set();
  for (const p of rows) {
    if (!p?.hasApiKey || !FULFILLMENT.includes(p.category)) continue;
    if (seen.has(norm(p.name))) continue;
    seen.add(norm(p.name));
    out.push(p);
  }
  return out;
}
