import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `dataplans` table — all data bundle offerings.
// Prices vary by user tier (userprice, agentprice, vendorprice).
const DataPlan = sequelize.define('dataplans', {
  pId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  name: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  price: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'Buying price from provider',
  },
  userprice: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  agentprice: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  vendorprice: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  planid: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'Provider plan ID sent in API call',
  },
  type: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'SME, Gifting, Corporate',
  },
  datanetwork: {
    type: DataTypes.TINYINT,
    allowNull: false,
    comment: '1=MTN, 2=Glo, 3=9mobile/T2, 4=Airtel',
  },
  day: {
    type: DataTypes.STRING(255),
    allowNull: false,
    comment: 'Validity period in days',
  },
  // Admin enable/disable toggle. A provider often pauses a plan for a few
  // days; deleting the row would destroy pricing history and orphan past
  // transactions, so we flip this instead. Disabled plans are hidden from
  // customers and rejected at purchase, but stay fully intact in the DB.
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'enabled',
    comment: 'enabled | disabled',
  },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default DataPlan;
