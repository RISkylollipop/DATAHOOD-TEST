// ============================================================
//  Wallet Operations — ATOMIC, race-safe money movement
// ------------------------------------------------------------
//  SECURITY (fixes SECURITY-AUDIT C2 "double-spend / race"):
//
//  Every balance change here runs inside a DB transaction and
//  takes a ROW LOCK (SELECT ... FOR UPDATE) on the subscriber
//  row before reading + writing the balance. Concurrent requests
//  for the SAME user are therefore serialized by the database —
//  two simultaneous purchases can no longer both pass a balance
//  check before either save commits, and two webhooks can no
//  longer double-credit the same wallet.
//
//  RULES for callers:
//   - NEVER mutate user.sWallet / user.sRefWallet and call
//     user.save() directly anymore. Always go through these
//     helpers. A stray full user.save() would clobber a
//     concurrent atomic update with a stale in-memory value.
//   - After calling a helper, sync the in-memory object from the
//     returned balances if you still need it (helpers do this for
//     the row they locked, but req.user is a different instance).
//
//  All amounts are coerced with Number(); callers should already
//  have validated them.
// ============================================================

import sequelize from '../config/database.js';
import { Op } from 'sequelize';
import { Subscriber, Transaction, WalletLedger } from '../models/index.js';
import { escapeLike } from './refGuard.js';
import { isPurchaseService } from './serviceNames.js';

/**
 * Append one ledger row describing a balance change.
 *
 * MUST be called with the same transaction `t` that performed the change,
 * so the row and the balance commit or roll back together. A ledger entry
 * written on another connection can outlive a rolled-back balance change
 * and then "prove" money moved when it did not.
 *
 * Not exported: the only legitimate writer is this module.
 */
async function appendLedger(t, {
  sId, wallet = 'main', direction, amount, balanceBefore, balanceAfter, reason, reference = null, meta = null,
}) {
  await WalletLedger.create({
    sId,
    wallet,
    direction,
    amount: Number(amount).toFixed(2),
    balanceBefore: Number(balanceBefore).toFixed(2),
    balanceAfter: Number(balanceAfter).toFixed(2),
    reason,
    reference: reference ? String(reference).slice(0, 200) : null,
    // Stringified here so callers pass plain objects and can't accidentally
    // hand Sequelize something unserialisable.
    meta: meta ? JSON.stringify(meta) : null,
  }, { transaction: t });
}

/**
 * Atomically debit the main wallet. Fails (ok:false) if the row is
 * missing or the balance is insufficient — the balance check and the
 * write happen under the same row lock, so it is race-safe.
 *
 * `reason`/`reference`/`meta` land in wallet_ledger. Reason defaults to
 * 'purchase' because that is what the overwhelming majority of debits
 * are; pass it explicitly for anything else.
 *
 * @returns {Promise<{ok:boolean, reason?:string, oldBalance?:number, newBalance?:number}>}
 */
export async function debitWallet(userId, amount, { reason = 'purchase', reference = null, meta = null } = {}) {
  const amt = Number(amount);
  if (!(amt > 0)) return { ok: false, reason: 'bad_amount' };
  return sequelize.transaction(async (t) => {
    const user = await Subscriber.findByPk(userId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!user) return { ok: false, reason: 'not_found' };
    const oldBalance = Number(user.sWallet || 0);
    if (oldBalance < amt) return { ok: false, reason: 'insufficient', oldBalance };
    const newBalance = oldBalance - amt;
    user.sWallet = newBalance;
    await user.save({ transaction: t });
    await appendLedger(t, {
      sId: userId, direction: 'debit', amount: amt,
      balanceBefore: oldBalance, balanceAfter: newBalance, reason, reference, meta,
    });
    return { ok: true, oldBalance, newBalance };
  });
}

/**
 * Atomically credit the main wallet (funding, or refund on failure).
 * @returns {Promise<{ok:boolean, reason?:string, oldBalance?:number, newBalance?:number}>}
 */
export async function creditWallet(userId, amount, { reason = 'funding', reference = null, meta = null } = {}) {
  const amt = Number(amount);
  if (!(amt > 0)) return { ok: false, reason: 'bad_amount' };
  return sequelize.transaction(async (t) => {
    const user = await Subscriber.findByPk(userId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!user) return { ok: false, reason: 'not_found' };
    const oldBalance = Number(user.sWallet || 0);
    const newBalance = oldBalance + amt;
    user.sWallet = newBalance;
    await user.save({ transaction: t });
    await appendLedger(t, {
      sId: userId, direction: 'credit', amount: amt,
      balanceBefore: oldBalance, balanceAfter: newBalance, reason, reference, meta,
    });
    return { ok: true, oldBalance, newBalance };
  });
}

/**
 * Refund a previously debited amount. Delegates to creditWallet but
 * defaults the ledger reason to 'refund', so a reversal is
 * distinguishable from a genuine top-up during reconciliation. Pass the
 * original transref as `reference` to pair the two rows.
 */
export async function refundWallet(userId, amount, { reason = 'refund', reference = null, meta = null } = {}) {
  return creditWallet(userId, amount, { reason, reference, meta });
}

/** MySQL duplicate-key, however Sequelize happens to have wrapped it. */
function isDuplicateKey(err) {
  return err?.name === 'SequelizeUniqueConstraintError'
    || err?.parent?.errno === 1062
    || err?.original?.errno === 1062;
}

/**
 * Credit a wallet AND write its transaction row in ONE transaction,
 * with the UNIQUE index on transactions.transref as the mutex.
 *
 * WHY THIS EXISTS SEPARATELY FROM creditWallet
 *
 * The webhook path used to read:
 *
 *   if (await Transaction.findOne({ where: { transref: ref } })) return;
 *   await creditWallet(...);            // transaction #1
 *   await Transaction.create({ ... });  // transaction #2
 *
 * Three independent problems in five lines:
 *
 *  1. RACE. The findOne/create pair is check-then-act with no lock
 *     between the halves. Two concurrent deliveries of the same
 *     payment both pass the SELECT and both credit. Payment gateways
 *     retry aggressively on any non-2xx — and this endpoint was
 *     answering 500 on every single call because of the ReferenceError
 *     below, so retries were the normal case, not the rare one.
 *  2. TORN WRITE. If the process dies between the two awaits, the
 *     money is in the wallet with no transaction row: the customer
 *     sees a balance they cannot explain and support has nothing to
 *     reconcile against. Worse, the duplicate guard keys on that
 *     missing row, so the NEXT retry credits again.
 *  3. The ordering is backwards. The row that proves the payment was
 *     handled is written last, so it can never protect the credit.
 *
 * Here the INSERT goes FIRST, inside the same transaction as the
 * balance change. A duplicate reference therefore collides on the
 * unique index before any money moves, and the rollback takes the
 * credit with it. The database is doing the mutual exclusion, which is
 * the only layer that can.
 *
 * REQUIRES sql/security_hardening_prod.sql to have been applied. If
 * the index is missing this still fixes (2) and (3) but degrades to
 * the old racy behaviour for (1) — it cannot detect a collision the
 * database is not enforcing. The boot-time schema report names it.
 *
 * @param {object} p
 * @param {number} p.userId
 * @param {number} p.amount        amount to CREDIT (net of any charge)
 * @param {string} p.reference     transref; the idempotency key
 * @param {object} p.txn           extra transactions columns
 * @param {string} [p.reason]      wallet_ledger reason
 * @param {object} [p.meta]        wallet_ledger meta
 * @returns {Promise<{ok:boolean, reason?:string, oldBalance?:number, newBalance?:number}>}
 *   reason 'duplicate' means the reference was already recorded — the
 *   caller should answer 200 to stop the gateway retrying, NOT 500.
 */
export async function fundWalletOnce({
  userId, amount, reference, txn = {}, reason = 'funding', meta = null,
}) {
  const amt = Number(amount);
  if (!(amt > 0)) return { ok: false, reason: 'bad_amount' };
  if (!reference) return { ok: false, reason: 'no_reference' };

  try {
    return await sequelize.transaction(async (t) => {
      // 1. Claim the reference. This INSERT is the lock: a second
      //    concurrent delivery blocks here on the unique index and
      //    then fails, rather than racing ahead to the balance.
      //    oldbal/newbal are filled in after the credit below.
      const row = await Transaction.create({
        sId: userId,
        transref: reference,
        status: 0,
        profit: 0,
        ...txn,
      }, { transaction: t });

      // 2. Move the money under a row lock on the subscriber.
      const user = await Subscriber.findByPk(userId, { lock: t.LOCK.UPDATE, transaction: t });
      if (!user) {
        // Throwing rather than returning: a return would COMMIT the
        // transaction row we just claimed, permanently blocking the
        // reference for a payment that was never credited.
        const e = new Error('subscriber_missing');
        e.walletReason = 'not_found';
        throw e;
      }
      const oldBalance = Number(user.sWallet || 0);
      const newBalance = oldBalance + amt;
      user.sWallet = newBalance;
      await user.save({ transaction: t });

      await appendLedger(t, {
        sId: userId, direction: 'credit', amount: amt,
        balanceBefore: oldBalance, balanceAfter: newBalance, reason, reference, meta,
      });

      // 3. Record the balances on the transaction row now that they
      //    are known. Same transaction, so the row never exists with
      //    blank balances.
      row.oldbal = String(oldBalance);
      row.newbal = String(newBalance);
      await row.save({ transaction: t });

      return { ok: true, oldBalance, newBalance };
    });
  } catch (err) {
    if (isDuplicateKey(err)) return { ok: false, reason: 'duplicate' };
    if (err?.walletReason) return { ok: false, reason: err.walletReason };
    throw err;
  }
}

/**
 * Atomically credit the referral (bonus) wallet.
 * @returns {Promise<{ok:boolean, reason?:string, oldRefWallet?:number, newRefWallet?:number}>}
 */
export async function creditRefWallet(userId, amount, { reason = 'referral_bonus', reference = null, meta = null } = {}) {
  const amt = Number(amount);
  if (!(amt > 0)) return { ok: false, reason: 'bad_amount' };
  return sequelize.transaction(async (t) => {
    const user = await Subscriber.findByPk(userId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!user) return { ok: false, reason: 'not_found' };
    const oldRefWallet = Number(user.sRefWallet || 0);
    const newRefWallet = oldRefWallet + amt;
    user.sRefWallet = newRefWallet;
    await user.save({ transaction: t });
    await appendLedger(t, {
      sId: userId, wallet: 'bonus', direction: 'credit', amount: amt,
      balanceBefore: oldRefWallet, balanceAfter: newRefWallet, reason, reference, meta,
    });
    return { ok: true, oldRefWallet, newRefWallet };
  });
}

/**
 * Atomically debit the referral (bonus) wallet. Fails (ok:false) if the
 * row is missing or the bonus balance is insufficient. Used by admin
 * "adjust bonus" actions in user management.
 * @returns {Promise<{ok:boolean, reason?:string, oldRefWallet?:number, newRefWallet?:number}>}
 */
export async function debitRefWallet(userId, amount, { reason = 'admin_debit', reference = null, meta = null } = {}) {
  const amt = Number(amount);
  if (!(amt > 0)) return { ok: false, reason: 'bad_amount' };
  return sequelize.transaction(async (t) => {
    const user = await Subscriber.findByPk(userId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!user) return { ok: false, reason: 'not_found' };
    const oldRefWallet = Number(user.sRefWallet || 0);
    if (oldRefWallet < amt) return { ok: false, reason: 'insufficient', oldRefWallet };
    const newRefWallet = oldRefWallet - amt;
    user.sRefWallet = newRefWallet;
    await user.save({ transaction: t });
    await appendLedger(t, {
      sId: userId, wallet: 'bonus', direction: 'debit', amount: amt,
      balanceBefore: oldRefWallet, balanceAfter: newRefWallet, reason, reference, meta,
    });
    return { ok: true, oldRefWallet, newRefWallet };
  });
}

/**
 * Atomically move the whole referral-bonus balance into the main
 * wallet (the "transfer bonus to main" action). Done under a single
 * row lock so the two fields can't drift under concurrency.
 * @returns {Promise<{ok:boolean, reason?:string, moved?:number, oldBalance?:number, newBalance?:number}>}
 */
export async function transferRefToMain(userId) {
  return sequelize.transaction(async (t) => {
    const user = await Subscriber.findByPk(userId, { lock: t.LOCK.UPDATE, transaction: t });
    if (!user) return { ok: false, reason: 'not_found' };
    const moved = Number(user.sRefWallet || 0);
    if (moved <= 0) return { ok: false, reason: 'empty' };
    const oldBalance = Number(user.sWallet || 0);
    const newBalance = oldBalance + moved;
    user.sWallet = newBalance;
    user.sRefWallet = 0;
    await user.save({ transaction: t });
    // Two wallets moved, so two rows — each wallet's chain has to stay
    // continuous on its own. Recorded as a debit out of bonus and a
    // credit into main so the pair nets to zero across the account.
    await appendLedger(t, {
      sId: userId, wallet: 'bonus', direction: 'debit', amount: moved,
      balanceBefore: moved, balanceAfter: 0, reason: 'bonus_transfer',
    });
    await appendLedger(t, {
      sId: userId, wallet: 'main', direction: 'credit', amount: moved,
      balanceBefore: oldBalance, balanceAfter: newBalance, reason: 'bonus_transfer',
    });
    return { ok: true, moved, oldBalance, newBalance };
  });
}

/**
 * ADMIN transaction status change — mirrors the legacy PHP
 * `updateTransactionStatus` (AdminModel.php) exactly, with two safety
 * additions the legacy lacked (idempotency + audit of who did it).
 *
 * The four admin actions (from the legacy transaction-details form):
 *   'success'        (legacy 0)  → mark the txn successful. No wallet change.
 *   'success_debit'  (legacy 10) → mark successful AND debit the user's main
 *                                  wallet by the txn amount; write a "Debit"
 *                                  audit transaction row.
 *   'failed'         (legacy 1)  → mark the txn failed. No wallet change.
 *   'failed_refund'  (legacy 11) → mark failed AND credit (refund) the user's
 *                                  main wallet by the txn amount; write a
 *                                  "Refund" audit transaction row.
 *
 * Node status-code conventions are honoured for the ORIGINAL row
 * (0 = successful, 2 = failed) while the audit rows are recorded as
 * status 0 (a completed money movement), exactly like the legacy.
 *
 * Legacy parity note: 'success_debit' is an admin override and is allowed
 * to push the balance negative (the legacy does `oldbal - amount` with no
 * floor). Idempotency: the wallet move is skipped if an audit row for the
 * same action+txn already exists, so a double-click can't double-refund or
 * double-debit — the status label still updates.
 *
 * All work (status update + balance change + audit insert) happens inside a
 * single DB transaction with a row lock on the affected subscriber.
 *
 * @param {object} p
 * @param {string} p.transref
 * @param {string} p.action
 * @param {object} [p.actor] {adminId, adminEmail} — recorded in the ledger
 *   meta. wallet_ledger says a balance moved; without this, nothing in the
 *   database says WHO moved it, and "a line in a rotating log file" is not
 *   an audit trail for an action that can mint money.
 * @returns {Promise<{ok:boolean, reason?:string, newStatus?:number,
 *   walletMove?:{oldBalance:number,newBalance:number,moved:number,kind:string}|{skipped:true,reason:string}|null}>}
 */
export async function adminChangeTxnStatus({ transref, action, actor = null }) {
  const VALID = ['success', 'success_debit', 'failed', 'failed_refund'];
  if (!VALID.includes(action)) return { ok: false, reason: 'bad_action' };

  return sequelize.transaction(async (t) => {
    // Lock the transaction row itself, not just the subscriber. Two admins
    // double-clicking (or one admin whose browser retried) otherwise both
    // read status 5, both find no audit row, and both move money — the
    // idempotency probe below is a check-then-act like any other, so it
    // needs the row held for the duration to mean anything.
    const txn = await Transaction.findOne({
      where: { transref },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!txn) return { ok: false, reason: 'not_found' };

    const amount = Number(txn.amount) || 0;
    // Node convention: successful actions → 0, failed actions → 2.
    const newStatus = (action === 'success' || action === 'success_debit') ? 0 : 2;

    let walletMove = null;
    const moves = action === 'success_debit' || action === 'failed_refund';

    // ---- DIRECTION GUARD ----
    // A money-moving action is only meaningful on a row that represents a
    // PURCHASE. Pointed at anything else it inverts:
    //
    //   'Wallet Funding' + failed_refund → credits the deposit a second
    //       time. A N50,000 bank transfer becomes N100,000 of balance,
    //       with a plausible-looking Refund row to explain it.
    //   'Refund'/'Debit' (rows this function wrote) + failed_refund →
    //       refunds a refund, and each pass writes a fresh audit row whose
    //       transref is a NEW reference, so the idempotency probe below
    //       never sees it. Repeatable.
    //   'Admin Credit' + failed_refund → doubles a manual adjustment.
    //
    // Blocked before the status change too, not just before the money:
    // silently relabelling a funding row as "failed" while declining the
    // refund would leave the admin screen lying about a settled deposit.
    if (moves && !isPurchaseService(txn.servicename)) {
      return { ok: false, reason: 'not_refundable', servicename: txn.servicename || null };
    }

    if (moves && amount > 0) {
      // NOTE: audit-ref delimiter is '-' (URL-safe), NOT '/'. These refs are
      // used as a URL path param (GET /transactions/:ref[/receipt]); a '/'
      // would split the path and 404 the detail + receipt lookups.
      const prefix = action === 'success_debit' ? 'DEBIT-' : 'REFUND-';
      // Idempotency: has this exact money movement already been recorded?
      //
      // escapeLike because `transref` is CLIENT-SUPPLIED on every purchase
      // (the frontend mints it in config.js makeRef so a retry reuses the
      // same value — correct, but attacker-chosen). A reference containing
      // '%' turns this probe into a wildcard that matches some OTHER audit
      // row, the function concludes "already recorded", and a refund the
      // customer is owed is silently skipped. utils/refGuard.js now rejects
      // such references at the door; this escape is the second line, for
      // the rows already in the table from before that guard existed.
      const already = await Transaction.findOne({
        where: { transref: { [Op.like]: `${prefix}${escapeLike(transref)}-%` } },
        transaction: t,
      });

      if (already) {
        walletMove = { skipped: true, reason: 'already_recorded' };
      } else {
        const user = await Subscriber.findByPk(txn.sId, { lock: t.LOCK.UPDATE, transaction: t });
        if (!user) return { ok: false, reason: 'user_not_found' };

        const oldBalance = Number(user.sWallet || 0);
        const newBalance = action === 'success_debit'
          ? oldBalance - amount   // admin override — legacy allows negative
          : oldBalance + amount;  // refund
        user.sWallet = newBalance;
        await user.save({ transaction: t });

        const kind = action === 'success_debit' ? 'debit' : 'refund';
        // This helper writes the balance inline rather than calling
        // debitWallet/creditWallet (it already holds the lock and must not
        // nest a second transaction), so the ledger row is written here too.
        // Same transaction, same lock — the invariant still holds.
        await appendLedger(t, {
          sId: txn.sId,
          direction: kind === 'debit' ? 'debit' : 'credit',
          amount,
          balanceBefore: oldBalance,
          balanceAfter: newBalance,
          reason: kind === 'debit' ? 'admin_txn_debit' : 'admin_txn_refund',
          reference: transref,
          // The actor belongs IN the ledger row, not only in the log file:
          // log files rotate and are deletable, wallet_ledger is the
          // financial record. adminEmail is included because sysId alone
          // stops being identifiable once an admin account is removed.
          meta: {
            action,
            servicename: txn.servicename || null,
            adminId: actor?.adminId ?? null,
            adminEmail: actor?.adminEmail ?? null,
          },
        });
        await Transaction.create({
          sId: txn.sId,
          transref: `${prefix}${transref}-${Date.now()}`,
          servicename: kind === 'debit' ? 'Debit' : 'Refund',
          servicedesc: kind === 'debit'
            ? `Debit of N${amount} for transaction reference ${transref}.`
            : `Refund of N${amount} for transaction reference ${transref}.`,
          amount: String(amount),
          // refund → status 1 ('refunded', brown/yellow badge); debit → 0.
          status: kind === 'refund' ? 1 : 0,
          oldbal: String(oldBalance),
          newbal: String(newBalance),
          date: new Date(),
        }, { transaction: t });

        // AUDIT RULE, applied to the ORIGINAL row: once a refund has actually
        // been paid, that transaction's net effect on the wallet is zero, so it
        // must stop reading as "debited and never returned". Without this the
        // row keeps showing oldbal != newbal forever and there is no way to
        // tell a resolved discrepancy from an outstanding one — which is the
        // whole point of the rule.
        //
        // Only on refund, and only in this branch: if the movement was skipped
        // as already-recorded, nothing was paid now and the row is left alone.
        // 'success_debit' is untouched on purpose — there the money legitimately
        // left the wallet and the difference is the true record.
        if (kind === 'refund') {
          txn.newbal = txn.oldbal;
        }

        walletMove = { oldBalance, newBalance, moved: amount, kind };
      }
    }

    txn.status = newStatus;
    await txn.save({ transaction: t });

    return { ok: true, newStatus, walletMove };
  });
}

/**
 * ADMIN manual reconcile of a STUCK ('processing', status 5) transaction:
 * settle it as success (0) or failed (2), optionally refunding the amount.
 *
 * WHY THIS MOVED OUT OF THE CONTROLLER
 *
 * The controller version read the row, checked `status !== 5`, called
 * creditWallet(), then saved the row — four statements on four
 * connections with nothing held between them:
 *
 *  1. DOUBLE REFUND. Two admins looking at the same stuck transaction
 *     (or one admin whose click was retried) both read status 5, both
 *     pass the check, and both refund. Nothing detects it afterwards
 *     either: the refund left no reference, so no query can pair the two
 *     credits with the debit they were reversing.
 *  2. WRONG LEDGER REASON. `creditWallet(user.sId, amount)` passed no
 *     options, so every manual refund was recorded with the default
 *     reason 'funding' and a null reference — indistinguishable in
 *     wallet_ledger from a customer depositing money. That breaks the
 *     refund-audit rule (a reversal must be pairable with its debit) and
 *     inflates funding inflow in the sales figures.
 *  3. TORN WRITE. The credit committed in its own transaction before
 *     `txn.save()`. A crash in between leaves the money refunded and the
 *     transaction still 'processing' — so the next reconcile refunds it
 *     again, legitimately, because the state says nothing happened.
 *
 * Here the transaction row is locked FOR UPDATE first, so the status
 * check and everything that follows are serialised by the database; a
 * concurrent second attempt waits, then reads status 2 and is refused
 * with 'not_processing'. Row update, balance change and ledger row all
 * commit or roll back together.
 *
 * @param {object} p
 * @param {string} p.transref
 * @param {number} p.finalStatus 0 = success, 2 = failed
 * @param {boolean} [p.refund]   only honoured when finalStatus is 2
 * @param {object} [p.actor]     {adminId, adminEmail}
 * @returns {Promise<{ok:boolean, reason?:string, refunded?:number,
 *   oldBalance?:number, newBalance?:number, sId?:number}>}
 */
export async function adminReconcileTxn({
  transref, finalStatus, refund = false, actor = null,
}) {
  if (![0, 2].includes(finalStatus)) return { ok: false, reason: 'bad_status' };

  return sequelize.transaction(async (t) => {
    const txn = await Transaction.findOne({
      where: { transref },
      lock: t.LOCK.UPDATE,
      transaction: t,
    });
    if (!txn) return { ok: false, reason: 'not_found' };

    // Read INSIDE the lock. This is the whole point: outside it, the check
    // and the refund are two separate facts about two different moments.
    if (txn.status !== 5) return { ok: false, reason: 'not_processing', status: txn.status };

    const amount = Number(txn.amount) || 0;
    const wantsRefund = finalStatus === 2 && refund === true && amount > 0;

    // Same direction guard as adminChangeTxnStatus: only a purchase can be
    // refunded. A 'Wallet Funding' row cannot be stuck in 'processing' by
    // any current code path, but "cannot happen today" is not a control.
    if (wantsRefund && !isPurchaseService(txn.servicename)) {
      return { ok: false, reason: 'not_refundable', servicename: txn.servicename || null };
    }

    let refunded = 0;
    let oldBalance;
    let newBalance;

    if (wantsRefund) {
      const user = await Subscriber.findByPk(txn.sId, { lock: t.LOCK.UPDATE, transaction: t });
      if (!user) {
        // Throw, don't return: a return commits the status change, which
        // would mark the transaction settled-and-refunded when no money
        // moved, and the row would never be eligible for reconcile again.
        const e = new Error('subscriber_missing');
        e.walletReason = 'user_not_found';
        throw e;
      }
      oldBalance = Number(user.sWallet || 0);
      newBalance = oldBalance + amount;
      user.sWallet = newBalance;
      await user.save({ transaction: t });

      await appendLedger(t, {
        sId: txn.sId,
        direction: 'credit',
        amount,
        balanceBefore: oldBalance,
        balanceAfter: newBalance,
        // 'refund' + the original transref, so the reversal is pairable
        // with the debit it reverses. This is what (2) above got wrong.
        reason: 'refund',
        reference: transref,
        meta: {
          action: 'admin_reconcile',
          servicename: txn.servicename || null,
          adminId: actor?.adminId ?? null,
          adminEmail: actor?.adminEmail ?? null,
        },
      });
      refunded = amount;

      // Refund audit rule: the row's net effect on the wallet is now zero,
      // so stop it reading as "debited and never returned".
      txn.newbal = txn.oldbal;
    }

    txn.status = finalStatus;
    await txn.save({ transaction: t });

    return { ok: true, refunded, oldBalance, newBalance, sId: txn.sId };
  }).catch((err) => {
    if (err?.walletReason) return { ok: false, reason: err.walletReason };
    throw err;
  });
}
