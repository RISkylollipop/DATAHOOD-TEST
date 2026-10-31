// ============================================================
//  Airtime Controller — VTU and Sharesell purchases
// ------------------------------------------------------------
//  Security + business rules:
//   - Transaction PIN required (stored bcrypt in Subscriber.sPin)
//   - Network availability checked (networkStatus + vtuStatus/sharesellStatus)
//   - Phone number validated against network (unless ported_number=true)
//   - Discount applied by user tier (sType: 1=user, 2=agent, 3=vendor)
//   - Min/max airtime limits enforced (from SiteSettings)
//   - Duplicate transaction blocked (same service+desc within 60s)
//   - Wallet debited BEFORE provider call (status=5 "processing")
//   - On success: status=0, referral bonus credited, profit saved
//   - On fail: status=2, user refunded
//   - WhatsApp receipt sent async (never blocks the purchase)
// ============================================================

import { Op } from 'sequelize';
import { Subscriber, Transaction, Network, Airtime, SiteSettings, Provider } from '../models/index.js';
import { decryptSecret, hashPassword, verifyPassword, isBcryptHash } from '../utils/crypto.js';
import { debitWallet, refundWallet, creditRefWallet } from '../utils/walletOps.js';
import { verifyUserPin } from '../utils/pin.js';
import { providerFailureMessage } from '../utils/publicErrors.js';
import { purchaseAirtime as callProviderAirtime } from '../services/providerService.js';
import { dispatchWhatsAppReceipt } from '../services/whatsappReceiptDispatch.js';
import { emailTransactionReceipt } from '../services/receiptEmail.js';
import * as logger from '../utils/logger.js';

/**
 * Verify a transaction PIN with per-account brute-force lockout.
 * Delegates to the shared guard in utils/pin.js (single source of truth
 * for legacy-plaintext upgrade + lockout). Returns the guard's result.
 */
async function verifyPin(user, pinPlain) {
  return verifyUserPin(user, pinPlain);
}

/**
 * POST /api/airtime/purchase
 * body: { network, networktype (VTU|Sharesell), phone, amount, transref, pin, ported_number? }
 */
export async function purchaseAirtimeHandler(req, res) {
  const user = req.user; // from requireUser middleware
  const { network, networktype, phone, amount, transref, pin, ported_number } = req.body;

  try {
    // --- 1. Validate PIN (bcrypt, with legacy plaintext auto-upgrade) ---
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
    if (!network || !networktype || !phone || !amount || !transref) {
      return res.status(400).json({ status: 'fail', msg: 'Missing required fields.' });
    }
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ status: 'fail', msg: 'Invalid amount.' });
    }

    // --- 3. Verify network exists ---
    const net = await Network.findOne({ where: { nId: parseInt(network) } });
    if (!net) {
      return res.status(400).json({ status: 'fail', msg: 'Invalid network selected.' });
    }

    // --- 4. Check network availability ---
    const isVTU = String(networktype).toUpperCase() === 'VTU';
    const isSS = String(networktype).toUpperCase() === 'SHARESELL';
    if (!isVTU && !isSS) {
      return res.status(400).json({ status: 'fail', msg: 'Airtime type must be VTU or Sharesell.' });
    }
    if (net.networkStatus !== 'On') {
      return res.status(503).json({ status: 'fail', msg: `${net.network} is currently unavailable.` });
    }
    if (isVTU && net.vtuStatus !== 'On') {
      return res.status(503).json({ status: 'fail', msg: `${net.network} VTU is not available.` });
    }
    if (isSS && net.sharesellStatus !== 'On') {
      return res.status(503).json({ status: 'fail', msg: `${net.network} Sharesell is not available.` });
    }

    // --- 5. Verify phone number matches network (unless ported) ---
    const portedFlag = Boolean(ported_number);
    if (!portedFlag) {
      const phoneValid = verifyPhoneNumber(phone, net.network);
      if (!phoneValid.valid) {
        return res.status(400).json({ status: 'fail', msg: phoneValid.msg });
      }
    }

    // --- 6. Calculate discount ---
    const discountRow = await Airtime.findOne({
      where: { aNetwork: net.nId, aType: networktype },
    });
    if (!discountRow) {
      return res.status(500).json({ status: 'fail', msg: 'Airtime discount not configured for this network.' });
    }

    const userType = user.sType; // 1=user, 2=agent, 3=vendor
    let discountPct = discountRow.aUserDiscount;
    if (userType === 3) discountPct = discountRow.aVendorDiscount;
    else if (userType === 2) discountPct = discountRow.aAgentDiscount;

    const amountToPay = (amt * discountPct) / 100;
    const buyAmountFromProvider = (amt * discountRow.aBuyDiscount) / 100;
    const profit = amountToPay - buyAmountFromProvider;

    // --- 7. Check balance (fast advisory pre-check; the authoritative,
    //         race-safe check happens in the atomic debit at step 11) ---
    if (user.sWallet < amountToPay) {
      return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
    }

    // --- 8. Check min/max limits ---
    const settings = await SiteSettings.findByPk(1);
    const airtimeMin = settings ? parseFloat(settings.airtimemin) : 50;
    const airtimeMax = settings ? parseFloat(settings.airtimemax) : 5000;
    if (amt < airtimeMin) {
      return res.status(400).json({ status: 'fail', msg: `Minimum airtime purchase is ₦${airtimeMin}` });
    }
    if (amt > airtimeMax) {
      return res.status(400).json({ status: 'fail', msg: `Maximum airtime purchase is ₦${airtimeMax}` });
    }

    // --- 9. Check transaction ref uniqueness ---
    const existingRef = await Transaction.findOne({ where: { transref } });
    if (existingRef) {
      return res.status(409).json({ status: 'fail', msg: 'Transaction reference already exists.' });
    }

    // --- 10. Check for duplicate (same service+desc within 60s) ---
    // NOTE: keep servicedesc ASCII-only (use "N", never the ₦ sign). The legacy
    // `transactions.servicedesc` column is latin1, which cannot store or compare
    // the Unicode ₦ (U+20A6) — it throws "Illegal mix of collations" /
    // "Conversion ... impossible for parameter". The data/electricity/cable
    // controllers all use plain-ASCII descriptions for exactly this reason.
    const serviceName = 'Airtime';
    const serviceDesc = `${net.network} Airtime purchase of N${amt} for ${phone}`;
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

    // --- 11. Debit user wallet ATOMICALLY (row-locked; race-safe) ---
    const debit = await debitWallet(user.sId, amountToPay, {
      reason: 'purchase', reference: transref, meta: { service: 'airtime', network: net.network },
    });
    if (!debit.ok) {
      if (debit.reason === 'insufficient') {
        return res.status(400).json({ status: 'fail', msg: 'Insufficient balance. Fund your wallet and try again.' });
      }
      logger.error('Airtime debit failed', { transref, reason: debit.reason });
      return res.status(500).json({ status: 'fail', msg: 'Could not complete purchase. Please try again.' });
    }
    const oldBalance = debit.oldBalance;
    const newBalance = debit.newBalance;
    user.sWallet = newBalance; // keep the in-memory copy consistent

    // --- 12. Record transaction as "processing" (status=5) ---
    const txn = await Transaction.create({
      sId: user.sId,
      transref,
      servicename: serviceName,
      servicedesc: serviceDesc,
      amount: String(amountToPay),
      status: 5,
      oldbal: String(oldBalance),
      newbal: String(newBalance),
      profit: 0, // updated on success
    });

    // --- 13. Resolve provider (default active airtime provider) ---
    const provider = await Provider.findOne({
      where: { category: 'airtime', status: 'active', isDefault: true },
    });
    if (!provider || !provider.baseUrl || !provider.apiKey) {
      // Refund immediately (atomic)
      const refund = await refundWallet(user.sId, amountToPay, { reference: transref, meta: { service: 'airtime' } });
      // AUDIT RULE — a reversed transaction must read as net-zero on the
      // receipt: balance before == balance after. A row where the two DIFFER is
      // then, by definition, a debit that was never returned, which is the
      // signal admin needs to find it and refund by hand.
      //
      // So newbal is only pulled back to oldbal when the refund actually
      // succeeded. refundWallet can answer {ok:false} (row gone, bad amount),
      // and a failed refund that still showed net-zero would hide real money
      // owed to the user — the exact thing this rule exists to expose.
      //
      // walletRestored is set on the same condition: it tells the idempotency
      // guard the debit was undone so the key is released and the user may
      // retry. If the refund failed the guard holds the key instead and
      // answers "outcome unconfirmed", which is the honest reply.
      if (refund.ok) {
        res.locals.walletRestored = true;
        user.sWallet = refund.newBalance;
        txn.newbal = String(oldBalance);
      } else {
        logger.error('Refund failed after airtime provider unavailable', {
          transref, user: user.sId, amount: amountToPay, reason: refund.reason,
        });
      }
      txn.status = 2;
      await txn.save();
      logger.error('Airtime purchase failed: no active provider configured', { transref });
      // "not configured" is an operator fact, not customer copy — the user
      // cannot act on it and it advertises a gap in our setup.
      return res.status(500).json({
        status: 'fail',
        msg: providerFailureMessage('non-json', { refunded: refund.ok }),
      });
    }

    // --- 14. Determine network ID for provider (VTU vs Sharesell) ---
    const providerNetworkId = isVTU ? net.vtuId : net.sharesellId;

    // --- 15. Call provider ---
    const apiKey = decryptSecret(provider.apiKey);
    const providerResult = await callProviderAirtime({
      host: provider.baseUrl,
      apiKey,
      networkId: providerNetworkId,
      amount: amt,
      phone,
      ref: transref,
      airtimeType: networktype,
      portedNumber: portedFlag,
    });

    // --- 16. Handle result ---
    if (providerResult.status === 'success') {
      // Mark completed
      txn.status = 0;
      txn.profit = profit;
      await txn.save();

      // Credit referral bonus if user was referred
      if (user.sReferal) {
        await creditReferralBonus(user, serviceName, amountToPay, settings, transref);
      }

      logger.info('Airtime purchase successful', { transref, user: user.sId, amount: amountToPay });

      // Send WhatsApp receipt (async, never blocks). Airtime/data only —
      // a bonus channel to the BUYER's number.
      sendWhatsAppReceiptAsync(user, txn, net.network, amt, transref);

      // Email the branded PDF receipt to the ACCOUNT HOLDER (always-on, all
      // services). Fire-and-forget — never awaited, never blocks the response.
      emailTransactionReceipt(user, txn);

      return res.json({
        status: 'success',
        msg: 'Airtime purchase successful.',
        data: {
          transref,
          service: serviceName,
          network: net.network,
          phone,
          amount: amt,
          amountPaid: amountToPay,
          oldBalance,
          newBalance,
        },
      });
    } else {
      // Provider failed — refund user (atomic)
      const refund = await refundWallet(user.sId, amountToPay, { reference: transref, meta: { service: 'airtime' } });
      // Net-zero on the receipt only if the money genuinely came back — see the
      // AUDIT RULE note on the provider-unavailable branch above.
      if (refund.ok) {
        res.locals.walletRestored = true; // debit undone — retrying is safe
        user.sWallet = refund.newBalance;
        txn.newbal = String(oldBalance);
      } else {
        logger.error('Refund failed after airtime provider failure', {
          transref, user: user.sId, amount: amountToPay, reason: refund.reason,
        });
      }
      txn.status = 2;
      await txn.save();

      // providerResult.msg / .error / .cause / .raw are OPERATOR-ONLY. They go
      // to the file logger and stop there — this is the exact path that showed
      // a customer "your server IP is likely not whitelisted with this
      // provider". The user gets copy we wrote, keyed on the reason code.
      logger.providerError('airtime', 'purchase', providerResult.msg || 'unknown', {
        transref,
        provider: provider.name,
        host: provider.baseUrl,
        detail: providerResult.error,
        cause: providerResult.cause,
        providerResponse: providerResult.raw,
      });
      return res.status(500).json({
        status: 'fail',
        msg: providerFailureMessage(providerResult.reason, { refunded: refund.ok }),
      });
    }
  } catch (err) {
    logger.error('purchaseAirtime exception', { error: err.message, stack: err.stack, user: user.sId });
    return res.status(500).json({ status: 'fail', msg: 'Could not complete purchase. Please try again.' });
  }
}

// ========== Helpers ==========

/**
 * Verify a phone number's prefix matches the network.
 * Nigerian format: 080x (MTN), 090x (MTN), 081x (GLO), 070x (AIRTEL), etc.
 */
function verifyPhoneNumber(phone, networkName) {
  const p = String(phone).replace(/\D/g, '');
  if (p.length < 10) {
    return { valid: false, msg: 'Phone number is too short.' };
  }
  const prefix3 = p.slice(0, 3);
  const prefix4 = p.slice(0, 4);

  const net = networkName.toUpperCase();

  // MTN: 0803, 0806, 0703, 0706, 0813, 0816, 0810, 0814, 0903, 0906, 0913, 0916
  if (net === 'MTN') {
    if (['080', '070', '081', '090'].includes(prefix3)) {
      if (['0803', '0806', '0703', '0706', '0813', '0816', '0810', '0814', '0903', '0906', '0913', '0916'].includes(prefix4)) {
        return { valid: true };
      }
    }
    return { valid: false, msg: 'Phone number does not match MTN network.' };
  }

  // GLO: 0805, 0807, 0705, 0815, 0811, 0905
  if (net === 'GLO') {
    if (['080', '070', '081', '090'].includes(prefix3)) {
      if (['0805', '0807', '0705', '0815', '0811', '0905'].includes(prefix4)) {
        return { valid: true };
      }
    }
    return { valid: false, msg: 'Phone number does not match GLO network.' };
  }

  // AIRTEL: 0802, 0808, 0708, 0812, 0701, 0902, 0907, 0901, 0904, 0912
  if (net === 'AIRTEL') {
    if (['080', '070', '081', '090'].includes(prefix3)) {
      if (['0802', '0808', '0708', '0812', '0701', '0902', '0907', '0901', '0904', '0912'].includes(prefix4)) {
        return { valid: true };
      }
    }
    return { valid: false, msg: 'Phone number does not match Airtel network.' };
  }

  // 9MOBILE (T2 in UI, but DB still stores as 9MOBILE): 0809, 0818, 0817, 0909, 0908
  if (net === '9MOBILE') {
    if (['080', '081', '090'].includes(prefix3)) {
      if (['0809', '0818', '0817', '0909', '0908'].includes(prefix4)) {
        return { valid: true };
      }
    }
    return { valid: false, msg: 'Phone number does not match 9mobile network.' };
  }

  // Unknown network — allow (admin may have added a new one)
  return { valid: true };
}

/**
 * Credit referral bonus to the referrer's refWallet.
 * Bonus rate comes from SiteSettings.referalairtimebonus (default 1%),
 * applied to the transaction amount the buyer actually paid.
 */
async function creditReferralBonus(user, serviceName, txnAmount, settings, transref) {
  try {
    const bonusRate = settings?.referalairtimebonus || 1;
    const bonusAmount = (txnAmount * bonusRate) / 100;

    if (bonusAmount <= 0) return;

    // The referrer is identified by user.sReferal (phone of the person who referred this user)
    const referrer = await Subscriber.findOne({ where: { sPhone: user.sReferal } });
    if (referrer) {
      await creditRefWallet(referrer.sId, bonusAmount, {
        reference: transref, meta: { service: 'airtime', referredUser: user.sId },
      });
      logger.info('Referral bonus credited', { referrer: referrer.sId, amount: bonusAmount, service: serviceName });
    }
  } catch (err) {
    // Never block a purchase if bonus fails
    logger.error('creditReferralBonus failed', { error: err.message, stack: err.stack });
  }
}

/**
 * Send WhatsApp receipt async — never blocks the HTTP response.
 *
 * Only builds the receipt here; the provider lookup, key decryption, the
 * send itself and the "not on WhatsApp" fallback all live in ONE place
 * (services/whatsappReceiptDispatch.js), shared with the data controller,
 * so the unreachable handling cannot drift between the two.
 */
async function sendWhatsAppReceiptAsync(user, txn, networkName, amount, ref) {
  try {
    // `faceValue` is the ONLY money figure allowed out of here, and it must
    // be `amount` — the denomination the buyer asked for and can confirm by
    // dialling *556#. It arrives from the call site as `amt`.
    //
    // It is NOT `amountToPay` (amt * discountPct / 100, what the wallet was
    // debited) and NOT `buyAmountFromProvider` or `profit`. Those three are
    // computed within a few lines of each other around line 110 and are all
    // plain numbers, so nothing but the name distinguishes them — passing
    // one here would forward this reseller's margin to their own customer
    // the first time they share the receipt.
    //
    // Everything else is still scrubbed: `description` carries the price in
    // its text and sendWhatsAppReceipt runs stripMoney() over it.
    const receipt = {
      phone: user.sPhone,
      name: `${user.sFname} ${user.sLname}`,
      service: 'Airtime',
      // `network` feeds the template's own {{network}} variable. `description`
      // stays as the fallback for the plain-text (Termii) driver and is
      // stripMoney()'d before it goes anywhere.
      network: networkName,
      description: `${networkName} ₦${amount}`,
      faceValue: amount,
      ref,
      date: new Date(txn.date).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' }),
      // Not sent to WhatsApp. The dispatcher needs it to read and set the
      // per-account "not on WhatsApp" flag, and to address the fallback email.
      userId: user.sId,
    };

    await dispatchWhatsAppReceipt(user, receipt);
  } catch (err) {
    logger.error('WhatsApp receipt send failed', { error: err.message, stack: err.stack, ref });
  }
}
