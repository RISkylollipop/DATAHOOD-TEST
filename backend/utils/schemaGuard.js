// ============================================================
//  utils/schemaGuard.js — catch model/DB drift AT BOOT
// ------------------------------------------------------------
//  Sequelize names every column a model declares in its SELECT list, so
//  ONE column missing from the live table breaks EVERY read of that
//  table at once. On 2026-08-07 that happened to `dataplans.status` and
//  presented as "all plans have disappeared on admin and users" — an
//  hour went into ruling out data loss before a log line named the
//  column.
//
//  utils/dbErrors.js already turns that into a legible 503 at REQUEST
//  time. This module is the earlier warning: it compares what the
//  models declare against what the tables actually have, once, at boot,
//  so a pending migration is named in the log BEFORE the first customer
//  sees anything.
//
//  Why it can't live in config/database.js: it must import the models,
//  and the models import config/database.js.
//
//  Read-only. It runs SHOW COLUMNS and nothing else — it never alters a
//  table. Auto-migrating on boot is how a half-applied schema change
//  ends up in production with nobody having decided to apply it.
// ============================================================

import sequelize from '../config/database.js';
import * as logger from './logger.js';

// Tables worth checking at boot. Two different reasons land a table here,
// and the second is easy to overlook:
//
//   1. DRIFT IS FATAL TO THE FEATURE. `subscribers` is read by the auth
//      middleware, so a missing column there means nobody can log in —
//      including the operator who would fix it. Same for DataPlan,
//      Transaction and Provider: the site is visibly broken, so the only
//      value this guard adds is naming the cause in the first ten log
//      lines instead of the fortieth minute.
//
//   2. DRIFT IS SILENT. AdminAuditLog is the opposite case and the more
//      dangerous one. utils/auditLog.js is fail-open by design ("RULE 1:
//      THIS MUST NEVER THROW") so that an audit insert can never reject a
//      customer's refund. The cost of that design is that a missing
//      admin_audit_log table produces no failed request, no error page and
//      no visible symptom — the security-detection layer simply records
//      nothing while looking fully installed.
//
//      That was not hypothetical. The CREATE TABLE existed, but as
//      statement 2 of security_hardening_prod.sql, behind an ALTER that
//      migrate.js treats as fatal on error 1062 by design; on a database
//      with one duplicate transref the run aborted before reaching it. A
//      migration that half-applied plus a writer that cannot complain is
//      a feature that is absent and reports itself as present.
//
//      A component that cannot fail loudly has to be proven present some
//      other way. This is that way. Anything else fail-open added later
//      belongs on this list for the same reason.
const GUARDED = ['Subscriber', 'DataPlan', 'Transaction', 'Provider', 'AdminAuditLog'];

// MySQL ER_NO_SUCH_TABLE. Distinguished from every other query failure
// because it means something specific and actionable — a migration has not
// been run — whereas a connection error means "ask again later".
const ER_NO_SUCH_TABLE = 1146;

/**
 * The pure half: which declared columns are absent from the live table.
 *
 * Split out from the DB work so it can be unit-tested with no database —
 * see scripts/verify_schema_guard.js. The subtle part is that a model
 * attribute's KEY is the JS name and its `field` is the DB column; on a
 * renamed column those differ, and comparing the key would report drift
 * on a table that is perfectly fine.
 *
 * @param {object} attributes  model.getAttributes()
 * @param {Iterable<string>} liveColumns  Field values from SHOW COLUMNS
 * @returns {string[]} DB column names the table is missing
 */
export function diffColumns(attributes = {}, liveColumns = []) {
  const live = new Set(liveColumns);
  return Object.entries(attributes)
    // Fall back to the attribute key: `field` is normally filled in by
    // Sequelize, but a hand-built attribute object may omit it, and
    // silently skipping such a column would make the guard under-report.
    .map(([key, a]) => (a && a.field) || key)
    .filter((c) => !live.has(c));
}

/**
 * Compare declared columns against the live table.
 *
 * `tableMissing: true` means the table itself is absent, and `missing` is
 * then empty — there is no column list to report, because nothing to
 * compare against exists. Callers must branch on it rather than printing
 * an empty column list, which reads as "drift with no details".
 *
 * @returns {Promise<Array<{model: string, table: string, missing: string[], tableMissing?: boolean}>>}
 */
export async function findSchemaDrift(models = {}) {
  const drift = [];

  for (const name of GUARDED) {
    const model = models[name];
    if (!model) continue;

    const table = model.getTableName();
    let live;
    try {
      // Parameterless and identifier-only: the table name comes from the
      // model definition, never from a request.
      const [rows] = await sequelize.query(`SHOW COLUMNS FROM \`${table}\``);
      live = rows.map((r) => r.Field);
    } catch (err) {
      // THE TWO CASES HERE ARE NOT THE SAME, and collapsing them into one
      // warn is what let the missing admin_audit_log table survive review.
      //
      // A table that does not exist is a pending migration: deterministic,
      // reproducible, fixed by one command, and — for a fail-open consumer
      // like utils/auditLog.js — invisible everywhere else. It is drift, and
      // it is the most severe kind, because a missing column breaks one
      // table's reads while a missing table means the feature never ran at
      // all. Report it as drift.
      //
      // Anything else (unreachable host, auth failure, TLS) is transient
      // and owned by testConnection() and the health monitor. Warn and move
      // on; a DB that is down will say so far more clearly there, and
      // shouting "SCHEMA DRIFT" during a network blip sends the operator
      // to run migrations against a database they cannot reach.
      const errno = err.parent?.errno ?? err.original?.errno;
      if (errno === ER_NO_SUCH_TABLE) {
        drift.push({ model: name, table, missing: [], tableMissing: true });
      } else {
        logger.warn('Schema guard could not inspect table', { table, error: err.message });
      }
      continue;
    }

    const missing = diffColumns(model.getAttributes(), live);
    if (missing.length) drift.push({ model: name, table, missing });
  }

  return drift;
}

/**
 * Log any drift found. Returns the drift list so a caller can decide to
 * refuse to boot; by default we log and continue, because a schema that
 * is merely AHEAD in one table should not take down the endpoints that
 * still work — and because refusing to start would also take away the
 * admin panel needed to see the problem.
 */
export async function reportSchemaDrift(models) {
  const drift = await findSchemaDrift(models);
  if (!drift.length) return drift;

  for (const d of drift) {
    if (d.tableMissing) {
      // Worded to pre-empt the wrong conclusion. An absent table looks like
      // data loss, and the instinct is to go hunting for a backup. It is
      // not: nothing was ever written here, because there was never
      // anywhere to write it.
      logger.error('SCHEMA DRIFT — table does not exist, this feature is recording nothing', {
        table: d.table,
        fix: 'Run: npm run db:migrate  (backend/scripts/migrate.js), then restart',
        note: 'No data has been lost — the table was never created, so nothing was ever stored. '
          + 'If its writer is fail-open (utils/auditLog.js is), every write so far has been '
          + 'silently discarded and the only trace is repeated "Audit write failed" lines.',
      });
      continue;
    }

    logger.error('SCHEMA DRIFT — migration pending, reads of this table will fail', {
      table: d.table,
      missingColumns: d.missing.join(', '),
      fix: 'Run: npm run db:migrate  (backend/scripts/migrate.js), then restart',
      note: 'No data has been lost. The model expects columns the table does not have.',
    });
  }

  logger.boot(
    `⚠️  Schema drift in ${drift.length} table(s): `
    + `${drift.map((d) => `${d.table} (${d.tableMissing ? 'TABLE MISSING' : d.missing.join(', ')})`).join('; ')} `
    + '— run npm run db:migrate',
  );

  return drift;
}
