// ============================================================
//  auditLog — write a privileged action to admin_audit_log
// ------------------------------------------------------------
//  RULE 1: THIS MUST NEVER THROW.
//
//  Every caller is on a path where money has already moved or is
//  about to. If an audit insert can reject a refund, then the audit
//  trail becomes a denial-of-service surface against customers, and
//  the first production incident gets "fixed" by deleting the call.
//  So the write is fire-and-forget with a swallowed rejection, and
//  the failure is reported to the file log instead.
//
//  The honest consequence: a missing row is possible. This table is
//  corroborating evidence about WHO acted. `wallet_ledger` remains the
//  authoritative record of WHAT moved, and it is written inside the
//  same DB transaction as the balance change, so it cannot drift.
//
//  RULE 2: NOTHING SECRET GOES IN `detail`.
//
//  Every admin can read this table. The redaction below is a
//  belt-and-braces pass over the keys that have actually shown up in
//  request bodies on this project — it is not a substitute for
//  callers passing only what they mean to.
// ============================================================

import { AdminAuditLog } from '../models/index.js';
import * as logger from './logger.js';

// Key names that must never be persisted, matched case-insensitively
// against a substring of the key. Substring rather than exact match
// because the same secret arrives as `pin`, `newPin`, `confirmPin`,
// `pinCode` depending on which form posted it.
//
// THE COST OF SUBSTRING MATCHING, AND WHY IT IS STILL THE RIGHT CHOICE:
// it over-redacts. 'nin' catches `warning`, `pending`, `remaining`,
// `running`; 'code' catches `statusCode`, `countryCode`; 'auth' catches
// `authStyle` and `author`; 'card' catches `discard`. Every one of those
// false positives loses a harmless diagnostic value, which is the safe
// direction to fail — the unsafe direction loses a BVN.
//
// The trap for callers: a redacted key does not read as "we dropped
// something boring". It reads as though a real secret leaked into the row
// and was caught on the way out, which sends the next person reading the
// table on a hunt for a leak that never happened. So when you want to
// record a fact ABOUT a secret — that a key was rotated, say — name the
// field so it misses this list (`credentialsChanged`, not
// `apiKeyRotated`). controllers/providerController.js does exactly that
// and says why at the top of the file.
const SECRET_KEY_PATTERNS = [
  'pin', 'password', 'passwd', 'secret', 'token', 'otp', 'code',
  'apikey', 'api_key', 'authorization', 'auth', 'bvn', 'nin',
  'card', 'cvv', 'signature',
];

function isSecretKey(key) {
  const k = String(key).toLowerCase();
  return SECRET_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Deep-copy an object, replacing anything that looks like a secret
 * with a marker. The marker matters: an absent key reads as "the
 * admin didn't send one", which is a different fact from "they sent
 * one and we refused to store it".
 */
function redact(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSecretKey(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * Pull the actor and the request context off an Express request.
 * Tolerates a missing req so callers on background paths (retention
 * sweeps, webhook handlers) can pass null.
 *
 * Exported because walletOps also stamps the actor into `wallet_ledger`
 * meta, and that identity has to be derived the same way in both places —
 * two hand-rolled `req.admin?.sysId` reads drift the first time the auth
 * middleware changes what it attaches.
 */
export function actorFrom(req) {
  const admin = req?.admin || req?.sysUser || null;
  return {
    adminId: admin?.sysId ?? admin?.id ?? null,
    adminEmail: admin?.sysEmail ?? admin?.email ?? null,
    // req.ip is the real client because server.js sets
    // `trust proxy` to 1; without that this would be the Nginx box on
    // every single row.
    ip: req?.ip ? String(req.ip).slice(0, 45) : null,
    userAgent: req?.get ? String(req.get('user-agent') || '').slice(0, 255) || null : null,
  };
}

/**
 * Record one privileged action.
 *
 * @param {object} p
 * @param {import('express').Request|null} [p.req]  for actor + IP + UA
 * @param {string} p.action      stable machine name, e.g. 'txn.refund'
 * @param {string} [p.targetType] 'transaction' | 'subscriber' | 'provider' | ...
 * @param {string|number} [p.targetId]
 * @param {number} [p.amount]    money delta, when there is one
 * @param {object} [p.detail]    redacted before storage
 * @param {'success'|'fail'} [p.outcome]
 * @param {number|null} [p.adminId]     override — see below
 * @param {string|null} [p.adminEmail]  override — see below
 * @returns {Promise<void>} always resolves
 *
 * The two actor OVERRIDES exist for authentication events. At the moment a
 * login is being judged there is no req.admin yet — that is what the request
 * is trying to establish — so actorFrom() would return a null actor for both
 * "correct password" and "wrong password", and the row could not tell them
 * apart. A failed attempt against a REAL admin account and a failed attempt
 * against an address that does not exist are different facts, and the second
 * is what credential stuffing looks like.
 *
 * They are overrides, not additions: an explicitly passed actor wins over the
 * request, because the caller knows something the middleware does not.
 */
export async function audit({
  req = null, action, targetType = null, targetId = null,
  amount = null, detail = null, outcome = 'success',
  adminId = undefined, adminEmail = undefined,
} = {}) {
  try {
    const who = actorFrom(req);
    if (adminId !== undefined) who.adminId = adminId;
    if (adminEmail !== undefined) {
      who.adminEmail = adminEmail === null ? null : String(adminEmail).slice(0, 190);
    }
    await AdminAuditLog.create({
      ...who,
      action: String(action || 'unknown').slice(0, 64),
      targetType: targetType ? String(targetType).slice(0, 32) : null,
      targetId: targetId === null || targetId === undefined ? null : String(targetId).slice(0, 190),
      amount: amount === null || amount === undefined ? null : Number(amount).toFixed(2),
      // Truncated to fit TEXT comfortably. A detail blob big enough to
      // matter here is a caller passing a whole request body, which is
      // itself the bug.
      detail: detail ? JSON.stringify(redact(detail)).slice(0, 4000) : null,
      outcome: outcome === 'fail' ? 'fail' : 'success',
      createdAt: new Date(),
    });
  } catch (err) {
    // Swallowed on purpose — see RULE 1. Logged at error level with
    // the action so a systematically failing audit (missing table,
    // wrong column) is visible in the log rather than silent.
    logger.error('Audit write failed', {
      error: err.message, stack: err.stack, action,
    });
  }
}

/**
 * Fire-and-forget form for hot paths that must not wait on the insert.
 * Use `audit()` (awaited) when the action's whole point is the record —
 * e.g. a security setting change with no other side effect.
 */
export function auditAsync(payload) {
  // Void the promise rather than returning it: an un-awaited rejected
  // promise is an unhandled rejection, and `audit` already catches, so
  // this is belt-and-braces against a future refactor removing that.
  audit(payload).catch(() => {});
}

export { redact as _redactForTests };
export default { audit, auditAsync };
