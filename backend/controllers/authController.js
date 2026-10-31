// ============================================================
//  Auth Controller — register + login for users and admins
// ------------------------------------------------------------
//  Security requirements enforced here:
//   - Passwords hashed with bcrypt (never stored/returned plain)
//   - Legacy plaintext passwords auto-upgraded on first login
//   - JWT issued for sessions; API key hashed at rest
//   - Registration blocked by APPROVED blacklist entries
//   - Nothing sensitive logged to console (uses file logger)
// ============================================================

import dotenv from 'dotenv';
import { Subscriber, SysUser } from '../models/index.js';
import { signSessionToken } from '../utils/sessionToken.js';
import {
  hashPassword,
  verifyPassword,
  isBcryptHash,
  generateSecureToken,
  hashToken,
  verifyLegacyPassword,
  timingSafeEqualStr,
  burnPasswordWork,
} from '../utils/crypto.js';
import { isBlacklisted } from './blacklistController.js';
import { signChallenge } from './admin2faController.js';
import { POLICY_VERSION } from '../config/policy.js';
import { auditAsync } from '../utils/auditLog.js';
import * as logger from '../utils/logger.js';

dotenv.config();

// Session lifetime lives in utils/sessionToken.js — see that file for why the
// window is 15 minutes of IDLENESS rather than 15 minutes of age, and why it
// no longer reads JWT_EXPIRES_IN (=7d in .env.example, which silently beat the
// '15m' default this function used to fall back to).
const signToken = signSessionToken;

// Strip sensitive fields before returning a user object to the client.
function publicUser(u) {
  return {
    sId: u.sId,
    firstName: u.sFname,
    lastName: u.sLname,
    email: u.sEmail,
    phone: u.sPhone,
    state: u.sState,
    type: u.sType, // 1=user, 2=agent, 3=vendor
    wallet: u.sWallet,
    refWallet: u.sRefWallet,
    theme: u.themePreference,
    regStatus: u.sRegStatus,
  };
}

// ---------- USER: Register ----------

/**
 * POST /api/auth/register
 * body: { firstName, lastName, email, phone, password, state, referral? }
 */
export async function register(req, res) {
  try {
    const {
      firstName, lastName, email, phone, password, state, referral, acceptedTerms,
    } = req.body;

    // --- Basic validation ---
    const missing = [];
    if (!firstName) missing.push('first name');
    if (!lastName) missing.push('last name');
    if (!email) missing.push('email');
    if (!phone) missing.push('phone');
    if (!password) missing.push('password');
    if (!state) missing.push('state');
    if (missing.length) {
      return res.status(400).json({ status: 'fail', msg: `Missing: ${missing.join(', ')}` });
    }
    if (String(password).length < 6) {
      return res.status(400).json({ status: 'fail', msg: 'Password must be at least 6 characters.' });
    }

    // --- Consent is a required, affirmative act ---
    // Not a pre-ticked box: the client sends acceptedTerms=true only when
    // the user has actually ticked it. Refusing here rather than silently
    // defaulting it to true is the whole point — a consent record that was
    // manufactured server-side is not consent.
    if (acceptedTerms !== true && acceptedTerms !== 'true' && acceptedTerms !== 'on') {
      return res.status(422).json({
        status: 'fail',
        msg: 'Please accept the Terms of Service and Privacy Policy to create an account.',
      });
    }

    // --- Blacklist enforcement (approved entries block signup) ---
    if (await isBlacklisted(email, phone)) {
      logger.warn('Blocked blacklisted registration attempt', { email, phone });
      return res.status(403).json({
        status: 'fail',
        msg: 'Registration is not permitted for this email or phone number.',
      });
    }

    // --- Duplicate checks ---
    const existing = await Subscriber.findOne({
      where: { sPhone: String(phone).trim() },
    });
    if (existing) {
      return res.status(409).json({ status: 'fail', msg: 'An account with this phone number already exists.' });
    }

    // Email too. This check did not exist: sPhone was UNIQUE in the model and
    // guarded here, while sEmail was neither — so the same address could sit on
    // any number of accounts.
    //
    // Email is not decoration on this platform, it is one of the two LOGIN
    // IDENTIFIERS. login() and the whole password-reset flow resolve an account
    // with findOne({ [Op.or]: [{ sEmail }, { sPhone }] }), and findOne with no
    // ORDER BY returns whichever row the query plan reaches first. With a
    // duplicate address in the table, "the account for this email" is therefore
    // a coin flip between two accounts — and an attacker can put their own row
    // into that flip by signing up with someone else's address. Every mail we
    // then send about that account (reset code, verification, wallet notice)
    // also lands in an inbox its owner did not register, sent from our verified
    // domain, which is a phishing primitive we would be providing.
    //
    // Normalised exactly as the INSERT below normalises it (trim + lowercase),
    // and the column collation is utf8mb4_unicode_ci, so Foo@x and foo@x are
    // the same address to both this check and the UNIQUE index that now backs
    // it (sql/security_hardening_prod.sql). The index is what actually closes
    // the race: two simultaneous signups can both pass this SELECT.
    //
    // The 409 is an account-existence oracle, accepted deliberately and for the
    // same reason the phone 409 above is: a signup form must tell you to sign in
    // instead. It costs a deliberate registration attempt against registerLimiter,
    // unlike an unauthenticated probe — see the enumeration note at the top of
    // controllers/passwordResetController.js, which stays quiet precisely because
    // it is cheap to walk.
    const emailNorm = String(email).trim().toLowerCase();
    const emailTaken = await Subscriber.findOne({ where: { sEmail: emailNorm } });
    if (emailTaken) {
      return res.status(409).json({ status: 'fail', msg: 'An account with this email address already exists.' });
    }

    // --- Create account with hashed password + secure API key ---
    const hashed = await hashPassword(password);
    // 32 bytes of CSPRNG entropy (hex). No Date.now() — a timestamp is
    // guessable and adds no real entropy, so it only weakened the key.
    const apiKeyPlain = generateSecureToken(32);

    const user = await Subscriber.create({
      sFname: String(firstName).trim(),
      sLname: String(lastName).trim(),
      sEmail: emailNorm, // the value the duplicate check above tested
      sPhone: String(phone).trim(),
      sPass: hashed,
      sState: String(state).trim(),
      sApiKey: apiKeyPlain, // used as the user's personal API token
      sType: 1,
      sWallet: 0,
      sRegStatus: 0,
      sReferal: referral ? String(referral).trim() : '',
      sKYC: 0,
      sVerCode: Math.floor(1000 + Math.random() * 9000),
      // Consent as evidence, not a boolean: when, from where, and to
      // which version of the text. req.ip is the real client because
      // server.js sets trust proxy=1. The version pins the agreement to
      // the words on screen so a later edit cannot rewrite it.
      consentAt: new Date(),
      consentIp: String(req.ip || '').slice(0, 45),
      consentVersion: POLICY_VERSION,
    });

    const token = signToken({ sId: user.sId, role: 'user', tv: user.sTokenVersion || 0 });

    return res.status(201).json({
      status: 'success',
      msg: 'Account created successfully.',
      token,
      user: publicUser(user),
    });
  } catch (err) {
    // The two duplicate checks above are a check-then-act race: two signups
    // with the same phone or email arriving together can both pass their SELECT
    // and both reach this create(). The UNIQUE indexes are what actually
    // serialise them, and the loser lands here — as a constraint error, not a
    // server fault. Reporting it as a 500 would tell the second person the site
    // is broken and invite them to retry forever.
    //
    // Matched on the Sequelize error NAME, not on a parsed MySQL message: the
    // 1062 text embeds the index name and changes between MySQL versions.
    if (err.name === 'SequelizeUniqueConstraintError') {
      // Which column, explicitly. sApiKey is UNIQUE too, and a collision there
      // (32 bytes of CSPRNG) is not something to answer with "your phone number
      // is taken" — an unrecognised field falls through to the 500 below so it
      // gets logged with a stack instead of a plausible-looking lie.
      const paths = (err.errors || []).map((e) => e.path);
      if (paths.includes('sEmail') || paths.includes('sPhone')) {
        const onEmail = paths.includes('sEmail');
        logger.warn('Registration lost a duplicate race', { field: onEmail ? 'sEmail' : 'sPhone' });
        return res.status(409).json({
          status: 'fail',
          msg: onEmail
            ? 'An account with this email address already exists.'
            : 'An account with this phone number already exists.',
        });
      }
    }
    logger.error('register failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not create account. Please try again.' });
  }
}

// ---------- USER: Login ----------

/**
 * POST /api/auth/login
 * body: { identifier (phone or email), password }
 */
export async function login(req, res) {
  try {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
      return res.status(400).json({ status: 'fail', msg: 'Enter your phone/email and password.' });
    }

    const id = String(identifier).trim().toLowerCase();
    const user = await Subscriber.findOne({
      where: sequelizeOr(id),
    });
    if (!user) {
      // Spend the bcrypt time anyway. Returning here immediately answered
      // ~300ms faster than a wrong password on a real account, which made
      // this endpoint an account enumerator over Nigerian mobile numbers.
      // See utils/crypto.js burnPasswordWork.
      await burnPasswordWork(password);
      return res.status(401).json({ status: 'fail', msg: 'Invalid login details.' });
    }

    // --- Password check with legacy auto-upgrade ---
    let ok = false;
    // Tracks whether the branch taken already cost a full bcrypt round. The
    // legacy path is sha1+md5 (sub-millisecond), so a wrong password on a
    // not-yet-upgraded account would otherwise be the fast path and leak the
    // same signal in a subtler form.
    let spentBcryptTime = false;
    if (isBcryptHash(user.sPass)) {
      ok = await verifyPassword(password, user.sPass);
      spentBcryptTime = true;
    } else {
      // Legacy PHP hash: substr(sha1(md5($pass)), 3, 10).
      // Verify against that scheme, then transparently re-save as bcrypt
      // so the weak hash is gone forever after this one login.
      ok = verifyLegacyPassword(password, user.sPass);
      if (ok) {
        user.sPass = await hashPassword(password);
        spentBcryptTime = true;
        await user.save();
        logger.info('Upgraded legacy password to bcrypt', { sId: user.sId });
      }
    }

    if (!ok) {
      if (!spentBcryptTime) await burnPasswordWork(password);
      return res.status(401).json({ status: 'fail', msg: 'Invalid login details.' });
    }

    // ---------- Blocked accounts ----------
    //
    // Checked AFTER the password, deliberately. Answering "this account is
    // blocked" to someone who has not proved they own it confirms the account
    // exists — the same enumeration leak the timing fix above closes.
    //
    // Tested as `=== 1`, never `!== 0`. sRegStatus is a legacy field with four
    // live values (0 active, 1 blocked, 2 pending account verification,
    // 3 pending email verification) and the column default is not 0, so a
    // `!== 0` gate would lock out real, transacting customers on rows carried
    // over from the PHP install.
    //
    // This is the gap that made blocking incomplete: userController.changeStatus
    // bumps sTokenVersion so live sessions die immediately, but nothing stopped
    // the user simply logging in again and minting a fresh token. It also holds
    // the line for NDPA erasure — privacyService sets sRegStatus = 1 on an
    // erased account, and an erased account must not be able to come back.
    if (Number(user.sRegStatus) === 1) {
      logger.warn('Login refused: account is blocked', { sId: user.sId });
      // 403, not 401: the credentials were correct. On this project 401 is
      // reserved for JWT/session failures, and the frontend treats it as
      // "session died" and force-logs-out, which would be a confusing lie here.
      return res.status(403).json({
        status: 'fail',
        msg: 'This account has been suspended. Please contact support.',
      });
    }

    user.sLastActivity = new Date();
    await user.save();

    const token = signToken({ sId: user.sId, role: 'user', tv: user.sTokenVersion || 0 });
    return res.json({ status: 'success', msg: 'Login successful.', token, user: publicUser(user) });
  } catch (err) {
    logger.error('login failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not log in. Please try again.' });
  }
}

// Small helper to match either email or phone.
import { Op } from 'sequelize';
function sequelizeOr(identifier) {
  return { [Op.or]: [{ sEmail: identifier }, { sPhone: identifier }] };
}

// ---------- USER: Log out of all devices ----------

/**
 * POST /api/auth/logout-all   (requires a valid user token)
 * Bumps the account's token version so EVERY previously issued token
 * (including the one making this call) is immediately rejected by the
 * auth middleware. Then mints one fresh token for THIS session so the
 * current device stays signed in while all others are kicked out.
 * Use this after a password change or if the user suspects compromise.
 */
export async function logoutAll(req, res) {
  try {
    const user = req.user; // set by requireUser
    user.sTokenVersion = (user.sTokenVersion || 0) + 1;
    await user.save();

    const token = signToken({ sId: user.sId, role: 'user', tv: user.sTokenVersion });
    logger.info('User revoked all sessions (logout-all)', { sId: user.sId, newVersion: user.sTokenVersion });

    return res.json({
      status: 'success',
      msg: 'Signed out of all other devices. This device stays signed in.',
      token, // the caller must replace its stored token with this one
    });
  } catch (err) {
    logger.error('logoutAll failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not sign out other devices. Please try again.' });
  }
}

// ---------- ADMIN: Login ----------

/**
 * POST /api/auth/admin/login
 * body: { username, password }
 */
export async function adminLogin(req, res) {
  try {
    const { username, password } = req.body;
    
    
    if (!username || !password) {
      return res.status(400).json({ status: 'fail', msg: 'Enter your username and password.' });
    }

    // .scope('withSecrets') because SysUser's default scope excludes
    // sysToken — without it the bcrypt compare below reads undefined and
    // every admin login fails with "Invalid admin credentials".
    const admin = await SysUser.scope('withSecrets').findOne({
      where: { sysUsername: String(username).trim() },
    });
    if (!admin) {
      // Same enumeration defence as the user login — see utils/crypto.js
      // burnPasswordWork. An early return here is ~300ms faster than a wrong
      // password on a real admin, which reveals valid admin usernames.
      await burnPasswordWork(password);
      // Recorded with a NULL actor and a populated ip — "someone tried a
      // username that does not exist here", which is the shape of a stuffing
      // run against the admin door. auditAsync, never audit: awaiting a DB
      // insert on one login branch and not another reintroduces exactly the
      // timing difference burnPasswordWork above exists to remove.
      auditAsync({
        req,
        action: 'admin.login',
        outcome: 'fail',
        adminId: null,
        adminEmail: String(username).trim(),
        detail: { reason: 'unknown_username' },
      });
      return res.status(401).json({ status: 'fail', msg: 'Invalid admin credentials.' });
    }

    // sysToken now holds a bcrypt hash. The legacy PHP stored the admin
    // password in PLAINTEXT here (Account.php compared `sysToken=:password`
    // directly), so accept that once and immediately re-save as bcrypt.
    //
    // NOTE: this requires sysToken to be VARCHAR(150). It ships as
    // VARCHAR(30) in the legacy dump, which is too small for a 60-char
    // bcrypt hash — run backend/sql/missing_columns_migration.sql first
    // or the upgrade save throws "Data too long for column 'sysToken'".
    let ok = false;
    // The legacy branch is a constant-time string compare, not bcrypt, so it
    // is fast enough to leak on its own. Tracked so a failure there still
    // pays the same cost as a failed bcrypt compare.
    let spentBcryptTime = false;
    if (isBcryptHash(admin.sysToken)) {
      ok = await verifyPassword(password, admin.sysToken);
      spentBcryptTime = true;
    } else {
      ok = timingSafeEqualStr(admin.sysToken, String(password));
      if (ok) {
        admin.sysToken = await hashPassword(password);
        spentBcryptTime = true;
        await admin.save();
        logger.info('Upgraded legacy admin password to bcrypt', { sysId: admin.sysId });
      }
    }

    if (!ok) {
      if (!spentBcryptTime) await burnPasswordWork(password);
      // A wrong password against a REAL admin account is a materially different
      // fact from the unknown-username row above, and the pair of them is what
      // tells you whether an attacker knows a valid username.
      auditAsync({
        req,
        action: 'admin.login',
        outcome: 'fail',
        adminId: admin.sysId,
        adminEmail: admin.sysUsername,
        detail: { reason: 'bad_password' },
      });
      return res.status(401).json({ status: 'fail', msg: 'Invalid admin credentials.' });
    }

    // Blocked admins are refused here, AFTER the password check, so the
    // response cannot be used to enumerate which usernames exist.
    //
    // POLARITY WARNING: 0 is ACTIVE, non-zero is BLOCKED. That is the legacy
    // convention from core/Models/Account.php (`if($result["sysStatus"] <> 0)
    // return 2;`), and it inverts the usual 1-means-enabled instinct. The live
    // super-admin row ships as 0. Until now nothing in this codebase read the
    // column at all, so the legacy admin UI's "Block User" button wrote a
    // value that had no effect on anything.
    if (Number(admin.sysStatus) !== 0) {
      logger.warn('Blocked admin attempted login', { sysId: admin.sysId });
      auditAsync({
        req,
        action: 'admin.login',
        outcome: 'fail',
        adminId: admin.sysId,
        adminEmail: admin.sysUsername,
        // The password was CORRECT. A suspended admin whose credentials still
        // work is either a forgetful ex-colleague or someone using their
        // credentials, and both are worth a row.
        detail: { reason: 'account_blocked', passwordCorrect: true },
      });
      return res.status(403).json({ status: 'fail', msg: 'This admin account is not active.' });
    }

    // ---- second factor ----
    //
    // The password is correct, but for a 2FA account that is only half the
    // proof. What goes back here is a CHALLENGE token, not a session token:
    // its role is 'admin_2fa_pending', which requireAdmin rejects outright.
    //
    // Issuing the real token here and relying on the frontend to show a
    // code prompt would make 2FA decorative — an attacker holding the
    // password would ignore the prompt and call the admin API directly with
    // the token this endpoint just handed them.
    if (Number(admin.sysTotpEnabled) === 1) {
      logger.info('Admin password accepted, awaiting 2FA', { sysId: admin.sysId });
      // Deliberately recorded even though no session was issued. For a 2FA
      // account this row means THE PASSWORD IS KNOWN TO WHOEVER SENT IT — the
      // second factor stopped the login, but the first factor is spent. That is
      // the difference between "2FA saved us" and "nothing happened", and
      // without this row the two look identical afterwards.
      auditAsync({
        req,
        action: 'admin.login',
        outcome: 'success',
        adminId: admin.sysId,
        adminEmail: admin.sysUsername,
        detail: { stage: 'password_only', twoFactorRequired: true },
      });
      return res.json({
        status: 'success',
        twoFactorRequired: true,
        challenge: signChallenge(admin),
        msg: 'Enter the 6-digit code from your authenticator app.',
      });
    }

    // `tv` pins the token to the account's current token version. Omitting it
    // would mint a token that reads as version 0 and dies the first time this
    // admin's version is bumped — so both signing sites must include it.
    const token = signToken({ sysId: admin.sysId, role: 'admin', tv: admin.sysTokenVersion || 0 });
    auditAsync({
      req,
      action: 'admin.login',
      outcome: 'success',
      adminId: admin.sysId,
      adminEmail: admin.sysUsername,
      // No 2FA on this account, so the password alone opened the admin console.
      detail: { stage: 'session_issued', twoFactorRequired: false },
    });
    return res.json({
      status: 'success',
      msg: 'Admin login successful.',
      token,
      admin: { sysId: admin.sysId, name: admin.sysName, username: admin.sysUsername, role: admin.sysRole },
    });
  } catch (err) {
    logger.error('adminLogin failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not log in. Please try again.' });
  }
}
