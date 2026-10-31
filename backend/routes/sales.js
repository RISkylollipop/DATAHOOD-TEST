// ============================================================
//  Sales Route — admin-only analytics
// ------------------------------------------------------------
//  GET /api/admin/sales
// ============================================================

import express from 'express';
import { getSalesAnalysis } from '../controllers/salesController.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.get('/admin/sales', requireAdmin, getSalesAnalysis);

export default router;
