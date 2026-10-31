import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `wallet_ledger` — the append-only history of every balance
// change. See sql/wallet_ledger_table.sql for the full rationale.
//
// Rows are written by utils/walletOps.js INSIDE the same transaction and
// row lock as the balance change they describe. Do not create rows here
// from anywhere else: a ledger entry written outside that lock can
// describe a balance that never existed.
//
// APPEND-ONLY. There is intentionally no update or destroy path in the
// app for this model; corrections are new compensating rows.
const WalletLedger = sequelize.define('wallet_ledger', {
  id: {
    type: DataTypes.BIGINT,
    primaryKey: true,
    autoIncrement: true,
  },
  sId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  // 'main' = subscribers.sWallet, 'bonus' = subscribers.sRefWallet
  wallet: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: 'main',
  },
  direction: {
    type: DataTypes.STRING(8),
    allowNull: false,
  },
  // DECIMAL comes back from mysql2 as a string to avoid float rounding.
  // Callers that do arithmetic on it must Number() it first.
  amount: {
    type: DataTypes.DECIMAL(14, 2),
    allowNull: false,
  },
  balanceBefore: {
    type: DataTypes.DECIMAL(14, 2),
    allowNull: false,
  },
  balanceAfter: {
    type: DataTypes.DECIMAL(14, 2),
    allowNull: false,
  },
  reason: {
    type: DataTypes.STRING(32),
    allowNull: false,
  },
  reference: {
    type: DataTypes.STRING(200),
    allowNull: true,
  },
  meta: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default WalletLedger;
