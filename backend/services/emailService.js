// ============================================================
//  Email Service — Resend HTTP API
// ------------------------------------------------------------
//  Used for: signup verification, password reset, transaction
//  receipts (optional), and DOWNTIME ALERTS (critical errors,
//  provider failures, database disconnects).
//
//  Moved off SMTP/nodemailer deliberately. The shared mail host
//  rejected the mailbox login outright ("535 Incorrect
//  authentication data") and serves a TLS cert for the physical
//  box rather than the mail domain, so it also needed SNI
//  overrides to connect at all. Resend is one HTTPS POST with a
//  bearer key — neither failure mode exists here.
//
//  Requires in .env:
//    RESEND_API_KEY — from resend.com/api-keys
//    MAIL_FROM      — a sender on a domain VERIFIED in Resend
//                     (mail.kwarapolydata.com.ng). Resend refuses
//                     to send from an unverified domain, so this
//                     is not interchangeable with any old mailbox.
// ============================================================

import { Resend } from 'resend';
import dotenv from 'dotenv';

dotenv.config();

/** Verified sender. Read per-call so .env edits need no code change. */
const fromAddress = () => process.env.MAIL_FROM || 'support@mail.kwarapolydata.com.ng';

/**
 * Where operational alerts go. Exported because blacklistController and
 * healthMonitor each had their own `ADMIN_ALERT_EMAIL || SMTP_USER` copy —
 * four copies of one rule, and SMTP_USER no longer exists, so those would
 * have quietly resolved to `undefined` as a recipient.
 */
export const adminAlertRecipient = () => process.env.ADMIN_ALERT_EMAIL || fromAddress();

// Built on first send, NOT at import time. `new Resend()` throws when the
// key is missing, and this module is imported by utils/logger.js — which
// nearly every other module imports. Constructing eagerly would turn a
// missing key into a server that refuses to boot, instead of a mail
// feature that reports itself unconfigured.
let client = null;
function getClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY is not set — cannot send email.');
  if (!client) client = new Resend(key);
  return client;
}

/**
 * Send a generic email. Throws on failure.
 *
 * `headers` is optional and passed through to Resend — used by the
 * newsletter for List-Unsubscribe, which mail clients turn into a native
 * "Unsubscribe" button next to the sender name.
 *
 * resend.emails.send() RESOLVES with { data, error } instead of rejecting,
 * so the error branch is converted into a throw. Every call site in this
 * codebase was written against nodemailer and depends on a rejected
 * promise to log "email failed to send" — silently resolving on a failed
 * send would make those catch blocks dead code.
 *
 * `attachments` is optional and passed straight through to Resend. Each entry
 * is { filename, content, contentType }; `content` may be a Node Buffer (the
 * transaction-receipt PDF is handed over exactly that way) or a base64 string.
 * Only spread it in when there is something to attach, so an empty array is
 * never sent.
 */
export async function sendEmail({ to, subject, text, html, headers, attachments }) {
  const { data, error } = await getClient().emails.send({
    from: `${process.env.MAIL_FROM_NAME || 'DATAHOOD'} <${fromAddress()}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
    // `html: html || text` used to hand the PLAIN-TEXT body to Resend as the
    // HTML part. Any '<' in it was then parsed as markup by the recipient's
    // mail client, so a value that reached a text-only email — a user's name,
    // a provider's error string, a transaction description — could inject
    // arbitrary HTML, including an <a> pointing anywhere. In an email the
    // platform itself sent, from a verified domain, that is a ready-made
    // phishing primitive. Escape and convert instead of reusing the string raw.
    html: html || textToHtml(text),
    ...(headers ? { headers } : {}),
    ...(attachments && attachments.length ? { attachments } : {}),
  });
  if (error) {
    // Resend's own wording ("The domain is not verified", "Invalid API key")
    // is exactly what an operator needs in the log, so pass it through.
    throw new Error(error.message || 'Resend rejected the message');
  }
  return data;
}

/**
 * DOWNTIME ALERT — send to admin immediately when critical errors occur.
 * Called automatically from logger when database, provider, or server errors detected.
 */
export async function sendDowntimeAlert(message, meta = {}) {
  const adminEmail = adminAlertRecipient();
  const timestamp = new Date().toISOString();

  const text = `
🚨 Datahood Downtime Alert

Time: ${timestamp}
Environment: ${process.env.NODE_ENV}

Error: ${message}

Details:
${JSON.stringify(meta, null, 2)}

This is an automated alert. Check logs immediately.
  `.trim();

  const html = `
<div style="font-family: sans-serif; padding: 20px; background: #fff3cd; border: 2px solid #856404; border-radius: 8px;">
  <h2 style="color: #856404;">🚨 Downtime Alert</h2>
  <p><strong>Time:</strong> ${timestamp}</p>
  <p><strong>Environment:</strong> ${escapeForEmail(process.env.NODE_ENV)}</p>
  <p><strong>Error:</strong> ${escapeForEmail(message)}</p>
  <pre style="background: #f8f9fa; padding: 10px; border-radius: 4px; overflow-x: auto;">${escapeForEmail(JSON.stringify(meta, null, 2))}</pre>
  <p><em>This is an automated alert. Check server logs immediately.</em></p>
</div>
  `;

  await sendEmail({
    to: adminEmail,
    subject: `🚨 [ALERT] Datahood Downtime: ${message.substring(0, 50)}`,
    text,
    html,
  });
}

/**
 * Send email verification code at signup.
 */
export async function sendVerificationEmail(email, name, code) {
  const subject = 'Verify Your Datahood Account';
  const text = `Hi ${name},\n\nYour verification code is: ${code}\n\nEnter this code to activate your account.\n\nThank you,\n Datahood Team`;
  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>Verify Your Account</h2>
  <p>Hi <strong>${escapeForEmail(name)}</strong>,</p>
  <p>Your verification code is:</p>
  <div style="background: #f0f0f0; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 4px; border-radius: 8px;">
    ${code}
  </div>
  <p>Enter this code on the website to activate your account.</p>
  <p>If you didn't sign up, please ignore this email.</p>
  <p>Thank you,<br>Datahood Team</p>
</div>
  `;
  await sendEmail({ to: email, subject, text, html });
}

/**
 * Send password reset link/code.
 */
export async function sendPasswordResetEmail(email, name, resetToken) {
  const resetLink = `${process.env.CLIENT_ORIGINS?.split(',')[0]}/reset-password?token=${resetToken}`;
  const subject = 'Reset Your Password';
  const text = `Hi ${name},\n\nClick this link to reset your password:\n${resetLink}\n\nThis link expires in 1 hour.\n\n Datahood Team`;
  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2>Reset Your Password</h2>
  <p>Hi <strong>${escapeForEmail(name)}</strong>,</p>
  <p>Click the button below to reset your password:</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="${escapeForEmail(resetLink)}" style="background: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a>
  </div>
  <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
  <p>Datahood Team</p>
</div>
  `;
  await sendEmail({ to: email, subject, text, html });
}

// ============================================================
//  Wallet + transaction notifications
// ------------------------------------------------------------
//  Mirrors the legacy PHP behaviour: the user is emailed whenever
//  their wallet is funded or adjusted by an admin, and whenever a
//  standalone transaction (e.g. a deposit) completes. These are
//  ALWAYS fire-and-forget at the call site — a mail failure must
//  never block or roll back a money movement.
// ============================================================

const SITE_NAME = process.env.MAIL_FROM_NAME || 'Datahood';

function naira(n) {
  const v = Number(n || 0);
  return 'N' + v.toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * Wallet credit/debit email (admin adjustment or funding).
 * Mirrors legacy AdminModel wallet-adjust mail: greeting + amount +
 * old/new balance. `kind` is 'credit' or 'debit'.
 */
export async function sendWalletEmail({ to, name, kind, amount, oldBalance, newBalance, reason, walletLabel }) {
  if (!to) return;
  const action = kind === 'debit' ? 'debited' : 'credited';
  const title = `${walletLabel || 'Wallet'} ${kind === 'debit' ? 'Debit' : 'Credit'}`;
  const subject = `${title} (${SITE_NAME})`;
  // Every interpolated value below is escaped. `reason` and `walletLabel` are
  // typed by an admin, and `name` is whatever the user put in their profile —
  // all three land in an email the platform sends from a verified domain, which
  // makes an injected <a> a credible phishing link rather than a cosmetic bug.
  const reasonLine = reason ? `<p style="color:#555;margin:6px 0 0">Reason: ${escapeForEmail(reason)}</p>` : '';
  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="margin:0 0 10px">${escapeForEmail(title)}</h2>
  <p>Hi <strong>${escapeForEmail(name || 'there')}</strong>, your account has been <strong>${action}</strong> with ${naira(amount)}.</p>
  ${reasonLine}
  <div style="background:#f5f5f5;padding:12px 16px;border-radius:8px;margin-top:12px">
    <div>Old Balance: <strong>${naira(oldBalance)}</strong></div>
    <div>New Balance: <strong>${naira(newBalance)}</strong></div>
  </div>
  <p style="margin-top:18px;color:#555">Thank you for Trusting Us,<br/>${SITE_NAME} Team</p>
</div>
  `.trim();
  const text = `Hi ${name || 'there'}, your account has been ${action} with ${naira(amount)}.`
    + (reason ? ` Reason: ${reason}.` : '')
    + ` Old Balance: ${naira(oldBalance)}. New Balance: ${naira(newBalance)}.`;
  await sendEmail({ to, subject, text, html });
}

/**
 * Generic transaction email (deposit success, etc.).
 * Mirrors legacy ApiModel::sendEmailNotification($subject,$message,$email),
 * which appended "(sitename)" to the subject.
 */
export async function sendTransactionEmail({ to, servicename, message }) {
  if (!to) return;
  const subject = `${servicename} (${SITE_NAME})`;
  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="margin:0 0 10px">${escapeForEmail(servicename)}</h2>
  <p>${escapeForEmail(message)}</p>
  <p style="margin-top:18px;color:#555">Thank you,<br/>${SITE_NAME} Team</p>
</div>
  `.trim();
  const text = String(message).replace(/<[^>]+>/g, '');
  await sendEmail({ to, subject, text, html });
}


export async function sendReceiptFallbackEmail({
  to, name, service, network, description, faceValue, ref, date,
}) {
  if (!to) return;
  const subject = `${service} Receipt (${SITE_NAME})`;

  const rows = [
    ['Network', network],
    ['Details', description],
    // Only when the service actually named one — airtime. naira() renders an
    // ASCII "N", never the ₦ glyph, consistent with the servicedesc rule.
    faceValue != null && faceValue !== '' ? ['Amount', naira(faceValue)] : null,
    ['Reference', ref],
    ['Date', date],
  ].filter(Boolean);

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555">${escapeForEmail(k)}</td>` +
        `<td style="padding:4px 0"><strong>${escapeForEmail(v)}</strong></td></tr>`,
    )
    .join('');

  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="margin:0 0 4px">Transaction Receipt</h2>
  <p style="margin:0 0 14px">Hi ${escapeForEmail(name || 'there')}, your ${escapeForEmail(service)} transaction was successful.</p>
  <p style="margin:0 0 10px;color:#555">We could not reach this number on WhatsApp, so here is your receipt by email.</p>
  <table style="border-collapse:collapse;font-size:14px">${rowsHtml}</table>
  <p style="margin-top:18px;color:#555">Thank you for choosing ${BRAND}.<br/>${SITE_NAME} Team</p>
</div>
  `.trim();

  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  await sendEmail({ to, subject, text, html });
}

export async function sendReceiptEmail({ to, name, service, ref, date, attachment }) {
  if (!to) return;
  const svc = service || 'Transaction';
  const subject = `${svc} Receipt (${SITE_NAME})`;

  const rows = [
    ['Service', svc],
    ['Reference', ref],
    ['Date', date],
  ].filter(([, v]) => v != null && v !== '');

  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555">${escapeForEmail(k)}</td>` +
        `<td style="padding:4px 0"><strong>${escapeForEmail(v)}</strong></td></tr>`,
    )
    .join('');

  const attachLine = attachment
    ? '<p style="margin:0 0 10px;color:#555">Your receipt is attached as a PDF.</p>'
    : '';

  const html = `
<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="margin:0 0 4px">Transaction Receipt</h2>
  <p style="margin:0 0 14px">Hi ${escapeForEmail(name || 'there')}, your ${escapeForEmail(svc)} transaction was successful.</p>
  ${attachLine}
  <table style="border-collapse:collapse;font-size:14px">${rowsHtml}</table>
  <p style="margin-top:18px;color:#555">Thank you for choosing ${BRAND}.<br/>${SITE_NAME} Team</p>
</div>
  `.trim();

  const text = [
    `Hi ${name || 'there'}, your ${svc} transaction was successful.`,
    attachment ? 'Your receipt is attached as a PDF below.' : '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
  ].filter(Boolean).join('\n');

  await sendEmail({
    to,
    subject,
    text,
    html,
    attachments: attachment ? [attachment] : undefined,
  });
}


// ============================================================
//  Newsletter — marketing mail
// ------------------------------------------------------------
//  Kept apart from everything above, because the rules are different.
//  The mail above is TRANSACTIONAL: it answers something the recipient
//  just did, and they cannot opt out of a receipt for their own purchase.
//  The mail below is MARKETING: it goes to people who did nothing today,
//  so it must carry proof of consent and a way out of it, and it must
//  never be sent to a `subscribers` row just because that row has an
//  email column.
// ============================================================

// The customer-facing brand. `Datahood` is the domain the business
// operates under; Datahood is what the audience actually recognises, and
// it is what the landing page, the receipts and the app header all say.
// A newsletter signed with a name the reader has never seen gets marked as
// spam, so this is a deliverability decision as much as a branding one.

const BRAND = process.env.PUBLIC_BRAND || 'Datahood';

/** First absolute origin from CLIENT_ORIGINS — where the links must point. */
export function siteOrigin() {
  const first = String(process.env.CLIENT_ORIGINS || '').split(',')[0].trim();
  return first || 'https://app.datahood.kwarapolydata.com.ng';
}


export function newsletterShell({ title, bodyHtml, unsubscribeUrl, preheader }) {
  const origin = siteOrigin();
  // `title` and `preheader` come from the admin's subject line and are NOT
  // run through utils/richText.js — only the body is. Escaping them here
  // means a subject containing `</title><script>` is text, not markup.
  // bodyHtml is deliberately not escaped: it is already the sanitised
  // output of renderRichText().
  const safeTitle = escapeForEmail(title);
  const safePre = escapeForEmail(preheader || '');
  const safeUnsub = unsubscribeUrl ? escapeForEmail(unsubscribeUrl) : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${safeTitle}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-font-smoothing:antialiased">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden">${safePre}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,.08)">
    <tr><td style="padding:24px 30px;border-bottom:1px solid #e2e8f0">
      <span style="font:700 20px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1d4ed8;letter-spacing:-.4px">${BRAND}</span>
    </td></tr>
    <tr><td style="padding:30px;font:15px/1.65 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1e293b">
${bodyHtml}
    </td></tr>
    <tr><td style="padding:22px 30px;background:#f8fafc;border-top:1px solid #e2e8f0;font:12px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#64748b">
      <p style="margin:0 0 8px">${BRAND} — You Trusted Data Partner since 2021.</p>
      ${safeUnsub ? `<p style="margin:0">You are receiving this because you confirmed a subscription at <a href="${origin}" style="color:#475569">${origin.replace(/^https?:\/\//, '')}</a>.<br/>
      <a href="${safeUnsub}" style="color:#475569;text-decoration:underline">Unsubscribe</a> at any time — one click, no questions.</p>`
    : '<p style="margin:0">This is a one-off message about your subscription, not a marketing email.</p>'}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

/**
 * Step one of double opt-in: ask the address to prove it wants this.
 *
 * Deliberately NOT a "welcome" email. Nothing is subscribed yet, and
 * saying otherwise to someone whose address was typed in by a stranger is
 * both a lie and the thing that generates spam complaints.
 */
export async function sendNewsletterConfirmEmail({ to, name, confirmUrl }) {
  const greeting = name ? `Hi ${escapeForEmail(name)},` : 'Hi,';
  const bodyHtml = `
      <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3;color:#0f172a">Confirm your subscription</h1>
      <p style="margin:0 0 14px">${greeting}</p>
      <p style="margin:0 0 18px">Someone — hopefully you — asked to receive updates from ${BRAND}: new data plans, price drops and service notices. Click below to confirm and we will add you to the list.</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 22px">
        <tr><td style="background:#1d4ed8;border-radius:8px">
          <a href="${confirmUrl}" style="display:inline-block;padding:13px 30px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px">Yes, subscribe me</a>
        </td></tr>
      </table>
      <p style="margin:0 0 14px;color:#475569">The link expires in 48 hours.</p>
      <p style="margin:0;color:#475569"><strong>Did not request this?</strong> Then do nothing at all. Without that click you will not be subscribed and you will not hear from us again.</p>`;
  const text = `${greeting}

Someone asked to subscribe this address to updates from ${BRAND}.

Confirm here (expires in 48 hours):
${confirmUrl}

If you did not request this, ignore this email — without that click you will not be subscribed and you will not hear from us again.`;

  await sendEmail({
    to,
    subject: `Confirm your ${BRAND} subscription`,
    text,
    html: newsletterShell({
      title: 'Confirm your subscription',
      bodyHtml,
      preheader: 'One click to confirm — then we will stop asking.',
    }),
  });
}

/**
 * One campaign email to one recipient.
 *
 * The List-Unsubscribe headers are what make Gmail and Apple Mail show a
 * native "Unsubscribe" link beside the sender. That link is the reason to
 * add them: a reader who wants out will otherwise reach for "Report spam",
 * and spam complaints are scored against the whole sending domain — the
 * same domain that carries password resets and receipts.
 */
export async function sendNewsletterCampaignEmail({ to, subject, bodyHtml, bodyText, unsubscribeUrl, preheader }) {
  const html = newsletterShell({ title: subject, bodyHtml, unsubscribeUrl, preheader });
  const text = `${bodyText}

—
${BRAND}
Unsubscribe: ${unsubscribeUrl}`;

  await sendEmail({
    to,
    subject,
    text,
    html,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      // RFC 8058. Without it, a client that offers one-click unsubscribe
      // has to fall back to opening the URL in a browser, and many simply
      // hide the button instead.
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });
}

/**
 * Minimal escaping for values interpolated into the email shells above.
 *
 * utils/richText.js does the real work for campaign bodies; this covers
 * the small stuff (a subscriber's name) so a name containing `<` cannot
 * break the surrounding markup.
 *
 * Exported so other modules that build their own HTML bodies — the password
 * reset and OTP mails, which interpolate `sFname` — escape identically rather
 * than each growing a slightly different copy of this.
 */
export function escapeForEmail(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Turn a plain-text body into a safe HTML part.
 *
 * Used when a caller supplied only `text`. Escaping alone would collapse every
 * line break, so the escaped output keeps its shape inside a <pre>-like block
 * rather than being re-parsed as markup. Escaping happens FIRST; converting
 * newlines to <br> afterwards is what keeps the inserted tags from being
 * escaped in turn.
 */
function textToHtml(text) {
  const safe = escapeForEmail(text).replace(/\r?\n/g, '<br>');
  return `<div style="font-family: sans-serif; font-size: 15px; line-height: 1.6; color: #1f2937;">${safe}</div>`;
}
