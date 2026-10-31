// ============================================================
//  scripts/verify_db_errors.js — assertions for dbErrorDetail()
// ------------------------------------------------------------
//  Run: node scripts/verify_db_errors.js     (exit 0 = all pass)
//
//  WHY THIS FILE EXISTS
//  A live createAccount failure was reported as, in full:
//
//    {"message":"createAccount exception","error":"Validation error",
//     "user":82,"gateway":"monnify"}
//
//  Three words naming no index, no column and no value, for what was
//  actually a duplicate-key violation MySQL had described precisely.
//  The cause is in the driver, not in our code:
//  sequelize/lib/dialects/mysql/query.js formatError() sets
//  `let message = "Validation error"` for ER_DUP_ENTRY and only
//  replaces it when the MODEL declares a msg on the unique key. The
//  real text survives on err.parent.sqlMessage, which nothing read.
//
//  So these assertions build the error the way the driver builds it —
//  literal 'Validation error' on top, detail underneath — rather than
//  the way it is tempting to build it in a test. A UniqueConstraintError
//  constructed WITHOUT that message argument carries the parent's text
//  and would make this whole file pass against a helper that does
//  nothing at all.
//
//  No database, no network: these are pure string assertions.
// ============================================================

import pkg from 'sequelize';
import { dbErrorDetail } from '../utils/dbErrors.js';

const { UniqueConstraintError, ValidationError, ValidationErrorItem } = pkg;

let pass = 0;
const failures = [];

function check(label, got, want) {
  const ok = typeof want === 'function' ? want(got) : got === want;
  if (ok) pass += 1;
  else failures.push(`${label}\n    got: ${JSON.stringify(got)}`);
}

/** An ER_DUP_ENTRY exactly as dialects/mysql/query.js formatError emits it. */
function mysqlDuplicate(indexName, dupValue, fields) {
  const text = `Duplicate entry '${dupValue}' for key '${indexName}'`;
  const parent = new Error(text);
  parent.errno = 1062;
  parent.code = 'ER_DUP_ENTRY';
  parent.sqlMessage = text;
  return new UniqueConstraintError({
    message: 'Validation error', // the literal the driver hardcodes
    errors: [],
    parent,
    fields,
  });
}

// ---- The reported incident -------------------------------------------------
const dup = mysqlDuplicate('uniq_va_ref', 'monnify-08099999999-ab12cd34', {
  gateway: 'monnify',
  accountReference: '08099999999-ab12cd34',
});

// Guard the premise itself. If Sequelize ever stops hardcoding this string,
// this assertion fails and tells the next reader the reasoning has expired —
// far better than silently testing a scenario that no longer occurs.
check('driver still reports the bare default', dup.message, 'Validation error');
check('UniqueConstraintError is a ValidationError', dup instanceof ValidationError, true);

check('detail names the index', dbErrorDetail(dup), (s) => s.includes('uniq_va_ref'));
check('detail says what kind of failure', dbErrorDetail(dup), (s) => s.includes('unique constraint violated'));
check('detail carries the duplicated value', dbErrorDetail(dup), (s) => s.includes('monnify-08099999999'));
check('detail is never the bare default', dbErrorDetail(dup), (s) => s !== 'Validation error');

// The other unique key on this table — the one that stays unique.
const dupNum = mysqlDuplicate('uniq_va_number', 'monnify-2127218790', {
  gateway: 'monnify',
  accountNumber: '2127218790',
});
check('account-number clash names its own index', dbErrorDetail(dupNum), (s) => s.includes('uniq_va_number'));

// A duplicate with no sqlMessage (driver variation) still names the columns,
// because the index name alone is what makes the entry actionable.
const dupNoSql = new UniqueConstraintError({
  message: 'Validation error',
  errors: [],
  parent: Object.assign(new Error('dup'), { errno: 1062 }),
  fields: { gateway: 'monnify', accountNumber: '2127218790' },
});
check('falls back to field names', dbErrorDetail(dupNoSql), (s) => s.includes('gateway') && s.includes('accountNumber'));

// ---- 1265: the ENUM trap ---------------------------------------------------
// Same class of silent failure as the providers.category incident: a value the
// live column will not accept, where CREATE TABLE IF NOT EXISTS never widened it.
const truncParent = Object.assign(new Error('trunc'), {
  errno: 1265,
  sqlMessage: "Data truncated for column 'category' at row 1",
});
const trunc = Object.assign(new Error('Validation error'), { parent: truncParent });
check('1265 points at the column definition', dbErrorDetail(trunc), (s) => s.includes('ENUM'));
check('1265 names the column', dbErrorDetail(trunc), (s) => s.includes('category'));

// ---- A genuine field validation --------------------------------------------
// No driver error underneath, so there is nothing better to say: keep the
// message rather than dressing it up as something it is not.
const plain = new ValidationError('Validation error', [
  new ValidationErrorItem('accountNumber cannot be null', 'notNull violation', 'accountNumber'),
]);
check('plain validation error is passed through', dbErrorDetail(plain), 'Validation error');

// ---- Robustness ------------------------------------------------------------
// A helper that throws while describing a failure destroys the log line it was
// called to write, turning a legible bug into a silent one.
check('null', dbErrorDetail(null), 'unknown error');
check('undefined', dbErrorDetail(undefined), 'unknown error');
check('empty object', dbErrorDetail({}), 'unknown error');
check('ordinary error keeps its message', dbErrorDetail(new Error('boom')), 'boom');
check('always returns a string', typeof dbErrorDetail(dup), 'string');

// An unrelated driver error keeps its own text plus the driver detail.
const other = Object.assign(new Error('Query failed'), {
  parent: Object.assign(new Error('x'), { errno: 1146, sqlMessage: "Table 'db.foo' doesn't exist" }),
});
check('other driver errors append sqlMessage', dbErrorDetail(other), (s) => s.includes("Table 'db.foo'"));

// ---- Report ----------------------------------------------------------------
// console is correct here: this is an operator-run CLI, not the server.
if (failures.length) {
  console.error(`\n${failures.length} FAILED:\n`);
  failures.forEach((f) => console.error(`  ${f}\n`));
  console.error(`${pass} passed, ${failures.length} failed`);
  process.exit(1);
}
console.log(`${pass} assertions passed.`);
process.exit(0);
