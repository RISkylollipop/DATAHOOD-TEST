// ============================================================
//  Idempotency — replay protection for money endpoints (#81)
// ------------------------------------------------------------
//  THE PROBLEM
//
//  Every purchase handler debits the wallet, then calls the
//  provider. If the response is lost — dropped connection, phone
//  switching from wifi to data, user impatiently tapping again —
//  the client has no way to know whether the purchase happened.
//  So it retries. Today that retry carries a BRAND NEW transref
//  (frontend config.js makeRef() runs inside the submit handler),
//  so the controller's "reference already exists" check sees a
//  new purchase and charges the user a second time.
//
//  THE FIX
//
//  Wrap the route. The first request inserts its key; a duplicate
//  collides on the primary key and is answered from the stored
//  response instead of being executed. The retry receives the
//  ORIGINAL outcome — a success is reported as the success it was,
//  and the wallet is debited exactly once.
//
//  This only works if the client sends the SAME key on a retry.
//  That is why frontend/src/config.js generates the reference once
//  per purchase intent and reuses it across attempts; regenerating
//  it per attempt silently disables everything below.
//
//  FAILS OPEN, DELIBERATELY
//
//  If this middleware cannot reach its table it logs and calls
//  next(). Deploying this file before running the migration must
//  not take purchases down — that is exactly how a missing column
//  once read as "all the plans were deleted" on this project. An
//  outage is worse than the absence of a guarantee that did not
//  exist yesterday.
// ============================================================

import crypto from 'crypto';
import { Op } from 'sequelize';
import { IdempotencyKey } from '../models/index.js';
import { checkTransref } from '../utils/refGuard.js';
import * as logger from '../utils/logger.js';

// How long a key blocks a replay. Long enough to cover any realistic
// retry (including a user reopening the app), short enough that this
// stays a small table. Permanent history lives in wallet_ledger.
const TTL_MS = 24 * 60 * 60 * 1000;

// An in_progress row older than this means the handler died mid-flight —
// crashed, or the process restarted between the debit and the response.
// We still refuse to re-run it (money may have moved), but we say so
// differently, because "still processing" is a lie after two minutes.
const STALE_MS = 2 * 60 * 1000;

// Never fingerprint the PIN: it is a secret, and a corrected PIN on the
// second attempt would change the fingerprint and read as tampering.
const EXCLUDED_FIELDS = new Set(['pin', 'password', 'otp']);

/**
 * Deterministic JSON — key order must not affect the hash, or the same
 * request serialised by a different client version would look tampered.
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => !EXCLUDED_FIELDS.has(k)).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function fingerprintOf(body) {
  return crypto.createHash('sha256').update(stableStringify(body || {})).digest('hex');
}

/** MySQL duplicate-key, however Sequelize happens to have wrapped it. */
function isDuplicate(err) {
  return err?.name === 'SequelizeUniqueConstraintError'
    || err?.parent?.errno === 1062
    || err?.original?.errno === 1062;
}

// Expired rows are swept opportunistically rather than by a cron: roughly
// one request in fifty pays for the cleanup. Never awaited — a slow DELETE
// must not sit in front of somebody's airtime purchase.
function sweepSometimes() {
  if (Math.random() > 0.02) return;
  IdempotencyKey.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } })
    .catch(() => {});
}

/**
 * Guard a money route.
 *
 *   router.post('/airtime', requireAuth, idempotent('airtime'), purchaseAirtime);
 *
 * MUST sit after the auth middleware — keys are scoped per user, so an
 * unauthenticated request has nothing to scope to and is passed through.
 */
export function idempotent(endpoint) {
  return async function idempotencyMiddleware(req, res, next) {
    const sId = req.user?.sId;
    const key = String(req.body?.transref || req.get('Idempotency-Key') || '').trim();

    // ---------- Reject a poisoned reference before anything stores it ----------
    //
    // `transref` is chosen by the client (frontend config.js makeRef), and
    // this middleware is the only thing every route that PERSISTS one passes
    // through. Validating here rather than in the five controllers means the
    // check cannot be mounted in the wrong order relative to the key insert
    // below — a reference we are going to refuse must not first get a row in
    // idempotency_keys, and must never reach `transactions.transref`, where a
    // reserved `REFUND-`/`DEBIT-` prefix would make an admin refund silently
    // skip paying a real customer. See utils/refGuard.js for the full attack.
    //
    // Only the BODY value is checked. The `Idempotency-Key` header fallback is
    // never written to `transactions`; it only ever forms part of a primary-key
    // lookup (findByPk, never LIKE) and is length-bounded by the slice below.
    if (req.body?.transref !== undefined) {
      const verdict = checkTransref(String(req.body.transref));
      if (!verdict.ok) {
        // Logged at warn, not error: a stale tab or a broken client build can
        // produce this honestly. `msg` from refGuard never echoes the rejected
        // value, so nothing attacker-controlled is reflected back to the UI.
        logger.warn('Rejected malformed transaction reference', { endpoint, sId });
        return res.status(400).json({ status: 'fail', msg: verdict.msg });
      }
    }

    // No key, no protection possible. Let it through: the controllers
    // still validate transref themselves and will reject a missing one
    // with their own message, which is friendlier than anything generic
    // this middleware could say.
    if (!sId || !key) return next();

    // Scope the key to the user. Two users must never be able to collide,
    // and one user must never be able to guess another's key and read back
    // their stored response.
    const scopedKey = `${sId}:${endpoint}:${key}`.slice(0, 120);
    const fingerprint = fingerprintOf(req.body);

    try {
      await IdempotencyKey.create({
        idemKey: scopedKey,
        sId,
        endpoint,
        fingerprint,
        status: 'in_progress',
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + TTL_MS),
      });
    } catch (err) {
      if (!isDuplicate(err)) {
        // Table missing, DB blip — log loudly and let the purchase proceed.
        logger.error('Idempotency guard unavailable', { error: err.message, stack: err.stack, endpoint, sId });
        return next();
      }

      // --- Duplicate: this key has been seen before. ---
      let row = null;
      try {
        row = await IdempotencyKey.findByPk(scopedKey);
      } catch (readErr) {
        logger.error('Idempotency replay read failed', { error: readErr.message, stack: readErr.stack, endpoint, sId });
        return next();
      }
      if (!row) return next(); // swept between the insert and the read

      // Same key, different request body. Not a retry — a client bug or an
      // attempt to reuse a spent key for a different purchase. Refuse; do
      // NOT replay, because the stored response describes something else.
      if (row.fingerprint !== fingerprint) {
        logger.warn('Idempotency key reused with different payload', { endpoint, sId, key: scopedKey });
        return res.status(422).json({
          status: 'fail',
          msg: 'This reference has already been used for a different transaction. Please start again.',
        });
      }

      if (row.status === 'completed') {
        // The whole point: hand back the original outcome.
        let body;
        try {
          body = JSON.parse(row.responseBody || '{}');
        } catch {
          body = { status: 'success', msg: 'This transaction was already processed. Check your transaction history.' };
        }
        logger.info('Idempotent replay served', { endpoint, sId, key: scopedKey });
        return res.status(row.responseCode || 200).json(body);
      }

      // Still in flight. Answering "failed" here would invite the retry we
      // are trying to prevent, so we say plainly that it is already running.
      const stale = Date.now() - new Date(row.createdAt).getTime() > STALE_MS;
      return res.status(409).json({
        status: 'fail',
        msg: stale
          ? 'This transaction was interrupted and its outcome is unconfirmed. Please check your transaction history before trying again.'
          : 'This transaction is already being processed. Please wait a moment.',
      });
    }

    sweepSometimes();

    // --- We own the key. Capture whatever the handler answers. ---
    // Wrapping res.json is what keeps the controllers untouched: there are
    // a dozen return paths across the five purchase handlers and every one
    // of them ends in res.json().
    const sendJson = res.json.bind(res);
    let recorded = false;

    res.json = (body) => {
      if (!recorded) {
        recorded = true;
        const code = res.statusCode || 200;

        // WHICH RESPONSES MAY BE REPLAYED, AND WHICH KEYS ARE RELEASED
        //
        //   2xx — the purchase succeeded. This is the case the whole
        //         feature exists for: a retry gets the success back
        //         instead of buying a second time.
        //
        //   4xx — rejected before the debit (wrong PIN, insufficient
        //         balance, bad number). Nothing happened, so RELEASE the
        //         key: the user corrects the PIN and tries again, and
        //         must not be met with a replay of their own error. Safe
        //         against double-taps because the row stayed in_progress
        //         for the whole first request, so a concurrent duplicate
        //         was already turned away with 409.
        //
        //   5xx — release ONLY if the controller set res.locals.walletRestored,
        //         meaning it refunded and the net effect is zero.
        //
        // The status code alone CANNOT decide the 5xx case, and assuming it
        // can is a double-charge waiting to happen. The refund-then-fail
        // paths in this codebase answer 500 in four places and 502 in two;
        // worse, dataController's `deliveredUnknown` branch answers 502 and
        // deliberately LEAVES the money debited (txn.status=5) pending
        // reconciliation. Keying off 502 would release that key and let a
        // retry buy the same bundle again while the first is still open.
        //
        // So the default for any 5xx is to HOLD the key. A retry then gets
        // "outcome unconfirmed, check your history" — which is the honest
        // answer when we genuinely do not know, and the safe one when we do
        // not know whether we know.
        const walletRestored = res.locals?.walletRestored === true;

        if (code < 400) {
          IdempotencyKey.update(
            { status: 'completed', responseCode: code, responseBody: JSON.stringify(body) },
            { where: { idemKey: scopedKey } },
          ).catch((err) => logger.error('Idempotency record failed', { error: err.message, key: scopedKey }));
        } else if (code < 500 || walletRestored) {
          IdempotencyKey.destroy({ where: { idemKey: scopedKey } })
            .catch((err) => logger.error('Idempotency release failed', { error: err.message, key: scopedKey }));
        }
      }
      return sendJson(body);
    };

    return next();
  };
}

export default idempotent;
