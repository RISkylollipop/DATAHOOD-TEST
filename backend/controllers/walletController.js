// ============================================================
//  Wallet Controller — balance, history, stats, receipts
// ------------------------------------------------------------
//  Read-only surfaces over the existing wallet + transactions
//  data. No balance is ever changed here — funding happens via
//  the payment gateways, and debits happen inside the service
//  controllers (airtime/data/bills). This controller only
//  reports and reconciles.
// ============================================================

import { Op } from 'sequelize';
import { Subscriber, Transaction } from '../models/index.js';
import { transferRefToMain, adminChangeTxnStatus, adminReconcileTxn } from '../utils/walletOps.js';
import { escapeLike } from '../utils/refGuard.js';
import { audit, actorFrom } from '../utils/auditLog.js';
import { verifyUserPin } from '../utils/pin.js';
import { streamTransactionReceipt } from '../utils/transactionReceipt.js';
import * as logger from '../utils/logger.js';

// Human-readable label for each status code (kept in sync with the
// codes defined on the Transaction model).
const STATUS_LABELS = {
  0: 'successful',
  1: 'refunded',
  2: 'failed',
  5: 'processing',
};

function decorate(txn) {
  const plain = txn.toJSON ? txn.toJSON() : txn;
  return {
    ...plain,
    statusLabel: STATUS_LABELS[plain.status] ?? 'unknown',
  };
}

// Admin view: flatten the joined subscriber into flat, display-ready fields
// (matches the legacy admin transaction list/detail which shows the user's
// name + email + phone alongside each transaction).
function adminDecorate(txn) {
  const plain = txn.toJSON ? txn.toJSON() : txn;
  const sub = plain.subscriber || plain.subscribers || plain.Subscriber || null;
  delete plain.subscriber;
  delete plain.subscribers;
  delete plain.Subscriber;
  const name = sub ? [sub.sFname, sub.sLname].filter(Boolean).join(' ').trim() : '';
  return {
    ...plain,
    statusLabel: STATUS_LABELS[plain.status] ?? 'unknown',
    // "performed by User : Email" fields.
    userName: name || null,
    userEmail: sub?.sEmail ?? null,
    userPhone: sub?.sPhone ?? null,
    userType: sub?.sType ?? null,
  };
}

// ============================================================
//  GET /api/wallet  — current balances snapshot
// ============================================================
export async function getWalletHandler(req, res) {
  const user = req.user;
  try {
    return res.json({
      status: 'success',
      data: {
        mainBalance: Number(user.sWallet) || 0,
        referralBalance: Number(user.sRefWallet) || 0,
        tier: user.sType, // 1=User, 2=Agent, 3=Vendor
        currency: 'NGN',
      },
    });
  } catch (err) {
    logger.error('getWallet exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not load wallet.' });
  }
}

// ============================================================
//  GET /api/transactions — paginated history with filters
//  query: page, limit, status, service, search, from, to
// ============================================================
export async function getTransactionsHandler(req, res) {
  const user = req.user;
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const where = { sId: user.sId };

    // Filter by status code (accepts the numeric code or a label).
    if (req.query.status !== undefined && req.query.status !== '') {
      const raw = String(req.query.status).toLowerCase();
      const byLabel = Object.entries(STATUS_LABELS).find(([, label]) => label === raw);
      const code = byLabel ? Number(byLabel[0]) : parseInt(raw);
      if (!Number.isNaN(code)) where.status = code;
    }

    // Filter by service name (airtime, data, electricity, cable tv...).
    // escapeLike: Sequelize parameterises the value, so this is not SQL
    // injection — but `%` and `_` are still LIKE metacharacters inside a
    // bound parameter. A search of '%' matches every row and turns a
    // paginated filter into a full table scan on demand.
    if (req.query.service) {
      where.servicename = { [Op.like]: `%${escapeLike(req.query.service)}%` };
    }

    // Free-text search across ref + description.
    if (req.query.search) {
      const q = `%${escapeLike(req.query.search)}%`;
      where[Op.or] = [
        { transref: { [Op.like]: q } },
        { servicedesc: { [Op.like]: q } },
      ];
    }

    // Date range on the transaction date.
    if (req.query.from || req.query.to) {
      where.date = {};
      if (req.query.from) where.date[Op.gte] = new Date(req.query.from);
      if (req.query.to) {
        // Include the whole "to" day.
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        where.date[Op.lte] = to;
      }
    }

    const { count, rows } = await Transaction.findAndCountAll({
      where,
      order: [['date', 'DESC'], ['tId', 'DESC']],
      limit,
      offset,
    });

    return res.json({
      status: 'success',
      data: {
        transactions: rows.map(decorate),
        pagination: {
          page,
          limit,
          total: count,
          totalPages: Math.ceil(count / limit) || 1,
          hasMore: offset + rows.length < count,
        },
      },
    });
  } catch (err) {
    logger.error('getTransactions exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not load transactions.' });
  }
}

// ============================================================
//  GET /api/transactions/:ref — single transaction (receipt)
// ============================================================
export async function getTransactionHandler(req, res) {
  const user = req.user;
  const { ref } = req.params;
  try {
    const txn = await Transaction.findOne({ where: { transref: ref, sId: user.sId } });
    if (!txn) {
      return res.status(404).json({ status: 'fail', msg: 'Transaction not found.' });
    }
    return res.json({ status: 'success', data: decorate(txn) });
  } catch (err) {
    logger.error('getTransaction exception', { error: err.message, stack: err.stack, user: user.sId, ref });
    return res.status(500).json({ status: 'fail', msg: 'Could not load transaction.' });
  }
}

// ============================================================
//  GET /api/transactions/:ref/receipt — downloadable PDF receipt
//  Streams a compact receipt that shows only what the user needs
//  to confirm the outcome (ref, service, description, amount,
//  status, date). Old/new wallet balances are deliberately
//  omitted so the receipt is safe to share.
// ============================================================
export async function downloadTransactionReceiptHandler(req, res) {
  const user = req.user;
  const { ref } = req.params;
  try {
    const txn = await Transaction.findOne({ where: { transref: ref, sId: user.sId } });
    if (!txn) {
      return res.status(404).json({ status: 'fail', msg: 'Transaction not found.' });
    }

    // No siteName is passed: receipts are branded DATAHOOD (the business) in
    // both renderers. Reading settings.sitename here would print
    // "KwaraPolyData" on the PDF while the PNG for the same transaction says
    // "DATAHOOD" — see the BRANDING note in utils/transactionReceipt.js.
    const accountName = [user.sFname, user.sLname].filter(Boolean).join(' ').trim() || null;

    const safeRef = String(txn.transref).replace(/[^a-zA-Z0-9_-]/g, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="receipt-${safeRef}.pdf"`);

    // Only the display-safe fields are passed — oldbal/newbal never leave here.
    streamTransactionReceipt({
      res,
      txn: {
        transref: txn.transref,
        servicename: txn.servicename,
        servicedesc: txn.servicedesc,
        amount: txn.amount,
        status: txn.status,
        date: txn.date,
      },
      accountName,
    });
  } catch (err) {
    logger.error('downloadTransactionReceipt exception', { error: err.message, stack: err.stack, user: user.sId, ref });
    if (!res.headersSent) {
      return res.status(500).json({ status: 'fail', msg: 'Could not generate receipt.' });
    }
  }
}

// ============================================================
//  GET /api/wallet/stats — spend summary for the dashboard
//  query: from, to  (defaults to the last 30 days)
// ============================================================
export async function getWalletStatsHandler(req, res) {
  const user = req.user;
  try {
    const to = req.query.to ? new Date(req.query.to) : new Date();
    to.setHours(23, 59, 59, 999);
    const from = req.query.from
      ? new Date(req.query.from)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const txns = await Transaction.findAll({
      where: { sId: user.sId, date: { [Op.gte]: from, [Op.lte]: to } },
    });

    let totalSpent = 0;
    let successCount = 0;
    let failedCount = 0;
    let processingCount = 0;
    const byService = {};

    for (const t of txns) {
      const amt = parseFloat(t.amount) || 0;
      if (t.status === 0) {
        totalSpent += amt;
        successCount += 1;
        const key = t.servicename || 'Other';
        byService[key] = (byService[key] || 0) + amt;
      } else if (t.status === 2) {
        failedCount += 1;
      } else if (t.status === 5) {
        processingCount += 1;
      }
    }

    return res.json({
      status: 'success',
      data: {
        range: { from: from.toISOString(), to: to.toISOString() },
        totalTransactions: txns.length,
        totalSpent: Math.round(totalSpent * 100) / 100,
        successCount,
        failedCount,
        processingCount,
        spendByService: Object.entries(byService)
          .map(([service, amount]) => ({ service, amount: Math.round(amount * 100) / 100 }))
          .sort((a, b) => b.amount - a.amount),
      },
    });
  } catch (err) {
    logger.error('getWalletStats exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not load wallet stats.' });
  }
}

// ============================================================
//  POST /api/wallet/transfer-bonus — move referral balance to main wallet
// ============================================================
export async function transferBonusHandler(req, res) {
  const user = req.user;
  const { pin } = req.body;

  try {
    if (!pin) return res.status(400).json({ status: 'fail', msg: 'Transaction PIN is required.' });

    // PIN verification with per-account brute-force lockout (shared guard).
    const pinCheck = await verifyUserPin(user, String(pin));
    if (pinCheck.locked) {
      return res.status(429).json({ status: 'fail', msg: `Too many incorrect PIN attempts. Try again in ${Math.ceil(pinCheck.retryAfterSec / 60)} minute(s).` });
    }
    if (!pinCheck.ok) return res.status(400).json({ status: 'fail', msg: 'Incorrect PIN. Please try again.' });

    const bonusBalance = Number(user.sRefWallet) || 0;
    if (bonusBalance <= 0) {
      return res.status(400).json({ status: 'fail', msg: 'No referral bonus available to transfer.' });
    }

    // ATOMIC move: locks the row, credits main from bonus, zeroes bonus.
    const moveResult = await transferRefToMain(user.sId);
    if (!moveResult.ok) {
      if (moveResult.reason === 'empty') {
        return res.status(400).json({ status: 'fail', msg: 'No referral bonus available to transfer.' });
      }
      logger.error('transferBonus atomic move failed', { sId: user.sId, reason: moveResult.reason });
      return res.status(500).json({ status: 'fail', msg: 'Could not complete transfer.' });
    }
    // Sync in-memory copy.
    user.sWallet = moveResult.newBalance;
    user.sRefWallet = 0;

    logger.info('Referral bonus transferred to main wallet', { sId: user.sId, amount: moveResult.moved });

    return res.json({
      status: 'success',
      msg: 'Referral bonus transferred to your main wallet.',
      data: {
        transferred: moveResult.moved,
        oldBalance: moveResult.oldBalance,
        newBalance: moveResult.newBalance,
      },
    });
  } catch (err) {
    logger.error('transferBonus exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not complete transfer.' });
  }
}

// ============================================================
//  Admin: GET /api/admin/transactions — all users, with filters
//  query: page, limit, status, service, userId, search, from, to
// ============================================================
export async function adminGetTransactionsHandler(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const where = {};

    if (req.query.userId) where.sId = parseInt(req.query.userId);
    if (req.query.status !== undefined && req.query.status !== '') {
      const raw = String(req.query.status).toLowerCase();
      const byLabel = Object.entries(STATUS_LABELS).find(([, label]) => label === raw);
      const code = byLabel ? Number(byLabel[0]) : parseInt(raw);
      if (!Number.isNaN(code)) where.status = code;
    }
    if (req.query.service) {
      where.servicename = { [Op.like]: `%${escapeLike(req.query.service)}%` };
    }
    if (req.query.search) {
      const q = `%${escapeLike(req.query.search)}%`;
      where[Op.or] = [
        { transref: { [Op.like]: q } },
        { servicedesc: { [Op.like]: q } },
        { servicename: { [Op.like]: q } },
        { '$subscriber.sEmail$': { [Op.like]: q } },
        { '$subscriber.sPhone$': { [Op.like]: q } },
      ];
    }
    if (req.query.from || req.query.to) {
      where.date = {};
      if (req.query.from) where.date[Op.gte] = new Date(req.query.from);
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        where.date[Op.lte] = to;
      }
    }

    const { count, rows } = await Transaction.findAndCountAll({
      where,
      include: [
        {
          model: Subscriber,
          attributes: ['sId', 'sFname', 'sLname', 'sPhone', 'sEmail', 'sType'],
        },
      ],
      // Needed so the joined `subscriber` alias is reachable from the WHERE
      // (email/phone search) while limit/offset are applied. Safe because the
      // association is belongsTo (one subscriber per txn) — no row fan-out.
      subQuery: false,
      order: [['date', 'DESC'], ['tId', 'DESC']],
      limit,
      offset,
    });

    return res.json({
      status: 'success',
      data: {
        transactions: rows.map(adminDecorate),
        pagination: {
          page,
          limit,
          total: count,
          totalPages: Math.ceil(count / limit) || 1,
          hasMore: offset + rows.length < count,
        },
      },
    });
  } catch (err) {
    logger.error('adminGetTransactions exception', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load transactions.' });
  }
}

// ============================================================
//  Admin: GET /api/admin/transactions/:ref — single transaction detail
//  Includes the user (name/email/phone) and old/new balance so the admin
//  detail card can show "performed by User : Email" + balances, exactly
//  like the legacy transaction-details.php page.
// ============================================================
export async function adminGetTransactionHandler(req, res) {
  const { ref } = req.params;
  try {
    const txn = await Transaction.findOne({
      where: { transref: ref },
      include: [
        {
          model: Subscriber,
          attributes: ['sId', 'sFname', 'sLname', 'sPhone', 'sEmail', 'sType'],
        },
      ],
    });
    if (!txn) {
      return res.status(404).json({ status: 'fail', msg: 'Transaction not found.' });
    }
    return res.json({ status: 'success', data: adminDecorate(txn) });
  } catch (err) {
    logger.error('adminGetTransaction exception', { error: err.message, stack: err.stack, ref });
    return res.status(500).json({ status: 'fail', msg: 'Could not load transaction.' });
  }
}

// ============================================================
//  Admin: PATCH /api/admin/transactions/:ref/reconcile
//  Manually mark a stuck "processing" transaction as success/fail
//  body: { finalStatus: 0 | 2, refund: true | false }
// ============================================================
export async function adminReconcileTransactionHandler(req, res) {
  const { ref } = req.params;
  const { finalStatus, refund } = req.body;

  try {
    if (![0, 2].includes(finalStatus)) {
      return res.status(400).json({ status: 'fail', msg: 'finalStatus must be 0 (success) or 2 (failed).' });
    }

    // Everything — the "is it still processing?" check, the refund and the
    // status write — happens under one row lock inside walletOps. It used
    // to be four unsynchronised statements here, which let two admins
    // refund the same stuck transaction twice and recorded each refund in
    // wallet_ledger as if it were a customer deposit.
    const result = await adminReconcileTxn({
      transref: ref,
      finalStatus,
      refund: refund === true,
      actor: actorFrom(req),
    });

    if (!result.ok) {
      const MSG = {
        not_found: [404, 'Transaction not found.'],
        user_not_found: [404, 'User for this transaction not found.'],
        not_processing: [400, 'Only processing transactions can be reconciled.'],
        not_refundable: [400, 'This row is a deposit or an adjustment, not a purchase, so it cannot be refunded.'],
        bad_status: [400, 'finalStatus must be 0 (success) or 2 (failed).'],
      };
      const [code, msg] = MSG[result.reason] || [400, 'Could not reconcile transaction.'];
      await audit({
        req,
        action: 'txn.reconcile',
        targetType: 'transaction',
        targetId: ref,
        detail: { finalStatus, refund: refund === true, reason: result.reason },
        outcome: 'fail',
      });
      return res.status(code).json({ status: 'fail', msg });
    }

    await audit({
      req,
      action: 'txn.reconcile',
      targetType: 'transaction',
      targetId: ref,
      amount: result.refunded || null,
      detail: {
        finalStatus,
        refunded: result.refunded,
        sId: result.sId,
        newBalance: result.newBalance ?? null,
      },
    });

    logger.info('Admin reconciled transaction', {
      ref, finalStatus, refunded: result.refunded, adminId: req.admin?.sysId ?? null,
    });

    // Re-read rather than returning the in-transaction instance: the row
    // was mutated inside walletOps and this keeps the response honest
    // about what is actually committed.
    const txn = await Transaction.findOne({ where: { transref: ref } });

    return res.json({
      status: 'success',
      msg: result.refunded
        ? `Transaction marked as ${STATUS_LABELS[finalStatus]} and N${result.refunded} refunded.`
        : `Transaction marked as ${STATUS_LABELS[finalStatus]}.`,
      data: txn ? decorate(txn) : null,
    });
  } catch (err) {
    logger.error('adminReconcileTransaction exception', { error: err.message, stack: err.stack, ref });
    return res.status(500).json({ status: 'fail', msg: 'Could not reconcile transaction.' });
  }
}

// ============================================================
//  Admin: PATCH /api/admin/transactions/:ref/status
//  The 4 legacy admin actions (from transaction-details.php):
//    action: 'success' | 'success_debit' | 'failed' | 'failed_refund'
//  Money movement + status change happen atomically in walletOps.
// ============================================================
export async function adminChangeTransactionStatusHandler(req, res) {
  const { ref } = req.params;
  const { action } = req.body;
  const VALID = ['success', 'success_debit', 'failed', 'failed_refund'];

  try {
    if (!VALID.includes(action)) {
      return res.status(400).json({ status: 'fail', msg: 'Invalid action.' });
    }

    const result = await adminChangeTxnStatus({ transref: ref, action, actor: actorFrom(req) });
    if (!result.ok) {
      if (result.reason === 'not_found') {
        return res.status(404).json({ status: 'fail', msg: 'Transaction not found.' });
      }
      if (result.reason === 'user_not_found') {
        return res.status(404).json({ status: 'fail', msg: 'User for this transaction not found.' });
      }
      if (result.reason === 'not_refundable') {
        // Named explicitly so the admin understands the refusal instead of
        // retrying it. This is the guard that stops 'Wallet Funding' +
        // failed_refund from crediting a deposit a second time.
        await audit({
          req,
          action: `txn.${action}`,
          targetType: 'transaction',
          targetId: ref,
          detail: { reason: 'not_refundable', servicename: result.servicename },
          outcome: 'fail',
        });
        return res.status(400).json({
          status: 'fail',
          msg: `This row is a ${result.servicename || 'non-purchase'} record, not a customer purchase, so its wallet amount cannot be debited or refunded. Use the wallet adjustment screen if a manual correction is genuinely needed.`,
        });
      }
      return res.status(400).json({ status: 'fail', msg: 'Could not update transaction.' });
    }

    // Durable audit row (who, from where, how much) in addition to the log
    // line below — log files rotate and are deletable; this is a table.
    await audit({
      req,
      action: `txn.${action}`,
      targetType: 'transaction',
      targetId: ref,
      amount: result.walletMove && !result.walletMove.skipped ? result.walletMove.moved : null,
      detail: {
        newStatus: result.newStatus,
        walletMove: result.walletMove?.skipped
          ? { skipped: true, reason: result.walletMove.reason }
          : (result.walletMove || null),
      },
    });

    // Audit trail — file logger only, never console (no PII leaked).
    logger.info('Admin changed transaction status', {
      ref,
      action,
      newStatus: result.newStatus,
      adminId: req.admin?.sysId ?? null,
      walletMove: result.walletMove
        ? (result.walletMove.skipped
            ? 'skipped(already_recorded)'
            : `${result.walletMove.kind} ${result.walletMove.moved}`)
        : 'none',
    });

    // Return the fresh detail so the UI updates in place.
    const txn = await Transaction.findOne({
      where: { transref: ref },
      include: [
        { model: Subscriber, attributes: ['sId', 'sFname', 'sLname', 'sPhone', 'sEmail', 'sType'] },
      ],
    });

    const MESSAGES = {
      success: 'Transaction marked successful.',
      success_debit: result.walletMove?.skipped
        ? 'Marked successful — wallet was already debited for this transaction.'
        : 'Marked successful and user wallet debited.',
      failed: 'Transaction marked failed.',
      failed_refund: result.walletMove?.skipped
        ? 'Marked failed — a refund was already issued for this transaction.'
        : 'Marked failed and user wallet refunded.',
    };

    return res.json({
      status: 'success',
      msg: MESSAGES[action],
      data: txn ? adminDecorate(txn) : null,
    });
  } catch (err) {
    logger.error('adminChangeTransactionStatus exception', { error: err.message, stack: err.stack, ref });
    return res.status(500).json({ status: 'fail', msg: 'Could not update transaction.' });
  }
}
