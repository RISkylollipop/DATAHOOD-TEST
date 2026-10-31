// ============================================================
//  Profile Routes — password + transaction PIN security
// ------------------------------------------------------------
//  Every route sits behind requireUser. The PIN-reset code goes to the
//  email on file, so it cannot be abused anonymously — but it still needs
//  a guessing limit, and that limit must key on the ACCOUNT rather than
//  the IP. Nigerian mobile carriers put thousands of subscribers behind
//  one CGNAT address, so an IP-keyed bucket would let one user's reset
//  attempts throttle strangers on the same carrier. Hence pinResetLimiter
//  (keyed on sId) rather than the anonymous resetAttemptLimiter.
// ============================================================

import express from 'express';
import { requireUser } from '../middleware/auth.js';
import { pinResetLimiter, privacyLimiter } from '../middleware/rateLimit.js';
import {
  getSecurityStatus,
  changePassword,
  setPin,
  changePin,
  requestPinReset,
  resetPin,
} from '../controllers/profileController.js';
import { exportMyData, deleteMyAccount } from '../controllers/privacyController.js';

const router = express.Router();

// requireUser on every route, so a bare `/profile/*` cannot be reached
// with a stale or missing token.
//
// THE PATH ARGUMENT IS LOAD-BEARING. This was `router.use(requireUser)`
// with no path, which does NOT mean "every route in this file" — it means
// every request that reaches this router, and server.js mounts this router
// on the bare `/api` prefix that all fifteen routers share. So it ran for
// any `/api/*` request that got this far and answered it instead of passing
// it on. Everything mounted BEFORE this router (server.js:137-149) was
// unaffected, which is why the damage looked so arbitrary: newsletterRoutes
// is the only router mounted after it, and the entire newsletter feature
// was dead.
//
//   GET  /api/admin/newsletter/stats  -> 403 "User access required."
//   POST /api/admin/newsletter/test   -> 403 "User access required."
//   POST /api/newsletter/subscribe    -> 401 "Authorization token is
//                                        required." for every visitor,
//                                        on a route that is public by design
//
// Scoping it to '/profile' keeps the guarantee above exactly as written —
// verified: an admin token on /profile/security still gets 403 — while
// leaving sibling routers alone. Never widen this back to a bare use();
// if a new prefix is added to this file, add its own use() line for it.
router.use('/profile', requireUser);

router.get('/profile/security', getSecurityStatus);
router.post('/profile/change-password', changePassword);
router.post('/profile/set-pin', setPin);
router.post('/profile/change-pin', changePin);
router.post('/profile/pin/request-reset', pinResetLimiter, requestPinReset);
router.post('/profile/pin/reset', pinResetLimiter, resetPin);

// ---- NDPA data-subject rights (services/privacyService.js) ----
// Both re-prove the password inside the controller; privacyLimiter is the
// resource guard (export is an expensive query) and the irreversibility
// guard (erasure cannot be undone), keyed on the account.
router.post('/profile/data-export', privacyLimiter, exportMyData);
router.post('/profile/delete-account', privacyLimiter, deleteMyAccount);

export default router;
