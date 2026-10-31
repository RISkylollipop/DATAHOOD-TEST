import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `networkid` table — network definitions and their per-service
// status flags (VTU/SME/Gifting/Corporate on/off) and provider plan IDs.
// NOTE: 9mobile is now branded T2 in the new UI, but the DB `network`
// value/id is preserved so existing data and provider mappings still work.
const Network = sequelize.define('networkid', {
  nId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  networkid: { type: DataTypes.STRING(10), allowNull: false },
  smeId: { type: DataTypes.STRING(10), allowNull: false },
  giftingId: { type: DataTypes.STRING(10), allowNull: false },
  corporateId: { type: DataTypes.STRING(10), allowNull: false },
  vtuId: { type: DataTypes.STRING(10), allowNull: false },
  sharesellId: { type: DataTypes.STRING(10), allowNull: false },
  network: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: 'MTN, GLO, 9MOBILE (T2), AIRTEL',
  },
  networkStatus: { type: DataTypes.STRING(10), defaultValue: 'Off' },
  vtuStatus: { type: DataTypes.STRING(10), defaultValue: 'Off' },
  sharesellStatus: { type: DataTypes.STRING(10), defaultValue: 'Off' },
  airtimepinStatus: { type: DataTypes.STRING(10), defaultValue: 'Off' },
  smeStatus: { type: DataTypes.STRING(10), defaultValue: 'Off' },
  giftingStatus: { type: DataTypes.STRING(10), defaultValue: 'Off' },
  corporateStatus: { type: DataTypes.STRING(10), defaultValue: 'Off' },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default Network;
