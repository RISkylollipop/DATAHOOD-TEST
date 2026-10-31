// ============================================================
//  controllers/newsletterController.js
// ------------------------------------------------------------
//  The marketing list: a public double-opt-in signup, and an admin
//  composer that mails the confirmed addresses.
//
//  Three rules shape everything in this file.
//
//  1. CONSENT IS EVIDENCE, NOT A BOOLEAN.
//     Every row records when consent was given, from which IP, through
//     which form, and — separately — when the confirmation link was
//     clicked. The click is the consent that counts. If the business is
//     ever asked to show that a particular person agreed to be mailed,
//     "status = confirmed" is not an answer; a timestamp, an address and
//     a source is.
//
//  2. THE LIST IS NOT THE USER TABLE.
//     `subscribers` rows are customers. Having an account permits
//     SERVICE mail — receipts, resets, notices — because there is a
//     contract. It does not permit marketing. So this file never reads
//     from `subscribers`, and the admin composer has no "email all my
//     users" option, however tempting that is to add.
//
//  3. THE MARKETING LIST AND THE TRANSACTIONAL MAIL SHARE ONE
//     REPUTATION. Both leave the same verified domain. Send unwanted
//     mail, collect complaints, and the domain gets throttled — and the
//     first casualties are password resets and receipts, which look to
//     the customer like the site is broken. Every throttle, cooldown and
//     unsubscribe affordance here is protecting those, not the campaign.
// ============================================================

import crypto from 'crypto';
import { Op } from 'sequelize';
import NewsletterSubscriber from '../models/NewsletterSubscriber.js';
import NewsletterCampaign from '../models/NewsletterCampaign.js';
import * as logger from '../utils/logger.js';
import { handleSchemaDrift } from '../utils/dbErrors.js';
import { renderRichText, renderPlainText, wordCount } from '../utils/richText.js';
import {
  sendNewsletterConfirmEmail,
  sendNewsletterCampaignEmail,
  newsletterShell,
  siteOrigin,
} from '../services/emailService.js';

const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000; // 48h — generous; people read mail late
const RESEND_COOLDOWN_MS = 5 * 60 * 1000;   // per-address, survives IP rotation

// Batch size and pause between batches. Resend's API is per-request, so a
// 4,000-address list is 4,000 HTTPS calls; firing them all at once would
// trip provider rate limits and look like a burst attack to receiving
// domains. Slow and steady also gives the campaign row time to record
// progress, so a crash mid-send leaves a truthful sentCount rather than a
// zero.
const BATCH_SIZE = 20;
const BATCH_PAUSE_MS = 1100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Deliberately permissive. A regex cannot decide whether an address
 * exists — only the confirmation email can, and that is the whole point
 * of double opt-in. This rejects the obviously-not-an-address so the
 * mistyped entry fails in the form rather than silently never arriving.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

const normaliseEmail = (raw) => String(raw ?? '').trim().toLowerCase();

/** SHA-256, hex. The token is emailed; only this ever touches the database. */
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Client IP for the consent record.
 *
 * `req.ip` is correct here because server.js sets `trust proxy` — without
 * that it would record the reverse proxy's address on every row, which is
 * worse than recording nothing because it looks like real evidence.
 */
const clientIp = (req) => String(req.ip || req.connection?.remoteAddress || '').slice(0, 45);

const confirmUrlFor = (token) => `${siteOrigin()}/newsletter/confirm?token=${token}`;
const unsubscribeUrlFor = (token) => `${siteOrigin()}/newsletter/unsubscribe?token=${token}`;

// ============================================================
//  PUBLIC
// ============================================================

/**
 * POST /newsletter/subscribe   { email, name?, source? }
 *
 * Always answers the same way, whatever the address's real state.
 *
 * That uniformity is the point. A response that distinguished "you are
 * now subscribed" from "you are already subscribed" would turn this open
 * form into an address-membership oracle: type an address, read the
 * reply, learn whether that person is a customer of this site. The reply
 * below is true in every branch — a confirmation link has been sent, or
 * the address is already on the list and needs nothing.
 */
export async function subscribe(req, res) {
  try {
    const email = normaliseEmail(req.body?.email);
    const name = String(req.body?.name ?? '').trim().slice(0, 80) || null;
    const source = String(req.body?.source ?? 'landing').trim().slice(0, 40) || 'landing';

    if (!email || !EMAIL_RE.test(email) || email.length > 190) {
      return res.status(422).json({
        status: 'fail',
        msg: 'Please enter a valid email address.',
      });
    }

    const generic = {
      status: 'success',
      msg: 'Almost done — check your inbox for a confirmation link. If you do not see it, look in spam.',
    };

    const existing = await NewsletterSubscriber.findOne({ where: { email } });
    const now = new Date();

    // Already confirmed: do nothing at all. Re-sending a confirmation to a
    // confirmed address is a free way to spam someone who is already on
    // the list, using the list's own form.
    if (existing && existing.status === 'confirmed') return res.json(generic);

    // Previously unsubscribed: this is a fresh, deliberate re-opt-in, so
    // it must go back through confirmation rather than silently flipping
    // the row back on. Someone who once left should have to say yes again.
    // Falls through to the pending path below.

    if (existing) {
      // Per-address cooldown. The IP-keyed limiter in middleware handles
      // the crude flood; this is what stops the same victim's inbox being
      // filled from a rotating pool of addresses.
      if (existing.confirmExpiresAt
        && existing.updatedAt
        && now - new Date(existing.updatedAt) < RESEND_COOLDOWN_MS
        && existing.status === 'pending') {
        return res.json(generic);
      }

      const token = crypto.randomBytes(24).toString('hex');
      await existing.update({
        name: name || existing.name,
        status: 'pending',
        source,
        confirmTokenHash: hashToken(token),
        confirmExpiresAt: new Date(now.getTime() + CONFIRM_TTL_MS),
        consentAt: now,
        consentIp: clientIp(req),
        unsubscribedAt: null,
        updatedAt: now,
      });
      await mailConfirmation(existing.email, existing.name, token);
      return res.json(generic);
    }

    const token = crypto.randomBytes(24).toString('hex');
    const created = await NewsletterSubscriber.create({
      email,
      name,
      status: 'pending',
      source,
      confirmTokenHash: hashToken(token),
      confirmExpiresAt: new Date(now.getTime() + CONFIRM_TTL_MS),
      // The unsubscribe token is minted NOW, not at confirmation time, and
      // never changes. Every campaign links to it, and those links live
      // forever in people's inboxes — a rotating token would turn an old
      // newsletter's unsubscribe link into a dead end, which is precisely
      // when someone reaches for "report spam" instead.
      unsubscribeToken: crypto.randomBytes(16).toString('hex'),
      consentAt: now,
      consentIp: clientIp(req),
      createdAt: now,
      updatedAt: now,
    });

    await mailConfirmation(created.email, created.name, token);
    return res.json(generic);
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'newsletter.subscribe', audience: 'user' })) return undefined;
    logger.error('Newsletter subscribe failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      status: 'fail',
      msg: 'Could not complete signup right now. Please try again shortly.',
    });
  }
}

/**
 * Send the confirmation, but never let a mail failure fail the request.
 *
 * The row is already written and the token is already valid; a bounced
 * send is a delivery problem, not a signup problem. Surfacing it would
 * also leak whether the address exists — a hard bounce on a fake address
 * would answer the question the generic response is designed not to.
 */
async function mailConfirmation(email, name, token) {
  try {
    await sendNewsletterConfirmEmail({ to: email, name, confirmUrl: confirmUrlFor(token) });
  } catch (err) {
    // Log the failure and the domain, never the full address: this log is
    // read often and should not slowly accumulate a copy of the list.
    logger.error('Newsletter confirmation email failed', {
      domain: String(email).split('@')[1] || 'unknown',
      error: err.message, stack: err.stack,
    });
  }
}

/**
 * GET|POST /newsletter/confirm?token=…
 *
 * The click that actually creates the subscription.
 */
export async function confirm(req, res) {
  try {
    const token = String(req.query?.token || req.body?.token || '').trim();
    if (!token) {
      return res.status(422).json({ status: 'fail', msg: 'That confirmation link is not valid.' });
    }

    const row = await NewsletterSubscriber.findOne({ where: { confirmTokenHash: hashToken(token) } });

    // No row means the token was already burned by an earlier click, or it
    // never existed. Those are indistinguishable by design — the hash is
    // nulled on use — so both get the same wording, phrased so that the
    // common case (a second click, or a mail client prefetching the link)
    // does not read as "something went wrong".
    if (!row) {
      const msg = 'This link has already been used, or it has expired. If you are not receiving our emails, please sign up again.';
      return res.status(410).json({ status: 'fail', msg });
    }

    if (row.confirmExpiresAt && new Date() > new Date(row.confirmExpiresAt)) {
      return res.status(410).json({
        status: 'fail',
        msg: 'That confirmation link has expired. Please sign up again and we will send a fresh one.',
      });
    }

    const now = new Date();
    await row.update({
      status: 'confirmed',
      confirmedAt: now,
      // Burn the token. One link, one use — so a forwarded email cannot be
      // replayed, and so the "already used" branch above is reachable.
      confirmTokenHash: null,
      confirmExpiresAt: null,
      unsubscribedAt: null,
      updatedAt: now,
    });

    logger.info('Newsletter subscription confirmed', { id: row.id, source: row.source });
    return res.json({
      status: 'success',
      msg: 'You are subscribed. Thank you!',
      data: { email: row.email, unsubscribeToken: row.unsubscribeToken },
    });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'newsletter.confirm', audience: 'user' })) return undefined;
    logger.error('Newsletter confirm failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not confirm right now. Please try again shortly.' });
  }
}

/**
 * GET|POST /newsletter/unsubscribe?token=…
 *
 * Must work in one click, with no login, no confirmation step and no
 * "tell us why" — the alternative the reader will choose is the spam
 * button, which costs the whole domain's deliverability.
 *
 * Also handles RFC 8058 one-click POSTs from Gmail and Apple Mail, which
 * arrive as a form post with no session and no CSRF token. Unauthenticated
 * is fine because the token IS the credential and the only thing it can do
 * is stop mail.
 *
 * The row is kept, not deleted. A deleted address is one that can be
 * re-added by the next import or signup with nobody the wiser; a row that
 * says "unsubscribed at 14:02" is a record that survives.
 */
export async function unsubscribe(req, res) {
  try {
    const token = String(req.query?.token || req.body?.token || '').trim();
    if (!token) {
      return res.status(422).json({ status: 'fail', msg: 'That unsubscribe link is not valid.' });
    }

    const row = await NewsletterSubscriber.findOne({ where: { unsubscribeToken: token } });

    // Unknown token still reports success. There is nothing to protect by
    // saying "no such subscriber", and someone clicking unsubscribe wants
    // one thing: to be told they will not be mailed again. That is true
    // either way.
    if (!row) {
      return res.json({ status: 'success', msg: 'You have been unsubscribed. You will not receive further emails from us.' });
    }

    if (row.status !== 'unsubscribed') {
      const now = new Date();
      await row.update({ status: 'unsubscribed', unsubscribedAt: now, updatedAt: now });
      logger.info('Newsletter unsubscribe', { id: row.id });
    }

    return res.json({
      status: 'success',
      msg: 'You have been unsubscribed. You will not receive further emails from us.',
    });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'newsletter.unsubscribe', audience: 'user' })) return undefined;
    logger.error('Newsletter unsubscribe failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not process that right now. Please try again shortly.' });
  }
}

// ============================================================
//  ADMIN
// ============================================================

/**
 * GET /admin/newsletter/subscribers?status=&q=&page=
 *
 * Returns addresses, because the operator needs to see who is on their
 * own list. Paginated rather than dumped: a single unbounded response is
 * how a list ends up in a browser cache, a screenshot or a support chat.
 */
export async function listSubscribers(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query?.limit, 10) || 50));
    const status = String(req.query?.status || '').trim();
    const q = String(req.query?.q || '').trim();

    const where = {};
    if (['pending', 'confirmed', 'unsubscribed'].includes(status)) where.status = status;
    if (q) where.email = { [Op.like]: `%${q}%` };

    const { rows, count } = await NewsletterSubscriber.findAndCountAll({
      where,
      order: [['id', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      attributes: [
        'id', 'email', 'name', 'status', 'source',
        'consentAt', 'consentIp', 'confirmedAt', 'unsubscribedAt', 'lastSentAt', 'createdAt',
      ],
    });

    return res.json({
      status: 'success',
      data: {
        subscribers: rows,
        total: count,
        page,
        limit,
        pages: Math.max(1, Math.ceil(count / limit)),
      },
    });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'newsletter.listSubscribers', audience: 'admin' })) return undefined;
    logger.error('Newsletter subscriber list failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load subscribers.' });
  }
}

/** GET /admin/newsletter/stats — the counts the composer shows before sending. */
export async function stats(req, res) {
  try {
    const [confirmed, pending, unsubscribed] = await Promise.all([
      NewsletterSubscriber.count({ where: { status: 'confirmed' } }),
      NewsletterSubscriber.count({ where: { status: 'pending' } }),
      NewsletterSubscriber.count({ where: { status: 'unsubscribed' } }),
    ]);

    const recent = await NewsletterCampaign.findAll({
      order: [['id', 'DESC']],
      limit: 10,
    });

    return res.json({
      status: 'success',
      data: {
        confirmed,
        pending,
        unsubscribed,
        total: confirmed + pending + unsubscribed,
        campaigns: recent,
      },
    });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'newsletter.stats', audience: 'admin' })) return undefined;
    logger.error('Newsletter stats failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load newsletter stats.' });
  }
}

/**
 * POST /admin/newsletter/preview  { subject, body }
 *
 * Renders on the SERVER and returns HTML, rather than shipping the
 * renderer to the browser and rendering there. Two reasons: the preview
 * is then literally the bytes that will be mailed, and there is exactly
 * one renderer to audit instead of two implementations that can drift.
 *
 * Returns the full document — header, footer and unsubscribe line — for
 * the same reason. A preview of only the body hides the two parts of the
 * email most likely to be wrong.
 */
export function preview(req, res) {
  const body = String(req.body?.body ?? '');
  const subject = String(req.body?.subject ?? '').trim();
  const html = renderRichText(body);
  const words = wordCount(body);
  return res.json({
    status: 'success',
    data: {
      html,
      fullHtml: newsletterShell({
        title: subject || 'Newsletter preview',
        bodyHtml: html,
        unsubscribeUrl: `${siteOrigin()}/newsletter/unsubscribe?token=preview`,
        preheader: 'Preview',
      }),
      text: renderPlainText(body),
      words,
      // ~200 wpm, floored at one minute. A hint for the composer, not a
      // promise — but a 3,000-word newsletter is worth noticing before
      // it goes to the whole list.
      minutes: Math.max(1, Math.round(words / 200)),
    },
  });
}

function validateCampaign({ subject, body }) {
  const errors = [];
  const s = String(subject ?? '').trim();
  const b = String(body ?? '').trim();
  if (!s) errors.push('A subject line is required.');
  if (s.length > 200) errors.push('Subject must be 200 characters or fewer.');
  if (!b) errors.push('The message body is empty.');
  if (b.length > 100000) errors.push('The message is too long.');
  return { errors, subject: s, body: b };
}

/**
 * POST /admin/newsletter/test  { subject, body, to? }
 *
 * Sends one copy to the admin's own address. Worth its own endpoint:
 * every mail client renders differently, and the only honest preview of
 * an email is that email, arrived, in a real inbox.
 *
 * Defaults to the acting admin's `sysEmail` rather than accepting an
 * arbitrary recipient by default — otherwise "test send" is an
 * unmetered way to mail any address on earth from a trusted domain.
 */
export async function sendTest(req, res) {
  try {
    const { errors, subject, body } = validateCampaign(req.body || {});
    if (errors.length) return res.status(422).json({ status: 'fail', msg: errors.join(' ') });

    const to = normaliseEmail(req.body?.to) || normaliseEmail(req.admin?.sysEmail);
    if (!to || !EMAIL_RE.test(to)) {
      return res.status(409).json({
        status: 'fail',
        msg: 'No address to send the test to. Set an email on your admin profile first.',
      });
    }

    await sendNewsletterCampaignEmail({
      to,
      subject: `[TEST] ${subject}`,
      bodyHtml: renderRichText(body),
      bodyText: renderPlainText(body),
      // A real, working unsubscribe token is not available for a test
      // recipient who may not be on the list, so point at the site's own
      // page. The link must still exist: a test that omits it is not a
      // test of what subscribers will receive.
      unsubscribeUrl: `${siteOrigin()}/newsletter/unsubscribe`,
      preheader: 'Test send — this is how the campaign will look.',
    });

    logger.info('Newsletter test sent', { by: req.admin?.sysId });
    return res.json({ status: 'success', msg: `Test sent to ${to}. Check the inbox — and the spam folder.` });
  } catch (err) {
    logger.error('Newsletter test send failed', { error: err.message, stack: err.stack });
    return res.status(502).json({
      status: 'fail',
      msg: `Could not send the test: ${err.message}`,
    });
  }
}

/**
 * POST /admin/newsletter/send  { subject, body, confirmText }
 *
 * The irreversible one.
 *
 * `confirmText` must equal the recipient count. It is not decoration: the
 * one mistake this endpoint cannot take back is being pressed by someone
 * who thought they were pressing "test", and typing the number forces a
 * look at how many people that is.
 *
 * Responds as soon as the campaign row exists and the send has started,
 * rather than holding the request open for what may be several minutes.
 * The row is the source of truth for progress, which is what makes "did
 * Tuesday's mail actually go out?" answerable later, and stops a nervous
 * operator sending it a second time.
 */
export async function sendCampaign(req, res) {
  let campaign = null;
  try {
    const { errors, subject, body } = validateCampaign(req.body || {});
    if (errors.length) return res.status(422).json({ status: 'fail', msg: errors.join(' ') });

    // Only confirmed addresses. Never pending (they did not finish opting
    // in) and never unsubscribed (they explicitly left).
    const recipients = await NewsletterSubscriber.findAll({
      where: { status: 'confirmed' },
      attributes: ['id', 'email', 'name', 'unsubscribeToken'],
      order: [['id', 'ASC']],
    });

    if (!recipients.length) {
      return res.status(409).json({
        status: 'fail',
        msg: 'There are no confirmed subscribers to send to yet.',
      });
    }

    const typed = String(req.body?.confirmText ?? '').trim();
    if (typed !== String(recipients.length)) {
      return res.status(409).json({
        status: 'fail',
        msg: `Type ${recipients.length} to confirm you are mailing ${recipients.length} ${recipients.length === 1 ? 'person' : 'people'}. This cannot be undone.`,
        data: { recipientCount: recipients.length },
      });
    }

    // A send already running: refuse rather than interleave two campaigns
    // through the same throttle and double-mail everyone.
    const inFlight = await NewsletterCampaign.findOne({ where: { status: 'sending' } });
    if (inFlight) {
      return res.status(409).json({
        status: 'fail',
        msg: `A campaign ("${inFlight.subject}") is still sending. Wait for it to finish before starting another.`,
      });
    }

    campaign = await NewsletterCampaign.create({
      subject,
      body,
      audience: 'newsletter',
      status: 'sending',
      recipientCount: recipients.length,
      sentBy: req.admin?.sysId ?? null,
      startedAt: new Date(),
    });

    // Render ONCE, outside the loop. The body is identical for everyone;
    // only the unsubscribe link differs.
    const bodyHtml = renderRichText(body);
    const bodyText = renderPlainText(body);

    // Fire and forget. Deliberately not awaited: a 4,000-address send
    // takes minutes, and an HTTP request held open that long dies to a
    // proxy timeout — leaving the operator staring at a network error
    // while the mail goes out perfectly well behind it.
    deliver(campaign, recipients, { subject, bodyHtml, bodyText })
      .catch((err) => logger.error('Newsletter delivery crashed', {
        campaignId: campaign.id, error: err.message,
      }));

    logger.info('Newsletter campaign started', {
      campaignId: campaign.id, recipients: recipients.length, by: req.admin?.sysId,
    });

    return res.json({
      status: 'success',
      msg: `Sending to ${recipients.length} subscriber${recipients.length === 1 ? '' : 's'}. This page will show progress.`,
      data: { campaignId: campaign.id, recipientCount: recipients.length },
    });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'newsletter.sendCampaign', audience: 'admin' })) return undefined;
    logger.error('Newsletter campaign failed to start', { error: err.message, stack: err.stack });
    if (campaign) {
      await campaign.update({
        status: 'failed', error: err.message.slice(0, 255), finishedAt: new Date(),
      }).catch(() => {});
    }
    return res.status(500).json({ status: 'fail', msg: 'Could not start the campaign.' });
  }
}

/**
 * The actual send loop. Runs detached from the request.
 *
 * One failed address must never stop the run — a single bad mailbox
 * would otherwise silently truncate the campaign at whatever alphabetical
 * position it happens to sit. Failures are counted and the run continues.
 */
async function deliver(campaign, recipients, { subject, bodyHtml, bodyText }) {
  let sent = 0;
  let failed = 0;

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);

    // Sequential within a batch, not Promise.all: the goal is a steady
    // trickle, and twenty simultaneous HTTPS calls is a burst.
    for (const person of batch) {
      try {
        await sendNewsletterCampaignEmail({
          to: person.email,
          subject,
          bodyHtml,
          bodyText,
          unsubscribeUrl: unsubscribeUrlFor(person.unsubscribeToken),
        });
        sent += 1;
        await NewsletterSubscriber.update(
          { lastSentAt: new Date() },
          { where: { id: person.id } },
        ).catch(() => {});
      } catch (err) {
        failed += 1;
        logger.error('Newsletter send to one recipient failed', {
          campaignId: campaign.id,
          subscriberId: person.id,
          domain: String(person.email).split('@')[1] || 'unknown',
          error: err.message, stack: err.stack,
        });
      }
    }

    // Checkpoint after each batch, so an operator watching the screen sees
    // real movement and a crash leaves an honest number behind.
    await campaign.update({ sentCount: sent, failedCount: failed }).catch(() => {});
    if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_PAUSE_MS);
  }

  await campaign.update({
    status: failed === recipients.length ? 'failed' : 'sent',
    sentCount: sent,
    failedCount: failed,
    finishedAt: new Date(),
    error: failed ? `${failed} recipient(s) failed` : null,
  }).catch(() => {});

  logger.info('Newsletter campaign finished', { campaignId: campaign.id, sent, failed });
}

/** GET /admin/newsletter/campaigns/:id — progress for the screen to poll. */
export async function getCampaign(req, res) {
  try {
    const row = await NewsletterCampaign.findByPk(req.params.id);
    if (!row) return res.status(404).json({ status: 'fail', msg: 'Campaign not found.' });
    return res.json({ status: 'success', data: row });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'newsletter.getCampaign', audience: 'admin' })) return undefined;
    logger.error('Newsletter campaign fetch failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load that campaign.' });
  }
}

/**
 * GET /admin/newsletter/export — CSV of confirmed subscribers.
 *
 * Includes the consent columns, because the reason to export a marketing
 * list is usually to prove the list is legitimate. An export of bare
 * addresses proves nothing.
 */
export async function exportSubscribers(req, res) {
  try {
    const rows = await NewsletterSubscriber.findAll({
      where: { status: 'confirmed' },
      order: [['id', 'ASC']],
      attributes: ['email', 'name', 'source', 'consentAt', 'consentIp', 'confirmedAt'],
    });

    // Guard against CSV formula injection: a cell beginning = + - @ is
    // executed as a formula when the file is opened in Excel. The list
    // contains attacker-supplied names, and the person opening the file
    // is an administrator.
    const cell = (v) => {
      const s = String(v ?? '');
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return `"${safe.replace(/"/g, '""')}"`;
    };

    const header = 'email,name,source,consent_at,consent_ip,confirmed_at';
    const body = rows.map((r) => [
      r.email, r.name, r.source, r.consentAt, r.consentIp, r.confirmedAt,
    ].map(cell).join(',')).join('\n');

    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="newsletter-subscribers-${stamp}.csv"`);
    logger.info('Newsletter list exported', { count: rows.length, by: req.admin?.sysId });
    return res.send(`${header}\n${body}`);
  } catch (err) {
    logger.error('Newsletter export failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not export the list.' });
  }
}

export default {
  subscribe,
  confirm,
  unsubscribe,
  listSubscribers,
  stats,
  preview,
  sendTest,
  sendCampaign,
  getCampaign,
  exportSubscribers,
};
