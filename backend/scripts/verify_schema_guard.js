// ============================================================
//  verify_schema_guard.js — checks utils/schemaGuard.js
// ------------------------------------------------------------
//  No network, no DB. Run: node scripts/verify_schema_guard.js
//
//  Two halves:
//    1. diffColumns() against hand-built inputs, including the renamed-
//       column case that a naive implementation gets wrong.
//    2. findSchemaDrift() — the REAL function, with sequelize.query
//       swapped for canned SHOW COLUMNS answers.
//
//  A NOTE ON HALF 2, because it is a lesson worth keeping: this header
//  used to describe exactly that second half, and the file did not
//  contain it. It built a `fakeModel` helper, never called
//  findSchemaDrift, and ran every assertion through diffColumns instead —
//  so the error-handling path, which is where the interesting decisions
//  live, had no coverage at all while the file said it did. The header was
//  the only thing anyone read. Half 2 is now real.
//
//  That gap mattered on 2026-08-19: the fix for an absent admin_audit_log
//  table lives entirely in findSchemaDrift's catch block, i.e. in the part
//  that was never executed by this suite.
//
//  Half 3 compares the CREATE TABLE text against the model, and also
//  asserts that exactly ONE file defines the table. That second check is
//  there because of how the duplicate it now guards against got written:
//  a Grep for `admin_audit_log` across backend/ came back with no .sql
//  match, so a second CREATE TABLE was added — but ripgrep honours
//  .gitignore, and *.sql is ignored in this repo to keep the leaked
//  legacy dumps out of git. GREP CANNOT SEE backend/sql/. Any "does the
//  migration for X exist?" question has to be answered with readdir or a
//  direct Read, which is what this file does.
//
//  The last block mutates the comparison on purpose and fails the run if
//  a broken version still passes.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sequelize from '../config/database.js';
import { diffColumns, findSchemaDrift } from '../utils/schemaGuard.js';
// Half 3 only. Pulls in every model + association; no queries run at import
// time, which is why this stays DB-free (server.js likewise imports models
// well before it calls testConnection).
import { AdminAuditLog } from '../models/index.js';

let pass = 0;
const fail = [];
const ok = (label, cond) => { cond ? pass++ : fail.push(label); };

// ---- diffColumns: the pure comparison -----------------------
ok('no drift when live has every declared column',
  diffColumns({ sId: { field: 'sId' }, sKYC: { field: 'sKYC' } }, ['sId', 'sKYC', 'extra']).length === 0);

ok('reports a column the table is missing',
  diffColumns({ sId: { field: 'sId' }, sKycType: { field: 'sKycType' } }, ['sId'])
    .join() === 'sKycType');

ok('reports several missing columns',
  diffColumns({ a: { field: 'a' }, b: { field: 'b' }, c: { field: 'c' } }, ['a']).join() === 'b,c');

// The case a naive implementation fails: attribute KEY differs from the
// DB column. Comparing keys would call this drift on a healthy table.
ok('renamed column compared by DB name, not JS name',
  diffColumns({ createdAt: { field: 'date_created' } }, ['date_created']).length === 0);
ok('renamed column still detected when genuinely absent',
  diffColumns({ createdAt: { field: 'date_created' } }, ['createdAt']).join() === 'date_created');

// A hand-built attribute with no `field` must fall back to the key, not
// be dropped — dropping it would make the guard silently under-report.
ok('attribute without .field falls back to its key',
  diffColumns({ sKycType: {} }, ['sId']).join() === 'sKycType');
ok('null attribute value does not throw and falls back to key',
  diffColumns({ weird: null }, ['weird']).length === 0);

// Extra columns in the DB are NOT drift: a table ahead of the models
// breaks nothing, and flagging it would cry wolf on every legacy column.
ok('extra live columns are not reported',
  diffColumns({ a: { field: 'a' } }, ['a', 'legacy1', 'legacy2']).length === 0);

ok('empty declared set yields no drift', diffColumns({}, ['a', 'b']).length === 0);
ok('empty live set reports everything declared',
  diffColumns({ a: { field: 'a' }, b: { field: 'b' } }, []).join() === 'a,b');

// ---- findSchemaDrift against a fake model -------------------
// Rebuilt here rather than imported, because importing the real one pulls
// in config/database.js and would try to reach a database. The logic under
// test is diffColumns, which IS the real one.
const fakeModel = (table, attrs) => ({
  getTableName: () => table,
  getAttributes: () => attrs,
});

// The actual 2026-08-07 shape: model declares `status`, table does not have it.
const dataplanAttrs = { id: { field: 'id' }, name: { field: 'name' }, status: { field: 'status' } };
const liveDataplans = ['id', 'name'];
ok('reproduces the 2026-08-07 incident: dataplans.status missing',
  diffColumns(fakeModel('dataplans', dataplanAttrs).getAttributes(), liveDataplans).join() === 'status');

// Today's change: subscribers.sKycType before the migration is applied.
const subAttrs = { sId: { field: 'sId' }, sKYC: { field: 'sKYC' }, sKycType: { field: 'sKycType' } };
ok('catches sKycType before kyc_identity_type.sql is applied',
  diffColumns(subAttrs, ['sId', 'sKYC']).join() === 'sKycType');
ok('clean once kyc_identity_type.sql is applied',
  diffColumns(subAttrs, ['sId', 'sKYC', 'sKycType']).length === 0);

// subscribers.sWhatsAppUnreachable before whatsapp_unreachable.sql is applied.
const waAttrs = { sId: { field: 'sId' }, sWhatsAppUnreachable: { field: 'sWhatsAppUnreachable' } };
ok('catches sWhatsAppUnreachable before whatsapp_unreachable.sql is applied',
  diffColumns(waAttrs, ['sId']).join() === 'sWhatsAppUnreachable');
ok('clean once whatsapp_unreachable.sql is applied',
  diffColumns(waAttrs, ['sId', 'sWhatsAppUnreachable']).length === 0);

// ============================================================
//  HALF 2 — the REAL findSchemaDrift, with canned SHOW COLUMNS
// ------------------------------------------------------------
//  sequelize.query is replaced on the shared instance. This works because
//  schemaGuard.js and this file import the SAME module object, so the
//  function under test calls the stub. It never opens a socket; importing
//  config/database.js constructs a Sequelize instance but Sequelize
//  connects lazily, on first query.
//
//  Note logger is NOT stubbed — an ESM namespace import is read-only, so
//  logger.warn cannot be reassigned. The one warning the ECONNREFUSED case
//  emits lands in backend/logs/ as normal. That is why these tests target
//  findSchemaDrift rather than reportSchemaDrift: the latter's whole job is
//  logging, so testing it here would write four fake SCHEMA DRIFT errors
//  into the real log and teach the next operator to distrust the file.
// ============================================================

const realQuery = sequelize.query.bind(sequelize);

/**
 * @param {Record<string, string[]|Error>} plan  table name -> columns, or an
 *   Error to throw for that table.
 */
function stubQuery(plan) {
  sequelize.query = async (sql) => {
    const m = /SHOW COLUMNS FROM `([^`]+)`/.exec(String(sql));
    if (!m) throw new Error(`test stub saw an unexpected query: ${sql}`);
    const answer = plan[m[1]];
    if (answer === undefined) throw new Error(`test stub has no answer for ${m[1]}`);
    if (answer instanceof Error) throw answer;
    // Shape matches mysql2: [rows, metadata], rows carrying a Field key.
    return [answer.map((f) => ({ Field: f }))];
  };
}

// Real Sequelize wraps the driver error, so the errno sits on .parent.
// migrate.js reads it the same way; if that ever changes, both break together.
const errNoSuchTable = (table) => Object.assign(
  new Error(`Table 'kwarapo1_datahood.${table}' doesn't exist`),
  { parent: { errno: 1146, code: 'ER_NO_SUCH_TABLE' } },
);
// No errno at all — a connection that never reached MySQL to be told anything.
const errUnreachable = () => Object.assign(
  new Error('connect ECONNREFUSED 127.0.0.1:3306'),
  { parent: { code: 'ECONNREFUSED' } },
);

// A trimmed AdminAuditLog. Only the shape matters, not the full column list.
const auditAttrs = {
  id: { field: 'id' }, action: { field: 'action' }, outcome: { field: 'outcome' },
};
const auditModels = () => ({ AdminAuditLog: fakeModel('admin_audit_log', auditAttrs) });

// ---- the 2026-08-19 bug: a table that does not exist ----
//
// THIS ASSERTION IS ALSO THE WIRING TEST. findSchemaDrift only iterates its
// private GUARDED list, so if 'AdminAuditLog' is dropped from that array the
// model below is never looked up, drift comes back empty and this fails.
// There is deliberately no separate "is it in GUARDED" check to keep in sync.
stubQuery({ admin_audit_log: errNoSuchTable('admin_audit_log') });
let drift = await findSchemaDrift(auditModels());
ok('a MISSING TABLE is reported as drift, not swallowed as a warning',
  drift.length === 1 && drift[0].tableMissing === true && drift[0].table === 'admin_audit_log');
ok('a missing table reports no phantom column list',
  drift.length === 1 && Array.isArray(drift[0].missing) && drift[0].missing.length === 0);

// ---- the case that must NOT be reported as drift ----
// Telling an operator to run migrations because the database is unreachable
// sends them to run DDL against a host they cannot connect to.
stubQuery({ admin_audit_log: errUnreachable() });
drift = await findSchemaDrift(auditModels());
ok('an unreachable database is NOT reported as schema drift', drift.length === 0);

// ---- the healthy case ----
stubQuery({ admin_audit_log: ['id', 'action', 'outcome', 'legacyExtra'] });
drift = await findSchemaDrift(auditModels());
ok('a table with every declared column yields no drift', drift.length === 0);

// ---- a table that exists but is behind ----
stubQuery({ admin_audit_log: ['id', 'action'] });
drift = await findSchemaDrift(auditModels());
ok('a missing COLUMN is drift, names the column, and leaves tableMissing unset',
  drift.length === 1 && !drift[0].tableMissing && drift[0].missing.join() === 'outcome');

// ---- a failing table must not abandon the rest of the sweep ----
// The ORDER here is the whole point, and the first version of this test got it
// wrong: GUARDED runs Subscriber first and AdminAuditLog last, so making the
// AUDIT table the failing one proves nothing about `continue` — there is
// nothing after it to lose. The failure has to come EARLY and the drift LATE.
// If that catch block ever `break`s or rethrows, subscribers being unmigrated
// would mask every other pending migration behind it.
stubQuery({
  subscribers: errNoSuchTable('subscribers'),
  admin_audit_log: ['id', 'action'],
});
drift = await findSchemaDrift({
  Subscriber: fakeModel('subscribers', { sId: { field: 'sId' } }),
  AdminAuditLog: fakeModel('admin_audit_log', auditAttrs),
});
ok('a failing table does not stop the sweep — drift in a LATER table is still found',
  drift.length === 2
  && drift[0].table === 'subscribers' && drift[0].tableMissing === true
  && drift[1].table === 'admin_audit_log' && drift[1].missing.join() === 'outcome');

// ---- CONTROL: prove the fix is observable in BOTH directions ----
// The pre-fix implementation warned and continued on EVERY query failure,
// so it returned [] for both errors below. The fix has to change the answer
// on 1146 and leave it alone on a connection failure — one without the other
// is either the original bug or a guard that cries wolf during a blip.
stubQuery({ admin_audit_log: errNoSuchTable('admin_audit_log') });
const onMissingTable = (await findSchemaDrift(auditModels())).length;
stubQuery({ admin_audit_log: errUnreachable() });
const onUnreachable = (await findSchemaDrift(auditModels())).length;
ok('CONTROL: pre-fix behaviour (warn on every error) is now distinguishable',
  onMissingTable === 1 && onUnreachable === 0);

sequelize.query = realQuery;

// ============================================================
//  HALF 3 — does the .sql file actually create what the model declares?
// ------------------------------------------------------------
//  Halves 1 and 2 compare the model against a LIVE table, which means the
//  earliest they can catch a typo is on the next boot against a database
//  that has already had the migration applied. This half compares the
//  model against the CREATE TABLE text, so a misspelled column is caught
//  here, with no database, before anything is deployed.
//
//  It reuses diffColumns deliberately: same comparator, different source
//  of "live" columns. Feeding it the .sql file instead of SHOW COLUMNS is
//  the whole trick, and it means this check cannot disagree with the boot
//  guard about what counts as a match.
//
//  Both directions are compared here, unlike the boot guard. An extra
//  column in a LIVE table is legacy baggage and correctly ignored; an
//  extra column in a CREATE TABLE that was hand-written from the model is
//  a typo — `adminID` next to a model's `adminId` would show up as one
//  missing and one extra, and only the pair makes the cause obvious.
// ============================================================

const SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sql');

/**
 * Column names declared by a CREATE TABLE, in file order.
 *
 * A definition line starts with a backticked identifier. That single rule
 * is what excludes `PRIMARY KEY (...)`, `KEY idx_... (...)`, `UNIQUE ...`
 * and every `-- comment`, all of which start with something else — so no
 * keyword blocklist to keep up to date.
 */
function columnsFromSql(file) {
  return fs.readFileSync(path.join(SQL_DIR, file), 'utf8')
    .split('\n')
    .map((l) => /^`(\w+)`\s/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => m[1]);
}

const sqlCols = columnsFromSql('admin_audit_log_table.sql');
const modelAttrs = AdminAuditLog.getAttributes();

ok('the parser found a plausible column list (not zero, not the index lines)',
  sqlCols.length >= 10 && !sqlCols.some((c) => /^idx_/.test(c)));

const notInSql = diffColumns(modelAttrs, sqlCols);
ok(`admin_audit_log_table.sql creates every column the model declares${notInSql.length ? ` — MISSING: ${notInSql.join(', ')}` : ''}`,
  notInSql.length === 0);

const declared = new Set(Object.entries(modelAttrs).map(([k, a]) => (a && a.field) || k));
const notInModel = sqlCols.filter((c) => !declared.has(c));
ok(`admin_audit_log_table.sql creates nothing the model does not declare${notInModel.length ? ` — EXTRA: ${notInModel.join(', ')}` : ''}`,
  notInModel.length === 0);

// timestamps:false on the model, so Sequelize will not name updatedAt in an
// INSERT. A column here would be permanently NULL and imply the table is
// mutable, which it is not — it is append-only by design.
ok('admin_audit_log has no updatedAt column', !sqlCols.includes('updatedAt'));

// Engine and collation are project-wide rules: InnoDB for row locks and
// transactions, utf8mb4_unicode_ci because utf8mb4_0900_ai_ci is MySQL-8-only
// and silently skips table creation on MariaDB and MySQL 5.7.
const auditSqlText = fs.readFileSync(path.join(SQL_DIR, 'admin_audit_log_table.sql'), 'utf8');
ok('admin_audit_log is InnoDB', /ENGINE=InnoDB/i.test(auditSqlText));
ok('admin_audit_log is utf8mb4_unicode_ci (not the MySQL-8-only 0900 collation)',
  /utf8mb4_unicode_ci/i.test(auditSqlText) && !/0900_ai_ci/i.test(auditSqlText));
ok('admin_audit_log creation is re-runnable', /CREATE TABLE IF NOT EXISTS/i.test(auditSqlText));

// The migration runner must actually list the file, or a fresh install
// creates every other table and silently skips this one.
const migrateText = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrate.js'), 'utf8',
);
ok('scripts/migrate.js lists admin_audit_log_table.sql in ORDER',
  /'admin_audit_log_table\.sql'/.test(migrateText));

// EXACTLY ONE file may define this table. Two CREATE TABLE IF NOT EXISTS for
// the same name is not a syntax error, not a runtime error, and produces no
// warning — the loser simply no-ops, so the live schema (here: which of two
// index-name sets exists) depends on which file migrate.js happens to reach
// first. That is worth failing a build over.
//
// Line-anchored rather than matched against the whole file, because both of
// these .sql files discuss `admin_audit_log` and CREATE TABLE at length in
// their comments. A real statement starts at the beginning of a line; a
// comment starts with `--`.
//
// readdir, NOT grep: *.sql is gitignored in this repo (the leaked legacy
// dumps) and ripgrep honours .gitignore, so a content search over backend/
// silently reports zero matches in this entire directory.
const definers = fs.readdirSync(SQL_DIR)
  .filter((f) => f.toLowerCase().endsWith('.sql'))
  .filter((f) => fs.readFileSync(path.join(SQL_DIR, f), 'utf8').split('\n')
    .some((l) => /^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?`?admin_audit_log`?/i.test(l)));

ok(`exactly one .sql file creates admin_audit_log — found: ${definers.join(', ') || 'NONE'}`,
  definers.length === 1 && definers[0] === 'admin_audit_log_table.sql');

// Same trap, stated as a rule the checker can enforce: the audit table must
// not be created by the file whose job is to fail loudly. security_hardening_
// prod.sql leads with ALTER TABLE transactions ADD UNIQUE (transref), which
// migrate.js treats as fatal on 1062 by design, and runFile() abandons the
// rest of a file at its first fatal statement — so anything additive placed
// after it is skipped on exactly the databases that need it most.
ok('security_hardening_prod.sql does not also create it (it aborts on 1062 by design)',
  !definers.includes('security_hardening_prod.sql'));

// ============================================================
//  CONTROL: break it and require the break to be CAUGHT.
// ============================================================
// These re-implement plausible WRONG versions of diffColumns and assert
// each one produces a different answer from the real one. If a mutant
// agrees with the real implementation on every case, the test above it
// was not actually discriminating and is worthless.
const mutants = [
  {
    name: 'compares by attribute KEY instead of .field (false drift on renames)',
    impl: (attrs, live) => Object.keys(attrs).filter((k) => !new Set(live).has(k)),
    // Must disagree on the renamed-column case.
    probe: [{ createdAt: { field: 'date_created' } }, ['date_created']],
  },
  {
    name: 'drops attributes with no .field (under-reports)',
    impl: (attrs, live) => Object.values(attrs)
      .map((a) => a && a.field).filter(Boolean)
      .filter((c) => !new Set(live).has(c)),
    probe: [{ sKycType: {} }, ['sId']],
  },
  {
    name: 'reports extra live columns as drift (cries wolf)',
    impl: (attrs, live) => {
      const declared = new Set(Object.entries(attrs).map(([k, a]) => (a && a.field) || k));
      return [...live].filter((c) => !declared.has(c));
    },
    probe: [{ a: { field: 'a' } }, ['a', 'legacy1']],
  },
  {
    name: 'always returns empty (a guard that guards nothing)',
    impl: () => [],
    probe: [subAttrs, ['sId', 'sKYC']],
  },
];

const survivors = [];
for (const m of mutants) {
  const real = diffColumns(...m.probe).join();
  const broken = m.impl(...m.probe).join();
  if (real === broken) survivors.push(m.name);
}

console.log(`\n  passed: ${pass}   failed: ${fail.length}`);
if (fail.length) fail.forEach((f) => console.log(`   FAIL  ${f}`));
if (survivors.length) survivors.forEach((s) => console.log(`   CONTROL SURVIVED  ${s}`));
const bad = fail.length + survivors.length;
console.log(bad ? '\n  RESULT: FAIL\n' : '\n  RESULT: PASS (controls all caught)\n');
process.exit(bad ? 1 : 0);
