// ============================================================
//  AdminAuditLog — append-only record of privileged actions
// ------------------------------------------------------------
//  wallet_ledger answers "did this balance move?". This answers
//  "WHICH ADMIN moved it, from where, and did it succeed?" — which
//  the ledger cannot, and which a rotating file log on the same box
//  as the attacker is a poor place to keep.
//
//  WRITE THROUGH utils/auditLog.js ONLY. That helper never throws:
//  an audit write must not be able to fail a refund the customer is
//  waiting for. The consequence is that a missing row is possible, so
//  this table is corroborating evidence, not the source of truth for
//  money — wallet_ledger is.
//
//  There is deliberately no update or destroy path anywhere in the
//  application, and no association to Subscriber or SysUser: a
//  cascade delete that tidied away the audit trail for a deleted
//  admin would erase exactly the rows worth keeping.
// ============================================================

import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

const AdminAuditLog = sequelize.define('AdminAuditLog', {
  id: {
    type: DataTypes.BIGINT.UNSIGNED,
    primaryKey: true,
    autoIncrement: true,
  },
  // Nullable on purpose: a rejected admin login has an IP and an
  // attempted email but no authenticated actor yet, and that is one of
  // the more interesting rows in the table.
  adminId: { type: DataTypes.INTEGER, allowNull: true },
  adminEmail: { type: DataTypes.STRING(190), allowNull: true },
  action: { type: DataTypes.STRING(64), allowNull: false },
  targetType: { type: DataTypes.STRING(32), allowNull: true },
  targetId: { type: DataTypes.STRING(190), allowNull: true },
  amount: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
  // JSON string. utils/auditLog.js redacts before it gets here.
  detail: { type: DataTypes.TEXT, allowNull: true },
  ip: { type: DataTypes.STRING(45), allowNull: true },
  userAgent: { type: DataTypes.STRING(255), allowNull: true },
  outcome: {
    type: DataTypes.ENUM('success', 'fail'),
    allowNull: false,
    defaultValue: 'success',
  },
  createdAt: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'admin_audit_log',
  // Only createdAt exists; an audit row is never updated, so an
  // updatedAt column would be a permanently-equal duplicate and
  // Sequelize would name it in every INSERT against a table that
  // does not have it.
  timestamps: false,
});

export default AdminAuditLog;
