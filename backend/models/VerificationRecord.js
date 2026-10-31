import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Stores each successful identity verification so the user can view
// history and re-download the verified PDF slip later. NEW table —
// run the migration in sql/verification_migration.sql.
//
// The returned identity fields are kept as a JSON string in `result`
// (photo included as base64) so the PDF can be regenerated on demand
// without re-hitting — and re-paying — the provider.
const VerificationRecord = sequelize.define('verifications', {
  vId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  sId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Subscriber who ran the verification',
  },
  transref: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'Links to the wallet transaction that paid for this check',
  },
  vType: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: 'nin | bvn | passport | dl | voters | phone',
  },
  query: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'The ID number / phone the user submitted — AES-256-GCM encrypted at rest (widened from 100 to fit the ciphertext)',
  },
  fullName: {
    type: DataTypes.STRING(512),
    allowNull: true,
    comment: 'Denormalized for quick history listing — AES-256-GCM encrypted at rest (widened from 150 to fit the ciphertext)',
  },
  result: {
    type: DataTypes.TEXT('long'),
    allowNull: true,
    comment: 'JSON of the normalized result incl. photo base64',
  },
  amount: {
    type: DataTypes.STRING(50),
    allowNull: false,
    defaultValue: '0',
  },
  date: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  // ---- Retention (sql/privacy_compliance.sql) ----
  // The subject of a verification is usually NOT the account holder — it
  // is whoever's NIN was typed in. They never agreed to anything here and
  // cannot ask us to delete it, so the only honest control is to not keep
  // it. Two stages, both driven by scripts/purge_retention.js.
  redactedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Stage 1: result blob (photo, DOB, address, raw payload) dropped',
  },
  purgedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: 'Stage 2: ID number and name dropped too; accounting stub remains',
  },
}, {
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { fields: ['sId'] },
    { fields: ['vType'] },
  ],
});

export default VerificationRecord;
