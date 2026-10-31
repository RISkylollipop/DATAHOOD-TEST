// ---------------------------------------------------------------------------
//  publicErrors.js — the only source of provider-failure copy shown to users
//
//  WHY THIS EXISTS
//  Provider failure text was being passed straight through to the client and
//  rendered in a toast. Two problems with that:
//
//    1. It leaks our infrastructure. A user buying airtime was shown
//       "Provider blocked the request - your server IP is likely not
//       whitelisted with this provider." That sentence names a provider
//       relationship, points at a server IP, and describes an internal
//       misconfiguration. It tells an attacker where to look and tells a
//       customer nothing they can act on.
//    2. It is not ours to write. Upstream `msg` values arrive from third-party
//       JSON we do not control, so a provider could put any string in front of
//       our users, in any tone, including one that contradicts what we just
//       did with their money.
//
//  THE RULE (user's, stated 2026-08-07): error text meant for an admin never
//  reaches a user toast. Diagnostics go to the file logger, where
//  logger.providerError already records provider name, host, HTTP status,
//  raw body and cause. Nothing here is diagnostic - it is customer copy.
//
//  HOW TO USE
//  Controllers pass the `reason` code from providerService plus what actually
//  happened to the money. Never pass a provider string into these functions,
//  and never build a user message from `result.msg`, `result.error`,
//  `result.detail` or `result.raw` - those four are operator-only fields.
// ---------------------------------------------------------------------------

/**
 * Copy for a purchase that failed and was fully reversed.
 *
 * Keyed on the `reason` codes classifyFetchError/parseJsonSafe emit:
 *   'explicit-fail'  - provider authoritatively said failed. Safe to be
 *                      definite: nothing was delivered and money is back.
 *   'timeout'        - no response in time. Delivery genuinely unknown, so the
 *                      copy must not promise either outcome.
 *   'network-error'  - could not reach the provider, or the socket died
 *                      mid-response. Also unknown.
 *   'non-json'       - provider returned HTML/garbage (auth page, IP block,
 *                      gateway error). The user does not need to know which.
 *   'unknown-status' - reached them, got a shape we do not recognise.
 */
const REFUNDED = {
  'explicit-fail': 'This purchase could not be completed by the network. Your wallet has been refunded.',
  timeout: 'The network took too long to respond. Your wallet has been refunded - please check your transaction history before trying again.',
  'network-error': 'We could not reach the network at the moment. Your wallet has been refunded, please try again shortly.',
  'non-json': 'This service is temporarily unavailable. Your wallet has been refunded, please try again shortly.',
  'unknown-status': 'This purchase could not be completed. Your wallet has been refunded, please try again shortly.',
};

const NOT_REFUNDED = {
  'explicit-fail': 'This purchase could not be completed by the network. Please try again.',
  timeout: 'The network took too long to respond. Please check your transaction history before trying again.',
  'network-error': 'We could not reach the network at the moment. Please try again shortly.',
  'non-json': 'This service is temporarily unavailable. Please try again shortly.',
  'unknown-status': 'This purchase could not be completed. Please try again shortly.',
};

const FALLBACK_REFUNDED = 'This purchase could not be completed. Your wallet has been refunded, please try again shortly.';
const FALLBACK_PLAIN = 'This purchase could not be completed. Please try again shortly.';

/**
 * @param {string} reason  code from providerService (never a provider string)
 * @param {{refunded?: boolean}} opts  whether the debit was actually reversed.
 *   Pass refunded:false when refundWallet answered {ok:false} - promising a
 *   refund that did not happen is worse than saying nothing about it.
 * @returns {string} copy safe to render in a toast
 */
export function providerFailureMessage(reason, { refunded = true } = {}) {
  const table = refunded ? REFUNDED : NOT_REFUNDED;
  return table[reason] || (refunded ? FALLBACK_REFUNDED : FALLBACK_PLAIN);
}

/**
 * Copy for a lookup that failed (meter number, IUC/smartcard).
 *
 * Deliberately identical for "provider says this number is invalid" and
 * "provider is unreachable": the actionable advice is the same, and we cannot
 * tell the two apart reliably enough to promise which it was.
 */
export function lookupFailureMessage(kind = 'details') {
  return `We could not verify the ${kind} you entered. Please check and try again in a moment.`;
}
