// ============================================================
//  retentionService.js — storage limitation, made mechanical
// ------------------------------------------------------------
//  NDPA s.24(1)(e) says personal data is kept "for no longer than is
//  necessary". A policy sentence saying so is worthless; this file is
//  the part that actually makes it true.
//
//  THE SHARP EDGE IS `verifications`.
//
//  When a user runs a NIN check, the row we store is not really about
//  them. `query` is somebody else's national identity number and
//  `result` is that person's photograph, date of birth, residential
//  address and LGA. That third party never visited this site, never
//  agreed to anything, and has no account from which to ask us for
//  erasure. The only control that protects them is us not keeping it.
//
//  So the decay is two-stage rather than one delete, because the two
//  halves of the row have genuinely different lifetimes:
//
//    Stage 1 — REDACT at VERIFICATION_REDACT_DAYS (default 90).
//      Drops `result` entirely: photograph, DOB, address, LGA and the
//      raw provider payload. What survives is the history line the
//      user paid for — type, masked ID, name, date, amount, transref.
//      This is the stage that matters; it removes the biometric.
//
//    Stage 2 — PURGE at VERIFICATION_PURGE_DAYS (default 365).
//      Drops the encrypted ID number and name too. The row becomes an
//      accounting stub that still ties to its transaction, so the
//      books reconcile and nobody has to choose between the finance
//      record and the privacy one.
//
//  Rows are never hard-deleted here. A missing row and a purged row
//  look identical to a bug but very different to an auditor, and
//  `transactions` would be left pointing at nothing.
//
//  The other two sweeps are hygiene rather than principle: consumed or
//  expired OTP codes and expired idempotency keys have no reason to
//  outlive their purpose, and otp_codes carries requestIp.
//
//  Every function here is idempotent and safe to run concurrently: the
//  WHERE clauses select only rows that have NOT yet been through the
//  stage being applied, so a second run finds nothing to do.
// ============================================================

import { Op } from 'sequelize';
import { VerificationRecord, OtpCode, IdempotencyKey } from '../models/index.js';
import * as logger from '../utils/logger.js';

// Read at call time, not at import time, so a deployment can change the
// window without a code edit and tests can set it per-case.
function days(name, fallback) {
  const raw = parseInt(process.env[name], 10);
  // A zero or negative window would redact everything ever written,
  // including the check the user ran ten seconds ago. Refuse it.
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return raw;
}

export function retentionPolicy() {
  return {
    redactDays: days('VERIFICATION_REDACT_DAYS', 90),
    purgeDays: days('VERIFICATION_PURGE_DAYS', 365),
    otpDays: days('OTP_RETAIN_DAYS', 7),
  };
}

function cutoff(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
}

// ------------------------------------------------------------
//  Stage 1 — drop the result blob
// ------------------------------------------------------------
export async function redactOldVerifications(now = new Date()) {
  const { redactDays } = retentionPolicy();
  const before = new Date(now.getTime() - redactDays * 24 * 60 * 60 * 1000);

  const [count] = await VerificationRecord.update(
    { result: null, redactedAt: now },
    {
      where: {
        date: { [Op.lt]: before },
        redactedAt: null,
      },
    },
  );
  return { stage: 'redact', olderThan: before, count };
}

// ------------------------------------------------------------
//  Stage 2 — drop the identifiers, keep the accounting stub
// ------------------------------------------------------------
//  `query` and `fullName` are NOT NULL / nullable respectively in the
//  table: query is NOT NULL, so it gets a literal marker rather than
//  NULL. Writing '' would be indistinguishable from a bug that saved
//  an empty ID, and silent truncation in non-strict MySQL means the
//  marker must be comfortably shorter than the column.
export const PURGED_MARKER = '[purged]';

export async function purgeOldVerifications(now = new Date()) {
  const { purgeDays } = retentionPolicy();
  const before = new Date(now.getTime() - purgeDays * 24 * 60 * 60 * 1000);

  const [count] = await VerificationRecord.update(
    {
      query: PURGED_MARKER,
      fullName: null,
      result: null,
      purgedAt: now,
      // A row can reach stage 2 without having passed through stage 1
      // (e.g. the window was shortened, or the job had never been run
      // on an old install). Stamp both so the audit trail is honest
      // about what state the row is in, not about which job touched it.
      redactedAt: now,
    },
    {
      where: {
        date: { [Op.lt]: before },
        purgedAt: null,
      },
    },
  );
  return { stage: 'purge', olderThan: before, count };
}

// ------------------------------------------------------------
//  Hygiene sweeps
// ------------------------------------------------------------
export async function sweepOtpCodes(now = new Date()) {
  const { otpDays } = retentionPolicy();
  const before = new Date(now.getTime() - otpDays * 24 * 60 * 60 * 1000);

  // Deleted, not redacted: a spent OTP has no evidential value and the
  // row carries requestIp. Only rows already past use are eligible, so
  // a live code is never pulled out from under a user mid-reset.
  const count = await OtpCode.destroy({
    where: {
      [Op.or]: [
        { consumedAt: { [Op.ne]: null } },
        { expiresAt: { [Op.lt]: now } },
      ],
      createdAt: { [Op.lt]: before },
    },
  });
  return { stage: 'otp', olderThan: before, count };
}

export async function sweepIdempotencyKeys(now = new Date()) {
  // These carry a cached response body, which for a purchase includes
  // the beneficiary's number. They exist only to answer a retry.
  const count = await IdempotencyKey.destroy({
    where: { expiresAt: { [Op.lt]: now } },
  });
  return { stage: 'idempotency', olderThan: now, count };
}

// ------------------------------------------------------------
//  Run everything
// ------------------------------------------------------------
/**
 * Order matters: purge before redact. Both stages match on age, and a
 * row old enough to purge is also old enough to redact — running redact
 * first would stamp redactedAt on rows that purge is about to claim,
 * and the counts would double-report the same rows.
 *
 * Each sweep is caught individually. A failure in the OTP sweep must
 * not stop the verification purge, which is the one with a real subject
 * behind it.
 */
export async function runRetention(now = new Date()) {
  const results = [];
  const steps = [
    ['purge', () => purgeOldVerifications(now)],
    ['redact', () => redactOldVerifications(now)],
    ['otp', () => sweepOtpCodes(now)],
    ['idempotency', () => sweepIdempotencyKeys(now)],
  ];

  for (const [name, fn] of steps) {
    try {
      const r = await fn();
      results.push(r);
      if (r.count > 0) {
        logger.info('Retention sweep applied', { stage: r.stage, count: r.count });
      }
    } catch (err) {
      logger.error('Retention sweep failed', { stage: name, error: err.message, stack: err.stack });
      results.push({ stage: name, count: 0, error: err.message });
    }
  }
  return results;
}

/**
 * Start the periodic run. Called from server.js.
 *
 * Deliberately NOT run at startup: a restart loop would otherwise fire
 * the sweep every few seconds against the whole table. First run is one
 * interval in.
 */
export function startRetentionJob(intervalMs = 24 * 60 * 60 * 1000) {
  const handle = setInterval(() => {
    runRetention().catch((err) => {
      logger.error('Retention job crashed', { error: err.message });
    });
  }, intervalMs);
  // Do not hold the process open for this alone.
  if (typeof handle.unref === 'function') handle.unref();
  logger.info('Retention job scheduled', { intervalMs, ...retentionPolicy() });
  return handle;
}
