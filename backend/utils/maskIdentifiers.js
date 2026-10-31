// ============================================================
//  utils/maskIdentifiers.js — redact third-party numbers in free text
// ------------------------------------------------------------
//  transaction `servicedesc` is free text built at purchase time, e.g.
//    "MTN Airtime purchase of N500 for 08012345678"
//    "Purchase of IKEDC prepaid electricity token for meter 45012345678"
//  When we erase the buyer we keep the financial record but must strip
//  the BENEFICIARY's number out of it — that person never had an account
//  and never consented to us holding their number forever.
//
//  Lives in its own module, with zero dependencies, for one concrete
//  reason: it is the single rule that decides "did erasure actually
//  remove the phone number, or did it also eat the amount off the
//  receipt?" — and the module it used to sit in (privacyService) pulls
//  in bcrypt, so the rule could not be unit-tested on its own. It can
//  now (scripts/privacy_selftest.mjs).
//
//  Threshold of 7 keeps amounts ("N500"), plan lengths ("30 Days") and
//  years intact while catching every identifier format in use — the
//  shortest of which is a 10-digit IUC. Last 4 kept so a support agent
//  can still match a customer's "…5678" without holding the whole number.
// ============================================================

const IDENTIFIER_RUN = /\d{7,}/g;

export function maskIdentifiers(text) {
  if (!text) return text;
  return String(text).replace(IDENTIFIER_RUN, (m) => `${'*'.repeat(m.length - 4)}${m.slice(-4)}`);
}
