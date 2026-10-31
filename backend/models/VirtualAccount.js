import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// A reserved bank account issued to a subscriber by one payment gateway.
// NEW table — run the migration in sql/virtual_accounts_table.sql.
//
// Why this exists: reserved accounts used to live in four flat columns on
// `subscribers`, which physically cannot hold two gateways at once. The
// expensive half of that was `sVirtualAccountRef` — the single value the
// funding webhook uses to find an account's owner. Adding a second gateway
// overwrote it, so deposits into the first gateway's account matched no
// subscriber and were dropped. This table gives every account its own row
// and its own reference.
//
// Rows are never deleted; `status` flips to 'inactive'. A closed account
// still has to explain the credits it took last year.
const VirtualAccount = sequelize.define('virtual_accounts', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  sId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'Subscriber that owns this account',
  },
  gateway: {
    type: DataTypes.STRING(32),
    allowNull: true,
    comment: 'Lowercased adapter key from paymentService.js. NULL means a legacy row whose gateway could not be inferred',
  },
  bankName: {
    type: DataTypes.STRING(60),
    allowNull: false,
    defaultValue: '',
  },
  accountNumber: {
    type: DataTypes.STRING(20),
    allowNull: false,
  },
  accountName: {
    type: DataTypes.STRING(120),
    allowNull: false,
    defaultValue: '',
    comment: 'Name the sender sees at their bank',
  },
  accountReference: {
    type: DataTypes.STRING(200),
    allowNull: false,
    comment: 'Our reference at the gateway; every webhook arrives keyed on this',
  },
  status: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'active',
    comment: 'active | inactive — status over deletion',
  },
}, {
  timestamps: true,
  freezeTableName: true,
  indexes: [
    // NOT unique, deliberately. One reservation at a gateway yields SEVERAL
    // bank accounts (Monnify: Wema, Sterling, Moniepoint, Fidelity) that all
    // share the one accountReference we sent, so this pair repeats by design —
    // it was unique here until it made the second bank's insert throw
    // "Validation error" and lose the whole set. The invariant that actually
    // protects the money is that every row sharing a (gateway, reference) has
    // the SAME sId, which the creation loop enforces: it writes one reference
    // per call and refuses a number owned by anyone else. So the webhook's
    // findOne on this pair still resolves the right owner whichever bank row
    // it happens to get back.
    { fields: ['gateway', 'accountReference'] },
    // This one stays unique — see the DDL header.
    { unique: true, fields: ['gateway', 'accountNumber'] },
    { fields: ['sId', 'gateway', 'status'] },
    { fields: ['accountReference'] },
  ],
});

export default VirtualAccount;
