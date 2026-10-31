// ============================================================
//  verify_webhook_credit.js — prove the funding webhook credits
// ------------------------------------------------------------
//  WHY THIS SCRIPT EXISTS
//
//  On 2026-08-18 the funding webhook was found to be crediting
//  nothing at all. paymentController.js built its ledger meta as
//  `{ gateway, ... }` while `gateway` was declared only in two OTHER
//  functions in the same file. ESM strict mode makes an unbound
//  identifier a ReferenceError, the argument object is constructed
//  before the callee runs, so creditWallet was never reached — and
//  the surrounding try/catch turned it into a log line and a 500.
//  Every bank transfer settled in the merchant account with no wallet
//  credit and no transactions row.
//
//  `node --check` cannot see this: the file parses perfectly. Only
//  EXECUTION reaches it. So this script executes the real handler
//  from the real file, against stubbed persistence.
//
//  WHAT IS REAL AND WHAT IS STUBBED
//
//  Real: paymentController.webhookHandler, its verifyWebhookSignature()
//  helper (defined in that same file — there is no utils/webhookSignature.js;
//  an earlier version of this header claimed there was), utils/crypto.js, and
//  the argument construction that was the actual bug.
//
//  Stubbed: the model statics and sequelize.transaction. Stubbing is
//  done by ASSIGNING ONTO the imported model objects — ESM bindings
//  are read-only but the objects they point at are not, and the
//  controller holds the same object reference. No database is needed
//  and none is contacted.
//
//  NOT covered: the UNIQUE(transref) index. A unique constraint is a
//  property of the live schema; this harness fakes the duplicate error
//  to prove the HANDLING is right, which is a different claim from
//  "the index exists". Run scripts/migrate.js for that, and see
//  section E for the check that tells them apart.
//
//  Usage: node scripts/verify_webhook_credit.js
//  Exit code 0 = all assertions passed.
//
//  IF IT PRINTS NOTHING AND EXITS 1, READ THIS BEFORE DEBUGGING THE TEST.
//  utils/crypto.js does `import bcrypt from 'bcrypt'`, and where the native
//  binding cannot load (wrong ELF arch — any container that did not build it
//  itself) that throws during module load. utils/logger.js installs an
//  uncaughtException handler that logs to the FILE log and exits 1, so the
//  crash leaves ZERO bytes on stdout and stderr and looks like the script did
//  nothing. Two consequences worth knowing:
//    - The real cause is the newest line in backend/logs/error-<today>.log.
//    - `node -r shim.cjs` will NOT fix it. Module._resolveFilename is not
//      consulted for a bare specifier in an `import` statement, so a CJS
//      resolver shim is silently bypassed. Use an ESM resolve hook registered
//      with node:module's register(), i.e. `node --import ./hook.mjs`.
//  Keep any such shim OUTSIDE this repo. Never let a fake bcrypt near a
//  password path that could be mistaken for the real one.
// ============================================================

import crypto from 'crypto';
import { Provider, Subscriber, Transaction, VirtualAccount, WalletLedger } from '../models/index.js';
import sequelize from '../config/database.js';
import { encryptSecret } from '../utils/crypto.js';
import { webhookHandler } from '../controllers/paymentController.js';

const SIGNING_SECRET = 'test-signing-secret-not-a-real-one';
const USER_ID = 4242;

let pass = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// ------------------------------------------------------------
//  Fakes
// ------------------------------------------------------------

/** Minimal Express res that records what the handler answered. */
function makeRes() {
  const res = { statusCode: 200, body: null, locals: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

/** A signed Monnify-shaped delivery. */
function makeReq({ amountPaid = 1000, paymentReference = 'MNFY-REF-0001', accountReference = 'ACCTREF001', paymentStatus = 'PAID' } = {}) {
  const body = {
    eventType: 'SUCCESSFUL_TRANSACTION',
    eventData: {
      accountReference, amountPaid, paymentReference, paymentStatus,
      paymentMethod: 'ACCOUNT_TRANSFER',
    },
  };
  const rawBody = JSON.stringify(body);
  // Monnify signs the raw bytes with HMAC-SHA512, hex encoded.
  const signature = crypto.createHmac('sha512', SIGNING_SECRET).update(rawBody).digest('hex');
  return {
    body,
    rawBody,
    headers: { 'monnify-signature': signature },
    ip: '203.0.113.9',
    get: () => '',
  };
}

/**
 * Install stubs. `state` collects everything the handler tried to
 * persist so the assertions can inspect it.
 */
function installStubs({ chargeConfig = '{}', existingRefs = new Set(), duplicateOnInsert = false } = {}) {
  const state = {
    txnRows: [], ledgerRows: [], savedBalance: null, committed: false, rolledBack: false,
  };

  Provider.findOne = async () => ({
    name: 'monnify',
    category: 'payment',
    status: 'active',
    secretKey: encryptSecret(SIGNING_SECRET),
    extraConfig: chargeConfig,
  });

  VirtualAccount.findOne = async () => ({ sId: USER_ID, gateway: 'monnify' });

  Transaction.findOne = async ({ where }) => (existingRefs.has(where.transref) ? { transref: where.transref } : null);

  // The row object the controller mutates and re-saves once the
  // balances are known.
  Transaction.create = async (values) => {
    if (duplicateOnInsert) {
      const err = new Error('Validation error');
      err.name = 'SequelizeUniqueConstraintError';
      err.parent = { errno: 1062 };
      throw err;
    }
    const row = { ...values, save: async () => { state.txnRows.push({ ...row }); } };
    state.txnRows.push({ ...values, _phase: 'insert' });
    return row;
  };

  const subscriber = {
    sId: USER_ID,
    sWallet: 500,
    save: async () => { state.savedBalance = subscriber.sWallet; },
  };
  Subscriber.findByPk = async () => subscriber;
  Subscriber.findOne = async () => null;

  WalletLedger.create = async (values) => { state.ledgerRows.push(values); return values; };

  // Real transaction semantics, minus a database: run the callback,
  // commit on resolve, mark rolled back on throw and re-throw so the
  // caller's duplicate handling is exercised for real.
  sequelize.transaction = async (fn) => {
    try {
      const out = await fn({ LOCK: { UPDATE: 'UPDATE' } });
      state.committed = true;
      return out;
    } catch (err) {
      state.rolledBack = true;
      throw err;
    }
  };

  return { state, subscriber };
}

// ------------------------------------------------------------
//  A. The bug itself: a valid paid delivery must credit the wallet
// ------------------------------------------------------------
console.log('\nA. Valid paid delivery credits the wallet');
{
  const { state, subscriber } = installStubs();
  const res = makeRes();
  await webhookHandler(makeReq({ amountPaid: 1000 }), res);

  check('responded 200', res.statusCode === 200, `got ${res.statusCode} ${JSON.stringify(res.body)}`);
  check('response reports the payment processed', res.body?.status === 'success');
  // THE REGRESSION TEST. Before the fix this was null: the
  // ReferenceError fired while building the ledger meta, so no balance
  // was ever written.
  check('balance was actually saved', state.savedBalance === 1500, `savedBalance=${state.savedBalance}`);
  check('in-memory wallet is 500 + 1000', subscriber.sWallet === 1500, `sWallet=${subscriber.sWallet}`);
  check('one ledger row written', state.ledgerRows.length === 1, `${state.ledgerRows.length} rows`);
  check('ledger direction is credit', state.ledgerRows[0]?.direction === 'credit');
  check('ledger reason is funding', state.ledgerRows[0]?.reason === 'funding');
  check('ledger reference is the payment reference', state.ledgerRows[0]?.reference === 'MNFY-REF-0001');

  // The field that used to throw. Its VALUE matters too: an empty or
  // undefined gateway in the ledger meta would satisfy "no crash" while
  // still failing the question the meta exists to answer.
  let meta = null;
  try { meta = JSON.parse(state.ledgerRows[0]?.meta || 'null'); } catch { /* leave null */ }
  check('ledger meta parses', meta !== null);
  check('ledger meta.gateway is the resolved provider name', meta?.gateway === 'monnify', `gateway=${JSON.stringify(meta?.gateway)}`);
  check('ledger meta records amountPaid', meta?.amountPaid === 1000);
  check('transaction row was written', state.txnRows.length >= 1);
  check('transaction row carries the reference', state.txnRows[0]?.transref === 'MNFY-REF-0001');
  check('transaction row is status 0 (successful)', state.txnRows[0]?.status === 0);
  check('transaction committed', state.committed === true);
}

// ------------------------------------------------------------
//  B. Ordering: the reference is claimed BEFORE money moves
// ------------------------------------------------------------
//  This is what makes the unique index able to protect the credit. If
//  the INSERT happened after the balance write, a collision would
//  arrive too late to prevent anything.
console.log('\nB. The transaction row is inserted before the balance is written');
{
  const order = [];
  const { state } = installStubs();
  const realCreate = Transaction.create;
  Transaction.create = async (v) => { order.push('insert'); return realCreate(v); };
  const realFindByPk = Subscriber.findByPk;
  Subscriber.findByPk = async (...a) => {
    const u = await realFindByPk(...a);
    const realSave = u.save;
    u.save = async () => { order.push('balance'); return realSave(); };
    return u;
  };

  const res = makeRes();
  await webhookHandler(makeReq({ paymentReference: 'MNFY-REF-ORDER' }), res);
  check('handler succeeded', res.statusCode === 200, JSON.stringify(res.body));
  check('insert precedes balance write', order.indexOf('insert') !== -1 && order.indexOf('insert') < order.indexOf('balance'), order.join(' -> '));
  check('committed', state.committed === true);
}

// ------------------------------------------------------------
//  C. Duplicate handling
// ------------------------------------------------------------
console.log('\nC. Duplicates do not double-credit');
{
  // C1: the cheap pre-check (gateway retrying a delivery we finished).
  const { state } = installStubs({ existingRefs: new Set(['MNFY-REF-0001']) });
  const res = makeRes();
  await webhookHandler(makeReq({ paymentReference: 'MNFY-REF-0001' }), res);
  check('C1 known reference answers 200 (stops the retry loop)', res.statusCode === 200);
  check('C1 no balance written', state.savedBalance === null, `savedBalance=${state.savedBalance}`);
  check('C1 no ledger row', state.ledgerRows.length === 0);
}
{
  // C2: the real guarantee — a CONCURRENT duplicate that got past the
  // pre-check and collided on the unique index inside the transaction.
  const { state, subscriber } = installStubs({ duplicateOnInsert: true });
  const res = makeRes();
  await webhookHandler(makeReq({ paymentReference: 'MNFY-REF-RACE' }), res);
  check('C2 answers 200, not 500', res.statusCode === 200, `got ${res.statusCode} ${JSON.stringify(res.body)}`);
  check('C2 reported as already processed', /already processed/i.test(res.body?.msg || ''), res.body?.msg);
  check('C2 no balance written', state.savedBalance === null, `savedBalance=${state.savedBalance}`);
  check('C2 wallet untouched', subscriber.sWallet === 500, `sWallet=${subscriber.sWallet}`);
  check('C2 transaction rolled back', state.rolledBack === true);
}

// ------------------------------------------------------------
//  D. Charges, and the misconfiguration that used to retry forever
// ------------------------------------------------------------
console.log('\nD. Funding charge is applied to the credited amount');
{
  const { state } = installStubs({ chargeConfig: JSON.stringify({ charges: 1.5 }) });
  const res = makeRes();
  await webhookHandler(makeReq({ amountPaid: 1000, paymentReference: 'MNFY-REF-CHG' }), res);
  check('1.5% of N1000 credits N985', state.savedBalance === 500 + 985, `savedBalance=${state.savedBalance}`);
  let meta = null;
  try { meta = JSON.parse(state.ledgerRows[0]?.meta || 'null'); } catch { /* null */ }
  check('charge recorded in ledger meta', meta?.chargeAmount === 15, `chargeAmount=${meta?.chargeAmount}`);
}
{
  // A flat charge >= the deposit. Previously this credited 0, was
  // rejected as bad_amount, answered 500, and the gateway retried the
  // same delivery forever.
  const { state } = installStubs({ chargeConfig: JSON.stringify({ charges: 2000 }) });
  const res = makeRes();
  await webhookHandler(makeReq({ amountPaid: 1000, paymentReference: 'MNFY-REF-OVERCHG' }), res);
  check('charge >= deposit answers 200, not 500', res.statusCode === 200, `got ${res.statusCode}`);
  check('nothing credited', state.savedBalance === null);
}

// ------------------------------------------------------------
//  E. Guards that must still reject
// ------------------------------------------------------------
console.log('\nE. Rejections');
{
  const { state } = installStubs();
  const req = makeReq({ paymentReference: 'MNFY-REF-BADSIG' });
  req.headers['monnify-signature'] = 'deadbeef';
  const res = makeRes();
  await webhookHandler(req, res);
  check('bad signature rejected 403', res.statusCode === 403, `got ${res.statusCode}`);
  check('bad signature credits nothing', state.savedBalance === null);
}
{
  // THE REAL DIVERGENCE ATTACK, and why the re-serialization fallback had
  // to go. `req.rawBody` is set only by express.json()'s verify hook, so a
  // delivery sent as application/x-www-form-urlencoded populates req.body
  // with rawBody left undefined. The handler used to fall back to
  // JSON.stringify(req.body) — verifying a signature against bytes it
  // invented rather than bytes it received. Now: no raw body, no credit.
  const { state } = installStubs();
  const req = makeReq({ amountPaid: 999999, paymentReference: 'MNFY-REF-NORAW' });
  delete req.rawBody;
  req.headers['content-type'] = 'application/x-www-form-urlencoded';
  const res = makeRes();
  await webhookHandler(req, res);
  check('delivery with no captured raw body is rejected', res.statusCode === 400, `got ${res.statusCode} ${JSON.stringify(res.body)}`);
  check('no raw body credits nothing', state.savedBalance === null, `savedBalance=${state.savedBalance}`);
}
{
  // Belt and braces on the same rule: even a signature that would verify
  // against the re-serialized form must not be accepted without rawBody.
  const { state } = installStubs();
  const req = makeReq({ amountPaid: 1000, paymentReference: 'MNFY-REF-RESER' });
  delete req.rawBody;
  req.headers['monnify-signature'] = crypto.createHmac('sha512', SIGNING_SECRET)
    .update(JSON.stringify(req.body)).digest('hex');
  const res = makeRes();
  await webhookHandler(req, res);
  check('a signature over the re-serialized body is not accepted', res.statusCode !== 200, `got ${res.statusCode}`);
  check('re-serialized signature credits nothing', state.savedBalance === null, `savedBalance=${state.savedBalance}`);
}
{
  // The signature must cover the AMOUNT. Sign 1000, deliver 999999 in the
  // raw bytes, and the recomputed HMAC no longer matches.
  const { state } = installStubs();
  const req = makeReq({ amountPaid: 1000, paymentReference: 'MNFY-REF-TAMPER' });
  req.body.eventData.amountPaid = 999999;
  req.rawBody = JSON.stringify(req.body); // real bytes now say 999999
  const res = makeRes();
  await webhookHandler(req, res);
  check('tampered amount rejected 403', res.statusCode === 403, `got ${res.statusCode}`);
  check('tampered amount credits nothing', state.savedBalance === null, `savedBalance=${state.savedBalance}`);
}
{
  const { state } = installStubs();
  const res = makeRes();
  await webhookHandler(makeReq({ paymentStatus: 'PENDING', paymentReference: 'MNFY-REF-PENDING' }), res);
  check('unpaid status credits nothing', state.savedBalance === null);
  check('unpaid status still acknowledged 200', res.statusCode === 200);
}
{
  // No reference = no idempotency key. Must refuse rather than credit
  // something a retry would credit again.
  const { state } = installStubs();
  const req = makeReq({ amountPaid: 1000 });
  delete req.body.eventData.paymentReference;
  req.rawBody = JSON.stringify(req.body);
  req.headers['monnify-signature'] = crypto.createHmac('sha512', SIGNING_SECRET).update(req.rawBody).digest('hex');
  const res = makeRes();
  await webhookHandler(req, res);
  check('missing reference rejected 400', res.statusCode === 400, `got ${res.statusCode}`);
  check('missing reference credits nothing', state.savedBalance === null);
}
{
  // A blank-but-truthy account reference must not match the column
  // default on every user who never generated an account.
  const { state } = installStubs();
  VirtualAccount.findOne = async () => null;
  Subscriber.findOne = async () => { throw new Error('legacy fallback must not run for a blank reference'); };
  const req = makeReq({ accountReference: '   ', paymentReference: 'MNFY-REF-BLANK' });
  req.rawBody = JSON.stringify(req.body);
  req.headers['monnify-signature'] = crypto.createHmac('sha512', SIGNING_SECRET).update(req.rawBody).digest('hex');
  const res = makeRes();
  await webhookHandler(req, res);
  check('blank account reference rejected 400', res.statusCode === 400, `got ${res.statusCode}`);
  check('blank account reference credits nothing', state.savedBalance === null);
}
{
  // ADDED 2026-08-19 — THE ORIGINAL C1 BYPASS, IN ITS EXACT SHAPE, which
  // this suite did not cover: send NO signature header at all.
  //
  // providerName still resolves to 'monnify' off req.body.eventType
  // (paymentController.js:389), so an unsigned delivery walks the same code
  // path a signed one does. The old gate read
  //   if (providerName === 'monnify' && signature && secret) { ...verify... }
  // and `&& signature` short-circuited to false, so verification was SKIPPED
  // — not failed, skipped — and the wallet was credited anyway.
  //
  // WHY 'bad signature rejected 403' ABOVE DOES NOT COVER THIS: 'deadbeef'
  // reaches the HMAC compare and loses there. A missing header never reaches
  // a compare, so the only thing that can stop it is the GUARD at :410 — and
  // if that guard is ever deleted, no failing compare is left behind to
  // notice. An untested guard is a comment.
  const { state } = installStubs();
  const req = makeReq({ amountPaid: 750000, paymentReference: 'MNFY-REF-NOSIG' });
  delete req.headers['monnify-signature'];
  const res = makeRes();
  await webhookHandler(req, res);
  check('unsigned delivery rejected 403 (audit C1)', res.statusCode === 403, `got ${res.statusCode} ${JSON.stringify(res.body)}`);
  check('unsigned delivery credits nothing', state.savedBalance === null, `savedBalance=${state.savedBalance}`);
  check('unsigned delivery writes no ledger row', state.ledgerRows.length === 0, `${state.ledgerRows.length} rows`);
}
{
  // The other half of the same short-circuit: `&& secret`. A provider row
  // with no secretKey used to mean "skip verification", which turns
  // forgetting to paste a key in the admin panel into an open funding
  // endpoint. It has to mean the opposite: cannot verify, therefore refuse.
  // Note this must be asserted separately — a deployment can have the
  // signature guard intact and still be wide open on a provider whose key
  // was never configured.
  const { state } = installStubs();
  Provider.findOne = async () => ({
    name: 'monnify', category: 'payment', status: 'active',
    secretKey: null, extraConfig: '{}',
  });
  const res = makeRes();
  await webhookHandler(makeReq({ amountPaid: 750000, paymentReference: 'MNFY-REF-NOSECRET' }), res);
  check('provider with no signing secret rejected 403', res.statusCode === 403, `got ${res.statusCode}`);
  check('no signing secret credits nothing', state.savedBalance === null, `savedBalance=${state.savedBalance}`);
}

// ------------------------------------------------------------
console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${pass} assertions passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
process.exit(0);
