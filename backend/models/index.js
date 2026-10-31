// ============================================================
//  Models Index — central registry + associations
// ------------------------------------------------------------
//  Import models from here everywhere else in the app.
// ============================================================

import sequelize from '../config/database.js';

import Subscriber from './Subscriber.js';
import Transaction from './Transaction.js';
import DataPlan from './DataPlan.js';
import CablePlan from './CablePlan.js';
import Network from './Network.js';
import SysUser from './SysUser.js';
import Blacklist from './Blacklist.js';
import Provider from './Provider.js';
import Airtime from './Airtime.js';
import SiteSettings from './SiteSettings.js';
import VerificationRecord from './VerificationRecord.js';
import OtpCode from './OtpCode.js';
import VirtualAccount from './VirtualAccount.js';
import WalletLedger from './WalletLedger.js';
import IdempotencyKey from './IdempotencyKey.js';
import NewsletterSubscriber from './NewsletterSubscriber.js';
import NewsletterCampaign from './NewsletterCampaign.js';
import AdminAuditLog from './AdminAuditLog.js';

// ---------- Associations ----------
// A subscriber has many transactions (sId links them).
Subscriber.hasMany(Transaction, { foreignKey: 'sId', sourceKey: 'sId' });
Transaction.belongsTo(Subscriber, { foreignKey: 'sId', targetKey: 'sId' });

// A user's identity verification history.
Subscriber.hasMany(VerificationRecord, { foreignKey: 'sId', sourceKey: 'sId' });
VerificationRecord.belongsTo(Subscriber, { foreignKey: 'sId', targetKey: 'sId' });

// A user's blacklist submissions.
Subscriber.hasMany(Blacklist, { foreignKey: 'submittedBy', sourceKey: 'sId' });

// Password/PIN reset codes issued to a user.
Subscriber.hasMany(OtpCode, { foreignKey: 'sId', sourceKey: 'sId' });
OtpCode.belongsTo(Subscriber, { foreignKey: 'sId', targetKey: 'sId' });

// Reserved bank accounts — one set per payment gateway, so a user can be
// funded through more than one at a time.
Subscriber.hasMany(VirtualAccount, { foreignKey: 'sId', sourceKey: 'sId' });
VirtualAccount.belongsTo(Subscriber, { foreignKey: 'sId', targetKey: 'sId' });

// Append-only history of every balance change. Read-only association:
// rows are written exclusively by utils/walletOps.js inside the same
// transaction as the balance change they describe.
Subscriber.hasMany(WalletLedger, { foreignKey: 'sId', sourceKey: 'sId' });
WalletLedger.belongsTo(Subscriber, { foreignKey: 'sId', targetKey: 'sId' });

// IdempotencyKey deliberately has NO association. Rows are short-lived
// replay records, not history, and the middleware always looks them up by
// primary key — an association would only invite joining expiring rows
// onto a user and reading them as transaction history.

// The newsletter tables have no association to Subscriber either, and that
// is the point: a marketing list entry is an address that consented, not a
// user. Joining them would make it easy to mail everyone with an account
// as though they had all opted in.

const models = {
  sequelize,
  Subscriber,
  Transaction,
  DataPlan,
  CablePlan,
  Network,
  SysUser,
  Blacklist,
  Provider,
  Airtime,
  SiteSettings,
  VerificationRecord,
  OtpCode,
  VirtualAccount,
  WalletLedger,
  IdempotencyKey,
  NewsletterSubscriber,
  NewsletterCampaign,
  AdminAuditLog,
};

export default models;
export {
  sequelize,
  Subscriber,
  Transaction,
  DataPlan,
  CablePlan,
  Network,
  SysUser,
  Blacklist,
  Provider,
  Airtime,
  SiteSettings,
  VerificationRecord,
  OtpCode,
  VirtualAccount,
  WalletLedger,
  IdempotencyKey,
  NewsletterSubscriber,
  NewsletterCampaign,
  AdminAuditLog,
};
