// ============================================================
//  Auth Routes
// ------------------------------------------------------------
//  Brute-force limiters (SECURITY-AUDIT C3) sit in FRONT of the
//  handlers so failed attempts are throttled per (IP + account).
// ============================================================

import express from 'express';
import { register, login, adminLogin, logoutAll } from '../controllers/authController.js';
import {
  forgotPassword,
  verifyResetCode,
  resetPassword,
} from '../controllers/passwordResetController.js';
import {
  setup as tfaSetup,
  confirm as tfaConfirm,
  verifyLogin as tfaVerifyLogin,
  requestDisable as tfaRequestDisable,
  disable as tfaDisable,
  status as tfaStatus,
} from '../controllers/admin2faController.js';
import {
  getProfile as adminGetProfile,
  updateProfile as adminUpdateProfile,
  changePassword as adminChangePassword,
  requestEmailChange as adminRequestEmailChange,
  confirmEmailChange as adminConfirmEmailChange,
} from '../controllers/adminProfileController.js';
import {
  loginLimiter,
  adminLoginLimiter,
  registerLimiter,
  authTrafficLimiter,
  forgotPasswordLimiter,
  resetAttemptLimiter,
  admin2faLimiter,
  adminProfileLimiter,
} from '../middleware/rateLimit.js';
import { requireUser, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// Own budget for the whole auth surface. The global limiter in server.js
// skips these paths, so read traffic elsewhere in /api can never spend the
// credit that signing in needs. Router-level, so a route added below is
// covered without anyone having to remember this line.
router.use('/auth', authTrafficLimiter);

router.post('/auth/register', registerLimiter, register);
router.post('/auth/login', loginLimiter, login);
router.post('/auth/admin/login', adminLoginLimiter, adminLogin);

// ---------- Admin two-factor authentication ----------
//
// The verify route carries NO session — the caller holds only the challenge
// minted by /auth/admin/login after a correct password. It is the one route
// that route-level auth cannot protect, so admin2faLimiter is the only thing
// standing between a stolen password and 1,000,000 guesses. It keys on the
// challenge rather than the IP, so rotating addresses does not reset the
// budget, and one attacker cannot lock a real admin out of a shared
// CGNAT bucket.
router.post('/auth/admin/2fa/verify', admin2faLimiter, tfaVerifyLogin);

// The rest require a live admin session. requireAdmin rejects the challenge
// token (its role is not 'admin'), so a half-authenticated caller cannot
// reach enrolment or disabling to sidestep the code prompt.
router.get('/auth/admin/2fa/status', requireAdmin, tfaStatus);
router.post('/auth/admin/2fa/setup', requireAdmin, tfaSetup);
router.post('/auth/admin/2fa/confirm', requireAdmin, admin2faLimiter, tfaConfirm);
router.post('/auth/admin/2fa/disable/request', requireAdmin, tfaRequestDisable);
router.post('/auth/admin/2fa/disable', requireAdmin, admin2faLimiter, tfaDisable);

// ---------- Admin's own account details ----------
//
// These exist because setup() above refuses 2FA enrolment when sysEmail is
// null and, until now, nothing in the panel could set one — a correct gate
// with no door behind it.
//
// The read is unlimited (it is a plain lookup the profile screen makes on
// every visit); every WRITE is limited, because each one re-checks the
// current password and would otherwise be a password oracle reachable with
// nothing but a stolen session token. See adminProfileLimiter.
router.get('/auth/admin/profile', requireAdmin, adminGetProfile);
router.put('/auth/admin/profile', requireAdmin, adminProfileLimiter, adminUpdateProfile);
router.post('/auth/admin/password', requireAdmin, adminProfileLimiter, adminChangePassword);
router.post('/auth/admin/profile/email/request', requireAdmin, adminProfileLimiter, adminRequestEmailChange);
router.post('/auth/admin/profile/email/confirm', requireAdmin, adminProfileLimiter, adminConfirmEmailChange);

// ---------- Forgot password (no session — the user cannot sign in) ----------
// Send is limited separately from guessing: one spends SMTP quota and fills a
// real person's inbox, the other brute-forces a 6-digit code. Different abuse,
// different ceiling.
router.post('/auth/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/auth/verify-reset-code', resetAttemptLimiter, verifyResetCode);
router.post('/auth/reset-password', resetAttemptLimiter, resetPassword);

// Revoke every existing session for the logged-in user (keeps this device).
router.post('/auth/logout-all', requireUser, logoutAll);

export default router;
