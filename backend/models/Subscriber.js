import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to the `subscribers` table — your user accounts.
// Column names match the legacy PHP schema exactly (sId, sFname, sApiKey, etc.)
// so existing data works without migration.
const Subscriber = sequelize.define('subscribers', {
  sId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  sApiKey: {
    type: DataTypes.STRING(200),
    allowNull: false,
    unique: true,
  },
  sFname: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  sLname: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  sEmail: {
    type: DataTypes.STRING(50),
    allowNull: true,
    // UNIQUE because sEmail is a LOGIN IDENTIFIER, not a contact detail:
    // login() and the password-reset flow both resolve an account with
    // findOne({ [Op.or]: [{ sEmail }, { sPhone }] }). A duplicate address makes
    // that lookup non-deterministic and lets a stranger's signup insert itself
    // into the result.
    //
    // Nullable AND unique on purpose. MySQL permits any number of NULLs in a
    // unique index, which is exactly what NDPA erasure needs —
    // privacyService.js sets sEmail = null when it anonymises an account, so
    // every erased row can hold "no address" without colliding. (Contrast
    // sPhone, which is NOT NULL, and therefore needs the distinct
    // `deleted-<sId>` value that file writes instead.)
    //
    // Declaring it here does NOT create the index: nothing in this codebase
    // calls sequelize.sync(), the schema comes from sql/ only. The index is
    // created by sql/security_hardening_prod.sql. This line keeps the model
    // honest about the live schema — the schema-drift incident was a model and
    // a database disagreeing, and it read as "all the data is gone".
    unique: true,
  },
  sPhone: {
    type: DataTypes.STRING(20),
    allowNull: false,
    unique: true,
  },
  sPass: {
    type: DataTypes.STRING(150),
    allowNull: false,
  },
  sState: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  sPin: {
    type: DataTypes.STRING(150),
    defaultValue: '1234',
    comment: 'Transaction PIN — bcrypt hashed (legacy plaintext auto-upgraded on first use)',
  },
  sPinStatus: {
    type: DataTypes.TINYINT,
    defaultValue: 0,
  },
  sType: {
    type: DataTypes.TINYINT,
    defaultValue: 1, // 1=User, 2=Agent, 3=Vendor
    comment: '1=Subscriber, 2=Agent, 3=Vendor',
  },
  sWallet: {
    type: DataTypes.FLOAT,
    defaultValue: 0.0,
  },
  sRefWallet: {
    type: DataTypes.FLOAT,
    defaultValue: 0.0,
  },
  sBankNo: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  sRolexBank: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  sSterlingBank: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  sFidelityBank: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  sBankName: {
    type: DataTypes.STRING(30),
    allowNull: true,
  },
  sRegStatus: {
    type: DataTypes.TINYINT,
    defaultValue: 3,
  },
  sVerCode: {
    type: DataTypes.SMALLINT,
    defaultValue: 0,
  },
  sRegDate: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
  sLastActivity: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  sReferal: {
    type: DataTypes.STRING(15),
    allowNull: true,
  },
  sKYC: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  sKycDate: {
    type: DataTypes.STRING(50),
    defaultValue: '',
  },
  // Which identity type the funding gateway accepted: 'bvn' or 'nin'.
  // The NUMBER is never stored — it is forwarded to the gateway and
  // dropped (services/paymentService.js). Do not add a column for it.
  // NULL means the row was verified before we started recording type.
  sKycType: {
    type: DataTypes.STRING(10),
    allowNull: true,
    defaultValue: null,
  },
  // Set once when a WhatsApp receipt comes back undeliverable (Meta 131026 —
  // the number is not on WhatsApp). While set, the dispatcher skips WhatsApp
  // for this account entirely and emails the receipt instead, so we do not
  // burn a request (and an error log) on every future purchase for a number
  // that will never receive one. Cleared when the user changes their phone.
  sWhatsAppUnreachable: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  sVirtualAccountRef: {
    type: DataTypes.STRING(200),
    defaultValue: '',
  },
  // NEW FIELDS for the features you requested
  deviceFingerprint: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'Device binding — stored on first login',
  },
  trustedDevices: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'JSON array of trusted device fingerprints',
  },
  webauthnCredentials: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'JSON array of WebAuthn public key credentials for fingerprint login',
  },
  pushSubscription: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'JSON object for web push notifications',
  },
  themePreference: {
    type: DataTypes.STRING(20),
    defaultValue: 'default-light',
    comment: 'Selected theme: default|blue|purple|green + -light|-dark',
  },
  sTokenVersion: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: 'JWT revocation counter. Bumping this invalidates every previously issued token for this user (logout-all / password reset / compromise).',
  },
  // ---- NDPA consent evidence (sql/privacy_compliance.sql) ----
  // A boolean "agreed: true" proves nothing after the fact. These three
  // together answer when, from where, and to WHICH text — the version
  // matters because otherwise editing the policy silently changes what
  // every existing user is held to have agreed to.
  consentAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  consentIp: {
    type: DataTypes.STRING(45),
    allowNull: true,
  },
  consentVersion: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },
  // ---- Erasure ----
  // Non-NULL means this row has been anonymised in place. It is not
  // deleted because transactions and wallet_ledger reference sId and must
  // still reconcile; see services/privacyService.js.
  deletedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  timestamps: false,
  freezeTableName: true,
});

export default Subscriber;
