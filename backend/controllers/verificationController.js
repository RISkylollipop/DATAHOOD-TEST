// ============================================================
//  Verification Controller — identity checks + verified PDF slip
// ------------------------------------------------------------
//  Flow mirrors the purchase controllers (airtime/data):
//   - PIN required
//   - price resolved by user tier (user/agent/vendor)
//   - wallet debited BEFORE the provider call (status=5)
//   - on success: status=0, record saved, receipt async
//   - on fail:   status=2, user REFUNDED (nothing delivered)
//
//  Prices are admin-configured on the verification provider's
//  extraConfig JSON, e.g.
//    { "prices": { "nin": {"user":100,"agent":80,"vendor":60}, ... },
//      "paths":  { "nin": "vnin" },   // optional per-type path override
//      "buyPrices": { "nin": 50 } }   // optional, for profit tracking
//  so adding/repricing a type needs NO code change.
// ============================================================

import { Subscriber, Transaction, Provider, SiteSettings, VerificationRecord } from '../models/index.js';
import { decryptSecret, encryptPII, decryptPII } from '../utils/crypto.js';
import { debitWallet, refundWallet, creditRefWallet } from '../utils/walletOps.js';
import { verifyUserPin } from '../utils/pin.js';
import { providerFailureMessage } from '../utils/publicErrors.js';
import { verifyIdentity, VERIFICATION_TYPES } from '../services/verificationService.js';
import { streamVerifiedSlip } from '../utils/verifiedSlip.js';
import { emailTransactionReceipt } from '../services/receiptEmail.js';
import * as logger from '../utils/logger.js';

async function verifyPin(user, pinPlain) {
  return verifyUserPin(user, pinPlain);
}

// Mask an ID/phone so it isn't stored in cleartext anywhere outside the
// (encrypted) verifications table — e.g. the transactions description that
// the user sees in history. Keeps the last 4 for recognisability.
function maskId(value) {
  const s = String(value || '');
  if (s.length <= 4) return '****';
  return `${'*'.repeat(s.length - 4)}${s.slice(-4)}`;
}

function tierKey(userType) {
  if (userType === 3) return 'vendor';
  if (userType === 2) return 'agent';
  return 'user';
}

function getProviderConfig(provider) {
  let cfg = {};
  try {
    cfg = JSON.parse(provider.extraConfig || '{}');
  } catch {
    cfg = {};
  }
  return cfg;
}

// Resolve the price for a type+tier from the provider config.
function resolvePrice(cfg, type, userType) {
  const prices = cfg.prices || {};
  const row = prices[type];
  if (!row) return null;
  const key = tierKey(userType);
  const val = row[key] ?? row.user; // fall back to user price
  const n = parseFloat(val);
  return Number.isNaN(n) ? null : n;
}

// ============================================================
//  GET /api/verify/types — list enabled types + this user's price
// ============================================================
export async function listTypesHandler(req, res) {
  const user = req.user;
  try {
    const provider = await Provider.findOne({
      where: { category: 'nin', status: 'active', isDefault: true },
    });
    const cfg = provider ? getProviderConfig(provider) : {};
    const configured = Boolean(provider && provider.baseUrl && provider.apiKey);

    const types = Object.entries(VERIFICATION_TYPES).map(([key, meta]) => {
      const price = resolvePrice(cfg, key, user.sType);
      return {
        type: key,
        label: meta.label,
        inputField: meta.input,
        expectedDigits: meta.digits,
        hasPhoto: meta.hasPhoto,
        price: price,
        available: configured && price !== null,
      };
    });

    return res.json({ status: 'success', data: { configured, types } });
  } catch (err) {
    logger.error('listTypes exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not load verification types.' });
  }
}

// ============================================================
//  POST /api/verify — run a verification
//  body: { type, query, transref, pin }
// ============================================================
export async function verifyHandler(req, res) {
  const user = req.user;
  const { type, query, transref, pin } = req.body;

  try {
    if (!pin) return res.status(400).json({ status: 'fail', msg: 'Transaction PIN is required.' });
    const pinCheck = await verifyPin(user, String(pin));
    if (pinCheck.locked) return res.status(429).json({ status: 'fail', msg: `Too many incorrect PIN attempts. Try again in ${Math.ceil(pinCheck.retryAfterSec / 60)} minute(s).` });
    if (!pinCheck.ok) return res.status(400).json({ status: 'fail', msg: 'Incorrect PIN. Please try again.' });

    if (!type || !query || !transref) {
      return res.status(400).json({ status: 'fail', msg: 'Verification type, ID number and reference are required.' });
    }

    const meta = VERIFICATION_TYPES[type];
    if (!meta) {
      return res.status(400).json({ status: 'fail', msg: 'Unsupported verification type.' });
    }

    // Basic input validation (digit-count where the type has a fixed length).
    const cleaned = String(query).trim();
    if (meta.digits && !new RegExp(`^\\d{${meta.digits}}$`).test(cleaned)) {
      return res.status(400).json({ status: 'fail', msg: `${meta.label} must be ${meta.digits} digits.` });
    }

    const provider = await Provider.findOne({
      where: { category: 'nin', status: 'active', isDefault: true },
    });
    if (!provider || !provider.baseUrl || !provider.apiKey) {
      return res.status(500).json({ status: 'fail', msg: 'Verification service is not configured.' });
    }

    const cfg = getProviderConfig(provider);
    const amountToPay = resolvePrice(cfg, type, user.sType);
    if (amountToPay === null) {
      return res.status(400).json({ status: 'fail', msg: 'This verification type is not available.' });
    }

    if (user.sWallet < amountToPay) {
      return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
    }

    const existingRef = await Transaction.findOne({ where: { transref } });
    if (existingRef) {
      return res.status(409).json({ status: 'fail', msg: 'Transaction reference already exists.' });
    }

    const serviceName = 'Verification';
    const serviceDesc = `${meta.label} verification for ${maskId(cleaned)}`;

    // --- Debit first (status=5 processing) — ATOMIC (row-locked; race-safe) ---
    // Note: `meta` below is the ledger's context field, not this handler's
    // local `meta` (the verification-type descriptor). Kept minimal so the
    // two don't get confused — and an ID must never land in the ledger.
    const debit = await debitWallet(user.sId, amountToPay, {
      reason: 'purchase', reference: transref, meta: { service: 'verification' },
    });
    if (!debit.ok) {
      if (debit.reason === 'insufficient') {
        return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
      }
      logger.error('Verification debit failed', { transref, reason: debit.reason });
      return res.status(500).json({ status: 'fail', msg: 'Could not complete verification. Please try again.' });
    }
    const oldBalance = debit.oldBalance;
    const newBalance = debit.newBalance;
    user.sWallet = newBalance;

    const txn = await Transaction.create({
      sId: user.sId,
      transref,
      servicename: serviceName,
      servicedesc: serviceDesc,
      amount: String(amountToPay),
      status: 5,
      oldbal: String(oldBalance),
      newbal: String(newBalance),
      profit: 0,
    });

    // --- Call provider ---
    const apiKey = decryptSecret(provider.apiKey);
    const result = await verifyIdentity({
      host: provider.baseUrl,
      apiKey,
      authStyle: provider.authStyle || 'token',
      extraConfig: cfg,
      type,
      query: cleaned,
    });

    if (result.status === 'success') {
      // profit = amount charged - admin's buy price (if configured)
      const buyPrice = parseFloat((cfg.buyPrices || {})[type]);
      const profit = Number.isNaN(buyPrice) ? 0 : amountToPay - buyPrice;
      txn.status = 0;
      txn.profit = profit;
      await txn.save();

      // Save the verification record for history + PDF re-download.
      // PII (ID number, full name, and the full result blob incl. photo)
      // is ENCRYPTED at rest (SECURITY-AUDIT H3). It is only decrypted in
      // memory when the owner views history / re-downloads their slip.
      const record = await VerificationRecord.create({
        sId: user.sId,
        transref,
        vType: type,
        query: encryptPII(cleaned),
        fullName: encryptPII(result.data.fullName || null),
        result: encryptPII(JSON.stringify(result.data)),
        amount: String(amountToPay),
      });

      if (user.sReferal) {
        await creditReferralBonus(user, amountToPay, transref);
      }

      logger.info('Verification successful', { type, user: user.sId, transref });
      // No WhatsApp receipt for verification. There is no approved Meta
      // template for it, and the old one put the identity query itself
      // (a BVN/NIN/plate) into the message body — that is not something to
      // push out over WhatsApp. The slip stays behind the authenticated
      // detail/PDF endpoint.
      //
      // The account holder IS emailed the branded transaction receipt (always-on,
      // all five services). It is built from the TRANSACTION row, whose
      // servicedesc is masked ("<type> verification for ******1234") — it carries
      // no money and no full ID. The verified identity slip (real name, DOB,
      // photo, full ID) is NEVER emailed; it stays behind /api/verify/:vId/slip.
      // Fire-and-forget — never blocks the response.
      emailTransactionReceipt(user, txn);

      // Return the data WITHOUT the (heavy) photo base64 — the PDF/detail
      // endpoint serves the photo. Keeps the JSON response light.
      const { photoBase64, ...lightData } = result.data;
      return res.json({
        status: 'success',
        msg: 'Verification successful.',
        data: {
          vId: record.vId,
          transref,
          type,
          hasPhoto: Boolean(photoBase64),
          result: lightData,
          amountPaid: amountToPay,
          oldBalance,
          newBalance,
          downloadUrl: `/api/verify/${record.vId}/slip`,
        },
      });
    } else {
      // Refund — nothing delivered (atomic).
      const refund = await refundWallet(user.sId, amountToPay, { reference: transref, meta: { service: 'verification' } });
      // AUDIT RULE — a reversed transaction reads as net-zero on the receipt
      // (balance before == balance after). A row where they DIFFER is a debit
      // that was never returned, which is how admin finds money to refund by
      // hand. Only equalise when the refund really succeeded: refundWallet can
      // answer {ok:false}, and showing net-zero after a failed refund would
      // hide money the user is owed.
      if (refund.ok) {
        res.locals.walletRestored = true; // debit undone — retrying is safe
        user.sWallet = refund.newBalance;
        txn.newbal = String(oldBalance);
      } else {
        logger.error('Refund failed after verification failure', {
          transref, user: user.sId, amount: amountToPay, reason: refund.reason,
        });
      }
      txn.status = 2;
      await txn.save();
      logger.providerError('verification', type, result.msg || 'unknown', { transref, provider: provider.name, host: provider.baseUrl, detail: result.error, cause: result.cause, providerResponse: result.raw });
      // Provider text stays in the log — the user gets our copy.
      return res.status(502).json({
        status: 'fail',
        msg: providerFailureMessage(result.reason, { refunded: refund.ok }),
      });
    }
  } catch (err) {
    logger.error('verify exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not complete verification. Please try again.' });
  }
}

// ============================================================
//  GET /api/verify/history — paginated list of the user's checks
// ============================================================
export async function historyHandler(req, res) {
  const user = req.user;
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;

    const { count, rows } = await VerificationRecord.findAndCountAll({
      where: { sId: user.sId },
      attributes: ['vId', 'vType', 'query', 'fullName', 'amount', 'date', 'transref', 'redactedAt', 'purgedAt'],
      order: [['date', 'DESC'], ['vId', 'DESC']],
      limit,
      offset,
    });

    return res.json({
      status: 'success',
      data: {
        records: rows.map((r) => {
          const plain = r.toJSON();
          // Decrypt PII back for the owner's own history view.
          plain.query = decryptPII(plain.query);
          plain.fullName = decryptPII(plain.fullName);
          // The line stays in history after retention has stripped the
          // details — it is proof of a purchase, so removing it would
          // read as a missing transaction.
          plain.retained = !(plain.redactedAt || plain.purgedAt);
          return { ...plain, label: VERIFICATION_TYPES[plain.vType]?.label || plain.vType };
        }),
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
    logger.error('verify history exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not load verification history.' });
  }
}

// ============================================================
//  GET /api/verify/:vId — single record (full result incl. photo)
// ============================================================
export async function getRecordHandler(req, res) {
  const user = req.user;
  const { vId } = req.params;
  try {
    const record = await VerificationRecord.findOne({ where: { vId: parseInt(vId), sId: user.sId } });
    if (!record) {
      return res.status(404).json({ status: 'fail', msg: 'Verification record not found.' });
    }
    let result = {};
    try {
      result = JSON.parse(decryptPII(record.result) || '{}');
    } catch {
      result = {};
    }
    // Past the retention window the result blob is gone (see
    // services/retentionService.js). Say so, rather than returning an
    // empty object the UI would render as a record with no details —
    // that reads as data loss and generates a support ticket.
    const retired = Boolean(record.redactedAt || record.purgedAt);
    return res.json({
      status: 'success',
      data: {
        vId: record.vId,
        type: record.vType,
        label: VERIFICATION_TYPES[record.vType]?.label || record.vType,
        query: decryptPII(record.query),
        transref: record.transref,
        date: record.date,
        result,
        retained: !retired,
        retiredAt: record.redactedAt || record.purgedAt || null,
        downloadUrl: retired ? null : `/api/verify/${record.vId}/slip`,
      },
    });
  } catch (err) {
    logger.error('getRecord exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not load verification record.' });
  }
}

// ============================================================
//  GET /api/verify/:vId/slip — download the verified PDF slip
// ============================================================
export async function downloadSlipHandler(req, res) {
  const user = req.user;
  const { vId } = req.params;
  try {
    const record = await VerificationRecord.findOne({ where: { vId: parseInt(vId), sId: user.sId } });
    if (!record) {
      return res.status(404).json({ status: 'fail', msg: 'Verification record not found.' });
    }

    // The slip is generated from the stored result. Once retention has
    // dropped that blob there is nothing to generate FROM, and rendering
    // a slip with empty name/DOB/photo would produce an official-looking
    // document asserting blanks — worse than refusing. 410, not 404: the
    // record existed and the user is not wrong to ask for it.
    if (record.redactedAt || record.purgedAt) {
      return res.status(410).json({
        status: 'fail',
        msg: 'This slip is no longer available. Verification details are deleted after our retention period, so please download slips soon after running a check.',
      });
    }

    let result = {};
    try {
      result = JSON.parse(decryptPII(record.result) || '{}');
    } catch {
      result = {};
    }

    const settings = await SiteSettings.findByPk(1);
    const siteName = settings?.sitename || 'KwaraPolyData';

    const filename = `verification-${record.vType}-${record.vId}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    streamVerifiedSlip({
      res,
      record: {
        vType: record.vType,
        query: decryptPII(record.query),
        fullName: decryptPII(record.fullName),
        result,
        date: record.date,
        transref: record.transref,
      },
      siteName,
    });
  } catch (err) {
    logger.error('downloadSlip exception', { error: err.message, stack: err.stack, user: user.sId });
    // If headers already sent (stream started), we can't send JSON.
    if (!res.headersSent) {
      return res.status(500).json({ status: 'fail', msg: 'Could not generate slip.' });
    }
  }
}

// ========== Helpers ==========

// `transref` is passed in, not closed over. It used to be referenced here as a
// bare identifier that exists only in the handler's scope, so every call threw
// ReferenceError — swallowed by the catch below, which meant referral bonuses on
// verifications were never paid and the log line blamed a vague failure.
async function creditReferralBonus(user, txnAmount, transref) {
  try {
    const settings = await SiteSettings.findByPk(1);
    // No dedicated verification bonus field — reuse the wallet bonus rate.
    const bonusRate = settings?.referalwalletbonus || 1;
    const bonusAmount = (txnAmount * bonusRate) / 100;
    if (bonusAmount <= 0) return;
    const referrer = await Subscriber.findOne({ where: { sPhone: user.sReferal } });
    if (referrer) {
      await creditRefWallet(referrer.sId, bonusAmount, {
        reference: transref, meta: { service: 'verification', referredUser: user.sId },
      });
      logger.info('Referral bonus credited', { referrer: referrer.sId, amount: bonusAmount, service: 'Verification' });
    }
  } catch (err) {
    logger.error('creditReferralBonus (verification) failed', { error: err.message, stack: err.stack });
  }
}
