// ============================================================
//  Blacklist Controller — full working implementation
// ------------------------------------------------------------
//  Rebuilt from scratch (the legacy version was broken).
//
//  Flow:
//   - Public/user submits an email or phone  -> status 'pending'
//   - Admin adds directly                     -> status 'approved' (instant)
//   - Admin approves a pending entry          -> status 'approved'
//   - Admin rejects a pending entry           -> status 'rejected'
//   - Admin removes any entry                 -> deleted
//   - Registration is blocked ONLY by 'approved' entries
// ============================================================

import { Op } from 'sequelize';
import { Blacklist } from '../models/index.js';
import { sendEmail, adminAlertRecipient } from '../services/emailService.js';
import * as logger from '../utils/logger.js';

// ---------- Helpers ----------

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize + classify an input as email or phone.
 * Returns { value, type } or null if invalid.
 */
function classify(rawValue, rawType) {
  const value = String(rawValue || '').trim().toLowerCase();
  if (!value) return null;

  let type = rawType;
  if (!type) {
    type = EMAIL_RE.test(value) ? 'email' : 'phone';
  }

  if (type === 'email') {
    if (!EMAIL_RE.test(value)) return null;
    return { value, type: 'email' };
  }

  // phone: strip non-digits, normalize to local 0-prefixed 11-digit
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('234')) digits = '0' + digits.slice(3);
  if (digits.length !== 11) return null;
  return { value: digits, type: 'phone' };
}

/**
 * Core check used by the registration flow.
 * Returns true if the email/phone is actively blacklisted (approved).
 */
export async function isBlacklisted(email, phone) {
  const candidates = [];
  if (email) candidates.push(String(email).trim().toLowerCase());
  if (phone) {
    let digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('234')) digits = '0' + digits.slice(3);
    candidates.push(digits);
  }
  if (candidates.length === 0) return false;

  const hit = await Blacklist.findOne({
    where: { value: { [Op.in]: candidates }, status: 'approved' },
  });
  return Boolean(hit);
}

// ---------- Public / User submission ----------

/**
 * POST /api/blacklist/submit
 * Anyone can submit. If a logged-in user submits, we tag them.
 * Always lands as 'pending' for admin approval.
 */
export async function submitBlacklist(req, res) {
  try {
    const { value, type, reason } = req.body;
    const classified = classify(value, type);
    if (!classified) {
      return res.status(400).json({ status: 'fail', msg: 'Enter a valid email address or 11-digit phone number.' });
    }

    // Already actively blacklisted? No need to submit again.
    const existingApproved = await Blacklist.findOne({
      where: { value: classified.value, status: 'approved' },
    });
    if (existingApproved) {
      return res.status(409).json({ status: 'fail', msg: 'This entry is already blacklisted.' });
    }

    // Already pending? Avoid duplicates.
    const existingPending = await Blacklist.findOne({
      where: { value: classified.value, status: 'pending' },
    });
    if (existingPending) {
      return res.status(409).json({ status: 'fail', msg: 'This entry is already awaiting review.' });
    }

    const isAdmin = req.auth?.role === 'admin';

    const entry = await Blacklist.create({
      value: classified.value,
      type: classified.type,
      reason: reason ? String(reason).slice(0, 255) : null,
      // Admin submissions are approved instantly; user/anonymous are pending.
      status: isAdmin ? 'approved' : 'pending',
      submittedBy: req.auth?.sId || null,
      submittedByRole: isAdmin ? 'admin' : 'user',
      reviewedBy: isAdmin ? req.auth?.sysId || null : null,
      reviewedAt: isAdmin ? new Date() : null,
    });

    // Notify admin of a new pending submission (fails soft).
    if (!isAdmin) {
      sendEmail({
        to: adminAlertRecipient(),
        subject: 'New blacklist submission awaiting approval',
        text: `A new ${classified.type} was submitted for blacklisting: ${classified.value}\nReason: ${reason || 'none given'}\n\nReview it in the admin panel.`,
      }).catch((e) => logger.error('Blacklist notify email failed', { error: e.message }));
    }

    return res.status(201).json({
      status: 'success',
      msg: isAdmin
        ? 'Entry blacklisted successfully.'
        : 'Thank you. Your submission has been sent for approval.',
      data: { id: entry.id, status: entry.status },
    });
  } catch (err) {
    logger.error('submitBlacklist failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not submit right now. Please try again.' });
  }
}

// ---------- Admin management ----------

/**
 * GET /api/admin/blacklist?status=approved|pending|rejected&type=email|phone&search=
 * Admin views blacklisted entries and the pending queue.
 */
export async function listBlacklist(req, res) {
  try {
    const { status, type, search } = req.query;
    const where = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (search) where.value = { [Op.like]: `%${String(search).trim().toLowerCase()}%` };

    const entries = await Blacklist.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });

    // Handy counts for the admin dashboard badges.
    const [approved, pending] = await Promise.all([
      Blacklist.count({ where: { status: 'approved' } }),
      Blacklist.count({ where: { status: 'pending' } }),
    ]);

    return res.json({
      status: 'success',
      counts: { approved, pending },
      data: entries,
    });
  } catch (err) {
    logger.error('listBlacklist failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load blacklist.' });
  }
}

/**
 * PATCH /api/admin/blacklist/:id/approve
 */
export async function approveBlacklist(req, res) {
  try {
    const entry = await Blacklist.findByPk(req.params.id);
    if (!entry) return res.status(404).json({ status: 'fail', msg: 'Entry not found.' });

    entry.status = 'approved';
    entry.reviewedBy = req.auth?.sysId || null;
    entry.reviewedAt = new Date();
    await entry.save();

    return res.json({ status: 'success', msg: 'Entry approved and now blocking registration.', data: entry });
  } catch (err) {
    logger.error('approveBlacklist failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not approve entry.' });
  }
}

/**
 * PATCH /api/admin/blacklist/:id/reject
 */
export async function rejectBlacklist(req, res) {
  try {
    const entry = await Blacklist.findByPk(req.params.id);
    if (!entry) return res.status(404).json({ status: 'fail', msg: 'Entry not found.' });

    entry.status = 'rejected';
    entry.reviewedBy = req.auth?.sysId || null;
    entry.reviewedAt = new Date();
    await entry.save();

    return res.json({ status: 'success', msg: 'Submission rejected.', data: entry });
  } catch (err) {
    logger.error('rejectBlacklist failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not reject entry.' });
  }
}

/**
 * DELETE /api/admin/blacklist/:id
 * Remove an email/phone from the blacklist entirely.
 */
export async function removeBlacklist(req, res) {
  try {
    const entry = await Blacklist.findByPk(req.params.id);
    if (!entry) return res.status(404).json({ status: 'fail', msg: 'Entry not found.' });

    await entry.destroy();
    return res.json({ status: 'success', msg: 'Entry removed from blacklist.' });
  } catch (err) {
    logger.error('removeBlacklist failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not remove entry.' });
  }
}
