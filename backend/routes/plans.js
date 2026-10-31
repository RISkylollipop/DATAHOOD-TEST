// ============================================================
//  Plan Routes — all admin-only
// ------------------------------------------------------------
//  Add / edit / delete / enable / disable for:
//    - Data plans      (/api/admin/plans/data)
//    - Cable plans     (/api/admin/plans/cable)
//    - Electricity     (/api/admin/plans/electricity)
// ============================================================

import express from 'express';
import {
  // data
  listDataPlans, createDataPlan, updateDataPlan, deleteDataPlan, toggleDataPlan,
  toggleDataPlanType, listDataNetworks,
  // cable
  listCablePlans, createCablePlan, updateCablePlan, deleteCablePlan, toggleCableProvider, listCableProviders,
  // electricity
  listElectricityProviders, createElectricityProvider, updateElectricityProvider,
  deleteElectricityProvider, toggleElectricityProvider,
} from '../controllers/planController.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// ---- Data plans ----
router.get('/admin/plans/data/networks', requireAdmin, listDataNetworks);
router.get('/admin/plans/data', requireAdmin, listDataPlans);
router.post('/admin/plans/data', requireAdmin, createDataPlan);
router.put('/admin/plans/data/:id', requireAdmin, updateDataPlan);
router.delete('/admin/plans/data/:id', requireAdmin, deleteDataPlan);
// Per-plan enable/disable (one bundle). Distinct from the network-level
// toggle below, which switches a whole plan TYPE for a network.
router.patch('/admin/plans/data/:id/toggle', requireAdmin, toggleDataPlan);
router.patch('/admin/plans/data/network/:networkId/toggle/:type', requireAdmin, toggleDataPlanType);

// ---- Cable plans ----
router.get('/admin/plans/cable/providers', requireAdmin, listCableProviders);
router.get('/admin/plans/cable', requireAdmin, listCablePlans);
router.post('/admin/plans/cable', requireAdmin, createCablePlan);
router.put('/admin/plans/cable/:id', requireAdmin, updateCablePlan);
router.delete('/admin/plans/cable/:id', requireAdmin, deleteCablePlan);
router.patch('/admin/plans/cable/provider/:providerId/toggle', requireAdmin, toggleCableProvider);

// ---- Electricity DisCos ----
router.get('/admin/plans/electricity', requireAdmin, listElectricityProviders);
router.post('/admin/plans/electricity', requireAdmin, createElectricityProvider);
router.put('/admin/plans/electricity/:id', requireAdmin, updateElectricityProvider);
router.delete('/admin/plans/electricity/:id', requireAdmin, deleteElectricityProvider);
router.patch('/admin/plans/electricity/:id/toggle', requireAdmin, toggleElectricityProvider);

export default router;
