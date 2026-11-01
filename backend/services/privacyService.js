// ============================================================
//  privacyService.js — access and erasure, in one place
// ------------------------------------------------------------
//  NDPA gives a data subject a right of access (s.34) and a right to
//  erasure (s.36). Both are implemented here rather than in a
//  controller, because there are two callers — the user deleting their
//  own account and an admin deleting it for them — and the failure mode
//  of having two implementations is that one of them forgets a table.
//  It already had that bug: userController.deleteUser called a bare
//  user.destroy(), which left every verification row (someone else's
//  NIN and photograph) sitting in the database with no owner and no way
//  to ever find it again.
//
//  ── WHY ERASURE IS ANONYMISATION, NOT DELETION ──
//
//  `transactions` and `wallet_ledger` are financial records keyed on
//  sId. Delete the subscribers row and every naira that moved through
//  the platform reconciles to nobody — the books stop balancing, and a
//  refund dispute six months later has no counterparty. Nigerian
//  record-keeping expectations and the user's own right to erasure pull
//  in opposite directions here, and the resolution is the standard one:
//  keep the transaction, remove the person. What is left is a shell row
//  holding an id, a status and two zeroed balances.
//
//  This is stated plainly in the privacy policy. Telling someone their
//  account is "deleted" while retaining their name against their
//  transactions would be the actual violation.
//
//  ── WHAT IS HARD-DELETED ──
//
//  verifications, otp_codes, idempotency_keys and virtual_accounts are
//  destroyed outright. None of them is a financial record, and
//  verifications is the one that matters most: the subject of those
//  rows is usually a third party who never had an account here.
// ============================================================

import { Op } from 'sequelize';
import {
  sequelize,
  Subscriber,
  Transaction,
  WalletLedger,
  VirtualAccount,
  VerificationRecord,
  OtpCode,
  IdempotencyKey,
  NewsletterSubscriber,
} from '../models/index.js';
import { hashPassword, generateSecureToken, decryptPII } from '../utils/crypto.js';
import { maskIdentifiers } from '../utils/maskIdentifiers.js';
import * as logger from '../utils/logger.js';

// ------------------------------------------------------------
//  Beneficiary numbers inside transaction descriptions
// ------------------------------------------------------------
//  The masking rule lives in utils/maskIdentifiers.js (dependency-free
//  so it can be unit-tested without dragging bcrypt in) and is
//  re-exported here for the callers that already import it from this
//  service.
export { maskIdentifiers };

// ------------------------------------------------------------
//  RIGHT OF ACCESS — build the export bundle
// ------------------------------------------------------------
/**
 * Everything held about one subscriber, in a portable shape.
 *
 * Deliberately excluded, and named in the bundle so the omission is
 * visible rather than suspicious:
 *   - password and transaction PIN. Both are bcrypt hashes; they are
 *     not the user's data in any useful sense and echoing them back
 *     turns a stolen session into a stolen credential file.
 *   - the API key. Same reasoning: it is a live credential.
 *   - device fingerprints and WebAuthn public keys, which are returned
 *     as presence flags rather than values.
 */
export async function buildExportBundle(sId) {
  const user = await Subscriber.findByPk(sId);
  if (!user) return null;

  const [transactions, ledger, accounts, verifications] = await Promise.all([
    Transaction.findAll({
      where: { sId },
      order: [['date', 'DESC']],
      attributes: ['transref', 'servicename', 'servicedesc', 'amount', 'status', 'oldbal', 'newbal', 'date'],
    }),
    WalletLedger.findAll({
      where: { sId },
      order: [['createdAt', 'DESC']],
      attributes: ['wallet', 'direction', 'amount', 'balanceBefore', 'balanceAfter', 'reason', 'reference', 'createdAt'],
    }),
    VirtualAccount.findAll({
      where: { sId },
      attributes: ['gateway', 'bankName', 'accountNumber', 'accountName', 'status', 'createdAt'],
    }),
    VerificationRecord.findAll({
      where: { sId },
      order: [['date', 'DESC']],
      attributes: ['vId', 'vType', 'query', 'fullName', 'amount', 'date', 'transref', 'redactedAt', 'purgedAt'],
    }),
  ]);

  const newsletter = user.sEmail
    ? await NewsletterSubscriber.findOne({
      where: { email: String(user.sEmail).toLowerCase() },
      attributes: ['email', 'status', 'source', 'consentAt', 'consentIp', 'confirmedAt', 'unsubscribedAt'],
    })
    : null;

  return {
    exportedAt: new Date().toISOString(),
    subject: 'This file contains the personal data Datahood holds about your account.',

    account: {
      accountId: user.sId,
      firstName: user.sFname,
      lastName: user.sLname,
      email: user.sEmail || null,
      phone: user.sPhone,
      state: user.sState,
      accountType: { 1: 'User', 2: 'Agent', 3: 'Vendor' }[user.sType] || 'User',
      registeredAt: user.sRegDate,
      lastActivity: user.sLastActivity,
      referredBy: user.sReferal || null,
      themePreference: user.themePreference,
    },

    consent: {
      agreedAt: user.consentAt,
      agreedFromIp: user.consentIp,
      policyVersion: user.consentVersion,
      note: user.consentAt
        ? 'Recorded when you accepted the terms and privacy policy.'
        : 'Your account predates consent logging, so no record exists. Your agreement is evidenced by your continued use of the service.',
    },

    // An export that omits a category is a false statement about what we
    // hold, so this appears even when nothing was ever verified. The BVN/NIN
    // itself is absent because it is genuinely not stored anywhere — it is
    // forwarded to the payment gateway and dropped.
    fundingIdentityCheck: {
      verified: Number(user.sKYC || 0) !== 0,
      verifiedAt: user.sKycDate || null,
      idTypeUsed: user.sKycType || null,
      note: Number(user.sKYC || 0) !== 0
        ? 'Required by the bank that issued your funding account. We hold only the fact, the date and the ID type — never the BVN or NIN itself.'
        : 'You have not opened a dedicated funding account, so no identity details were ever collected.',
    },

    wallet: {
      mainBalance: Number(user.sWallet || 0),
      referralBalance: Number(user.sRefWallet || 0),
      bankAccountOnFile: user.sBankNo || null,
      bankName: user.sBankName || null,
    },

    virtualAccounts: accounts.map((a) => a.toJSON()),
    transactions: transactions.map((t) => t.toJSON()),
    walletLedger: ledger.map((l) => l.toJSON()),

    identityVerifications: verifications.map((v) => {
      const p = v.toJSON();
      return {
        reference: p.transref,
        type: p.vType,
        // Decrypted for the owner's own export — this is the one place
        // the plaintext is legitimately theirs to receive.
        idNumberChecked: decryptPII(p.query),
        nameReturned: decryptPII(p.fullName),
        amount: p.amount,
        date: p.date,
        detailsRetained: !(p.redactedAt || p.purgedAt),
        detailsRemovedAt: p.redactedAt || p.purgedAt || null,
      };
    }),

    newsletter: newsletter ? newsletter.toJSON() : null,

    security: {
      transactionPinSet: true,
      trustedDeviceCount: safeArrayLength(user.trustedDevices),
      fingerprintLoginRegistered: safeArrayLength(user.webauthnCredentials) > 0,
      pushNotificationsRegistered: Boolean(user.pushSubscription),
    },

    notIncluded: [
      'Your password and transaction PIN — both are stored only as one-way bcrypt hashes and cannot be read by anyone, including us.',
      'Your API key — it is a live credential; regenerate it from your dashboard if you need it.',
      'Raw device fingerprints and security-key material, summarised above as counts.',
      'Identity-verification photographs and address details older than our retention window, which are deleted automatically.',
    ],
  };
}

function safeArrayLength(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.length : 0;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------
//  RIGHT TO ERASURE
// ------------------------------------------------------------
/**
 * Anonymise a subscriber and destroy everything that is not a
 * financial record.
 *
 * Idempotent: a row already carrying deletedAt returns
 * { alreadyErased: true } without touching anything, so a retried
 * request or a double-click cannot produce a second pass.
 *
 * Runs in one transaction. A partial erasure — verifications gone but
 * the name still on the account — is the worst possible outcome,
 * because it looks done and is not.
 *
 * @param {number} sId
 * @param {object} opts
 * @param {string} opts.reason      'user-request' | 'admin'
 * @param {number} [opts.actorId]   sysId of the admin, when applicable
 * @param {boolean} [opts.force]    proceed despite a non-zero balance
 */
export async function eraseSubscriber(sId, { reason = 'user-request', actorId = null, force = false } = {}) {
  const user = await Subscriber.findByPk(sId);
  if (!user) return { ok: false, reason: 'not-found' };
  if (user.deletedAt) return { ok: true, alreadyErased: true, counts: {} };

  const balance = Number(user.sWallet || 0) + Number(user.sRefWallet || 0);
  // Refusing here is a protection, not an obstruction. Erasure zeroes the
  // wallet, and doing that to a funded account means quietly keeping money
  // that belongs to somebody we can no longer identify or repay.
  if (balance > 0 && !force) {
    return { ok: false, reason: 'balance-remaining', balance };
  }

  // Generated before the transaction opens: bcrypt is deliberately slow
  // and holding row locks across it would be a self-inflicted contention
  // problem on the busiest table in the schema.
  const deadPassword = await hashPassword(generateSecureToken(32));
  const deadPin = await hashPassword(generateSecureToken(16));
  const now = new Date();
  const counts = {};

  await sequelize.transaction(async (t) => {
    // --- Hard deletes: nothing here is a financial record ---

    // The sharpest one. Each row holds a third party's ID number and,
    // for NIN/BVN/passport, their photograph.
    counts.verifications = await VerificationRecord.destroy({ where: { sId }, transaction: t });

    // Carries requestIp and is meaningless without the account.
    counts.otpCodes = await OtpCode.destroy({ where: { sId }, transaction: t });

    // Cached response bodies include beneficiary numbers.
    counts.idempotencyKeys = await IdempotencyKey.destroy({ where: { sId }, transaction: t });

    // Our lookup copy only. The payment gateway holds its own record of
    // the reserved account under its own retention rules — the policy
    // says so, because promising otherwise would be a promise we do not
    // control.
    counts.virtualAccounts = await VirtualAccount.destroy({ where: { sId }, transaction: t });

    // An erasure request covers the mailing list too. Unsubscribing
    // keeps the row as a suppression record; erasure does not, because
    // the address itself is the personal data.
    if (user.sEmail) {
      counts.newsletter = await NewsletterSubscriber.destroy({
        where: { email: String(user.sEmail).toLowerCase() },
        transaction: t,
      });
    }

    // --- Kept, but stripped of third-party identifiers ---
    const txns = await Transaction.findAll({
      where: { sId, servicedesc: { [Op.ne]: null } },
      attributes: ['tId', 'servicedesc'],
      transaction: t,
    });
    let masked = 0;
    for (const txn of txns) {
      const clean = maskIdentifiers(txn.servicedesc);
      if (clean !== txn.servicedesc) {
        await Transaction.update(
          { servicedesc: clean },
          { where: { tId: txn.tId }, transaction: t },
        );
        masked += 1;
      }
    }
    counts.transactionsMasked = masked;

    // wallet_ledger.meta can carry a beneficiary in its JSON context.
    // The amounts and balances are the record; the context is not.
    counts.ledgerCleared = (await WalletLedger.update(
      { meta: null },
      { where: { sId, meta: { [Op.ne]: null } }, transaction: t },
    ))[0];

    // --- Anonymise the account row itself ---
    await Subscriber.update({
      sFname: 'Deleted',
      sLname: 'Account',
      sEmail: null,
      // NOT NULL and UNIQUE, so it needs a value and a distinct one.
      // 8 + up to 11 digits stays inside VARCHAR(20); MySQL in
      // non-strict mode would silently truncate a longer value and the
      // second deletion would then collide on the unique index.
      sPhone: `deleted-${sId}`,
      sPass: deadPassword,
      sPin: deadPin,
      sApiKey: generateSecureToken(32),
      sState: '',
      sBankNo: null,
      sRolexBank: null,
      sSterlingBank: null,
      sFidelityBank: null,
      sBankName: null,
      sReferal: '',
      sVirtualAccountRef: '',
      sKYC: 0,
      sKycDate: '',
      // Which ID type they verified with is still a fact about their
      // identity record, so it goes with the rest of the person.
      sKycType: null,
      // Delivery fact about a now-erased number — reset it so a future row
      // reusing this sId does not inherit a stale "not on WhatsApp" verdict.
      sWhatsAppUnreachable: 0,
      sWallet: 0,
      sRefWallet: 0,
      deviceFingerprint: null,
      trustedDevices: null,
      webauthnCredentials: null,
      pushSubscription: null,
      // 1 = Blocked. Login is refused before any of the above matters,
      // but defence in depth: the password is now unknowable anyway.
      sRegStatus: 1,
      // Every token issued to this account stops validating immediately.
      // Without this the user stays logged in on their phone, looking at
      // an account that no longer exists.
      sTokenVersion: (user.sTokenVersion || 0) + 1,
      consentIp: null,
      deletedAt: now,
    }, { where: { sId }, transaction: t });
  });

  // No names, no phone, no email — the log line must not re-create the
  // record we just erased.
  logger.info('Subscriber erased', { sId, reason, actorId, counts });

  return { ok: true, counts, erasedAt: now };
}
