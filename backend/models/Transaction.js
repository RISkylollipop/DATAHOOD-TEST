import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to the `transactions` table. Status codes preserved from the PHP app:
//   0 = successful/completed
//   2 = failed
//   5 = processing (debited, awaiting provider confirmation)
//   1 = (legacy) refunded / reversed in older records
const Transaction = sequelize.define('transactions', {
  tId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  sId: {
    type: DataTypes.INTEGER,
    allowNull: false,
  },
  transref: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  servicename: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  servicedesc: {
    type: DataTypes.STRING(255),
    allowNull: false,
  },
  amount: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  status: {
    type: DataTypes.TINYINT,
    allowNull: false,
  },
  oldbal: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  newbal: {
    type: DataTypes.STRING(100),
    allowNull: false,
  },
  profit: {
    type: DataTypes.FLOAT,
    defaultValue: 0,
  },
  date: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default Transaction;
