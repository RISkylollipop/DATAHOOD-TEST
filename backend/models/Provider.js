import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// New unified `providers` table — powers the admin provider-management UI.
// Replaces the scattered apiconfigs/apilinks approach with one flexible model
// covering EVERY service category, including the new BVN & NIN verification.
//
// Secrets (apiKey, secretKey) are stored ENCRYPTED (see utils/crypto.js),
// never in plaintext. The admin UI reads/writes these rows.
const Provider = sequelize.define('providers', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: 'e.g. Maskawasub, Premiumsub, Monnify, Palmpay, a NIN provider',
  },
  category: {
    type: DataTypes.ENUM(
      'airtime',
      'data',
      'cable',
      'electricity',
      'exam',       // JAMB/WAEC/NECO pins
      'rechargepin',
      'bvn',        // BVN validation
      'nin',        // NIN verification/validation
      'payment',    // Monnify, Paymentpoint, Palmpay
      'whatsapp',   // Receipt delivery
      'wallet'
    ),
    allowNull: false,
  },
  baseUrl: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Provider API endpoint',
  },
  apiKey: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'ENCRYPTED at rest',
  },
  secretKey: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'ENCRYPTED at rest',
  },
  // Free-form JSON for gateway-specific fields (contractCode, businessId,
  // merchantId, templateName, etc.) so new providers need no schema change.
  extraConfig: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'JSON string of additional config fields; sensitive values encrypted',
  },
  authStyle: {
    type: DataTypes.ENUM('token', 'basic', 'bearer', 'custom'),
    defaultValue: 'token',
  },
  status: {
    type: DataTypes.ENUM('active', 'inactive'),
    defaultValue: 'inactive',
  },
  isDefault: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: 'The default provider used for this category when multiple exist',
  },
  lastCheckedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  lastStatus: {
    type: DataTypes.STRING(20),
    allowNull: true,
    comment: 'reachable / unreachable — from health checks',
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { fields: ['category'] },
    { fields: ['status'] },
  ],
});

export default Provider;
