// ============================================================
//  Provider Routes — all admin-only
// ============================================================

import express from 'express';
import {
  listProviders,
  createProvider,
  updateProvider,
  toggleProvider,
  deleteProvider,
  testProvider,
  getProviderBalance,
} from '../controllers/providerController.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.get('/admin/providers', requireAdmin, listProviders);
router.post('/admin/providers', requireAdmin, createProvider);
router.put('/admin/providers/:id', requireAdmin, updateProvider);
router.patch('/admin/providers/:id/toggle', requireAdmin, toggleProvider);
router.delete('/admin/providers/:id', requireAdmin, deleteProvider);
router.post('/admin/providers/:id/test', requireAdmin, testProvider);
router.get('/admin/providers/:id/balance', requireAdmin, getProviderBalance);

export default router;
