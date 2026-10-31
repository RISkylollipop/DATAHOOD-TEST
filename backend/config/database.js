import { Sequelize, ConnectionError } from 'sequelize';
import dotenv from 'dotenv';
import * as logger from '../utils/logger.js';

dotenv.config();

// ---------- Transport encryption to a REMOTE database ----------
// This database is a managed cloud host, so every statement — the DB
// password on handshake, then customer phone numbers, emails, balances
// and BVN/NIN *types* — crosses the public internet. Without TLS all of
// it is readable by anything on the path.
//
// Opt-in rather than on-by-default, deliberately: forcing TLS against a
// server that does not offer it fails the handshake, and a database that
// refuses to connect takes the whole platform down at boot. That is not
// a trade a security change gets to make silently. So the operator turns
// it on (DB_SSL=true) and bootGuard warns while it is off in production.
//
// DB_SSL_REJECT_UNAUTHORIZED=false allows a self-signed server
// certificate. It still encrypts, but it no longer authenticates the
// server, so it cannot stop an active man-in-the-middle — use it only if
// the provider genuinely ships a self-signed cert.
const sslEnabled = String(process.env.DB_SSL || '').toLowerCase() === 'true';
const dialectOptions = sslEnabled
  ? {
    ssl: {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false',
      ...(process.env.DB_SSL_CA ? { ca: process.env.DB_SSL_CA } : {}),
    },
  }
  : {};

// SQL logging is gated on an EXPLICIT flag, not on NODE_ENV.
//
// It used to key off NODE_ENV === 'development', which sounds safe until
// you notice that backend/.env on this project reads
// NODE_ENV=development and the log directory then filled with 14,343 SQL
// lines including 13 customer phone numbers and 3 email addresses. Bind
// values are interpolated into the logged statement, so "SQL logging" and
// "PII logging" are the same switch. Now it takes DEBUG_SQL=true, which
// bootGuard refuses to allow in production at all.
const sqlDebug = String(process.env.DEBUG_SQL || '').toLowerCase() === 'true';

// Single Sequelize instance shared across all models.
// Connects to the SAME MySQL database the PHP app used, so existing data
// carries over untouched — we only change the code that talks to it.
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    dialectOptions,
    // SQL logging goes to the FILE logger, never the console — raw SQL can
    // contain password hashes, encrypted keys and customer PII. Off unless
    // DEBUG_SQL=true is set deliberately (see the note above).
    logging: sqlDebug
      ? (sql) => logger.info('SQL', { sql })
      : false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
    // Retry a query whose CONNECTION failed.
    //
    // This database is remote (a managed cloud host), so every query crosses
    // the public internet, and `min: 0` above means an idle app drops its
    // connections and re-handshakes from cold on the next request. A dropped
    // packet during that handshake is not a rare event on this path — it is
    // the normal weather — and it surfaces as ECONNRESET/ETIMEDOUT from
    // findByPk in whatever middleware happened to run first.
    //
    // Sequelize wraps connection acquisition inside this retry (sequelize.js
    // ~line 300-322), so a retry here re-dials rather than re-issuing a query
    // on a dead socket. Its shipped default matches only the string
    // "SQLITE_BUSY: database is locked" — dead code on MySQL — which is why
    // this has to be set explicitly rather than left alone.
    //
    // Matching on the CLASS, not a message: `retry-as-promised` tries
    // `err instanceof match` first, and every connection fault subclasses
    // ConnectionError, including the generic one thrown for unlisted socket
    // codes. Matching message strings would silently stop working the day a
    // driver reworded anything.
    //
    // AccessDeniedError also extends ConnectionError, so bad credentials get
    // retried too. That is accepted: it costs a fraction of a second and only
    // ever happens on a misconfigured deploy, and excluding it would mean
    // passing a predicate function, which that library only invokes by way of
    // an `instanceof` TypeError — a trick that quietly becomes a no-op if
    // anyone rewrites the arrow function as a normal one.
    retry: {
      max: 3,
      match: [ConnectionError],
      backoffBase: 200,
      backoffExponent: 1.5,
    },
    define: {
      // The legacy PHP schema does not follow Sequelize's default conventions,
      // so we disable automatic timestamps/pluralization globally and set
      // them explicitly per-model where needed.
      timestamps: false,
      freezeTableName: true,
    },
  }
);

export async function testConnection() {
  try {
    await sequelize.authenticate();
    logger.boot('✅ Database connection established successfully.');
    return true;
  } catch (error) {
    // NEVER console.error this — MySQL connection failures echo the DB
    // username and host back in the message ("Access denied for user
    // 'x'@'host'"). File log only.
    logger.error('Unable to connect to the database', { error: error.message, stack: error.stack });
    return false;
  }
}

// Boot-time schema drift detection lives in utils/schemaGuard.js — it has to
// import the models to know which columns they declare, and the models import
// this file, so it cannot live here without a circular import.

export default sequelize;
