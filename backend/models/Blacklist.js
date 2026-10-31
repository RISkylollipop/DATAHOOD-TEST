import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Extends the legacy `blacklisted_emails` concept into a full workflow table.
// Handles BOTH emails and phone numbers, with an approval pipeline:
//   - Admin-added entries are 'approved' immediately.
//   - User-submitted entries start as 'pending' and await admin approval.
// Registration is blocked only by 'approved' entries.
const Blacklist = sequelize.define('blacklist', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  value: {
    type: DataTypes.STRING(150),
    allowNull: false,
    comment: 'The email address or phone number being blacklisted',
  },
  type: {
    type: DataTypes.ENUM('email', 'phone'),
    allowNull: false,
  },
  reason: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'rejected'),
    defaultValue: 'pending',
    comment: 'pending = awaiting admin approval; approved = actively blocking',
  },
  submittedBy: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'sId of user who submitted; NULL if added by admin',
  },
  submittedByRole: {
    type: DataTypes.ENUM('user', 'admin'),
    defaultValue: 'user',
  },
  reviewedBy: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'Admin sysId who approved/rejected',
  },
  reviewedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  createdAt: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: false,
  freezeTableName: true,
  indexes: [
    { fields: ['value'] },
    { fields: ['status'] },
  ],
});

export default Blacklist;
