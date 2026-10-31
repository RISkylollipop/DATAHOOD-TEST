import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `sitesettings` table — global platform configuration.
// Single-row table (sId=1) holding site-wide settings like contact info,
// referral bonus rates, wallet charges, airtime limits, and social links.
const SiteSettings = sequelize.define('sitesettings', {
  sId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    defaultValue: 1,
  },
  sitename: { type: DataTypes.STRING(20), allowNull: true },
  siteurl: { type: DataTypes.STRING(100), allowNull: true },
  agentupgrade: { type: DataTypes.STRING(20), allowNull: true },
  vendorupgrade: { type: DataTypes.STRING(20), allowNull: true },
  apidocumentation: { type: DataTypes.STRING(100), allowNull: true },
  phone: { type: DataTypes.STRING(30), allowNull: true },
  email: { type: DataTypes.STRING(120), allowNull: true },
  whatsapp: { type: DataTypes.STRING(30), allowNull: true },
  whatsappgroup: { type: DataTypes.STRING(255), allowNull: true },
  // Widened from VARCHAR(10) by site_settings_social_widths.sql — the
  // legacy admin form labels this "Facebook Link" but the column could
  // not hold one, so links were silently truncated on save.
  facebook: { type: DataTypes.STRING(200), allowNull: true },
  twitter: { type: DataTypes.STRING(200), allowNull: true },
  instagram: { type: DataTypes.STRING(200), allowNull: true },
  telegram: { type: DataTypes.STRING(200), allowNull: true },
  // Free text, e.g. "Mon-Sat, 8am-9pm WAT". Blank means the Support page
  // makes no availability claim at all, which is the honest default.
  supporthours: { type: DataTypes.STRING(120), allowNull: true },
  referalupgradebonus: { type: DataTypes.FLOAT, defaultValue: 100 },
  referalairtimebonus: { type: DataTypes.FLOAT, defaultValue: 1 },
  referaldatabonus: { type: DataTypes.FLOAT, defaultValue: 1 },
  referalwalletbonus: { type: DataTypes.FLOAT, defaultValue: 1 },
  referalcablebonus: { type: DataTypes.FLOAT, defaultValue: 1 },
  referalexambonus: { type: DataTypes.FLOAT, defaultValue: 1 },
  referalmeterbonus: { type: DataTypes.FLOAT, defaultValue: 1 },
  wallettowalletcharges: { type: DataTypes.FLOAT, defaultValue: 50 },
  sitecolor: { type: DataTypes.STRING(10), defaultValue: '#0000e6' },
  logindesign: { type: DataTypes.STRING(10), defaultValue: '5' },
  homedesign: { type: DataTypes.STRING(10), defaultValue: '5' },
  notificationStatus: { type: DataTypes.STRING(5), defaultValue: 'Off' },
  accountname: { type: DataTypes.STRING(50), allowNull: true },
  accountno: { type: DataTypes.STRING(15), allowNull: true },
  bankname: { type: DataTypes.STRING(20), allowNull: true },
  electricitycharges: { type: DataTypes.STRING(5), allowNull: true },
  airtimemin: { type: DataTypes.STRING(10), defaultValue: '50' },
  airtimemax: { type: DataTypes.STRING(10), defaultValue: '500' },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default SiteSettings;
