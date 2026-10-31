import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `newsletter_subscribers` — the double-opt-in marketing list.
//
// Kept apart from `subscribers` (the platform's user accounts) on purpose.
// A person can be one, the other, or both, and the two carry different
// permissions: a user account permits service mail because there is a
// contract; a newsletter row permits marketing because someone clicked a
// confirmation link. Merging them would lose that distinction and with it
// the ability to answer "what were we allowed to send this person?".
const NewsletterSubscriber = sequelize.define('newsletter_subscribers', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  email: { type: DataTypes.STRING(190), allowNull: false },
  name: { type: DataTypes.STRING(80), allowNull: true },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
  source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'landing' },
  // SHA-256 of the emailed token, never the token — same rule as otp_codes.
  // A leaked dump must not let someone confirm addresses they do not own.
  confirmTokenHash: { type: DataTypes.STRING(64), allowNull: true },
  confirmExpiresAt: { type: DataTypes.DATE, allowNull: true },
  unsubscribeToken: { type: DataTypes.STRING(32), allowNull: false },
  consentAt: { type: DataTypes.DATE, allowNull: true },
  consentIp: { type: DataTypes.STRING(45), allowNull: true },
  confirmedAt: { type: DataTypes.DATE, allowNull: true },
  unsubscribedAt: { type: DataTypes.DATE, allowNull: true },
  lastSentAt: { type: DataTypes.DATE, allowNull: true },
  createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
  timestamps: false, // the table manages both columns itself via DEFAULT/ON UPDATE
  freezeTableName: true,
});

export default NewsletterSubscriber;
