// ============================================================
//  Data Purchase Controller
// ------------------------------------------------------------
//  Similar flow to airtime but with these key differences:
//   1. Plan-based pricing (user/agent/vendor tiers)
//   2. Data type checked (SME/Gifting/Corporate status)
//   3. Explicit provider 'failed' → refund immediately (status=1)
//   4. Timeout/network/non-JSON → processing (status=5) for reconciliation
//      (data may still land when the outcome is genuinely unknown)
// ============================================================

import { Op } from 'sequelize';
import { Subscriber, Transaction, Network, DataPlan, SiteSettings, Provider } from '../models/index.js';
import { decryptSecret, hashPassword, verifyPassword, isBcryptHash } from '../utils/crypto.js';
import { debitWallet, refundWallet, creditRefWallet } from '../utils/walletOps.js';
import { verifyUserPin } from '../utils/pin.js';
import { providerFailureMessage } from '../utils/publicErrors.js';
import { purchaseData as callProviderData } from '../services/providerService.js';
import { dispatchWhatsAppReceipt } from '../services/whatsappReceiptDispatch.js';
import { emailTransactionReceipt } from '../services/receiptEmail.js';
import * as logger from '../utils/logger.js';

async function verifyPin(user, pinPlain) {
  return verifyUserPin(user, pinPlain);
}

/**
 * POST /api/data/purchase
 * body: { network, phone, dataplan (pId), transref, pin, ported_number? }
 */
export async function purchaseDataHandler(req, res) {
  const user = req.user;
  const { network, phone, dataplan, transref, pin, ported_number } = req.body;

  try {
    // --- 1. Validate PIN ---
    if (!pin) {
      return res.status(400).json({ status: 'fail', msg: 'Transaction PIN is required.' });
    }
    const pinCheck = await verifyPin(user, String(pin));
    if (pinCheck.locked) {
      return res.status(429).json({ status: 'fail', msg: `Too many incorrect PIN attempts. Try again in ${Math.ceil(pinCheck.retryAfterSec / 60)} minute(s).` });
    }
    if (!pinCheck.ok) {
      return res.status(400).json({ status: 'fail', msg: 'Incorrect PIN. Please try again.' });
    }

    // --- 2. Validate inputs ---
    if (!network || !phone || !dataplan || !transref) {
      return res.status(400).json({ status: 'fail', msg: 'Missing required fields.' });
    }

    // --- 3. Verify network ---
    const net = await Network.findOne({ where: { nId: parseInt(network) } });
    if (!net) {
      return res.status(400).json({ status: 'fail', msg: 'Invalid network selected.' });
    }
    if (net.networkStatus !== 'On') {
      return res.status(503).json({ status: 'fail', msg: `${net.network} is currently unavailable.` });
    }

    // --- 4. Verify data plan and get pricing for user tier ---
    const plan = await DataPlan.findByPk(parseInt(dataplan));
    if (!plan || plan.datanetwork !== net.nId) {
      return res.status(400).json({ status: 'fail', msg: 'Invalid data plan selected.' });
    }
    if (plan.status !== 'enabled') {
      return res.status(400).json({ status: 'fail', msg: 'This plan is temporarily unavailable.' });
    }

    const userType = user.sType;
    let amountToPay = parseFloat(plan.userprice);
    if (userType === 3) amountToPay = parseFloat(plan.vendorprice);
    else if (userType === 2) amountToPay = parseFloat(plan.agentprice);

    const buyPrice = parseFloat(plan.price);
    const profit = amountToPay - buyPrice;

    // --- 5. Check data group (type) availability ---
    const dataType = plan.type; // SME, Gifting, Corporate
    if (dataType === 'SME' && net.smeStatus !== 'On') {
      return res.status(503).json({ status: 'fail', msg: `${net.network} SME is not available.` });
    }
    if (dataType === 'Gifting' && net.giftingStatus !== 'On') {
      return res.status(503).json({ status: 'fail', msg: `${net.network} Gifting is not available.` });
    }
    if (dataType === 'Corporate' && net.corporateStatus !== 'On') {
      return res.status(503).json({ status: 'fail', msg: `${net.network} Corporate is not available.` });
    }

    // --- 6. Verify phone number (unless ported) ---
    const portedFlag = Boolean(ported_number);
    if (!portedFlag) {
      const phoneValid = verifyPhoneNumber(phone, net.network);
      if (!phoneValid.valid) {
        return res.status(400).json({ status: 'fail', msg: phoneValid.msg });
      }
    }

    // --- 7. Check balance (advisory; authoritative check is the atomic debit) ---
    if (user.sWallet < amountToPay) {
      return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
    }

    // --- 8. Check transaction ref uniqueness ---
    const existingRef = await Transaction.findOne({ where: { transref } });
    if (existingRef) {
      return res.status(409).json({ status: 'fail', msg: 'Transaction reference already exists.' });
    }

    // --- 9. Check for duplicate (same service+desc within 60s) ---
    const serviceName = 'Data';
    const serviceDesc = `Purchase of ${net.network} ${plan.name} ${dataType} ${plan.day} Days Plan for ${phone}`;
    const sixtySecsAgo = new Date(Date.now() - 60 * 1000);
    const duplicate = await Transaction.findOne({
      where: {
        sId: user.sId,
        servicename: serviceName,
        servicedesc: serviceDesc,
        date: { [Op.gte]: sixtySecsAgo },
      },
    });
    if (duplicate) {
      return res.status(429).json({ status: 'fail', msg: 'Possible duplicate transaction. Try again after 60 seconds.' });
    }

    // --- 10. Debit user wallet ATOMICALLY (row-locked; race-safe) ---
    const debit = await debitWallet(user.sId, amountToPay, {
      reason: 'purchase', reference: transref, meta: { service: 'data' },
    });
    if (!debit.ok) {
      if (debit.reason === 'insufficient') {
        return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
      }
      logger.error('Data debit failed', { transref, reason: debit.reason });
      return res.status(500).json({ status: 'fail', msg: 'Could not complete purchase. Please try again.' });
    }
    const oldBalance = debit.oldBalance;
    const newBalance = debit.newBalance;
    user.sWallet = newBalance; // keep the in-memory copy consistent

    // --- 11. Record transaction as "processing" (status=5) ---
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

    // --- 12. Resolve provider (default active data provider) ---
    const provider = await Provider.findOne({
      where: { category: 'data', status: 'active', isDefault: true },
    });
    if (!provider || !provider.baseUrl || !provider.apiKey) {
      // Refund immediately (atomic) — nothing was sent to any provider yet
      const refund = await refundWallet(user.sId, amountToPay, { reference: transref, meta: { service: 'data' } });
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
        logger.error('Refund failed after data provider unavailable', {
          transref, user: user.sId, amount: amountToPay, reason: refund.reason,
        });
      }
      txn.status = 2;
      await txn.save();
      logger.error('Data purchase failed: no active provider configured', { transref });
      // Operator fact — the user cannot act on our configuration state.
      return res.status(500).json({
        status: 'fail',
        msg: providerFailureMessage('non-json', { refunded: refund.ok }),
      });
    }

    // --- 13. Determine provider network ID based on data type ---
    let providerNetworkId;
    if (dataType === 'SME') providerNetworkId = net.smeId;
    else if (dataType === 'Gifting') providerNetworkId = net.giftingId;
    else providerNetworkId = net.corporateId;

    // --- 14. Call provider ---
    const apiKey = decryptSecret(provider.apiKey);
    const providerResult = await callProviderData({
      host: provider.baseUrl,
      apiKey,
      networkId: providerNetworkId,
      phone,
      ref: transref,
      planId: plan.planid,
      portedNumber: portedFlag,
    });

    // --- 15. Handle result ---
    if (providerResult.status === 'success') {
      // Mark completed
      txn.status = 0;
      txn.profit = profit;
      await txn.save();

      // Credit referral bonus if user was referred
      if (user.sReferal) {
        await creditReferralBonus(user, serviceName, amountToPay, await SiteSettings.findByPk(1), transref);
      }

      logger.info('Data purchase successful', { transref, user: user.sId, plan: plan.name });

      // Send WhatsApp receipt async (bonus channel to the buyer)
      sendWhatsAppReceiptAsync(user, txn, net.network, plan.name, transref);

      // Email the branded PDF receipt to the account holder (always-on).
      emailTransactionReceipt(user, txn);

      return res.json({
        status: 'success',
        msg: 'Data purchase successful.',
        data: {
          transref,
          service: serviceName,
          network: net.network,
          plan: plan.name,
          phone,
          amountPaid: amountToPay,
          oldBalance,
          newBalance,
        },
      });
    } else {
      // ----------------------------------------------------------
      //  Failure handling — two very different cases.
      // ----------------------------------------------------------
      //  (a) The provider explicitly answered "failed". That is an
      //      authoritative statement that nothing was delivered, so
      //      we refund NOW rather than making the customer wait for
      //      a reconciliation run.
      //
      //  (b) The call timed out, was blocked, or returned something
      //      we could not parse. Delivery is genuinely unknown — the
      //      bundle may still land on the phone. Auto-refunding here
      //      would lose money twice (we pay the provider AND refund),
      //      so it stays 'processing' for admin reconciliation.
      const reason = providerResult.reason;
      const deliveredUnknown = reason !== 'explicit-fail';

      // OPERATOR-ONLY from here: provider msg/error/cause/raw go to the file
      // logger and never into a response body.
      logger.providerError('data', 'purchase', providerResult.msg || 'unknown', {
        transref,
        provider: provider.name,
        host: provider.baseUrl,
        detail: providerResult.error,
        cause: providerResult.cause,
        reason,
        outcome: deliveredUnknown ? 'processing (delivery unknown)' : 'refunded (provider reported failed)',
        providerResponse: providerResult.raw,
      });

      if (deliveredUnknown) {
        // Leave the money debited; admin reconciles once the true
        // outcome is known via the provider dashboard.
        //
        // newbal deliberately stays at the DEBITED figure, so the receipt shows
        // balance before != balance after. Under the audit rule that is the
        // signal for "money left the wallet and has not come back" — this row
        // is meant to stand out in reconciliation until someone resolves it.
        // Do not equalise it for symmetry with the refund branch below.
        //
        // Deliberately does NOT set res.locals.walletRestored. The bundle may
        // well have been delivered, so the idempotency guard must keep this key
        // and answer a retry with "outcome unconfirmed" instead of letting the
        // user buy the same bundle twice. Do not add the flag here for symmetry
        // with the refund branch below — the two look alike and both answer 502,
        // but only that one actually returned the money.
        txn.status = 5;
        await txn.save();
        return res.status(502).json({
          status: 'fail',
          msg: 'We could not confirm this purchase with the network. If the data does not arrive, it will be refunded automatically.',
        });
      }

      // Explicit failure → atomic refund + audit row, status 1 (refunded).
      const refund = await refundWallet(user.sId, amountToPay, { reference: transref, meta: { service: 'data' } });
      // Net-zero on the receipt only if the money genuinely came back — see the
      // AUDIT RULE note on the provider-unavailable branch above.
      if (refund.ok) {
        res.locals.walletRestored = true; // debit undone — retrying is safe
        user.sWallet = refund.newBalance;
        txn.newbal = String(oldBalance);
      } else {
        logger.error('Refund failed after data provider reported failure', {
          transref, user: user.sId, amount: amountToPay, reason: refund.reason,
        });
      }
      txn.status = 1;
      await txn.save();

      logger.info('Data purchase refunded (provider reported failed)', {
        transref, user: user.sId, amount: amountToPay,
      });

      return res.status(502).json({
        status: 'fail',
        // Must not promise a refund that did not happen — keyed on refund.ok.
        msg: providerFailureMessage('explicit-fail', { refunded: refund.ok }),
        // The real post-refund balance, not the pre-transaction one: another
        // purchase may have landed in between.
        data: { refunded: amountToPay, newBalance: refund.ok ? refund.newBalance : oldBalance },
      });
    }
  } catch (err) {
    logger.error('purchaseData exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not complete purchase. Please try again.' });
  }
}

// ========== Helpers (same as airtime) ==========

function verifyPhoneNumber(phone, networkName) {
  const p = String(phone).replace(/\D/g, '');
  if (p.length < 10) {
    return { valid: false, msg: 'Phone number is too short.' };
  }
  const prefix3 = p.slice(0, 3);
  const prefix4 = p.slice(0, 4);

  const net = networkName.toUpperCase();

  if (net === 'MTN') {
    if (['080', '070', '081', '090'].includes(prefix3)) {
      if (['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'].includes(prefix4)) {
        return { valid: true };
      }
    }
    return { valid: false, msg: 'Phone number does not match MTN network.' };
  }

  if (net === 'GLO') {
    if (['080', '070', '081', '090'].includes(prefix3)) {
      if (['0805', '0807', '0705', '0815', '0811', '0905'].includes(prefix4)) {
        return { valid: true };
      }
    }
    return { valid: false, msg: 'Phone number does not match GLO network.' };
  }

  if (net === 'AIRTEL') {
    if (['080', '070', '081', '090'].includes(prefix3)) {
      if (['0802', '0808', '0708', '0812', '0701', '0902', '0907', '0901', '0904', '0912'].includes(prefix4)) {
        return { valid: true };
      }
    }
    return { valid: false, msg: 'Phone number does not match Airtel network.' };
  }

  if (net === '9MOBILE') {
    if (['080', '081', '090'].includes(prefix3)) {
      if (['0809', '0818', '0817', '0909', '0908'].includes(prefix4)) {
        return { valid: true };
      }
    }
    return { valid: false, msg: 'Phone number does not match 9mobile network.' };
  }

  return { valid: true };
}

async function creditReferralBonus(user, serviceName, txnAmount, settings, transref) {
  try {
    const bonusRate = settings?.referaldatabonus || 1;
    const bonusAmount = (txnAmount * bonusRate) / 100;

    if (bonusAmount <= 0) return;

    const referrer = await Subscriber.findOne({ where: { sPhone: user.sReferal } });
    if (referrer) {
      await creditRefWallet(referrer.sId, bonusAmount, {
        reference: transref, meta: { service: 'data', referredUser: user.sId },
      });
      logger.info('Referral bonus credited', { referrer: referrer.sId, amount: bonusAmount, service: serviceName });
    }
  } catch (err) {
    logger.error('creditReferralBonus failed', { error: err.message, stack: err.stack });
  }
}

async function sendWhatsAppReceiptAsync(user, txn, networkName, planName, ref) {
  try {
    // NO faceValue here, deliberately — do not add one for symmetry with
    // airtimeController. Airtime has a face value the buyer named and can
    // verify ("N100 of MTN"), so showing it discloses nothing. A data plan
    // has no such figure: the buyer asked for "1GB SME", and any naira
    // amount attached to it is what the RESELLER paid. Printing it on a
    // receipt they forward to their customer hands over their margin.
    const receipt = {
      phone: user.sPhone,
      name: `${user.sFname} ${user.sLname}`,
      service: 'Data',
      network: networkName,
      // The template's {{Description}} — the plan the buyer asked for, e.g.
      // "1GB SME". deliveredValue() prefers this over `description`, which
      // remains the plain-text fallback for the Termii driver.
      planName,
      description: `${networkName} ${planName}`,
      ref,
      date: new Date(txn.date).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }),
      // Not sent to WhatsApp — see airtimeController.
      userId: user.sId,
    };

    await dispatchWhatsAppReceipt(user, receipt);
  } catch (err) {
    logger.error('WhatsApp receipt send failed', { error: err.message, stack: err.stack, ref });
  }
}
