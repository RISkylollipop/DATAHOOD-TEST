import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `idempotency_keys` — the replay window for money endpoints.
// See sql/idempotency_keys_table.sql for the full rationale.
//
// Rows are written and read exclusively by middleware/idempotency.js.
// Nothing else should touch this table: the guarantee comes from the
// INSERT being the lock, and a SELECT-then-INSERT anywhere else
// reopens exactly the race this table exists to close.
//
// This is NOT transaction history — rows expire. wallet_ledger and
// transactions are the permanent records.
const IdempotencyKey = sequelize.define('idempotency_keys', {
  idemKey: {
    type: DataTypes.STRING(120),
    primaryKey: true,
  },
  sId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  endpoint: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  // sha256 hex of the money-carrying request fields. Same key + different
  // fingerprint is a client bug or tampering, never a legitimate retry.
  fingerprint: {
    type: DataTypes.CHAR(64),
    allowNull: false,
  },
  status: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'in_progress',
  },
  responseCode: {
    type: DataTypes.SMALLINT,
    allowNull: true,
  },
  responseBody: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default IdempotencyKey;
