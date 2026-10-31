// ============================================================
//  scripts/purge_retention.js — run the retention sweeps by hand
// ------------------------------------------------------------
//  The same sweeps run on a daily timer inside the API process, but a
//  timer you cannot invoke is a timer you cannot verify. This exists so
//  the answer to "is the NIN photo retention actually working" is a
//  command someone can run, not a claim.
//
//  Usage:
//    node scripts/purge_retention.js --dry-run   # count only, change nothing
//    node scripts/purge_retention.js             # apply
//
//  --dry-run is the default-safe mode and should be the first thing run
//  on a live database: the first real run of a 90-day window against
//  years of history will touch a large number of rows at once, and it
//  is better to see that number before it happens than after.
// ============================================================

import dotenv from 'dotenv';
import { Op } from 'sequelize';
import sequelize from '../config/database.js';
import { VerificationRecord, OtpCode, IdempotencyKey } from '../models/index.js';
import { runRetention, retentionPolicy } from '../services/retentionService.js';

dotenv.config();

const DRY = process.argv.includes('--dry-run') || process.argv.includes('-n');

function ago(d) {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

// Counting query mirrors the update's WHERE exactly. If these two ever
// drift the dry run stops predicting the real one, so they are written
// next to each other on purpose.
async function preview() {
  const { redactDays, purgeDays, otpDays } = retentionPolicy();
  const now = new Date();

  const toPurge = await VerificationRecord.count({
    where: { date: { [Op.lt]: ago(purgeDays) }, purgedAt: null },
  });
  const toRedact = await VerificationRecord.count({
    where: { date: { [Op.lt]: ago(redactDays) }, redactedAt: null },
  });
  const toOtp = await OtpCode.count({
    where: {
      [Op.or]: [{ consumedAt: { [Op.ne]: null } }, { expiresAt: { [Op.lt]: now } }],
      createdAt: { [Op.lt]: ago(otpDays) },
    },
  });
  const toIdem = await IdempotencyKey.count({
    where: { expiresAt: { [Op.lt]: now } },
  });

  return [
    { stage: 'purge', count: toPurge },
    // toRedact includes the purge set: a row old enough to purge is old
    // enough to redact. The real run does purge first, so the redact
    // count it reports will be lower than this. Said plainly rather than
    // quietly subtracted, because a reader comparing the two numbers
    // should not have to guess why they differ.
    { stage: 'redact', count: toRedact },
    { stage: 'otp', count: toOtp },
    { stage: 'idempotency', count: toIdem },
  ];
}

async function main() {
  const policy = retentionPolicy();
  process.stdout.write(
    `\nRetention policy\n`
    + `  verification result blob redacted after : ${policy.redactDays} days\n`
    + `  verification identifiers purged after   : ${policy.purgeDays} days\n`
    + `  spent OTP codes removed after           : ${policy.otpDays} days\n`
    + `  mode                                    : ${DRY ? 'DRY RUN (no writes)' : 'APPLY'}\n\n`,
  );

  const rows = DRY ? await preview() : await runRetention();

  for (const r of rows) {
    const label = r.stage.padEnd(14);
    const verb = DRY ? 'would affect' : 'affected';
    process.stdout.write(`  ${label} ${verb} ${r.count} row(s)${r.error ? `  ERROR: ${r.error}` : ''}\n`);
  }

  const failed = rows.some((r) => r.error);
  process.stdout.write(`\n${DRY ? 'Dry run complete — nothing was written.' : 'Done.'}\n\n`);
  await sequelize.close();
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  process.stderr.write(`\nRetention run failed: ${err.message}\n\n`);
  try { await sequelize.close(); } catch { /* already closed */ }
  process.exit(1);
});
