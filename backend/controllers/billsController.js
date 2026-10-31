// ============================================================
//  Bills Controller — Electricity token + Cable TV
// ------------------------------------------------------------
//  Both follow the same debit-then-fulfill pattern as data,
//  with a verify step (meter / IUC) exposed separately so the
//  frontend can confirm the customer name before paying.
//
//  Electricity price = amount entered by user (flat, no plan).
//  Cable price = tier price from cableplans (user/agent/vendor).
//  On provider failure: refund (unlike data) since these are
//  single-shot and a failure means nothing was delivered.
// ============================================================

import { Op } from 'sequelize';
import { Subscriber, Transaction, CablePlan, SiteSettings, Provider } from '../models/index.js';
import { decryptSecret, hashPassword, verifyPassword, isBcryptHash } from '../utils/crypto.js';
import { debitWallet, refundWallet, creditRefWallet } from '../utils/walletOps.js';
import { verifyUserPin } from '../utils/pin.js';
import { providerFailureMessage, lookupFailureMessage } from '../utils/publicErrors.js';
import {
  verifyMeter,
  purchaseElectricity,
  verifyIUC,
  purchaseCable,
} from '../services/providerService.js';
import { emailTransactionReceipt } from '../services/receiptEmail.js';
import * as logger from '../utils/logger.js';

async function verifyPin(user, pinPlain) {
  return verifyUserPin(user, pinPlain);
}

function resolveTierPrice(row, userType) {
  let amount = parseFloat(row.userprice);
  if (userType === 3) amount = parseFloat(row.vendorprice);
  else if (userType === 2) amount = parseFloat(row.agentprice);
  return amount;
}

// ============================================================
//  Electricity — verify meter
// ============================================================

/**
 * POST /api/electricity/verify
 * body: { provider, meternumber, metertype }
 */
export async function verifyMeterHandler(req, res) {
  const { provider, meternumber, metertype } = req.body;
  try {
    if (!provider || !meternumber || !metertype) {
      return res.status(400).json({ status: 'fail', msg: 'Provider, meter number and meter type are required.' });
    }

    const p = await Provider.findOne({ where: { category: 'electricity', status: 'active', isDefault: true } });
    if (!p || !p.baseUrl || !p.apiKey) {
      return res.status(500).json({ status: 'fail', msg: 'Electricity service is not configured.' });
    }

    const apiKey = decryptSecret(p.apiKey);
    const verifyUrl = p.baseUrl.replace(/\/?$/, '/') + 'verify/';
    const result = await verifyMeter({
      host: verifyUrl,
      apiKey,
      provider,
      meterNumber: meternumber,
      meterType: metertype,
    });

    if (result.status === 'success') {
      return res.json({ status: 'success', msg: 'Meter verified.', data: { customerName: result.customerName } });
    }
    // result.msg is provider text — logged, never returned.
    logger.providerError('electricity', 'verify-meter', result.msg || 'unknown', {
      detail: result.error, cause: result.cause, reason: result.reason, providerResponse: result.raw,
    });
    return res.status(400).json({ status: 'fail', msg: lookupFailureMessage('meter details') });
  } catch (err) {
    logger.error('verifyMeter exception', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not verify meter number.' });
  }
}
// ============================================================
//  Electricity — purchase token
// ============================================================

/**
 * POST /api/electricity/purchase
 * body: { provider, phone, metertype, meternumber, amount, transref, pin }
 */
export async function purchaseElectricityHandler(req, res) {
  const user = req.user;
  const { provider, phone, metertype, meternumber, amount, transref, pin } = req.body;

  try {
    if (!pin) return res.status(400).json({ status: 'fail', msg: 'Transaction PIN is required.' });
    const pinCheck = await verifyPin(user, String(pin));
    if (pinCheck.locked) return res.status(429).json({ status: 'fail', msg: `Too many incorrect PIN attempts. Try again in ${Math.ceil(pinCheck.retryAfterSec / 60)} minute(s).` });
    if (!pinCheck.ok) return res.status(400).json({ status: 'fail', msg: 'Incorrect PIN. Please try again.' });

    if (!provider || !phone || !metertype || !meternumber || !amount || !transref) {
      return res.status(400).json({ status: 'fail', msg: 'Missing required fields.' });
    }

    const amountToPay = parseFloat(amount);
    if (isNaN(amountToPay) || amountToPay <= 0) {
      return res.status(400).json({ status: 'fail', msg: 'Invalid amount.' });
    }

    if (user.sWallet < amountToPay) {
      return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
    }

    const existingRef = await Transaction.findOne({ where: { transref } });
    if (existingRef) {
      return res.status(409).json({ status: 'fail', msg: 'Transaction reference already exists.' });
    }

    const p = await Provider.findOne({ where: { category: 'electricity', status: 'active', isDefault: true } });
    if (!p || !p.baseUrl || !p.apiKey) {
      return res.status(500).json({ status: 'fail', msg: 'Electricity service is not configured.' });
    }

    const serviceName = 'Electricity';
    const serviceDesc = `Purchase of ${provider} ${metertype} electricity token for meter ${meternumber}`;

    // Debit first — ATOMIC (row-locked; race-safe)
    const debit = await debitWallet(user.sId, amountToPay, {
      reason: 'purchase', reference: transref, meta: { service: 'electricity', provider },
    });
    if (!debit.ok) {
      if (debit.reason === 'insufficient') {
        return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
      }
      logger.error('Electricity debit failed', { transref, reason: debit.reason });
      return res.status(500).json({ status: 'fail', msg: 'Could not complete purchase. Please try again.' });
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

    const apiKey = decryptSecret(p.apiKey);
    const result = await purchaseElectricity({
      host: p.baseUrl.replace(/\/?$/, '/'),
      apiKey,
      provider,
      meterNumber: meternumber,
      meterType: metertype,
      phone,
      amount: amountToPay,
      ref: transref,
    });

    if (result.status === 'success') {
      txn.status = 0;
      await txn.save();
      logger.info('Electricity purchase successful', { transref, user: user.sId });
      // No WhatsApp receipt for electricity. Meta only lets a business open a
      // conversation with an approved template, and the two we have approved
      // (datahood_receipt_airtime / _data) have no field for a meter token.
      // The customer still gets the full PNG/PDF receipt in the dashboard.
      // The account holder is emailed the branded PDF receipt (always-on, all
      // services). Fire-and-forget — never blocks the response.
      emailTransactionReceipt(user, txn);
      return res.json({
        status: 'success',
        msg: 'Electricity token purchased.',
        data: { transref, token: result.token, amountPaid: amountToPay, oldBalance, newBalance },
      });
    } else {
      // Refund — nothing delivered (atomic)
      const refund = await refundWallet(user.sId, amountToPay, { reference: transref });
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
        logger.error('Refund failed after electricity purchase failure', {
          transref, user: user.sId, amount: amountToPay, reason: refund.reason,
        });
      }
      txn.status = 2;
      await txn.save();
      logger.providerError('electricity', 'purchase', result.msg || 'unknown', { transref, provider: p.name, host: p.baseUrl, detail: result.error, cause: result.cause, providerResponse: result.raw });
      // Provider text stays in the log — the user gets our copy.
      return res.status(500).json({
        status: 'fail',
        msg: providerFailureMessage(result.reason, { refunded: refund.ok }),
      });
    }
  } catch (err) {
    logger.error('purchaseElectricity exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not complete purchase. Please try again.' });
  }
}
// ============================================================
//  Cable TV — verify IUC
// ============================================================

/**
 * POST /api/cable/verify
 * body: { provider, iucnumber }
 */
export async function verifyIUCHandler(req, res) {
  const { provider, iucnumber } = req.body;
  try {
    if (!provider || !iucnumber) {
      return res.status(400).json({ status: 'fail', msg: 'Provider and IUC number are required.' });
    }

    const p = await Provider.findOne({ where: { category: 'cable', status: 'active', isDefault: true } });
    if (!p || !p.baseUrl || !p.apiKey) {
      return res.status(500).json({ status: 'fail', msg: 'Cable TV service is not configured.' });
    }

    const apiKey = decryptSecret(p.apiKey);
    const verifyUrl = p.baseUrl.replace(/\/?$/, '/') + 'verify/';
    const result = await verifyIUC({ host: verifyUrl, apiKey, provider, iucNumber: iucnumber });

    if (result.status === 'success') {
      return res.json({ status: 'success', msg: 'IUC verified.', data: { customerName: result.customerName } });
    }
    // result.msg is provider text — logged, never returned.
    logger.providerError('cable', 'verify-iuc', result.msg || 'unknown', {
      detail: result.error, cause: result.cause, reason: result.reason, providerResponse: result.raw,
    });
    return res.status(400).json({ status: 'fail', msg: lookupFailureMessage('IUC number') });
  } catch (err) {
    logger.error('verifyIUC exception', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not verify IUC number.' });
  }
}

// ============================================================
//  Cable TV — purchase subscription
// ============================================================

/**
 * POST /api/cable/purchase
 * body: { provider, phone, subtype, iucnumber, cableplan (cpId), transref, pin }
 */
export async function purchaseCableHandler(req, res) {
  const user = req.user;
  const { provider, phone, subtype, iucnumber, cableplan, transref, pin } = req.body;

  try {
    if (!pin) return res.status(400).json({ status: 'fail', msg: 'Transaction PIN is required.' });
    const pinCheck = await verifyPin(user, String(pin));
    if (pinCheck.locked) return res.status(429).json({ status: 'fail', msg: `Too many incorrect PIN attempts. Try again in ${Math.ceil(pinCheck.retryAfterSec / 60)} minute(s).` });
    if (!pinCheck.ok) return res.status(400).json({ status: 'fail', msg: 'Incorrect PIN. Please try again.' });

    if (!provider || !phone || !iucnumber || !cableplan || !transref) {
      return res.status(400).json({ status: 'fail', msg: 'Missing required fields.' });
    }

    const plan = await CablePlan.findByPk(parseInt(cableplan));
    if (!plan) {
      return res.status(400).json({ status: 'fail', msg: 'Invalid cable plan selected.' });
    }

    const amountToPay = resolveTierPrice(plan, user.sType);
    const buyPrice = parseFloat(plan.price);
    const profit = amountToPay - buyPrice;

    if (user.sWallet < amountToPay) {
      return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
    }

    const existingRef = await Transaction.findOne({ where: { transref } });
    if (existingRef) {
      return res.status(409).json({ status: 'fail', msg: 'Transaction reference already exists.' });
    }

    const p = await Provider.findOne({ where: { category: 'cable', status: 'active', isDefault: true } });
    if (!p || !p.baseUrl || !p.apiKey) {
      return res.status(500).json({ status: 'fail', msg: 'Cable TV service is not configured.' });
    }

    const serviceName = 'Cable TV';
    const serviceDesc = `Purchase of ${provider} ${plan.name} for IUC ${iucnumber}`;

    // Debit first — ATOMIC (row-locked; race-safe)
    const debit = await debitWallet(user.sId, amountToPay, {
      reason: 'purchase', reference: transref, meta: { service: 'cable', provider },
    });
    if (!debit.ok) {
      if (debit.reason === 'insufficient') {
        return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
      }
      logger.error('Cable debit failed', { transref, reason: debit.reason });
      return res.status(500).json({ status: 'fail', msg: 'Could not complete purchase. Please try again.' });
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

    const apiKey = decryptSecret(p.apiKey);
    const result = await purchaseCable({
      host: p.baseUrl.replace(/\/?$/, '/'),
      apiKey,
      provider,
      iucNumber: iucnumber,
      planId: plan.planid,
      phone,
      ref: transref,
      subType: subtype,
    });

    if (result.status === 'success') {
      txn.status = 0;
      txn.profit = profit;
      await txn.save();
      if (user.sReferal) {
        await creditReferralBonus(user, serviceName, amountToPay, await SiteSettings.findByPk(1), transref);
      }
      logger.info('Cable purchase successful', { transref, user: user.sId, plan: plan.name });
      // No WhatsApp receipt for cable — no approved Meta template for it.
      // See the electricity branch above. Dashboard receipt is unaffected.
      // Account holder is emailed the branded PDF receipt (always-on).
      emailTransactionReceipt(user, txn);
      return res.json({
        status: 'success',
        msg: 'Cable subscription successful.',
        data: { transref, plan: plan.name, amountPaid: amountToPay, oldBalance, newBalance },
      });
    } else {
      // Refund — nothing delivered (atomic)
      const refund = await refundWallet(user.sId, amountToPay, { reference: transref });
      // Net-zero on the receipt only if the money genuinely came back — see the
      // AUDIT RULE note in purchaseElectricity above.
      if (refund.ok) {
        res.locals.walletRestored = true; // debit undone — retrying is safe
        user.sWallet = refund.newBalance;
        txn.newbal = String(oldBalance);
      } else {
        logger.error('Refund failed after cable purchase failure', {
          transref, user: user.sId, amount: amountToPay, reason: refund.reason,
        });
      }
      txn.status = 2;
      await txn.save();
      logger.providerError('cable', 'purchase', result.msg || 'unknown', { transref, provider: p.name, host: p.baseUrl, detail: result.error, cause: result.cause, providerResponse: result.raw });
      // Provider text stays in the log — the user gets our copy.
      return res.status(500).json({
        status: 'fail',
        msg: providerFailureMessage(result.reason, { refunded: refund.ok }),
      });
    }
  } catch (err) {
    logger.error('purchaseCable exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not complete purchase. Please try again.' });
  }
}

// ============================================================
//  Shared helpers
// ============================================================

async function creditReferralBonus(user, serviceName, txnAmount, settings, transref) {
  try {
    const bonusRate = settings?.referalcablebonus || 1;
    const bonusAmount = (txnAmount * bonusRate) / 100;
    if (bonusAmount <= 0) return;

    const referrer = await Subscriber.findOne({ where: { sPhone: user.sReferal } });
    if (referrer) {
      await creditRefWallet(referrer.sId, bonusAmount, {
        reference: transref, meta: { referredUser: user.sId },
      });
      logger.info('Referral bonus credited', { referrer: referrer.sId, amount: bonusAmount, service: serviceName });
    }
  } catch (err) {
    logger.error('creditReferralBonus failed', { error: err.message, stack: err.stack });
  }
}
