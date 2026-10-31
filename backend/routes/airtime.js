// ============================================================
//  Airtime Routes — user purchases (requires login + PIN)
// ============================================================

import express from 'express';
import { purchaseAirtimeHandler } from '../controllers/airtimeController.js';
import { requireUser } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';

const router = express.Router();

// idempotent() sits after requireUser (it scopes keys per user) and before the
// handler (a replay must be answered without touching the wallet).
router.post('/airtime/purchase', requireUser, idempotent('airtime'), purchaseAirtimeHandler);

export default router;
