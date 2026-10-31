// ============================================================
//  Transaction Receipt Email — always-on, all five services
// ------------------------------------------------------------
//  One entry point the purchase controllers call after a SUCCESSFUL
//  transaction: airtime, data, cable TV, electricity and verification.
//  It renders the branded PDF receipt and emails it to the ACCOUNT
//  HOLDER (the reseller, user.sEmail).
//
//  This is independent of WhatsApp. WhatsApp (airtime/data only) is a
//  bonus channel to the BUYER; this email is the reliable record for the
//  account holder and works for every service, whether or not WhatsApp is
//  configured. Because it always fires, the WhatsApp dispatcher no longer
//  emails the account holder itself (that would double-send) — see
//  services/whatsappReceiptDispatch.js.
//
//  Fire-and-forget: called WITHOUT await from the controllers, and it
//  never throws — a mail or PDF failure must never touch a purchase that
//  already completed.
//
//  MONEY RULE (hard — receipt carries no amount): the PDF and the email
//  body both omit every figure. The reseller sees amounts in their
//  dashboard; the receipt they forward to their own customer must not
//  reveal their margin. See utils/transactionReceipt.js.
//
//  PII: verification also flows through here, but the receipt is built
//  from the TRANSACTION row — whose servicedesc is masked
//  ("NIN verification for ******1234") — never from the verified identity
//  slip. The slip (real name, DOB, photo, the looked-up ID) stays behind
//  the authenticated download endpoint and is never emailed.
// ============================================================

import { renderReceiptPdfBuffer } from '../utils/transactionReceipt.js';
import { sendReceiptEmail } from './emailService.js';
import * as logger from '../utils/logger.js';

/**
 * Email the account holder their transaction receipt with the PDF attached.
 *
 * @param {object} user  the account holder (req.user / Subscriber row)
 * @param {object} txn   the completed Transaction row
 *   Uses { transref, servicename, servicedesc, status, date }. `amount`,
 *   `oldbal`, `newbal` are intentionally NOT read — the renderer ignores them
 *   and the body never shows money.
 */
export async function emailTransactionReceipt(user, txn) {
  const ref = txn?.transref;
  try {
    const to = user?.sEmail;
    if (!to) {
      // Not an error: plenty of legacy accounts have no email. Logged so it is
      // explainable why a given purchase produced no receipt email.
      logger.info('Receipt email skipped: account has no email on file', { ref, userId: user?.sId });
      return;
    }

    const accountName = [user.sFname, user.sLname].filter(Boolean).join(' ').trim() || null;
    const service = txn.servicename;
    const dateDisplay = txn.date
      ? new Date(txn.date).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })
      : '';

    // Build the PDF. If it fails, fall through with no attachment — the receipt
    // still goes out as a plain email rather than not at all.
    let attachment = null;
    try {
      const buffer = await renderReceiptPdfBuffer({
        txn: {
          transref: txn.transref,
          servicename: txn.servicename,
          servicedesc: txn.servicedesc,
          status: txn.status,
          date: txn.date,
        },
        accountName,
      });
      const safeRef = String(txn.transref || 'receipt').replace(/[^a-zA-Z0-9_-]/g, '');
      attachment = {
        filename: `receipt-${safeRef}.pdf`,
        content: buffer,
        contentType: 'application/pdf',
      };
    } catch (err) {
      logger.error('Receipt PDF generation failed; sending text-only receipt email', {
        error: err.message, stack: err.stack, ref,
      });
    }

    await sendReceiptEmail({
      to,
      name: accountName,
      service,
      ref,
      date: dateDisplay,
      attachment,
    });

    logger.info('Receipt email sent', { ref, userId: user.sId, withPdf: Boolean(attachment) });
  } catch (err) {
    // The whole point: never let a receipt failure reach the purchase flow.
    logger.error('Receipt email failed', { error: err.message, stack: err.stack, ref });
  }
}
