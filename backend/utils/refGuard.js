// ============================================================
//  refGuard — transaction-reference validation + LIKE escaping
// ------------------------------------------------------------
//  WHY THIS EXISTS
//
//  `transactions.transref` is supplied by the CLIENT. The frontend
//  generates it once per purchase intent (config.js makeRef) so that
//  a retry reuses it and the idempotency guard can recognise the
//  replay — that design is correct, but it means the value arriving
//  at the controller is fully attacker-chosen, and until now nothing
//  checked its shape.
//
//  Two reserved prefixes make that dangerous. utils/walletOps.js
//  records admin money movements as `DEBIT-<ref>-<ms>` and
//  `REFUND-<ref>-<ms>`, and decides whether a refund has already been
//  paid by probing `transref LIKE 'REFUND-<ref>-%'`.
//
//  So a user who buys N50 of airtime with
//      transref = "REFUND-<someone else's ref>-1"
//  plants a row that makes that probe return a hit. When an admin
//  later refunds the real transaction, the probe reads
//  "already_recorded", the wallet move is SKIPPED, the status label
//  still flips to failed, and the response says success. The victim
//  never receives their money and nothing in the UI says so. The
//  same trick with `DEBIT-` blocks an admin debit.
//
//  A `%` or `_` in a stored transref also turns the admin transaction
//  search (`transref LIKE q`) into a wildcard match on other people's
//  references.
//
//  Hence: one allow-list for what a client may send, one escaper for
//  every LIKE pattern built from stored or user data.
// ============================================================

// Deliberately an ALLOW-list. A deny-list of "dangerous characters"
// would have to anticipate every future consumer of this string
// (SQL LIKE today, a URL path param already, a filename tomorrow);
// an allow-list of URL-safe characters is correct for all of them.
//
// The reference is used as a URL path segment
// (GET /transactions/:ref/receipt), so no '/', '.', or '%'.
const SAFE_REF = /^[A-Za-z0-9_-]{8,64}$/;

// Prefixes the SERVER uses to mint its own reference rows. A client
// reference must never be able to impersonate one. Compared
// case-insensitively: MySQL's default collations are case-insensitive,
// so 'refund-x-1' collides with the probe for 'REFUND-x-1' just as
// well as the uppercase form would.
const RESERVED_PREFIXES = ['DEBIT-', 'REFUND-', 'ADM'];

/**
 * Is this a client reference we are willing to store?
 *
 * @param {unknown} ref
 * @returns {{ok: true} | {ok: false, msg: string}}
 *   `msg` is safe to show a user: it describes the format rule and
 *   never echoes the rejected value back (that value is attacker
 *   controlled and would be reflected straight into the UI).
 */
export function checkTransref(ref) {
  if (typeof ref !== 'string' || !SAFE_REF.test(ref)) {
    return {
      ok: false,
      msg: 'Invalid transaction reference. Please refresh the page and try again.',
    };
  }
  const upper = ref.toUpperCase();
  if (RESERVED_PREFIXES.some((p) => upper.startsWith(p))) {
    return {
      ok: false,
      msg: 'Invalid transaction reference. Please refresh the page and try again.',
    };
  }
  return { ok: true };
}

/**
 * Escape a value that is being INTERPOLATED INTO a LIKE pattern.
 *
 * Sequelize parameterises the pattern, so this is not SQL injection —
 * it is wildcard injection, which is a different and quieter bug: the
 * query stays well-formed and simply matches more rows than intended.
 *
 * Escapes the two LIKE metacharacters plus the escape character
 * itself. Backslash MUST go first or the escapes we add would then be
 * escaped in turn. MySQL treats '\' as the default LIKE escape
 * character, so no ESCAPE clause is needed.
 */
export function escapeLike(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/** The reserved prefixes, exported so tests can assert on the real list. */
export const RESERVED = Object.freeze([...RESERVED_PREFIXES]);

export default { checkTransref, escapeLike, RESERVED };
