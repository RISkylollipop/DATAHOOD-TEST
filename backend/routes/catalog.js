// ============================================================
//  Catalog Routes — dropdown data for the purchase forms
// ------------------------------------------------------------
//  Networks are public (needed on the landing/pricing page).
//  Data/cable plans require login so prices resolve to the
//  user's tier. Public settings are open (branding/limits).
// ============================================================

import express from 'express';
import {
  getNetworks,
  getNetworkStatus,
  getDataPlans,
  getCablePlans,
  getElectricityProviders,
  getPublicSettings,
  getPublicPricing,
} from '../controllers/catalogController.js';
import { getSettings, updateSettings } from '../controllers/siteSettingsController.js';
import { requireUser, requireAdmin, optionalAuth } from '../middleware/auth.js';

const router = express.Router();

router.get('/catalog/networks', getNetworks);
router.get('/catalog/network-status', getNetworkStatus);
router.get('/catalog/dataplans', requireUser, getDataPlans);
router.get('/catalog/cableplans', requireUser, getCablePlans);
router.get('/catalog/electricity', getElectricityProviders);
router.get('/catalog/pricing', optionalAuth, getPublicPricing);
router.get('/settings/public', getPublicSettings);

// ---- Admin: edit the same row the public route reads ----
// Kept in this file rather than a new one so the two views of
// `sitesettings` sit side by side: whatever the admin form can write is
// visibly a superset of what /settings/public hands to every visitor.
router.get('/admin/settings', requireAdmin, getSettings);
router.put('/admin/settings', requireAdmin, updateSettings);

export default router;
