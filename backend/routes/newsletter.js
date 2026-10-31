// ============================================================
//  routes/newsletter.js
// ------------------------------------------------------------
//  Public signup/confirm/unsubscribe + the admin composer.
//
//  Both halves live in one file so the boundary is visible in one
//  screen: everything above the divider is reachable by anyone on the
//  internet, everything below it requires an admin token. A reviewer
//  should never have to open two files to check whether the endpoint
//  that mails the entire list is authenticated.
// ============================================================

import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import {
  newsletterSignupLimiter,
  newsletterTokenLimiter,
  newsletterSendLimiter,
} from '../middleware/rateLimit.js';
import {
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
} from '../controllers/newsletterController.js';

const router = express.Router();

// ---- Public ----
router.post('/newsletter/subscribe', newsletterSignupLimiter, subscribe);

// Both verbs, for both endpoints, on purpose.
//
// GET is what a person clicking a link in their mail app sends. POST is
// what Gmail and Apple Mail send for one-click unsubscribe (RFC 8058),
// with no session and no CSRF token — which is acceptable here because
// the token in the URL is the only credential involved and the only
// thing it can do is stop mail arriving.
router.get('/newsletter/confirm', newsletterTokenLimiter, confirm);
router.post('/newsletter/confirm', newsletterTokenLimiter, confirm);
router.get('/newsletter/unsubscribe', newsletterTokenLimiter, unsubscribe);
router.post('/newsletter/unsubscribe', newsletterTokenLimiter, unsubscribe);

// ---- Admin ----
router.get('/admin/newsletter/stats', requireAdmin, stats);
router.get('/admin/newsletter/subscribers', requireAdmin, listSubscribers);
router.get('/admin/newsletter/export', requireAdmin, exportSubscribers);
router.get('/admin/newsletter/campaigns/:id', requireAdmin, getCampaign);
router.post('/admin/newsletter/preview', requireAdmin, preview);
router.post('/admin/newsletter/test', requireAdmin, sendTest);

// The one that cannot be taken back. Its own limiter, separate from every
// other admin route, so that exhausting it never blocks the composer's
// preview or test-send — the two things an operator reaches for when a
// send has just gone wrong.
router.post('/admin/newsletter/send', requireAdmin, newsletterSendLimiter, sendCampaign);

export default router;
