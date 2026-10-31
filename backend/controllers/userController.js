// ============================================================
//  User Controller — admin user management + funding
// ------------------------------------------------------------
//  Powers the admin "Users" screen. Full CRUD for user
//  accounts: list (paginated + search + filters), view detail,
//  edit profile fields, credit/debit wallets (main + bonus),
//  change account status/type, reset password/API key, delete.
//
//  Security:
//   - All endpoints requireAdmin.
//   - Every money / status / delete operation is logged (file logger)
//     AND written to admin_audit_log with the acting admin, their IP and
//     user agent. The file log rotates and is purged under the retention
//     policy; the audit table is the durable answer to "who did this to
//     this customer's account". See utils/auditLog.js.
//   - Password reset bumps sTokenVersion to revoke all sessions.
//   - Wallet ops use atomic helpers (SELECT ... FOR UPDATE) — never a
//     direct user.sWallet mutation.
// ============================================================

import { Op } from 'sequelize';
import { Subscriber, Transaction } from '../models/index.js';
import { creditWallet, debitWallet, creditRefWallet, debitRefWallet } from '../utils/walletOps.js';
import { hashPassword, generateSecureToken } from '../utils/crypto.js';
import { buildVirtualAccounts } from '../utils/virtualAccounts.js';
import { sendWalletEmail } from '../services/emailService.js';
import { eraseSubscriber } from '../services/privacyService.js';
import { audit } from '../utils/auditLog.js';
import * as logger from '../utils/logger.js';

// Account status codes (sRegStatus). Confirmed from the legacy dump: every
// real, transacting account carries 0, so 0 = Active. Registration also sets 0.
const STATUS_LABELS = {
  0: 'Active',
  1: 'Blocked',
  2: 'Pending account verification',
  3: 'Pending email verification',
};
const TYPE_LABELS = { 1: 'User', 2: 'Agent', 3: 'Vendor' };

const VALID_STATUS = new Set([0, 1, 2, 3]);
const VALID_TYPE = new Set([1, 2, 3]);

// Compact representation for the users table.
function adminUserSummary(u) {
  return {
    sId: u.sId,
    name: `${u.sFname} ${u.sLname}`.replace(/\s+/g, ' ').trim(),
    firstName: u.sFname,
    lastName: u.sLname,
    phone: u.sPhone,
    email: u.sEmail || '',
    state: u.sState,
    wallet: Number(u.sWallet || 0),
    refWallet: Number(u.sRefWallet || 0),
    type: u.sType,
    typeLabel: TYPE_LABELS[u.sType] || 'User',
    status: u.sRegStatus,
    statusLabel: STATUS_LABELS[u.sRegStatus] ?? 'Unknown',
    regDate: u.sRegDate,
    lastActivity: u.sLastActivity,
    referal: u.sReferal || '',
  };
}

// ---------- List ----------

/**
 * GET /api/admin/users?page=1&limit=25&type=&status=&search=
 * Paginated, searchable (name / phone / email), filterable by type + status.
 */
export async function listUsers(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const offset = (page - 1) * limit;

    const where = {};
    if (req.query.type && VALID_TYPE.has(Number(req.query.type))) {
      where.sType = Number(req.query.type);
    }
    if (req.query.status !== undefined && req.query.status !== '' && VALID_STATUS.has(Number(req.query.status))) {
      where.sRegStatus = Number(req.query.status);
    }
    const search = (req.query.search || '').trim();
    if (search) {
      where[Op.or] = [
        { sPhone: { [Op.like]: `%${search}%` } },
        { sEmail: { [Op.like]: `%${search}%` } },
        { sFname: { [Op.like]: `%${search}%` } },
        { sLname: { [Op.like]: `%${search}%` } },
      ];
    }

    const { rows, count } = await Subscriber.findAndCountAll({
      where,
      order: [['sId', 'DESC']],
      limit,
      offset,
    });

    return res.json({
      status: 'success',
      data: {
        users: rows.map(adminUserSummary),
        total: count,
        page,
        limit,
        pages: Math.ceil(count / limit) || 1,
        statusLabels: STATUS_LABELS,
        typeLabels: TYPE_LABELS,
      },
    });
  } catch (err) {
    logger.error('listUsers failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load users.' });
  }
}

// ---------- View single ----------

/**
 * GET /api/admin/users/:id
 * Full detail incl. resolved "referred by", referral count, virtual
 * account info, and the last few transactions.
 */
export async function getUser(req, res) {
  try {
    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    // "Referred by" — sReferal stores the referrer's PHONE number.
    let referredBy = null;
    if (user.sReferal) {
      const ref = await Subscriber.findOne({ where: { sPhone: user.sReferal } });
      if (ref) {
        referredBy = { sId: ref.sId, name: `${ref.sFname} ${ref.sLname}`.trim(), phone: ref.sPhone };
      }
    }

    // How many people THIS user has referred (others carrying their phone).
    const referralCount = await Subscriber.count({ where: { sReferal: user.sPhone } });

    // Recent activity.
    const recent = await Transaction.findAll({
      where: { sId: user.sId },
      order: [['tId', 'DESC']],
      limit: 8,
    });

    // Virtual accounts the user can fund (built during payment onboarding).
    // Shared helper so this admin view and the customer's own Fund Wallet
    // page can never disagree about which accounts a user holds. `gateway`
    // is carried through because a user may now hold accounts at several,
    // and support's first question is always "which gateway".
    const virtualAccounts = (await buildVirtualAccounts(user)).map((a) => ({
      bank: a.bankName,
      number: a.accountNumber,
      gateway: a.gateway,
    }));

    return res.json({
      status: 'success',
      data: {
        ...adminUserSummary(user),
        apiKey: user.sApiKey,
        kyc: user.sKYC,
        kycDate: user.sKycDate || '',
        pinStatus: user.sPinStatus,
        referredBy,
        referralCount,
        virtualAccounts,
        recentTransactions: recent.map((t) => ({
          transref: t.transref,
          servicename: t.servicename,
          servicedesc: t.servicedesc,
          amount: t.amount,
          status: t.status,
          date: t.date,
        })),
        statusLabels: STATUS_LABELS,
        typeLabels: TYPE_LABELS,
      },
    });
  } catch (err) {
    logger.error('getUser failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not load user.' });
  }
}

// ---------- Edit details ----------

/**
 * PUT /api/admin/users/:id
 * Edit name / email / phone / state / type. Phone + email uniqueness enforced.
 */
export async function updateUser(req, res) {
  try {
    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    const { firstName, lastName, email, phone, state, type } = req.body;

    if (phone !== undefined && String(phone).trim() && String(phone).trim() !== user.sPhone) {
      const clash = await Subscriber.findOne({ where: { sPhone: String(phone).trim(), sId: { [Op.ne]: user.sId } } });
      if (clash) return res.status(409).json({ status: 'fail', msg: 'That phone number is already in use.' });
      user.sPhone = String(phone).trim();
      // A new number has never been tested against WhatsApp. Clear the
      // "not on WhatsApp" flag so the next receipt tries WhatsApp again
      // instead of silently falling back to email forever.
      user.sWhatsAppUnreachable = 0;
    }
    if (email !== undefined) {
      const e = String(email).trim();
      if (e) {
        const clash = await Subscriber.findOne({ where: { sEmail: e, sId: { [Op.ne]: user.sId } } });
        if (clash) return res.status(409).json({ status: 'fail', msg: 'That email is already in use.' });
      }
      user.sEmail = e || null;
    }
    if (firstName !== undefined) user.sFname = String(firstName).trim();
    if (lastName !== undefined) user.sLname = String(lastName).trim();
    if (state !== undefined) user.sState = String(state).trim();
    if (type !== undefined && VALID_TYPE.has(Number(type))) user.sType = Number(type);

    await user.save();
    logger.info('Admin edited user', { adminId: req.auth?.sysId, userId: user.sId });
    return res.json({ status: 'success', msg: 'User updated.', data: adminUserSummary(user) });
  } catch (err) {
    logger.error('updateUser failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not update user.' });
  }
}

// ---------- Change account type ----------

/**
 * PATCH /api/admin/users/:id/type   body: { type: 1|2|3 }
 */
export async function changeType(req, res) {
  try {
    const type = Number(req.body.type);
    if (!VALID_TYPE.has(type)) return res.status(400).json({ status: 'fail', msg: 'Invalid account type.' });

    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    // Captured before the assignment — an audit row that cannot say what the
    // value WAS only tells you half of what happened.
    const previousType = user.sType;

    user.sType = type;
    await user.save();
    logger.info('Admin changed user type', { adminId: req.auth?.sysId, userId: user.sId, type });
    // Account type is a PRICING lever: sType selects userprice / agentprice /
    // vendorprice on every purchase (see dataController). Promoting an account
    // to vendor is therefore a permanent discount granted to one customer, and
    // it leaves no ledger row of its own — this is the only durable record.
    await audit({
      req,
      action: 'user.type_change',
      targetType: 'subscriber',
      targetId: user.sId,
      detail: { from: previousType, to: type, label: TYPE_LABELS[type] },
    });
    return res.json({ status: 'success', msg: `Account type set to ${TYPE_LABELS[type]}.`, data: adminUserSummary(user) });
  } catch (err) {
    logger.error('changeType failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not change account type.' });
  }
}

// ---------- Change account status ----------

/**
 * PATCH /api/admin/users/:id/status   body: { status: 0|1|2|3 }
 *  0 Active · 1 Blocked · 2 Pending account verification · 3 Pending email verification
 */
export async function changeStatus(req, res) {
  try {
    const status = Number(req.body.status);
    if (!VALID_STATUS.has(status)) return res.status(400).json({ status: 'fail', msg: 'Invalid account status.' });

    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    const previousStatus = Number(user.sRegStatus);

    user.sRegStatus = status;
    // Blocking a user should also revoke their live sessions.
    if (status === 1) user.sTokenVersion = (user.sTokenVersion || 0) + 1;
    await user.save();

    logger.info('Admin changed user status', { adminId: req.auth?.sysId, userId: user.sId, status });
    // Blocking and UNBLOCKING both matter here. An attacker who reaches the
    // admin console can suspend a competitor, or quietly restore an account
    // the business deliberately suspended for fraud, and neither move touches
    // wallet_ledger. Recording the previous value is what makes an unauthorised
    // unblock visible after the fact.
    await audit({
      req,
      action: 'user.status_change',
      targetType: 'subscriber',
      targetId: user.sId,
      detail: {
        from: previousStatus,
        to: status,
        label: STATUS_LABELS[status],
        sessionsRevoked: status === 1,
      },
    });
    return res.json({ status: 'success', msg: `Status set to ${STATUS_LABELS[status]}.`, data: adminUserSummary(user) });
  } catch (err) {
    logger.error('changeStatus failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not change account status.' });
  }
}

// ---------- Credit / Debit ----------

// Record an admin funding action in the user's transaction history so it's
// auditable and visible to the user. Never throws — logs on failure.
// The description mirrors the legacy wording but deliberately stops at
// "By Admin" — the admin's login identity is NOT exposed in the user's
// own transaction history.
async function recordFundingTx(user, { credit, wallet, amount, oldBal, newBal, adminId, note }) {
  try {
    const walletLabel = wallet === 'bonus' ? 'Bonus wallet' : 'Main wallet';
    const action = credit ? 'Credit' : 'Debit';
    const reasonPart = note ? ` Reason: ${note}.` : '';
    const servicedesc = wallet === 'bonus'
      ? `Bonus wallet ${action} of N${amount} for user ${user.sEmail || ''}.${reasonPart} By Admin`
      : `Wallet ${action} of N${amount} for user ${user.sEmail || ''}.${reasonPart} By Admin`;
    await Transaction.create({
      sId: user.sId,
      transref: `ADM${Date.now()}${Math.floor(Math.random() * 1000)}`,
      servicename: credit ? 'Admin Credit' : 'Admin Debit',
      servicedesc,
      amount: String(amount),
      status: 0, // successful
      oldbal: String(oldBal ?? ''),
      newbal: String(newBal ?? ''),
      profit: 0,
      date: new Date(),
    });
    // Email the user (fire-and-forget — never blocks the money movement).
    sendWalletEmail({
      to: user.sEmail,
      name: user.sFname,
      kind: credit ? 'credit' : 'debit',
      amount,
      oldBalance: oldBal,
      newBalance: newBal,
      reason: note,
      walletLabel,
    }).catch((err) => logger.error('wallet email failed', { error: err.message, userId: user.sId }));
  } catch (err) {
    logger.error('recordFundingTx failed', { error: err.message, stack: err.stack, userId: user.sId });
  }
}

/**
 * POST /api/admin/users/:id/credit   body: { amount, wallet: 'main'|'bonus', note? }
 */
export async function creditUser(req, res) {
  try {
    const amount = Number(req.body.amount);
    const wallet = req.body.wallet === 'bonus' ? 'bonus' : 'main';
    if (!(amount > 0)) return res.status(400).json({ status: 'fail', msg: 'Enter a valid amount.' });

    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    // The admin who did this is the single most important thing to capture
    // for a manual adjustment — it is the one movement with no provider or
    // gateway record behind it.
    const ledger = {
      reason: 'admin_credit',
      meta: { adminId: req.auth?.sysId, note: req.body.note || null },
    };
    const result = wallet === 'bonus'
      ? await creditRefWallet(user.sId, amount, ledger)
      : await creditWallet(user.sId, amount, ledger);

    if (!result.ok) {
      return res.status(400).json({ status: 'fail', msg: 'Could not credit wallet.' });
    }

    const oldBal = wallet === 'bonus' ? result.oldRefWallet : result.oldBalance;
    const newBal = wallet === 'bonus' ? result.newRefWallet : result.newBalance;
    await recordFundingTx(user, { credit: true, wallet, amount, oldBal, newBal, adminId: req.auth?.sysId, note: req.body.note });

    logger.info('Admin credited user', { adminId: req.auth?.sysId, userId: user.sId, wallet, amount });
    // Manual credit is the one balance increase with no payment behind it —
    // no gateway webhook, no provider, nothing external to reconcile against.
    // walletOps already stamps adminId into wallet_ledger.meta; this row adds
    // the IP and user agent, which is what distinguishes the real admin from
    // someone using their session.
    await audit({
      req,
      action: 'wallet.admin_credit',
      targetType: 'subscriber',
      targetId: user.sId,
      amount,
      detail: { wallet, oldBalance: oldBal, newBalance: newBal, note: req.body.note || null },
    });
    return res.json({
      status: 'success',
      msg: `Credited ${wallet === 'bonus' ? 'bonus' : 'main'} wallet.`,
      data: { wallet, newBalance: newBal },
    });
  } catch (err) {
    logger.error('creditUser failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not credit user.' });
  }
}

/**
 * POST /api/admin/users/:id/debit   body: { amount, wallet: 'main'|'bonus', note? }
 */
export async function debitUser(req, res) {
  try {
    const amount = Number(req.body.amount);
    const wallet = req.body.wallet === 'bonus' ? 'bonus' : 'main';
    if (!(amount > 0)) return res.status(400).json({ status: 'fail', msg: 'Enter a valid amount.' });

    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    const ledger = {
      reason: 'admin_debit',
      meta: { adminId: req.auth?.sysId, note: req.body.note || null },
    };
    const result = wallet === 'bonus'
      ? await debitRefWallet(user.sId, amount, ledger)
      : await debitWallet(user.sId, amount, ledger);

    if (!result.ok) {
      const msg = result.reason === 'insufficient' ? 'Insufficient balance in that wallet.' : 'Could not debit wallet.';
      return res.status(400).json({ status: 'fail', msg });
    }

    const oldBal = wallet === 'bonus' ? result.oldRefWallet : result.oldBalance;
    const newBal = wallet === 'bonus' ? result.newRefWallet : result.newBalance;
    await recordFundingTx(user, { credit: false, wallet, amount, oldBal, newBal, adminId: req.auth?.sysId, note: req.body.note });

    logger.info('Admin debited user', { adminId: req.auth?.sysId, userId: user.sId, wallet, amount });
    await audit({
      req,
      action: 'wallet.admin_debit',
      targetType: 'subscriber',
      targetId: user.sId,
      amount,
      detail: { wallet, oldBalance: oldBal, newBalance: newBal, note: req.body.note || null },
    });
    return res.json({
      status: 'success',
      msg: `Debited ${wallet === 'bonus' ? 'bonus' : 'main'} wallet.`,
      data: { wallet, newBalance: newBal },
    });
  } catch (err) {
    logger.error('debitUser failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not debit user.' });
  }
}

// ---------- Reset password ----------

/**
 * POST /api/admin/users/:id/reset-password   body: { password }
 * Hashes with bcrypt and bumps sTokenVersion to revoke every live session.
 */
export async function resetPassword(req, res) {
  try {
    const password = String(req.body.password || '');
    if (password.length < 6) {
      return res.status(400).json({ status: 'fail', msg: 'Password must be at least 6 characters.' });
    }
    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    user.sPass = await hashPassword(password);
    user.sTokenVersion = (user.sTokenVersion || 0) + 1; // force re-login everywhere
    await user.save();

    logger.info('Admin reset user password', { adminId: req.auth?.sysId, userId: user.sId });
    // The single most dangerous non-money action in this file: it hands an
    // admin working credentials for a customer's account, and the customer's
    // only clue is being signed out. NOTE the password itself is not in
    // `detail` — auditLog.js redacts any key containing "password", but the
    // right defence is not passing it.
    await audit({
      req,
      action: 'user.password_reset',
      targetType: 'subscriber',
      targetId: user.sId,
      detail: { sessionsRevoked: true },
    });
    return res.json({ status: 'success', msg: 'Password reset. The user must log in again.' });
  } catch (err) {
    logger.error('resetPassword failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not reset password.' });
  }
}

// ---------- Reset API key ----------

/**
 * POST /api/admin/users/:id/reset-apikey
 * Issues a fresh cryptographically-random developer API key.
 */
export async function resetApiKey(req, res) {
  try {
    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    // Ensure global uniqueness (sApiKey is a unique column).
    let key;
    for (let i = 0; i < 5; i += 1) {
      key = generateSecureToken(32);
      const clash = await Subscriber.findOne({ where: { sApiKey: key } });
      if (!clash) break;
    }
    user.sApiKey = key;
    await user.save();

    logger.info('Admin reset user API key', { adminId: req.auth?.sysId, userId: user.sId });
    // The new key is deliberately NOT in `detail`. It is a bearer credential,
    // every admin can read this table, and the point of the row is that the
    // rotation happened — not what it rotated to.
    await audit({
      req,
      action: 'user.apikey_reset',
      targetType: 'subscriber',
      targetId: user.sId,
    });
    return res.json({ status: 'success', msg: 'API key regenerated.', data: { apiKey: key } });
  } catch (err) {
    logger.error('resetApiKey failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not reset API key.' });
  }
}

// ---------- Delete ----------

/**
 * DELETE /api/admin/users/:id?force=1
 *
 * Routed through the SAME eraser the user's own self-service deletion
 * uses (services/privacyService.js), so the two paths cannot drift and
 * forget a table. The old implementation here called a bare
 * user.destroy(), which left every verification row — a third party's
 * NIN and photograph — orphaned in the database with no owner and no
 * way to ever find it again.
 *
 * force=1 lets an admin erase an account that still holds a wallet
 * balance; without it, a funded account is refused for the same reason
 * the user path refuses it — we would be keeping money we can no longer
 * return. The admin gets told the balance rather than a silent no-op.
 */
export async function deleteUser(req, res) {
  try {
    const user = await Subscriber.findByPk(req.params.id);
    if (!user) return res.status(404).json({ status: 'fail', msg: 'User not found.' });

    const force = req.query.force === '1' || req.query.force === 'true';
    // Balance read BEFORE the eraser runs: after anonymisation the wallet is
    // zeroed, so a `force` erasure that walked away from customer money would
    // otherwise leave no record of how much.
    const balanceAtErasure = Number(user.sWallet || 0);
    const result = await eraseSubscriber(user.sId, {
      reason: 'admin',
      actorId: req.auth?.sysId ?? null,
      force,
    });

    if (!result.ok && result.reason === 'balance-remaining') {
      // Audited as a FAILED attempt. "An admin tried to erase a funded account
      // and was refused" is exactly the pattern worth being able to find later,
      // especially if a successful force= follows it seconds afterwards.
      await audit({
        req,
        action: 'user.erase',
        targetType: 'subscriber',
        targetId: user.sId,
        amount: result.balance,
        outcome: 'fail',
        detail: { refused: 'balance-remaining', force: false },
      });
      return res.status(409).json({
        status: 'fail',
        code: 'balance-remaining',
        balance: result.balance,
        msg: `This account still holds N${result.balance.toLocaleString('en-NG')}. Refund or clear the wallet first, or re-send with force to erase anyway.`,
      });
    }
    if (!result.ok) {
      return res.status(500).json({ status: 'fail', msg: 'Could not delete account.' });
    }

    // NOTE WHAT IS NOT HERE: no email, no phone, no name.
    //
    // This is an NDPA erasure. privacyService anonymises the row precisely so
    // the person is no longer identifiable, and writing their address into an
    // append-only audit table that every admin can read would undo that — the
    // erasure would be defeated by its own paper trail. The sId is retained
    // because it is already retained in `transactions` and `wallet_ledger` for
    // financial reconciliation, so it discloses nothing new.
    await audit({
      req,
      action: 'user.erase',
      targetType: 'subscriber',
      targetId: user.sId,
      amount: balanceAtErasure || null,
      detail: { force, forcedOverBalance: force && balanceAtErasure > 0 },
    });
    return res.json({ status: 'success', msg: 'Account erased.' });
  } catch (err) {
    logger.error('deleteUser failed', { error: err.message, stack: err.stack, id: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not delete account.' });
  }
}
