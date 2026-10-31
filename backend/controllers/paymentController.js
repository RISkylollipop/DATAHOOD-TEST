// ============================================================
//  Payment Controller — virtual accounts + webhook handling
// ------------------------------------------------------------
//  Users create virtual accounts (one set per gateway) by calling
//  /payment/create-account with a verified identity: BVN or NIN, plus
//  the first name, last name and phone number registered against it.
//  The gateway forwards those to NIBSS/NIMC for an exact match, so they
//  are collected separately from the signup profile — see
//  utils/kycIdentity.js. The identity NUMBER is passed through and NEVER
//  persisted or logged; `sKYC`/`sKycDate`/`sKycType` record only THAT one
//  was accepted, when, and whether it was a BVN or a NIN — which is what
//  the privacy policy commits us to keeping, and no more.
//
//  One call returns SEVERAL account numbers (one per partner bank), all
//  stored against the same accountReference. Do not call it repeatedly
//  to collect more banks.
//
//  The admin configures which gateway(s) are active via the provider panel.
//
//  Incoming payments hit /payment/webhook (public, no auth) and
//  credit the user's wallet after signature verification.
//
//  Admin endpoints let you configure gateway credentials and
//  toggle which ones are active.
// ============================================================

import crypto from 'crypto';
import { Subscriber, Provider, Transaction, VirtualAccount } from '../models/index.js';
import { decryptSecret, encryptSecret, generateSecureToken } from '../utils/crypto.js';
import { fundWalletOnce } from '../utils/walletOps.js';
import { createVirtualAccount, getGateway, listGateways, resolveNeedsBvn } from '../services/paymentService.js';
import { sendTransactionEmail } from '../services/emailService.js';
import { buildVirtualAccounts, heldGateways } from '../utils/virtualAccounts.js';
import { validateIdentity } from '../utils/kycIdentity.js';
import { ensureSingleDefault } from './providerController.js';
import { dbErrorDetail } from '../utils/dbErrors.js';
import * as logger from '../utils/logger.js';

// ------------------------------------------------------------
//  Webhook signature verification (SECURITY-AUDIT C1)
// ------------------------------------------------------------
//  Every gateway signs its webhook body with a shared secret. We
//  recompute the HMAC over the EXACT received bytes and compare in
//  constant time. Default scheme is HMAC-SHA512 -> hex (Monnify's
//  scheme); a gateway that differs can override via the provider's
//  extraConfig: { "signatureAlgo": "sha256", "signatureEncoding": "base64" }.
//  A missing secret, missing signature, or mismatch is REJECTED — we
//  never credit an unverifiable webhook.
function verifyWebhookSignature({ rawBody, signature, secret, algo, encoding }) {
  if (!secret || !signature) return false;
  const hashAlgo = (algo || 'sha512').toLowerCase();
  const enc = (encoding || 'hex').toLowerCase();
  let expected;
  try {
    expected = crypto.createHmac(hashAlgo, secret).update(rawBody, 'utf8').digest(enc);
  } catch {
    return false;
  }
  // Constant-time compare; guard against length mismatch (timingSafeEqual throws).
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ============================================================
//  POST /api/payment/create-account — user creates virtual account
//  body: { gateway, idType: 'bvn'|'nin', idNumber, firstName, lastName, phone }
//
//  firstName/lastName/phone are the details held AGAINST THE BVN OR NIN,
//  which are not always the signup details — see utils/kycIdentity.js for
//  why sending the profile's name and login number silently fails the
//  NIBSS match. `bvn` is still accepted as a legacy alias for idNumber.
// ============================================================
export async function createAccountHandler(req, res) {
  const user = req.user;
  const { gateway } = req.body;

  try {
    if (!gateway) {
      return res.status(400).json({ status: 'fail', msg: 'Choose a funding gateway.' });
    }

    const adapter = getGateway(gateway);
    if (!adapter) {
      return res.status(400).json({ status: 'fail', msg: 'Unknown funding gateway.' });
    }

    const key = gateway.toLowerCase();

    // One account set PER GATEWAY, not one in total. The old test was
    // `user.sKYC !== 0`, and sKYC is set on the first success — so a user
    // could never be given a second funding option. sKYC still means
    // "BVN verified at least once", which is not a reason to refuse.
    if ((await heldGateways(user)).has(key)) {
      return res.status(409).json({
        status: 'fail',
        msg: 'You already have an account with this gateway. Choose a different one.',
      });
    }

    // No isDefault filter: "default" picks which gateway the UI suggests
    // first, and must not decide which ones a user is allowed to hold.
    // configureGatewayHandler can also leave isDefault set on several
    // rows at once, which made this lookup nondeterministic.
    const p = await Provider.findOne({
      where: { category: 'payment', name: key, status: 'active' },
    });
    if (!p || !p.apiKey) {
      return res.status(500).json({ status: 'fail', msg: `${gateway} is not configured or inactive.` });
    }

    // Whether this gateway needs a BVN is a property of the merchant
    // contract. The adapter's flag is only the default — the admin's
    // `requireBvn` override in extraConfig wins (see resolveNeedsBvn).
    const extraCfg = (() => {
      try { return JSON.parse(p.extraConfig || '{}'); } catch { return {}; }
    })();
    // The identity block: BVN or NIN, plus the name and phone registered
    // against it. Defaults to the profile only where the client sent
    // nothing, so an existing caller that omits them still behaves as
    // before rather than failing validation on fields it never knew about.
    const idCheck = validateIdentity(
      {
        idType: req.body.idType || 'bvn',
        idNumber: req.body.idNumber ?? req.body.bvn,
        firstName: req.body.firstName ?? user.sFname,
        lastName: req.body.lastName ?? user.sLname,
        phone: req.body.phone ?? user.sPhone,
      },
      resolveNeedsBvn(adapter, extraCfg),
    );
    if (!idCheck.ok) {
      return res.status(idCheck.status).json({ status: 'fail', msg: idCheck.msg });
    }
    const identity = idCheck.value;

    const cfg = {
      apiKey: decryptSecret(p.apiKey),
      secretKey: p.secretKey ? decryptSecret(p.secretKey) : null,
      contractCode: extraCfg.contractCode || null,
      businessId: extraCfg.businessId || null,
      appId: extraCfg.appId || null,
      merchantId: extraCfg.merchantId || null,
      privateKey: extraCfg.privateKey || null,
      publicKey: extraCfg.publicKey || null,
      baseUrl: p.baseUrl,
    };

    // Unpredictable reference: phone + 16 hex chars of CSPRNG entropy, so an
    // attacker cannot guess another user's account reference (SECURITY-AUDIT C1).
    const accountReference = `${user.sPhone}-${generateSecureToken(8)}`;
    const result = await createVirtualAccount(gateway.toLowerCase(), cfg, {
      // The name on the identity record wins: the gateway matches it
      // against NIBSS/NIMC, and a mismatch is a flat rejection.
      customerName: identity?.fullName || `${user.sFname} ${user.sLname}`,
      customerEmail: user.sEmail || `${user.sPhone}@placeholder.local`,
      accountReference,
      phone: user.sPhone,
      // Forwarded by the adapters to the gateway; never stored, never
      // logged. Contains the BVN/NIN — do not spread it into any log call.
      identity,
    });

    // Extract account numbers from provider response (shape varies)
    const raw = result.accounts || result.virtualAccounts || [];
    const accountName = `${user.sFname} ${user.sLname}`.trim();
    const accounts = raw
      .map((a) => ({
        bankName: String(a.bankName || a.bank || gateway),
        accountNumber: String(a.accountNumber || a.virtualAccountNumber || '').trim(),
        accountName: a.accountName || accountName,
      }))
      .filter((a) => a.accountNumber);

    if (accounts.length === 0) {
      // The gateway answered without a usable account number. Storing a
      // row keyed on '' would poison the unique index for every later
      // creation, so refuse instead.
      logger.error('Gateway returned no account number', { user: user.sId, gateway: key });
      return res.status(502).json({
        status: 'fail',
        msg: 'The payment provider did not return an account number. Please try again.',
      });
    }

    // One row per account. findOrCreate rather than a blind insert: the
    // unique index on (gateway, accountNumber) is a real safety net, and a
    // clash that belongs to ANOTHER subscriber means the gateway reissued
    // a number and we would otherwise credit the wrong wallet.
    for (const acct of accounts) {
      const [row, created] = await VirtualAccount.findOrCreate({
        where: { gateway: key, accountNumber: acct.accountNumber },
        defaults: {
          sId: user.sId,
          gateway: key,
          bankName: acct.bankName,
          accountNumber: acct.accountNumber,
          accountName: acct.accountName,
          accountReference,
          status: 'active',
        },
      });
      if (!created && row.sId !== user.sId) {
        logger.error('Gateway reissued an account number owned by another subscriber', {
          gateway: key, accountNumber: acct.accountNumber, existingOwner: row.sId, requestedBy: user.sId,
        });
        return res.status(409).json({
          status: 'fail',
          msg: 'That account number is already in use. Please contact support.',
        });
      }
      if (!created) {
        // Ours already — refresh the reference so webhooks keep resolving.
        row.accountReference = accountReference;
        row.status = 'active';
        await row.save();
      }
    }

    // sKYC records that an identity was verified, which is why it is no longer
    // the "already has an account" gate. sKycType records which ID type the
    // gateway accepted; NULL on existing rows means verified before we started
    // recording the type.
    user.sKYC = 1;
    user.sKycDate = new Date().toISOString();
    if (identity) user.sKycType = identity.idType;

    // ---- Legacy column dual-write (PHP parity) ----
    // The old admin panel still reads these, so keep them populated. They
    // hold ONE gateway, so a second gateway must never overwrite them:
    // whichever gateway got there first keeps the slots, and keeps
    // sVirtualAccountRef, which is the webhook's legacy fallback key.
    if (!String(user.sVirtualAccountRef || '').trim()) {
      user.sVirtualAccountRef = accountReference;
    }
    if (key === 'monnify') {
      for (const acc of accounts) {
        const bank = acc.bankName.toLowerCase();
        if (bank.includes('wema')) user.sBankNo = acc.accountNumber;
        else if (bank.includes('moniepoint') || bank.includes('rolex')) user.sRolexBank = acc.accountNumber;
        else if (bank.includes('sterling')) user.sSterlingBank = acc.accountNumber;
        else if (bank.includes('fidelity')) user.sFidelityBank = acc.accountNumber;
      }
    } else if (!String(user.sBankNo || '').trim()) {
      user.sBankNo = accounts[0].accountNumber;
      user.sBankName = accounts[0].bankName;
    }

    // MONEY SAFETY: save ONLY the account columns.
    //
    // A bare user.save() writes every attribute Sequelize thinks is
    // dirty — and it re-writes sWallet from this in-memory copy, which
    // was read before the (slow) HTTP round-trip to the gateway. A
    // webhook that credited this user during that window would be
    // silently reverted: the credit is committed under a row lock in
    // walletOps, then overwritten here by a stale value with no lock and
    // no error. The ledger would show the credit and the balance would
    // not, which is the hardest class of money bug to detect after the
    // fact. This is the rule stated at the top of utils/walletOps.js;
    // naming the fields is how it is enforced rather than remembered.
    await user.save({
      fields: [
        'sVirtualAccountRef', 'sBankNo', 'sBankName',
        'sRolexBank', 'sSterlingBank', 'sFidelityBank',
        'sKYC', 'sKycDate', 'sKycType',
      ].filter((f) => user.changed(f)),
    });

    logger.info('Virtual account created', { user: user.sId, gateway: key, ref: accountReference });

    return res.json({
      status: 'success',
      msg: 'Virtual account created successfully.',
      data: { accounts: accounts.map((a) => ({ ...a, gateway: key })) },
    });
  } catch (err) {
    // `stack` is what lets logger.js derive `thrownAt`, and dbErrorDetail
    // turns the Sequelize default "Validation error" — which named no index,
    // no column, no value — into "unique constraint violated — Duplicate
    // entry '...' for key 'uniq_va_ref'", the string that names the bug.
    logger.error('createAccount exception', {
      error: dbErrorDetail(err), stack: err.stack, user: user.sId, gateway,
    });
    return res.status(500).json({ status: 'fail', msg: 'Could not create virtual account. Please try again.' });
  }
}

// ============================================================
//  GET /api/payment/accounts — user reads their OWN reserved accounts
// ------------------------------------------------------------
//  Without this, the Fund Wallet page had no way to learn that a
//  user already holds reserved accounts: it only ever populated
//  the list from the create-account RESPONSE. Every returning user
//  (and every account migrated from the legacy PHP database) was
//  therefore shown an empty "Generate account" form which then
//  failed with "You already have a virtual account."
//
//  Read-only and cheap — one indexed read plus the legacy columns
//  already on the user row, so there is no gateway round-trip here.
//
//  Also answers "what else could I add?". That list used to be
//  hardcoded in Wallet.js, which meant the UI offered gateways the
//  admin had switched off and asked for a BVN on the wrong ones.
// ============================================================
export async function getMyAccountsHandler(req, res) {
  const user = req.user;

  try {
    const accounts = await buildVirtualAccounts(user);
    const held = new Set(accounts.map((a) => a.gateway).filter(Boolean));

    // Only gateways the admin has actually configured and left active.
    const active = await Provider.findAll({
      where: { category: 'payment', status: 'active' },
      attributes: ['name', 'isDefault', 'extraConfig'],
    });

    const available = active
      // getGateway THROWS on an unknown key rather than returning null, so a
      // stale provider row (a gateway removed from the registry) would 500
      // this whole endpoint and leave the Fund page blank.
      .filter((p) => {
        if (held.has(String(p.name).toLowerCase())) return false;
        try { return !!getGateway(p.name); } catch { return false; }
      })
      .map((p) => {
        let extra = {};
        try { extra = JSON.parse(p.extraConfig || '{}'); } catch { extra = {}; }
        return {
          gateway: String(p.name).toLowerCase(),
          // Resolved server-side, admin override included, so the form asks
          // for a BVN exactly when creation will demand one. Wallet.js used
          // to hardcode this list and got Monnify wrong.
          needsBvn: resolveNeedsBvn(getGateway(p.name), extra),
          recommended: !!p.isDefault,
        };
      });

    return res.json({
      status: 'success',
      data: {
        accounts,
        available,
        // Kept for older clients that read a single boolean.
        canCreate: available.length > 0,
        kyc: user.sKYC !== 0,
      },
    });
  } catch (err) {
    logger.error('getMyAccounts exception', { error: err.message, stack: err.stack, user: user?.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not load your funding accounts.' });
  }
}

// ============================================================
//  POST /api/payment/webhook — public, receives payment notifications
// ============================================================
export async function webhookHandler(req, res) {
  const signature = req.headers['monnify-signature'] || req.headers['x-paymentpoint-signature'] || req.headers['x-palmpay-signature'];
  // The signature covers the EXACT bytes the gateway sent, captured by the
  // express.json() verify hook in server.js.
  //
  // There is deliberately NO re-serialization fallback. This used to read
  // `req.rawBody || JSON.stringify(req.body)`, which is unsound in both
  // directions:
  //
  //  - It cannot succeed honestly. JSON.stringify is not the gateway's
  //    serializer: key order, unicode escaping and number formatting all
  //    differ, so the recomputed HMAC would not match a genuine delivery
  //    anyway. The fallback's only real effect was to make a MISSING raw
  //    body look like a signature problem instead of a parsing problem.
  //  - It verifies a signature against bytes we invented rather than bytes
  //    we received, which is the one thing signature verification exists to
  //    prevent. `req.rawBody` is only set for requests express.json()
  //    parsed; a delivery sent as form-urlencoded populates req.body with
  //    rawBody still undefined, and the two can then disagree about the
  //    AMOUNT while the check passes.
  //
  // So: no raw body, no verification, no credit.
  const rawBody = req.rawBody;

  try {
    // Identify provider from webhook payload shape or signature header
    let providerName = null;
    if (req.headers['monnify-signature']) providerName = 'monnify';
    else if (req.headers['x-paymentpoint-signature']) providerName = 'paymentpoint';
    else if (req.headers['x-palmpay-signature']) providerName = 'palmpay';
    else if (req.body.eventType) providerName = 'monnify'; // Monnify sends eventType

    if (!providerName) {
      logger.warn('Webhook received with unknown provider');
      return res.status(400).json({ status: 'fail', msg: 'Unknown provider.' });
    }

    const p = await Provider.findOne({ where: { category: 'payment', name: providerName, status: 'active' } });
    if (!p) {
      logger.warn('Webhook for inactive provider', { provider: providerName });
      return res.status(400).json({ status: 'fail', msg: 'Provider not configured.' });
    }

    // --- Verify signature for EVERY provider; REJECT if unverifiable ---
    // (SECURITY-AUDIT C1: never skip verification, never credit a webhook we
    //  cannot cryptographically trust.)
    const secret = p.secretKey ? decryptSecret(p.secretKey) : null;
    if (!secret) {
      logger.error('Webhook rejected: no signing secret configured for provider', { provider: providerName });
      return res.status(403).json({ status: 'fail', msg: 'Signature verification unavailable.' });
    }
    if (!signature) {
      logger.warn('Webhook rejected: missing signature header', { provider: providerName });
      return res.status(403).json({ status: 'fail', msg: 'Missing signature.' });
    }
    // No captured bytes means the request did not arrive as JSON (so
    // express.json()'s verify hook never ran) or the body was empty. Either
    // way there is nothing authentic to verify against — see the note at the
    // top of this function for why re-serializing req.body is not a fallback.
    if (!rawBody) {
      logger.warn('Webhook rejected: raw body not captured (was it sent as JSON?)', {
        provider: providerName, contentType: req.headers['content-type'] || '(none)',
      });
      return res.status(400).json({ status: 'fail', msg: 'Request body must be sent as application/json.' });
    }
    let sigCfg = {};
    try {
      sigCfg = JSON.parse(p.extraConfig || '{}');
    } catch {
      sigCfg = {};
    }
    const validSig = verifyWebhookSignature({
      rawBody,
      signature,
      secret,
      algo: sigCfg.signatureAlgo,
      encoding: sigCfg.signatureEncoding,
    });
    if (!validSig) {
      // Do NOT log the expected hash or the raw body (they are secret/PII).
      logger.warn('Webhook signature mismatch — rejected', { provider: providerName });
      return res.status(403).json({ status: 'fail', msg: 'Invalid signature.' });
    }

    // Extract payment details (Monnify shape)
    const eventData = req.body.eventData || req.body;
    // Trimmed deliberately. Subscriber.sVirtualAccountRef defaults to the
    // empty string, so a blank-but-truthy reference (' ') reaching the
    // legacy fallback below could match an arbitrary user who has never
    // generated an account, and credit a stranger's wallet.
    const accountReference = String(eventData.accountReference || eventData.customerReference || '').trim();
    const amountPaid = parseFloat(eventData.amountPaid || eventData.amount || 0);
    const paymentReference = eventData.paymentReference || eventData.transactionReference;
    const paymentStatus = eventData.paymentStatus || eventData.status;

    if (!accountReference || amountPaid <= 0) {
      logger.warn('Webhook missing required fields', { provider: providerName, ref: paymentReference });
      return res.status(400).json({ status: 'fail', msg: 'Invalid webhook data.' });
    }
    // The reference is the idempotency key for the whole credit. Without
    // it there is nothing to make the operation replay-safe, so a retry
    // would credit again — reject rather than credit blind. Checked
    // separately from the fields above so the log says which one is the
    // problem; a gateway sending no reference is a configuration fault
    // on their side and needs to be recognisable.
    if (!paymentReference) {
      logger.error('Webhook rejected: no payment reference in payload', { provider: providerName });
      return res.status(400).json({ status: 'fail', msg: 'Missing payment reference.' });
    }

    // --- Only credit when the gateway says the money was actually PAID ---
    // (SECURITY-AUDIT C1: previously the wallet was credited regardless.)
    const statusStr = String(paymentStatus || '').toLowerCase();
    const isPaid = statusStr === 'paid' || statusStr === 'success' || statusStr === 'successful' || statusStr === 'completed';
    if (!isPaid) {
      logger.info('Webhook received but not in a paid state — no credit applied', { provider: providerName, ref: paymentReference, status: statusStr });
      return res.json({ status: 'success', msg: 'Acknowledged (not paid).' });
    }

    // --- Find the account's owner ---
    // Resolution order, first hit wins:
    //   1. virtual_accounts row keyed (gateway, accountReference). This is
    //      the money-critical lookup: the table allows several gateways per
    //      user, so the reference alone used to find the wrong (or no) owner.
    //      Crediting by (gateway, reference) can never credit a wallet the
    //      reference does not belong to.
    //   2. Subscriber.sVirtualAccountRef, for accounts created before the
    //      table existed. A legacy user who never re-runs creation gets
    //      their deposits matched exactly as they always were.
    let user = null;
    const vaRow = await VirtualAccount.findOne({
      where: { gateway: providerName, accountReference },
    });
    if (vaRow) {
      user = await Subscriber.findByPk(vaRow.sId);
    }
    // `accountReference` is guaranteed non-empty above; the explicit test
    // keeps that guarantee local, because matching '' here would match the
    // column default on every user who never generated an account.
    if (!user && accountReference) {
      user = await Subscriber.findOne({ where: { sVirtualAccountRef: accountReference } });
    }
    if (!user) {
      logger.warn('Webhook for unknown account reference', { provider: providerName, ref: paymentReference });
      return res.status(404).json({ status: 'fail', msg: 'Account not found.' });
    }

    // Fast path for the common duplicate: the gateway is retrying a
    // delivery we already handled. Answering 200 here stops the retry
    // loop cheaply. This is NOT the safety mechanism — it is a
    // check-then-act read with no lock, so a genuinely concurrent pair
    // of deliveries can both pass it. The guarantee lives in the UNIQUE
    // index on transactions.transref, enforced inside fundWalletOnce
    // below, which is where a collision actually costs money.
    const existing = await Transaction.findOne({ where: { transref: paymentReference } });
    if (existing) {
      logger.info('Duplicate webhook ignored', { ref: paymentReference });
      return res.json({ status: 'success', msg: 'Already processed.' });
    }

    // Apply funding charge. The rate is stored on the payment provider's
    // own config (set in the admin gateway form): a value >= 50 is treated
    // as a flat Naira fee, otherwise as a percentage.
    let chargeRate = 0;
    try {
      chargeRate = parseFloat(JSON.parse(p.extraConfig || '{}').charges || 0);
    } catch {
      chargeRate = 0;
    }
    let chargeAmount = 0;
    if (chargeRate > 0) {
      if (chargeRate >= 50) {
        // Flat charge
        chargeAmount = chargeRate;
      } else {
        // Percentage
        chargeAmount = (amountPaid * chargeRate) / 100;
      }
    }
    const creditAmount = Math.max(0, amountPaid - chargeAmount);
    // A charge configured at or above the deposit would credit zero and
    // then be rejected as bad_amount, which logs as a failure and makes
    // the gateway retry forever. Say what it actually is: a misconfigured
    // charge rate, needing an operator, not a retry.
    if (!(creditAmount > 0)) {
      logger.error('Webhook credit skipped: charge consumed the whole deposit', {
        provider: providerName, ref: paymentReference, amountPaid, chargeAmount,
      });
      return res.status(200).json({ status: 'success', msg: 'Acknowledged (nothing to credit).' });
    }

    // Credit the wallet and write the transaction row in ONE database
    // transaction, with the unique reference claimed BEFORE the money
    // moves. See fundWalletOnce for why the old credit-then-record
    // ordering could both double-credit and lose the record.
    //
    // NOTE `gateway: providerName`. This line previously read
    // `meta: { gateway, ... }` with no `gateway` binding anywhere in this
    // function — it is declared only in createAccountHandler and
    // configureGatewayHandler. Under ESM strict mode the argument object
    // is built before the call, so every single delivery threw
    // ReferenceError before creditWallet ran, was swallowed by the catch
    // below, and answered 500: the money settled in the merchant account
    // and no wallet was ever credited.
    const credit = await fundWalletOnce({
      userId: user.sId,
      amount: creditAmount,
      reference: paymentReference,
      reason: 'funding',
      // charge is recorded so a user asking "why did N1,000 become N990?"
      // can be answered from the ledger alone.
      meta: { gateway: providerName, amountPaid, chargeAmount },
      txn: {
        servicename: 'Wallet Funding',
        servicedesc: `${providerName} payment via ${eventData.paymentMethod || 'bank transfer'}`,
        amount: String(creditAmount),
        status: 0, // 0 = successful; we only reach here when the gateway said paid
        profit: 0,
      },
    });

    if (!credit.ok) {
      if (credit.reason === 'duplicate') {
        // Lost the race to a concurrent delivery of the same payment.
        // The other one credited; this one must not. 200 so the gateway
        // stops retrying — from its point of view the notification was
        // accepted, which is true.
        logger.info('Concurrent duplicate webhook rejected by unique reference', { ref: paymentReference });
        return res.json({ status: 'success', msg: 'Already processed.' });
      }
      logger.error('Webhook credit failed', { user: user.sId, ref: paymentReference, reason: credit.reason });
      return res.status(500).json({ status: 'fail', msg: 'Could not apply payment.' });
    }

    logger.info('Wallet funded via webhook', { user: user.sId, amount: creditAmount, ref: paymentReference });

    return res.json({ status: 'success', msg: 'Payment processed.' });
  } catch (err) {
    // Never log the raw body (may contain PII/secrets); just the error message.
    logger.error('webhook exception', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Webhook processing failed.' });
  }
}

// ============================================================
//  Admin: GET /api/admin/payment/gateways — list available gateways
// ============================================================
export async function listGatewaysHandler(req, res) {
  try {
    const gateways = listGateways();
    return res.json({ status: 'success', data: gateways });
  } catch (err) {
    logger.error('listGateways exception', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not list gateways.' });
  }
}

// ============================================================
//  Admin: POST /api/admin/payment/gateways — configure a gateway
//  body: { gateway, config: { apiKey, secretKey, contractCode, ... }, isActive }
// ============================================================
export async function configureGatewayHandler(req, res) {
  const { gateway, config, isActive, isDefault } = req.body;

  try {
    if (!gateway || !config) {
      return res.status(400).json({ status: 'fail', msg: 'Gateway and config are required.' });
    }

    const key = String(gateway).toLowerCase();

    // Encrypt sensitive keys
    const apiKey = config.apiKey ? await encryptSecret(config.apiKey) : null;
    const secretKey = config.secretKey ? await encryptSecret(config.secretKey) : null;

    // Store other config as JSON
    const extraConfig = { ...config };
    delete extraConfig.apiKey;
    delete extraConfig.secretKey;

    // `default` now means "the one the funding page suggests first", and it
    // is a separate switch from active. It used to be assigned isActive,
    // which quietly marked EVERY active gateway as default — several rows
    // carrying isDefault=1 at once, so any findOne filtering on it returned
    // whichever row MySQL happened to reach first.
    const makeDefault = isDefault === undefined ? !!isActive : !!isDefault;

    const [provider, created] = await Provider.findOrCreate({
      where: { category: 'payment', name: key },
      defaults: {
        category: 'payment',
        name: key,
        baseUrl: config.baseUrl || '',
        apiKey,
        secretKey,
        extraConfig: JSON.stringify(extraConfig),
        status: isActive ? 'active' : 'inactive',
        isDefault: makeDefault && !!isActive,
      },
    });

    if (!created) {
      provider.baseUrl = config.baseUrl || provider.baseUrl;
      provider.apiKey = apiKey || provider.apiKey;
      provider.secretKey = secretKey || provider.secretKey;
      provider.extraConfig = JSON.stringify(extraConfig);
      provider.status = isActive ? 'active' : 'inactive';
      // An inactive gateway can never be the default one.
      provider.isDefault = makeDefault && !!isActive;
      await provider.save();
    }

    // Exactly one default. Demote the others rather than leaving the
    // choice to row order. Shared with the generic provider form so both
    // paths enforce the same rule.
    if (makeDefault && isActive) {
      await ensureSingleDefault('payment', provider.id);
    }

    logger.info('Payment gateway configured', { gateway: key, isActive, isDefault: makeDefault });

    return res.json({ status: 'success', msg: 'Gateway configured successfully.' });
  } catch (err) {
    logger.error('configureGateway exception', { error: err.message, stack: err.stack, gateway });
    return res.status(500).json({ status: 'fail', msg: 'Could not configure gateway.' });
  }
}
