// ============================================================
//  utils/dbErrors.js — turn schema drift into a legible message
// ------------------------------------------------------------
//  Written after a real incident. `dataplans.status` was declared in
//  models/DataPlan.js but sql/dataplan_status_migration.sql had never
//  been applied to the live DB. Sequelize names every declared column
//  in its SELECT list, so MySQL rejected the whole statement with
//  error 1054 and EVERY read of that table 500'd at once.
//
//  What the operator saw was "all plans have disappeared on admin and
//  users" — indistinguishable from someone deleting the catalogue. The
//  data was never touched. An hour went into ruling out data loss
//  before the log line naming the column was spotted.
//
//  So: when a query fails because a column the model expects is not in
//  the table, say exactly that. A pending migration should read as a
//  pending migration, not as missing data.
// ============================================================

import * as logger from './logger.js';
// callSite(1): skip this helper's own frame and report the controller that
// called it. Without it every schema-drift entry names this file.
import { callSite } from './logger.js';

// MySQL error numbers, from the server's own list. Sequelize buries the
// driver error under .parent / .original depending on how it was raised.
const ER_BAD_FIELD_ERROR = 1054; // Unknown column 'x' in 'field list'
const ER_NO_SUCH_TABLE = 1146; // Table 'db.x' doesn't exist

function errno(err) {
  return err?.parent?.errno ?? err?.original?.errno ?? err?.errno ?? null;
}

/**
 * True when the failure is schema drift — the model expects a column or
 * table the live database does not have. Distinct from a genuine query
 * bug: nothing the caller sent could cause it, and no retry will help.
 */
export function isSchemaDrift(err) {
  const code = errno(err);
  return code === ER_BAD_FIELD_ERROR || code === ER_NO_SUCH_TABLE;
}

const ER_DUP_ENTRY = 1062; // Duplicate entry 'x' for key 'y'
const ER_DATA_TRUNCATED = 1265; // Data truncated for column (usually an ENUM)

/**
 * A legible description of a database error, for the log.
 *
 * Exists because of a real incident that cost an hour: creating a virtual
 * account failed with `error: "Validation error"` and nothing else. That
 * string is Sequelize's DEFAULT ValidationError message, and
 * UniqueConstraintError extends ValidationError — so a duplicate-key
 * violation, which MySQL itself describes precisely, reached the log as
 * three characterless words naming no index, no column and no value.
 *
 * The driver's own message is the useful one ("Duplicate entry 'monnify-...'
 * for key 'uniq_va_ref'"): it names the index, which names the constraint
 * that was wrong. So prefer it, and fall back to err.message when there is
 * no driver error underneath (a genuine field validation).
 *
 * Returns a string, never throws — a logging helper that can fail while
 * describing a failure is worse than the missing detail.
 */
export function dbErrorDetail(err) {
  if (!err) return 'unknown error';
  const code = errno(err);
  // sqlMessage is MySQL's text; `message` on the driver error repeats it.
  const driverMsg = err?.parent?.sqlMessage || err?.original?.sqlMessage || null;
  const base = err.message || 'unknown error';

  if (code === ER_DUP_ENTRY) {
    // err.fields is Sequelize's parse of the same thing and is sometimes
    // populated when sqlMessage is not, so try both before giving up.
    const fields = err.fields && typeof err.fields === 'object'
      ? Object.keys(err.fields).join(', ')
      : '';
    const detail = driverMsg || (fields ? `duplicate value for (${fields})` : base);
    return `unique constraint violated — ${detail}`;
  }
  if (code === ER_DATA_TRUNCATED) {
    // The ENUM trap: a value the live column does not accept. See
    // sql/providers_table.sql for why CREATE TABLE IF NOT EXISTS never
    // widens one.
    return `value rejected by the column definition (ENUM out of range?) — ${driverMsg || base}`;
  }
  return driverMsg ? `${base} (${driverMsg})` : base;
}

/**
 * Respond to a schema-drift failure.
 *
 * 503, not 500: the request was valid and the data is intact — the server
 * is not currently able to serve it. Also not 401, which would trip the
 * auto-logout in the frontend's client.js and hide the real problem
 * behind a surprise sign-out.
 *
 * `audience: 'admin'` includes the driver's own message, which names the
 * missing column. That is safe on admin-only routes and is the single
 * most useful string in the whole incident. Customer-facing routes get a
 * neutral message; the detail goes to the log instead, never to the
 * client (no stack traces or internals past the boundary).
 *
 * @returns {boolean} true if handled — caller should stop.
 */
export function handleSchemaDrift(res, err, { where, audience = 'user' } = {}) {
  if (!isSchemaDrift(err)) return false;

  logger.error('Schema drift — migration pending', {
    where,
    errno: errno(err),
    error: err.message,
    // This helper is called from many controllers, so the logger's own `at`
    // would read "utils/dbErrors.js:60" for every drift incident in the app —
    // the same line no matter which page broke. Overriding it names the
    // caller (logger honours an explicit `at`), and the stack gives the
    // logger the throw site inside the driver as `thrownAt`.
    at: callSite(1),
    stack: err.stack,
    hint: 'Run: npm run db:migrate (see backend/scripts/migrate.js)',
  });

  const msg = audience === 'admin'
    ? `Database update pending — a column this page reads is missing from the table. `
      + `Run "npm run db:migrate" on the server, then restart the backend. `
      + `Your plans and records are intact. Detail: ${err.message}`
    : 'This section is briefly unavailable while the service is being updated. '
      + 'Nothing has been lost — please try again shortly.';

  res.status(503).json({ status: 'fail', msg, code: 'MIGRATION_PENDING' });
  return true;
}
