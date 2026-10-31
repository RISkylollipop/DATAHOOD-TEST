// ============================================================
//  Data Routes — user purchases (requires login + PIN)
// ============================================================

import express from 'express';
import { purchaseDataHandler } from '../controllers/dataController.js';
import { requireUser } from '../middleware/auth.js';
import { idempotent } from '../middleware/idempotency.js';

const router = express.Router();

router.post('/data/purchase', requireUser, idempotent('data'), purchaseDataHandler);

export default router;
