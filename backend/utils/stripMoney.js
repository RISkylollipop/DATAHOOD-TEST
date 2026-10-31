// ============================================================
//  stripMoney — remove naira figures from a description string
// ------------------------------------------------------------
//  Lives on its own so the backend has exactly ONE copy. It was
//  previously a private function inside transactionReceipt.js, which
//  meant the WhatsApp receipt could not reuse it and grew its own
//  (absent) version — and shipped the amount to the customer.
//
//  Why any of this exists: the platform's users are RESELLERS. They
//  buy at a discounted rate and sell on at their own markup, and the
//  receipt is what they hand to THEIR customer. Any figure on it
//  reveals the reseller's buy price, and therefore their margin, to
//  the person they are selling to.
//
//  The labels are the easy half. The trap is the DESCRIPTION:
//  airtimeController stores "MTN Airtime purchase of N500 for
//  0801..." — the price is inside the sentence, and no amount of
//  removing an `amount` field takes it out. This does.
//
//  The stored string keeps its figure: the dashboard, search and
//  duplicate-detection all rely on it. Stripping happens at render.
//
//  MUST stay behaviourally identical to stripMoney() in
//  frontend/src/utils/receiptImage.jsx — the PNG, the PDF and the
//  WhatsApp text are triplets and have to render the same sentence
//  for the same transaction.
// ============================================================

/**
 * @param {string} text
 * @returns {string} the same sentence with any naira figure removed
 */
export function stripMoney(text) {
  return String(text || '')
    // "of N500", "worth NGN 1,200.00", a bare "₦300". Taking the leading
    // "of"/"worth" with it keeps the sentence grammatical:
    // "purchase of N500 for 0801..." -> "purchase for 0801...".
    .replace(/(?:\s*\b(?:of|worth)\s+)?(?:₦|NGN|N)\s?\d[\d,]*(?:\.\d{1,2})?\b/gi, '')
    // A figure at the very end leaves the preposition hanging
    // ("Airtime for N500" -> "Airtime for"). Drop it.
    .replace(/\s*\b(?:of|for|worth)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export default stripMoney;
