// ============================================================
//  Verification Routes — identity checks (requires login + PIN)
// ------------------------------------------------------------
//  All six identity types (NIN, BVN, Passport, Driver's License,
//  Voter's Card, Phone) share these endpoints; the `type` in the
//  body selects which. The provider + per-type pricing are set in
//  the admin provider panel (category 'nin').
// ============================================================

import express from 'express';
import {
  listTypesHandler,
  verifyHandler,
  historyHandler,
  getRecordHandler,
  downloadSlipHandler,
} from '../controllers/verificationController.js';
import { requireUser } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';

const router = express.Router();

router.get('/verify/types', requireUser, listTypesHandler);
router.post('/verify', requireUser, idempotent('verify'), verifyHandler);
router.get('/verify/history', requireUser, historyHandler);
router.get('/verify/:vId', requireUser, getRecordHandler);
router.get('/verify/:vId/slip', requireUser, downloadSlipHandler);

export default router;
