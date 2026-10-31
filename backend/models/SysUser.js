import { DataTypes } from 'sequelize';
import sequelize from '../config/database.js';

// Maps to `sysusers` table — admin/staff accounts.
// The legacy sysToken was plaintext; passwords now go through bcrypt.
// sysRole: '1' = super admin. Extendable for staff roles later.
const SysUser = sequelize.define('sysusers', {
  sysId: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  sysName: {
    type: DataTypes.STRING(50),
    allowNull: false,
  },
  sysRole: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: '1 = super admin',
  },
  sysUsername: {
    type: DataTypes.STRING(50),
    allowNull: false,
    unique: true,
  },
  // Renamed usage: now stores a BCRYPT HASH of the admin password,
  // not a plaintext token. Column kept for schema compatibility.
  sysToken: {
    type: DataTypes.STRING(150),
    allowNull: false,
    comment: 'bcrypt hash of admin password',
  },
  // Legacy polarity, and it is the opposite of the obvious guess:
  // 0 = ACTIVE, non-zero = BLOCKED. Confirmed against the legacy
  // core/Models/Account.php, which refuses login with `sysStatus <> 0`,
  // and dashboard/doc-usr.php, which prints "Active" when it is 0.
  // The one production admin row is 0, so treating 1 as "enabled" would
  // have locked out the only administrator.
  sysStatus: {
    type: DataTypes.TINYINT,
    defaultValue: 0,
    comment: '0 = active, non-zero = blocked (legacy polarity)',
  },

  // ---------- Admin identity (admin_2fa_and_otp_scope.sql) ----------
  // Added because there was nowhere to send an admin OTP: the legacy
  // manage-account.php only ever changed a password.
  // Unique but nullable — MySQL permits many NULLs under a UNIQUE index,
  // so existing admins without an email coexist; first to set one claims it.
  sysEmail: {
    type: DataTypes.STRING(120),
    allowNull: true,
    unique: true,
    comment: 'Admin email — destination for OTP codes',
  },
  sysPhone: {
    type: DataTypes.STRING(20),
    allowNull: true,
  },

  // ---------- Authenticator app (TOTP) ----------
  // Ciphertext envelope from utils/crypto.js, never the raw base32 secret:
  // anyone who could read this column would otherwise mint valid codes
  // forever. Excluded from the default scope below, so it cannot leak into
  // a response by accident.
  sysTotpSecret: {
    type: DataTypes.STRING(255),
    allowNull: true,
    comment: 'AES-256-GCM encrypted TOTP secret — never plaintext',
  },
  // Two-phase enrolment: the secret is written when the QR is shown, but
  // this only flips to 1 after the admin enters a live code from the app.
  // Without that gate a mis-scan locks them out of their own account.
  sysTotpEnabled: {
    type: DataTypes.TINYINT,
    allowNull: false,
    defaultValue: 0,
  },
  sysTotpConfirmedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  // Replay guard. A TOTP code stays valid for its whole 30s step plus the
  // drift window, so without recording the step that was accepted the same
  // six digits work twice.
  sysTotpLastStep: {
    type: DataTypes.BIGINT,
    allowNull: true,
  },
  sysBackupCodes: {
    type: DataTypes.TEXT,
    allowNull: true,
    comment: 'JSON array of bcrypt-hashed single-use recovery codes',
  },

  // ---------- Token revocation ----------
  // Mirrors sTokenVersion on Subscriber. Admin JWTs live 7 days and were
  // previously irrevocable for that whole window, which made "turn on 2FA
  // because I think someone is in my account" do nothing about the session
  // already in their account. requireAdmin compares this against the `tv`
  // claim; bumping it invalidates every token minted before the bump.
  sysTokenVersion: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
}, {
  timestamps: false,
  freezeTableName: true,

  // requireAdmin attaches the whole instance as req.admin, so any handler
  // that returns it — or spreads it — would ship the bcrypt hash and the
  // encrypted TOTP secret to the client. Excluding both by default makes
  // that leak impossible instead of merely unlikely; the two paths that
  // genuinely need them ask for it via .scope('withSecrets').
  defaultScope: {
    attributes: { exclude: ['sysToken', 'sysTotpSecret'] },
  },
  scopes: {
    withSecrets: { attributes: { include: ['sysToken', 'sysTotpSecret'] } },
  },
});

export default SysUser;
