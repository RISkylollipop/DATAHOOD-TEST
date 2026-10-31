// ============================================================
//  Bills Routes — Electricity + Cable TV (user purchases)
// ============================================================

import express from 'express';
import {
  verifyMeterHandler,
  purchaseElectricityHandler,
  verifyIUCHandler,
  purchaseCableHandler,
} from '../controllers/billsController.js';
import { requireUser } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';

const router = express.Router();

// The /verify routes are free lookups that move no money — they need no
// idempotency key, and giving them one would burn the purchase's reference
// before the purchase itself could use it.

// Electricity
router.post('/electricity/verify', requireUser, verifyMeterHandler);
router.post('/electricity/purchase', requireUser, idempotent('electricity'), purchaseElectricityHandler);

// Cable TV
router.post('/cable/verify', requireUser, verifyIUCHandler);
router.post('/cable/purchase', requireUser, idempotent('cable'), purchaseCableHandler);

export default router;
