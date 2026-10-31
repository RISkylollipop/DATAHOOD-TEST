// ============================================================
//  User Routes — all admin-only (user management + funding)
// ------------------------------------------------------------
//  Admin screen to manage subscriber accounts:
//    list / view / edit / credit / debit / status / type /
//    reset password / reset API key / delete
// ============================================================

import express from 'express';
import {
  listUsers, getUser, updateUser,
  changeType, changeStatus,
  creditUser, debitUser,
  resetPassword, resetApiKey, deleteUser,
} from '../controllers/userController.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();

router.get('/admin/users', requireAdmin, listUsers);
router.get('/admin/users/:id', requireAdmin, getUser);
router.put('/admin/users/:id', requireAdmin, updateUser);
router.patch('/admin/users/:id/type', requireAdmin, changeType);
router.patch('/admin/users/:id/status', requireAdmin, changeStatus);
router.post('/admin/users/:id/credit', requireAdmin, creditUser);
router.post('/admin/users/:id/debit', requireAdmin, debitUser);
router.post('/admin/users/:id/reset-password', requireAdmin, resetPassword);
router.post('/admin/users/:id/reset-apikey', requireAdmin, resetApiKey);
router.delete('/admin/users/:id', requireAdmin, deleteUser);

export default router;
