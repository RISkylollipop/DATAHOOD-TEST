// ============================================================
//  scripts/repair_stranded_virtual_accounts.js
// ------------------------------------------------------------
//  Post-incident repair for the 2026-08-10 createAccount bug.
//
//  What happened: virtual_accounts carried UNIQUE (gateway,
//  accountReference), but one Monnify reservation returns SEVERAL
//  bank accounts all sharing the ONE reference we sent. The first
//  bank's INSERT committed, the second hit the unique index, and
//  the whole request 500'd with the bare message "Validation error".
//  The loop is not transactional, so the surviving rows were never
//  rolled back. Any subscriber who tried to create a monnify account
//  while the bug was live is left with a PARTIAL set (typically one
//  Wema row where Monnify meant to return four banks).
//
//  Why those rows need attention: the create-account gate
//  (utils/virtualAccounts.js heldGateways) treats ANY active row for
//  a gateway as "you already have this gateway", so the stranded
//  subscriber is now stuck at a 409 and can never finish the set —
//  until the broken row is retired.
//
//  The fix was structural (sql/virtual_accounts_ref_index_fix.sql
//  makes the pair a plain index), but the data damage predates it.
//  THIS SCRIPT is the data part.
//
//  Safety rules:
//   * Status over deletion, always. Rows are never DELETEed here. The
//     funding webhook resolves an owner by (gateway, accountReference)
//     with NO status filter, so a deposit into the old number still
//     credits the right wallet after a row is retired. Deleting the row
//     would not have broken that either, but it would erase the audit
//     trail; inactivation keeps it.
//   * --fix is explicit and narrow: one subscriber, one gateway, and
//     only when the operator names both. No bulk heuristics that guess
//     "Monnify must return four banks" — the provider row can be
//     configured for a subset, and guessing wrong retires money paths.
//   * After --fix the subscriber is allowed to create the gateway
//     again (heldGateways only sees status='active'), and a fresh
//     creation issues a new reservation. Note: reservations are
//     quota-bearing at the gateway, so each re-creation is a cost the
//     operator is choosing deliberately.
//
//  Usage:
//    node scripts/repair_stranded_virtual_accounts.js              # report only
//    node scripts/repair_stranded_virtual_accounts.js --fix 82 monnify
// ============================================================

import sequelize from '../config/database.js';

const [,, ...args] = process.argv;

/** Rows grouped per (sId, gateway): how many, since when, which banks. */
async function reportSets() {
  const [rows] = await sequelize.query(
    `SELECT sId, gateway, COUNT(*) AS n,
            MIN(createdAt) AS firstCreated, MAX(createdAt) AS lastCreated,
            GROUP_CONCAT(bankName ORDER BY id SEPARATOR ' | ') AS banks
       FROM virtual_accounts
      GROUP BY sId, gateway
      ORDER BY sId, gateway`,
    { raw: true },
  );
  return rows;
}

/** A set with one row from a multi-bank gateway is the bug's fingerprint. */
const MULTI_BANK_GATEWAYS = new Set(['monnify']);

async function main() {
  const fixIdx = args.indexOf('--fix');
  const fixTarget = fixIdx >= 0 && args[fixIdx + 1] && args[fixIdx + 2]
    ? { sId: Number(args[fixIdx + 1]), gateway: args[fixIdx + 2] }
    : null;

  if (!fixTarget && args.length > 0 && !args.includes('--fix')) {
    console.error('Unknown arguments. Use: node scripts/repair_stranded_virtual_accounts.js [--fix <sId> <gateway>]');
    process.exit(2);
  }
  if (fixTarget && (Number.isNaN(fixTarget.sId) || !fixTarget.gateway)) {
    console.error('--fix needs: <sId> <gateway>, e.g. --fix 82 monnify');
    process.exit(2);
  }

  await sequelize.authenticate();
  const sets = await reportSets();

  if (fixTarget) {
    const hit = sets.filter((s) => Number(s.sId) === fixTarget.sId && s.gateway === fixTarget.gateway);
    if (hit.length === 0) {
      console.error(`No virtual_accounts rows for sId=${fixTarget.sId} gateway=${fixTarget.gateway}. Nothing to do.`);
      await sequelize.close();
      process.exit(1);
    }

    console.log(`Retiring ${hit.length} row(s) for subscriber ${fixTarget.sId} (${fixTarget.gateway}):`);
    for (const s of hit) {
      console.log(`  - ${s.banks} (${s.n} row(s), last activity ${s.lastCreated})`);
    }

    const [result] = await sequelize.query(
      'UPDATE virtual_accounts SET status = \'inactive\' WHERE sId = ? AND gateway = ? AND status = \'active\'',
      { replacements: [fixTarget.sId, fixTarget.gateway] },
    );
    // mysql2 hands back a ResultSetHeader; read it defensively so a driver
    // difference prints a number rather than the word "undefined".
    const n = result?.affectedRows ?? result?.[0]?.affectedRows ?? hit.reduce((t, s) => t + Number(s.n), 0);
    console.log(`\nRetired ${n} row(s). The subscriber can now create ${fixTarget.gateway} again.`);
    console.log('Existing deposits into retired numbers still credit: the webhook ignores status.');
    await sequelize.close();
    process.exit(0);
  }

  // ---- Report mode (default) ----
  console.log('Virtual account sets per (subscriber, gateway):\n');
  let stranded = 0;
  for (const s of sets) {
    const likely = MULTI_BANK_GATEWAYS.has(s.gateway) && Number(s.n) === 1;
    if (likely) stranded += 1;
    console.log(
      `  sId ${String(s.sId).padEnd(5)} ${String(s.gateway).padEnd(12)} ${String(s.n).padStart(2)} row(s)`
      + `  first ${String(s.firstCreated).slice(0, 16)}  ${s.banks}`
      + (likely ? '   <-- likely stranded by the 2026-08-10 bug' : ''),
    );
  }

  console.log(
    `\n${sets.length} set(s) total, ${stranded} singleton ${stranded === 1 ? 'set' : 'sets'} on a multi-bank gateway.`
    + '\nIf a singleton is a botched creation, retire it so the subscriber can re-create:'
    + '\n  node scripts/repair_stranded_virtual_accounts.js --fix <sId> <gateway>'
  );
  await sequelize.close();
}

main()
  .catch(async (err) => {
    console.error(`\nFailed: ${err.message}`);
    await sequelize.close().catch(() => {});
    process.exit(1);
  });
