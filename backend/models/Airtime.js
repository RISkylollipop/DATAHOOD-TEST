import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `airtime` table — discount percentages for VTU and Sharesell
// by network and user tier. Admin configures these via the discount-management UI.
const Airtime = sequelize.define('airtime', {
  aId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  aNetwork: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Foreign key to networkid.nId',
  },
  aType: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: 'VTU or Sharesell',
  },
  aBuyDiscount: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: 'Discount % when buying from the provider',
  },
  aUserDiscount: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: 'Discount % for regular users (sType=1)',
  },
  aAgentDiscount: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: 'Discount % for agents (sType=2)',
  },
  aVendorDiscount: {
    type: DataTypes.FLOAT,
    allowNull: false,
    defaultValue: 0,
    comment: 'Discount % for vendors (sType=3)',
  },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default Airtime;
