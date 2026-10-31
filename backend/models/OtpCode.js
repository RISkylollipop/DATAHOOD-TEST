import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Short-lived one-time codes for password reset and PIN reset.
// NEW table — run the migration in sql/otp_codes_table.sql.
//
// The plaintext code is NEVER stored: `codeHash` holds a SHA-256 of it
// (utils/crypto.js hashToken), so a database dump cannot be replayed
// into an account takeover. Redeemed codes are marked via `consumedAt`
// rather than deleted, so "was this reset actually used, and when"
// remains answerable during a dispute.
const OtpCode = sequelize.define('otp_codes', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  // Which table sId points into. Without this, subscriber #5 and admin #5
  // share a row space: a customer's password-reset code could satisfy an
  // admin profile gate. Defaults to 'subscriber' so the rows that existed
  // before admin_2fa_and_otp_scope.sql are correct without a backfill.
  actorType: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'subscriber',
    comment: 'subscriber | sysuser',
  },
  sId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Id of the actor named by actorType — subscribers.sId or sysusers.sysId',
  },
  purpose: {
    type: DataTypes.STRING(32),
    allowNull: false,
    comment: 'password_reset | pin_reset | admin_* — scoping stops a code issued for one action being replayed against another',
  },
  codeHash: {
    type: DataTypes.CHAR(64),
    allowNull: false,
    comment: 'SHA-256 of the 6-digit code',
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  consumedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  attempts: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 0,
    comment: 'Wrong guesses against this code; survives a process restart, unlike the in-memory PIN lockout',
  },
  requestIp: {
    type: DataTypes.STRING(45),
    allowNull: true,
    comment: 'IPv6-safe width',
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { fields: ['actorType', 'sId', 'purpose'] },
    { fields: ['sId', 'purpose', 'consumedAt'] },
    { fields: ['expiresAt'] },
  ],
});

export default OtpCode;
