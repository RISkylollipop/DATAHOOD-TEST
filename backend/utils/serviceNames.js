// ============================================================
//  serviceNames — the canonical list of purchasable services
// ------------------------------------------------------------
//  WHY THIS IS ITS OWN MODULE
//
//  `transactions.servicename` is free text, and rows land in that table
//  from two very different kinds of writer:
//
//    PURCHASES        the five things a reseller actually buys —
//                     Airtime, Data, Electricity, Cable TV, Verification.
//                     A purchase debits the wallet, so reversing one
//                     credits it back. That is a refund.
//
//    LEDGER ARTEFACTS 'Wallet Funding' (a deposit — money came IN),
//                     'Debit' / 'Refund' (audit rows written BY an admin
//                     action), 'Admin Credit' / 'Admin Debit' (manual
//                     adjustments).
//
//  Nothing in the schema distinguishes them, and the admin transaction
//  screen lists them all identically. So "mark failed and refund" — a
//  perfectly reasonable action on a purchase — becomes a money printer
//  when it is pointed at the second group:
//
//    'Wallet Funding' + failed_refund  → credits the deposit AGAIN, so a
//                                        N50,000 transfer becomes
//                                        N100,000 of balance.
//    'Refund' + failed_refund          → refunds a refund.
//    'Admin Credit' + failed_refund    → doubles a manual credit.
//
//  The list is therefore an ALLOWLIST, not a blocklist. A blocklist
//  fails open: the day someone adds a sixth kind of ledger artefact,
//  a blocklist silently permits refunding it. An allowlist fails
//  closed — a genuinely new *purchase* service has to be added here
//  before an admin can refund it, and the failure mode is "the admin
//  gets a clear error", not "the wallet gained money nobody paid in".
//
//  Keep this in step with the `const serviceName = '...'` line at the
//  top of each purchase controller (airtime, data, bills x2,
//  verification). Those are the only writers of a refundable row.
// ============================================================

/** Services a customer buys, and therefore the only rows a refund makes sense on. */
export const PURCHASE_SERVICES = Object.freeze([
  'Airtime',
  'Data',
  'Electricity',
  'Cable TV',
  'Verification',
]);

/**
 * Is this transaction row a customer purchase (as opposed to a deposit
 * or an admin-written audit/adjustment row)?
 *
 * Compared case-insensitively and trimmed: the value is free text in the
 * database and legacy PHP rows are not guaranteed to be clean. Anything
 * unrecognised answers false — see the fail-closed note above.
 */
export function isPurchaseService(servicename) {
  const v = String(servicename ?? '').trim().toLowerCase();
  return PURCHASE_SERVICES.some((s) => s.toLowerCase() === v);
}

export default { PURCHASE_SERVICES, isPurchaseService };
