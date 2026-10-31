// ============================================================
//  bootGuard — refuse to start in an insecure configuration
// ------------------------------------------------------------
//  WHY THIS IS A BOOT CHECK AND NOT A WARNING
//
//  Every finding below is invisible at runtime. Nothing breaks, no
//  request fails, no log line looks wrong — the app simply runs with
//  a forgeable session, or with plaintext-recoverable provider keys,
//  or mirroring customer phone numbers into a console. You find out
//  when someone else does.
//
//  server.js already had exactly one guard of this shape: an empty
//  CLIENT_ORIGINS list exits(1) in production rather than serving an
//  open CORS policy. This extends that same "fail closed at boot"
//  principle to the rest of the security-critical configuration.
//
//  THE ONE THAT MATTERS MOST
//
//  backend/.env.example USED TO ship
//  JWT_SECRET=CHANGE_ME_LONG_RANDOM_STRING, and that value WORKS — it
//  is a valid HMAC key. The example file is tracked in git. So anyone
//  who copied .env.example to .env and forgot one line ran a production
//  API whose session tokens could be minted by any reader of the
//  repository, for any sId, including an admin's. There is no symptom.
//
//  That placeholder is now an EMPTY value in .env.example, so a copied
//  file fails this guard immediately instead of booting insecurely. The
//  placeholder list below stays regardless: it is what catches the .env
//  files already on disk from before that change, and the next person
//  who types something memorable into the blank.
//
//  DESIGN NOTES
//
//  - Non-production: report every problem as a warning and keep
//    running. A dev box that refuses to boot gets "fixed" by deleting
//    the guard.
//  - Production: collect ALL failures, log them together, then exit.
//    Reporting one at a time means three restarts to learn three
//    facts.
//  - Never log a secret, not even its length-and-prefix. The messages
//    name the variable and the rule, which is all an operator needs.
// ============================================================

import * as logger from './logger.js';

// Values that are documented placeholders or obvious filler. Compared
// case-insensitively after trimming. Not a strength test — that is
// separate — just "this is not a secret, it is a label".
const PLACEHOLDERS = [
  'change_me_long_random_string',
  'change_me',
  'changeme',
  'your_secret_here',
  'secret',
  'password',
  'test',
  'dev',
  'todo',
  'xxx',
];

// 32 chars is the floor for an HMAC secret we are willing to call
// production-grade. Below that, offline brute force against a single
// captured token becomes tractable, and a token is trivially captured
// (it is in every request the client makes).
const MIN_SECRET_LEN = 32;

/**
 * Is this string too low-entropy to be a secret, regardless of length?
 *
 * Catches the two ways a "long" secret is actually short: one
 * character repeated, and a short word repeated. Deliberately crude —
 * a real entropy estimate on a 32-char string is not meaningful, and
 * the goal is to catch 'aaaaaaaa...' and 'passwordpasswordpassword',
 * not to grade good secrets.
 */
function looksLowEntropy(value) {
  const distinct = new Set(value).size;
  if (distinct < 8) return true;
  return false;
}

function checkSecret(name, value, { minLen = MIN_SECRET_LEN } = {}) {
  const problems = [];
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) {
    problems.push(`${name} is not set.`);
    return problems;
  }
  if (PLACEHOLDERS.includes(v.toLowerCase())) {
    problems.push(`${name} is still the example placeholder. Anyone with the repository can forge values signed with it. Generate a real one: openssl rand -hex 32`);
    return problems;
  }
  if (v.length < minLen) {
    problems.push(`${name} is ${v.length} characters; at least ${minLen} are required. Generate one: openssl rand -hex 32`);
  }
  if (looksLowEntropy(v)) {
    problems.push(`${name} uses too few distinct characters to be a real secret. Generate one: openssl rand -hex 32`);
  }
  return problems;
}

/**
 * Validate the security-critical environment.
 *
 * @returns {{ok: boolean, problems: string[], warnings: string[]}}
 *   Returned rather than exiting here so this is testable; server.js
 *   owns the decision to exit.
 */
export function inspectEnv(env = process.env) {
  const problems = [];
  const warnings = [];

  // ---- NODE_ENV must be explicit ----
  // Two behaviours key off the exact string 'development':
  // utils/logger.js mirrors every log line to the console, and
  // config/database.js logs every SQL statement (bind values included
  // — that is customer phone numbers, emails and balances) into the
  // log file. An unset NODE_ENV is not 'production'; it just isn't
  // 'development' either, which is a confusing middle state to debug.
  const nodeEnv = String(env.NODE_ENV || '').trim();
  if (!['production', 'development', 'test'].includes(nodeEnv)) {
    problems.push(`NODE_ENV is "${nodeEnv || '(unset)'}"; it must be exactly production, development or test.`);
  }

  const isProd = nodeEnv === 'production';

  // ---- Signing and encryption keys ----
  problems.push(...checkSecret('JWT_SECRET', env.JWT_SECRET));

  // The provider API keys and webhook signing secrets in the
  // `providers` table are encrypted with this. If it is weak, every
  // vendor credential in the database is effectively plaintext, and
  // rotating it is a manual re-encrypt of every row — so it has to be
  // right on day one.
  problems.push(...checkSecret('APP_ENCRYPTION_KEY', env.APP_ENCRYPTION_KEY));

  // ---- Things that are only fatal in production ----
  if (isProd) {
    const origins = String(env.CLIENT_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    // server.js checks emptiness already; this adds the scheme rule.
    // An http:// origin on the allow-list means the session token is
    // sent over the wire in clear on any request the browser makes to
    // it, which defeats the point of having an allow-list.
    const insecure = origins.filter((o) => o.startsWith('http://'));
    if (insecure.length) {
      problems.push(`CLIENT_ORIGINS contains ${insecure.length} plain-http origin(s). Production origins must be https.`);
    }

    if (String(env.DEBUG_SQL || '').toLowerCase() === 'true') {
      problems.push('DEBUG_SQL=true logs every SQL statement with its bind values (customer phone numbers, emails, balances) to disk. Not permitted in production.');
    }
    if (String(env.DEBUG_CONSOLE || '').toLowerCase() === 'true') {
      problems.push('DEBUG_CONSOLE=true mirrors every log line to stdout, where the process manager captures it outside the log rotation and retention policy. Not permitted in production.');
    }

    // Not fatal: the app works, but nobody is told when it breaks.
    if (!String(env.ADMIN_ALERT_EMAIL || '').trim()) {
      warnings.push('ADMIN_ALERT_EMAIL is not set — provider downtime and webhook failures will be logged but not sent to anyone.');
    }

    // Not fatal, because forcing TLS on a server that does not offer it
    // fails the handshake and the whole platform stops booting. But a
    // remote managed database reached without TLS sends the DB password
    // on handshake and then every customer phone number, email and
    // balance in clear across the public internet.
    const dbHost = String(env.DB_HOST || '').trim().toLowerCase();
    const dbIsLocal = ['', 'localhost', '127.0.0.1', '::1'].includes(dbHost);
    if (!dbIsLocal && String(env.DB_SSL || '').toLowerCase() !== 'true') {
      warnings.push(`DB_SSL is not enabled but DB_HOST is remote (${dbHost}). Every statement, including the credentials on handshake, crosses the network in clear. Set DB_SSL=true once you have confirmed the provider supports TLS.`);
    }
    if (!dbIsLocal && String(env.DB_SSL_REJECT_UNAUTHORIZED || '').toLowerCase() === 'false') {
      warnings.push('DB_SSL_REJECT_UNAUTHORIZED=false encrypts the connection but does not verify the server certificate, so it cannot stop an active man-in-the-middle. Only correct if the provider ships a self-signed certificate.');
    }
  } else {
    // Say it once, loudly, so a production box misconfigured as
    // development is obvious in the first ten lines of the log.
    warnings.push(`Running with NODE_ENV=${nodeEnv}. Verbose diagnostics are available; this must never be the value on a live server.`);
  }

  return { ok: problems.length === 0, problems, warnings };
}

/**
 * Run the checks and, in production, exit rather than serve.
 * Called from server.js before app.listen().
 */
export function assertSecureBoot(env = process.env) {
  const { ok, problems, warnings } = inspectEnv(env);
  warnings.forEach((w) => logger.warn(`CONFIG: ${w}`));

  if (ok) return;

  const isProd = String(env.NODE_ENV || '').trim() === 'production';
  if (isProd) {
    logger.error('FATAL: refusing to start — insecure configuration', { problems });
    // Also to stderr: on a first deploy the log file may not be
    // readable yet, or the operator is watching the terminal. A
    // refusal to boot that leaves no visible reason gets diagnosed as
    // "the app is broken" and worked around.
    process.stderr.write(`\nFATAL: refusing to start — insecure configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n\n`);
    process.exit(1);
  }
  problems.forEach((p) => logger.warn(`CONFIG: ${p}`));
}

export default { inspectEnv, assertSecureBoot };
