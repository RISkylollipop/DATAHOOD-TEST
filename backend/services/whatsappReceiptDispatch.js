// ============================================================
//  WhatsApp Receipt Dispatch
// ------------------------------------------------------------
//  One place for everything the airtime and data controllers used to
//  duplicate: resolve the WhatsApp provider row, decrypt its keys,
//  hand the receipt to whatsappService, and — the part that MUST exist
//  exactly once — react when a number turns out not to be on WhatsApp.
//
//  Called un-awaited from the controllers (fire-and-forget), so nothing
//  here can delay or fail a purchase. It never throws.
//
//  Cable, electricity and verification do NOT come through here: there is
//  no approved Meta template for them, so they send no WhatsApp receipt at
//  all (see the controllers). Only airtime and data reach this function.
//
//  ── THIS FILE DOES NOT EMAIL THE ACCOUNT HOLDER ──
//  Every successful airtime/data purchase already emails the account holder
//  the branded PDF receipt from the controller (services/receiptEmail.js,
//  always-on for all five services). So the two reactions here that used to
//  email the receipt would now DOUBLE-send. This file keeps only the parts
//  that are WhatsApp's alone: persisting the "not on WhatsApp" fact so we
//  stop retrying, and a one-off ops heads-up to admin. The reseller still
//  gets their receipt — via the controller's email, not this one.
// ============================================================

import { Subscriber, Provider } from '../models/index.js';
import { decryptSecret } from '../utils/crypto.js';
import { sendWhatsAppReceipt } from './whatsappService.js';
import { sendReceiptFallbackEmail, adminAlertRecipient } from './emailService.js';
import * as logger from '../utils/logger.js';

/**
 * Persist the "not on WhatsApp" fact so we stop retrying, and give ops a
 * one-off heads-up. Runs only the FIRST time a number is found unreachable —
 * subsequent purchases short-circuit before WhatsApp is even attempted (see
 * dispatchWhatsAppReceipt).
 *
 * It does NOT email the account holder their receipt: the controller already
 * did that for this very purchase (always-on email). Emailing again here would
 * send the reseller two receipts for one purchase.
 */
async function markUnreachableAndNotify(user, receipt) {
  const ref = receipt?.ref;
  // Atomic column write — do not depend on `user` being a live Sequelize
  // instance, but keep the in-memory copy consistent for the rest of the req.
  await Subscriber.update(
    { sWhatsAppUnreachable: 1 },
    { where: { sId: user.sId } },
  );
  user.sWhatsAppUnreachable = 1;

  // Deliberately no phone number in the log — it is the buyer's personal data.
  logger.info('WhatsApp receipt undeliverable: number marked unreachable', {
    ref, userId: user.sId,
  });

  // Ops heads-up only. No buyer phone number; same money rule as everywhere.
  try {
    await sendReceiptFallbackEmail({
      to: adminAlertRecipient(),
      name: 'Team',
      service: `${receipt.service} (undeliverable WhatsApp)`,
      network: receipt.network,
      description: `A WhatsApp receipt for account #${user.sId} could not be delivered (recipient not on WhatsApp). The account holder already received the receipt by email. WhatsApp is now disabled for this account.`,
      faceValue: null,
      ref,
      date: receipt.date,
    });
  } catch (err) {
    logger.error('WhatsApp unreachable admin alert failed', { error: err.message, stack: err.stack, ref });
  }
}

/**
 * Send a WhatsApp receipt for an airtime or data purchase.
 *
 * @param {object} user     the buyer's account (Subscriber row / req.user)
 * @param {object} receipt  built by the controller; see whatsappService
 */
export async function dispatchWhatsAppReceipt(user, receipt) {
  const ref = receipt?.ref;
  try {
    // Known-bad number: skip WhatsApp entirely. The account holder still gets
    // their receipt from the controller's always-on email, so nothing to do
    // here but avoid firing a doomed request (and a red log line) every time.
    if (user?.sWhatsAppUnreachable) {
      logger.info('WhatsApp skipped: number previously marked unreachable', { ref, userId: user.sId });
      return;
    }

    const whatsappProvider = await Provider.findOne({
      where: { category: 'whatsapp', status: 'active', isDefault: true },
    });
    if (!whatsappProvider) {
      // Not an error: running without WhatsApp receipts is a valid config.
      // Named at info so an operator who left the row inactive or non-default
      // can see WHY no receipt went out, instead of it looking broken.
      logger.info('WhatsApp receipt skipped: no active default whatsapp provider row', {
        ref,
        hint: 'Admin → Providers → WhatsApp: set the row active and mark it default.',
      });
      return;
    }

    const cfg = {
      // Row Name, matched loosely by resolveDriver() ("Meta", "WhatsApp Cloud
      // API", "Termii" all resolve). {"provider":"meta"} in Extra config wins,
      // and failing both the credentials alone are enough.
      provider: whatsappProvider.name,
      ...JSON.parse(whatsappProvider.extraConfig || '{}'),
    };
    if (whatsappProvider.apiKey) cfg.apiKey = decryptSecret(whatsappProvider.apiKey);
    if (whatsappProvider.secretKey) cfg.token = decryptSecret(whatsappProvider.secretKey);

    const result = await sendWhatsAppReceipt(cfg, receipt);

    // The one outcome that is a fact about the number, not a transient error.
    // Everything else (send ok, skipped, param error, rate limit) is left to
    // whatsappService's own logging and is fine to retry next purchase.
    if (result && result.unreachable) {
      await markUnreachableAndNotify(user, receipt);
    }
  } catch (err) {
    // Never blocks the transaction, never swallowed. sendWhatsAppReceipt does
    // not throw on delivery failures, so anything here is a genuine bug
    // (provider row JSON, decrypt, DB) worth the stack.
    logger.error('WhatsApp receipt dispatch failed', { error: err.message, stack: err.stack, ref });
  }
}
