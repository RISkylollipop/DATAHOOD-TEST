// ============================================================
//  Blacklist Routes
// ------------------------------------------------------------
//  Public:  submit an email/phone for blacklisting (goes to
//           pending queue; approved instantly only if an admin
//           is the one submitting).
//  Admin:   list/view, approve, reject, remove entries.
// ============================================================

import express from 'express';
import {
  submitBlacklist,
  listBlacklist,
  approveBlacklist,
  rejectBlacklist,
  removeBlacklist,
} from '../controllers/blacklistController.js';
import { optionalAuth, requireAdmin } from '../middleware/auth.js';
import { blacklistSubmitLimiter } from '../middleware/rateLimit.js';

const router = express.Router();

// ---- Public / user submission ----
// optionalAuth: works for anonymous visitors AND logged-in users.
// If an admin token is present, the controller approves it instantly.
//
// ORDER IS LOAD-BEARING: optionalAuth runs BEFORE the limiter because the
// limiter's skip() reads req.auth.role. Swap these two and every admin gets
// counted as an anonymous IP, so an operator clearing a fraud list is cut
// off after ten entries.
router.post('/blacklist/submit', optionalAuth, blacklistSubmitLimiter, submitBlacklist);

// ---- Admin management (all require admin auth) ----
router.get('/admin/blacklist', requireAdmin, listBlacklist);
router.patch('/admin/blacklist/:id/approve', requireAdmin, approveBlacklist);
router.patch('/admin/blacklist/:id/reject', requireAdmin, rejectBlacklist);
router.delete('/admin/blacklist/:id', requireAdmin, removeBlacklist);

export default router;
