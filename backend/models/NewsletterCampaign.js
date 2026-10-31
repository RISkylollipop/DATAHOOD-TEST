import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `newsletter_campaigns` — one row per send.
//
// Stores the markdown-lite SOURCE rather than the rendered HTML, so a later
// fix to the email template applies to a resend, and so the admin screen can
// reopen a past campaign for editing without having to parse HTML back.
const NewsletterCampaign = sequelize.define('newsletter_campaigns', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  subject: { type: DataTypes.STRING(200), allowNull: false },
  body: { type: DataTypes.TEXT('medium'), allowNull: false },
  audience: { type: DataTypes.STRING(20), allowNull: false },
  status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'sending' },
  recipientCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  sentCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  failedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  sentBy: { type: DataTypes.INTEGER, allowNull: true },
  startedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  finishedAt: { type: DataTypes.DATE, allowNull: true },
  error: { type: DataTypes.STRING(255), allowNull: true },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default NewsletterCampaign;
