import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `cableplans` table — cable TV subscription offerings.
const CablePlan = sequelize.define('cableplans', {
  cpId: {
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
  },
  type: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
  cableprovider: {
    type: DataTypes.TINYINT,
    allowNull: false,
    comment: '1=GOTV, 2=DSTV, 3=STARTIMES',
  },
  day: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default CablePlan;
