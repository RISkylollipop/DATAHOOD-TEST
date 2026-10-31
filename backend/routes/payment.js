// ============================================================
//  Payment Routes — virtual accounts + webhooks
// ------------------------------------------------------------
//  User: create virtual account (requires BVN for KYC).
//  Public: webhook endpoint (no auth, signature-verified).
//  Admin: configure gateways.
// ============================================================

import express from 'express';
import {
  createAccountHandler,
  getMyAccountsHandler,
  webhookHandler,
  listGatewaysHandler,
  configureGatewayHandler,
} from '../controllers/paymentController.js';
import { requireUser, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// User
router.post('/payment/create-account', requireUser, createAccountHandler);
router.get('/payment/accounts', requireUser, getMyAccountsHandler);

// Public webhook (no auth, signature verified inside handler)
router.post('/payment/webhook', webhookHandler);

// Admin
router.get('/admin/payment/gateways', requireAdmin, listGatewaysHandler);
router.post('/admin/payment/gateways', requireAdmin, configureGatewayHandler);

export default router;
