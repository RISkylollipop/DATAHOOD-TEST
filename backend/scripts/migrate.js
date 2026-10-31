// ============================================================
//  scripts/migrate.js — apply the SQL files in sql/ to the DB
// ------------------------------------------------------------
//  package.json has always pointed `db:migrate` here, but the file
//  did not exist — which is exactly how dataplans.status ended up
//  declared in the DataPlan model while the live table never got
//  the column. Every query then selected a column MySQL didn't
//  have and both the admin and customer plan lists 500'd, looking
//  for all the world like the plans had been deleted.
//
//  Reuses config/database.js on purpose: same credentials, same
//  pool, same TLS settings as the running app, so "it connects for
//  the API but not for migrations" can't happen.
//
//  Usage:
//    node scripts/migrate.js                    # all files, in order
//    node scripts/migrate.js dataplan_status_migration.sql
//    node scripts/migrate.js --list             # show order, run nothing
//
//  Safe to re-run. MySQL 8 has no "ADD COLUMN IF NOT EXISTS", so
//  re-applying raises 1060/1061/1050; those mean "already applied"
//  and are reported as skipped, not failures.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sequelize from '../config/database.js';

const SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');

// Dependency order, not alphabetical: columns and tables must exist before
// the seeds that populate them, and the collation fix goes last so it sweeps
// up everything the earlier files created.
const ORDER = [
  'missing_columns_migration.sql',
  'security_pin_migration.sql',
  'security_hardening_migration.sql',
  'verification_migration.sql',
  // 'blacklist_table.sql',
  // Cleans up rows earlier runs duplicated, so it must follow the file
  // that seeds them. Listed explicitly rather than left to the
  // alphabetical fallback below, which would run it dead last.
  // 'blacklist_dedupe.sql',
  'providers_table.sql',
  'otp_codes_table.sql',
  'virtual_accounts_table.sql',
  // Replaces the UNIQUE (gateway, accountReference) that rejected the
  // second bank of a multi-bank reservation. Runs immediately after the
  // table file so a fresh install gets the DDL and the fix no-ops there.
  'virtual_accounts_ref_index_fix.sql',
  'wallet_ledger_table.sql',
  // Its sibling: wallet_ledger records WHAT moved, admin_audit_log records
  // WHO moved it. No foreign keys anywhere in it, on purpose, so it has no
  // dependency on any other file.
  //
  // MOVED HERE 2026-08-19 out of security_hardening_prod.sql, and the
  // POSITION is the entire point — do not tidy it back down the list.
  // That file's first statement is ALTER TABLE transactions ADD UNIQUE
  // (transref), which isBenign() below deliberately treats as FATAL on
  // 1062, and runFile() aborts a file at its first fatal statement. So on
  // any database holding one duplicate transref, the CREATE TABLE that
  // used to sit behind it never ran. The operator got a money-
  // reconciliation error, went to reconcile money — correctly — and never
  // learned the audit table had not been created. Creating a table cannot
  // fail on pre-existing data, so it does not belong behind a statement
  // whose job is to stop the run.
  'admin_audit_log_table.sql',
  'idempotency_keys_table.sql',
  'plans_management_migration.sql',
  'dataplan_status_migration.sql',
  'site_settings_social_widths.sql',
  'admin_2fa_and_otp_scope.sql',
  'newsletter_tables.sql',
  // Renames the seeded WhatsApp row, so it must run after
  // providers_table.sql has created and seeded it.
  'whatsapp_provider_rename.sql',
  // After verification_migration.sql (it alters `verifications`) and after
  // the subscribers columns exist.
  'privacy_compliance.sql',
  // Adds subscribers.sKycType, which models/Subscriber.js declares. Sequelize
  // names every declared column in its SELECT list, so leaving this unapplied
  // makes every read of `subscribers` fail at once — the exact shape of the
  // 2026-08-07 "all plans disappeared" incident.
  'kyc_identity_type.sql',
  'whatsapp_unreachable.sql',
  // 2026-08-18 security review. Goes late on purpose: it adds
  // UNIQUE(transactions.transref) and UNIQUE(subscribers.sEmail), the two
  // statements in this list that SHOULD fail loudly on existing bad data
  // (error 1062 = references already recorded twice, or two accounts
  // sharing a login email). Running it after every other DDL means a
  // failure here is unambiguous — nothing else is left pending behind it.
  'security_hardening_prod.sql',
  'seed_plans.sql',
  'utf8_collation_fix.sql',
];

// "already applied" — expected on a re-run, never fatal.
const BENIGN = {
  1050: 'table already exists',
  1060: 'column already exists',
  1061: 'index already exists',
  1091: 'column/index already absent',
};

// 1062 (duplicate entry) is benign for a SEED and fatal for a CONSTRAINT,
// so it cannot live in the table above.
//
// On `INSERT ... ` it means "this row is already there", which is exactly
// what a re-run should skip. On `ALTER TABLE ... ADD UNIQUE` it means the
// EXISTING DATA violates the constraint we are trying to add — for
// security_hardening_prod.sql that is "the transactions table already
// contains duplicate references", i.e. money recorded twice. Reporting
// that as "already applied" would print `ok` and leave the index absent,
// so every idempotency guard in the codebase would keep believing a
// database mutex was protecting it. The header of that file explains what
// to do; this makes sure the operator actually gets to read it.
function isBenign(code, stmt) {
  if (BENIGN[code]) return BENIGN[code];
  if (code === 1062 && /^\s*(insert|replace)\b/i.test(stmt)) return 'row already present';
  return null;
}

/**
 * Split a script into statements on semicolons, ignoring any that sit inside
 * a quoted string or a comment.
 *
 * A naive split(';') corrupts real migrations here: dataplan_status_migration
 * carries COMMENT 'enabled | disabled (admin toggle; disabled plans hidden
 * from customers)' — the semicolon inside those quotes would cut the ALTER
 * in half and both fragments would be syntax errors.
 *
 * DO NOT `import { splitStatements } from './migrate.js'` — not from a test,
 * not from a checker, not from anything. It is exported for readability only.
 * This module calls main() at the bottom on load, so ANY import of it
 * connects to the live database and applies every migration, then calls
 * process.exit. An innocent-looking import in a test file would silently run
 * production DDL. If another module needs this parser, move it to
 * utils/sqlSplit.js first and have migrate.js import it from there.
 */
export function splitStatements(sql) {
  const out = [];
  let buf = '';
  let quote = null;
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];

    if (quote) {
      buf += c;
      // Backtick identifiers have no backslash escapes; strings do.
      if (c === '\\' && quote !== '`') { buf += n ?? ''; i += 2; continue; }
      if (c === quote) {
        if (n === quote) { buf += n; i += 2; continue; } // '' doubled literal
        quote = null;
      }
      i += 1;
      continue;
    }

    // -- line comment (needs trailing space/EOL, so "--x" stays literal)
    if (c === '-' && n === '-' && (sql[i + 2] === undefined || /[\s]/.test(sql[i + 2]))) {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '#') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }

    if (c === "'" || c === '"' || c === '`') { quote = c; buf += c; i += 1; continue; }

    if (c === ';') {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }

    buf += c;
    i += 1;
  }

  if (buf.trim()) out.push(buf.trim());
  return out;
}

/** Files to run: ORDER first (those that exist), then any stragglers in sql/. */
function resolveFiles(requested) {
  const present = fs.existsSync(SQL_DIR)
    ? fs.readdirSync(SQL_DIR).filter((f) => f.toLowerCase().endsWith('.sql'))
    : [];

  if (requested.length) {
    const missing = requested.filter((f) => !present.includes(f));
    if (missing.length) {
      throw new Error(`Not found in sql/: ${missing.join(', ')}`);
    }
    return requested;
  }

  const ordered = ORDER.filter((f) => present.includes(f));
  // Anything added to sql/ but not yet listed in ORDER still runs — last,
  // alphabetically — so a new file is never silently ignored.
  const extras = present.filter((f) => !ORDER.includes(f)).sort();
  return [...ordered, ...extras];
}

async function runFile(file) {
  const statements = splitStatements(fs.readFileSync(path.join(SQL_DIR, file), 'utf8'));
  let applied = 0;
  let skipped = 0;

  for (const [idx, stmt] of statements.entries()) {
    try {
      await sequelize.query(stmt);
      applied += 1;
    } catch (err) {
      const code = err.parent?.errno ?? err.original?.errno;
      if (isBenign(code, stmt)) {
        skipped += 1;
        continue;
      }
      // Show which statement broke — without dumping a 14KB seed file.
      const preview = stmt.replace(/\s+/g, ' ').slice(0, 140);
      throw new Error(
        `${file} — statement ${idx + 1}/${statements.length} failed: ${err.message}\n    ${preview}...`
      );
    }
  }

  return { applied, skipped, total: statements.length };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--list')) {
    console.log('Migration order:');
    resolveFiles([]).forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    return;
  }

  const files = resolveFiles(args.filter((a) => !a.startsWith('--')));
  if (!files.length) {
    console.log('No .sql files found in sql/ — nothing to do.');
    return;
  }

  // Fail before touching anything if the DB is unreachable, so a DNS or TLS
  // problem doesn't read as "the migration ran and did nothing".
  await sequelize.authenticate();
  console.log(`Connected. Applying ${files.length} file(s):\n`);

  for (const file of files) {
    process.stdout.write(`  ${file} ... `);
    const { applied, skipped, total } = await runFile(file);
    const note = skipped ? ` (${skipped} already applied)` : '';
    console.log(`ok — ${applied}/${total} statements${note}`);
  }

  console.log('\nDone. Restart the backend so the connection pool picks up the new schema.');
}

// console output is correct here: this is an operator-run CLI, not the server.
main()
  .then(() => sequelize.close())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`\nMigration failed: ${err.message}`);
    await sequelize.close().catch(() => {});
    process.exit(1);
  });
