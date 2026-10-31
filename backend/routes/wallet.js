// ============================================================
//  Wallet + Transaction Routes
// ------------------------------------------------------------
//  User endpoints: balance, history, single receipt, stats,
//  and moving referral bonus into the main wallet.
//  Admin endpoints: view all transactions + reconcile stuck ones.
// ============================================================

import express from 'express';
import {
  getWalletHandler,
  getTransactionsHandler,
  getTransactionHandler,
  downloadTransactionReceiptHandler,
  getWalletStatsHandler,
  transferBonusHandler,
  adminGetTransactionsHandler,
  adminGetTransactionHandler,
  adminReconcileTransactionHandler,
  adminChangeTransactionStatusHandler,
} from '../controllers/walletController.js';
import { requireUser, requireAdmin } from '../middleware/auth.js';

const router = express.Router();

// ---- User ----
router.get('/wallet', requireUser, getWalletHandler);
router.get('/wallet/stats', requireUser, getWalletStatsHandler);
router.post('/wallet/transfer-bonus', requireUser, transferBonusHandler);
router.get('/transactions', requireUser, getTransactionsHandler);
router.get('/transactions/:ref', requireUser, getTransactionHandler);
router.get('/transactions/:ref/receipt', requireUser, downloadTransactionReceiptHandler);

// ---- Admin ----
router.get('/admin/transactions', requireAdmin, adminGetTransactionsHandler);
router.get('/admin/transactions/:ref', requireAdmin, adminGetTransactionHandler);
router.patch('/admin/transactions/:ref/status', requireAdmin, adminChangeTransactionStatusHandler);
router.patch('/admin/transactions/:ref/reconcile', requireAdmin, adminReconcileTransactionHandler);

export default router;
