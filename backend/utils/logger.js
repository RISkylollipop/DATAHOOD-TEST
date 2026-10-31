// ============================================================
//  Logger — file-based, zero console output in production
// ------------------------------------------------------------
//  All logs go to timestamped files. No console.log in prod.
//  Errors trigger email alerts when they indicate downtime.
// ============================================================

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendDowntimeAlert } from '../services/emailService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LOG_DIR = path.join(__dirname, '../logs');

// Ensure logs directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// All log times are rendered in Africa/Lagos (WAT, UTC+1) — the business's
// local time — using a readable "YYYY-MM-DD HH:mm:ss" format instead of ISO
// UTC (which read 1h behind and with a T/Z that's awkward to scan).
const LAGOS_TZ = 'Africa/Lagos';
const _dtFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: LAGOS_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function lagosParts(d = new Date()) {
  const p = Object.fromEntries(_dtFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return p; // { year, month, day, hour, minute, second }
}

function timestamp() {
  const p = lagosParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function getLogFile(level) {
  const p = lagosParts();
  const date = `${p.year}-${p.month}-${p.day}`; // Lagos-local day, not UTC
  return path.join(LOG_DIR, `${level}-${date}.log`);
}

// ------------------------------------------------------------
//  Where did this come from?
// ------------------------------------------------------------
//  Every entry carries an `at` field: "controllers/airtimeController.js:258".
//  Derived from a throwaway stack trace, so it is impossible for a call
//  site to forget it — the alternative (hand-passing a location in each
//  meta object) is wrong the moment anyone moves a line.
//
//  Message strings are NOT unique: "Provider request failed" appears in
//  several controllers, so grepping the message alone lands you in the
//  wrong file. The line number is the point.
//
//  Paths are relative to backend/ and always forward-slashed, so a log
//  written on Windows reads the same as one from the Linux server.
const BACKEND_ROOT = path.join(__dirname, '..');

/**
 * Normalise a path to forward slashes, whatever produced it.
 *
 * Splits on BOTH separators rather than `path.sep`, which is only the local
 * one: a log written on the Windows dev box and a log from the Linux server
 * should read identically, and `path.sep` gives each machine a different
 * answer — so the version that used it was a no-op on Linux and untestable
 * there too. Exported so it can be checked against a Windows-style path from
 * any platform.
 */
export function toPortablePath(p) {
  return String(p ?? '').split(/[\\/]+/).join('/');
}

// One stack frame -> "controllers/airtimeController.js:258", or null if the
// frame carries no file position (native, eval, internal).
//
// Shared by callSite (where the log call sits) and errorSite (where the error
// was thrown). Two copies of this parsing would drift, and the difference
// would only show up in a log nobody can trust.
function frameToLocation(frame) {
  // "at fn (file:///C:/x/utils/logger.js:50:20)" or "at file:///...:50:20"
  const m = frame.match(/\(?((?:file:\/\/\/|\/|[A-Za-z]:\\)[^()]+?):(\d+):\d+\)?\s*$/);
  if (!m) return null;

  let file = m[1];
  try {
    if (file.startsWith('file://')) file = fileURLToPath(file);
  } catch {
    // Not a URL we can convert (eval, internal). Fall through with the raw
    // string rather than dropping the frame entirely.
  }

  // The logger's own frames are never the answer.
  if (path.resolve(file) === path.resolve(__filename)) return null;

  const rel = toPortablePath(path.relative(BACKEND_ROOT, file));
  // Outside backend/ (node internals, a dependency): keep the basename
  // only. A full absolute path in a log file is noise, and on a shared
  // host it also discloses the deploy directory.
  return `${rel.startsWith('..') ? path.basename(file) : rel}:${m[2]}`;
}

export function callSite(depth = 0) {
  const orig = Error.stackTraceLimit;
  // Deep enough to clear the logger's own frames plus a wrapper or two,
  // shallow enough that building the string stays cheap on a hot path.
  Error.stackTraceLimit = 12;
  const raw = new Error().stack || '';
  Error.stackTraceLimit = orig;

  let skipped = 0;
  for (const frame of raw.split('\n').slice(1)) {
    const loc = frameToLocation(frame);
    if (!loc) continue;
    if (skipped++ < depth) continue;
    return loc;
  }
  return 'unknown';
}

/**
 * Where an error was THROWN, read off its own stack.
 *
 * `at` records where logger.error() was called, which for a caught error is
 * the handler — and the central error middleware is one line for the whole
 * app, so `at: server.js:162` names the same place for every failure in the
 * codebase and answers nothing. The throw site lives only in err.stack.
 *
 * Returns null when there is no usable stack, so the caller can omit the
 * field rather than log the string "unknown" and imply it looked.
 */
export function errorSite(err) {
  const raw = typeof err === 'string' ? err : err?.stack;
  if (typeof raw !== 'string' || !raw) return null;
  for (const frame of raw.split('\n').slice(1)) {
    const loc = frameToLocation(frame);
    if (loc) return loc;
  }
  return null;
}

function writeLog(level, message, meta = {}) {
  // If the caller handed us a stack, the throw site is the location worth
  // having, and deriving it here means no call site can forget to. Done
  // before the entry is built so `thrownAt` sits beside `at`: one says where
  // the failure happened, the other where it was noticed, and for a caught
  // error those are different files.
  const thrownAt = meta && typeof meta === 'object' && !meta.thrownAt
    ? errorSite(meta.stack || meta.error?.stack)
    : null;

  const entry = {
    timestamp: timestamp(),
    level,
    message,
    // depth 0, NOT 1: the loop above already skips every frame belonging to
    // this file, so the first frame it yields is the code that called
    // logger.error(). Passing 1 here would report the caller's caller.
    //
    // Placed before ...meta so an explicit `at` in a meta object still wins,
    // which is how a shared helper reports the location that matters rather
    // than its own.
    at: callSite(0),
    ...meta,
    // Only set when a throw site was actually found: an absent field reads as
    // "no stack was available", where the string "unknown" would suggest we
    // looked at a stack and failed to parse it.
    //
    // What protects a caller-supplied `thrownAt` is the `!meta.thrownAt` guard
    // above, NOT this spread position — with the guard in place the value is
    // null whenever the caller set one, so the order here cannot change the
    // outcome either way. Said explicitly because a mutation run proved it:
    // moving this line above ...meta changed nothing, and a comment claiming
    // the position is load-bearing would have sent the next reader to defend
    // the wrong line.
    ...(thrownAt ? { thrownAt } : {}),
  };
  const line = JSON.stringify(entry) + '\n';
  const file = getLogFile(level);

  fs.appendFileSync(file, line, 'utf8');

  // Mirror to stdout only when explicitly asked, via DEBUG_CONSOLE.
  //
  // This used to key off `NODE_ENV === 'development'`, which is the same
  // mistake that filled backend/logs with 14,343 SQL statements: the .env on
  // this project says `development`, so the "development only" branch was the
  // branch that ran, and every log line — customer phone numbers, emails,
  // balances, provider responses — went to stdout where the process manager
  // captures it OUTSIDE the log rotation and retention policy this file
  // implements. NDPA retention cannot cover a file it does not know about.
  //
  // utils/bootGuard.js refuses to boot with DEBUG_CONSOLE=true in production,
  // so the two halves of this rule cannot drift apart.
  if (String(process.env.DEBUG_CONSOLE || '').toLowerCase() === 'true') {
    // eslint-disable-next-line no-console
    console.log(`[${level.toUpperCase()}]`, message, meta);
  }
}

/**
 * Startup banner. The ONLY message allowed to print to the console in any
 * environment — it's a fixed, non-sensitive "server is up" line. Everything
 * else (including all errors, tokens, keys) goes to files only.
 */
export function boot(message, meta) {
  writeLog('info', message, meta);
  // eslint-disable-next-line no-console
  console.log(message);
}

export function info(message, meta) {
  writeLog('info', message, meta);
}

export function warn(message, meta) {
  writeLog('warn', message, meta);
}

export function error(message, meta) {
  writeLog('error', message, meta);

  // Check if this is a downtime-related error that needs email alert
  if (isDowntimeError(message, meta)) {
    alertOnce(`error:${message}`, message, meta);
  }
}

export function providerError(provider, operation, errorMsg, meta) {
  const message = `Provider ${provider} failed on ${operation}: ${errorMsg}`;
  writeLog('provider-error', message, { provider, operation, ...meta });

  // Alert on provider downtime — throttled per provider+operation.
  //
  // This used to send unconditionally, which made it a self-inflicted denial of
  // service: a provider declining a purchase is an ORDINARY event that any
  // logged-in user can cause on demand (a wrong meter number, an invalid IUC,
  // a plan the vendor has stopped selling). One user in a retry loop would
  // therefore mail the operator hundreds of times, burn the Resend quota that
  // customer RECEIPTS depend on, and train whoever reads the alerts to ignore
  // them — so the one alert that mattered would be missed.
  alertOnce(
    `provider:${provider}:${operation}`,
    `Provider Downtime: ${provider}`,
    { operation, error: errorMsg, ...meta },
  );
}

// ---------- Alert throttle ----------
//
// One alert per distinct cause per window. In-memory is the right scope: the
// alert is about THIS process being unable to do its job, and the platform runs
// as a single Node process on one VPS (see the hosting notes) so there is no
// second instance to coordinate with. A restart legitimately re-alerts — a
// crash-looping server should be noisy.
//
// Suppression is COUNTED and reported in the next alert that gets through, so
// throttling never turns "500 failures" into something that reads like one.
const ALERT_WINDOW_MS = 15 * 60 * 1000;
const alertState = new Map(); // key -> { lastSentAt, suppressed }

// Bounded so a high-cardinality key (a provider error string that embeds a
// transaction reference, say) cannot grow this map without limit. Evicting the
// oldest entry only costs an extra alert, never a missed one.
const ALERT_KEYS_MAX = 500;

function alertOnce(key, subject, meta) {
  const now = Date.now();
  const prev = alertState.get(key);

  if (prev && now - prev.lastSentAt < ALERT_WINDOW_MS) {
    prev.suppressed += 1;
    return;
  }

  if (alertState.size >= ALERT_KEYS_MAX && !prev) {
    const oldest = alertState.keys().next().value;
    if (oldest !== undefined) alertState.delete(oldest);
  }

  const suppressed = prev?.suppressed || 0;
  alertState.set(key, { lastSentAt: now, suppressed: 0 });

  const withCount = suppressed > 0
    ? { ...meta, suppressedSinceLastAlert: suppressed, alertWindowMinutes: ALERT_WINDOW_MS / 60000 }
    : meta;

  sendDowntimeAlert(subject, withCount).catch((err) => {
    // Never throw from a logger — see the note at the top of this file. The
    // failure itself is written to disk so a silently broken alert channel is
    // still discoverable.
    writeLog('error', 'Failed to send downtime email alert', {
      originalError: subject, emailError: err.message,
    });
  });
}

/**
 * Detect if an error indicates site or provider downtime that needs alerting.
 */
function isDowntimeError(message, meta) {
  const downtimeKeywords = [
    'database',
    'connection',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'cannot connect',
    'server error',
    'uncaught exception',
    'unhandled rejection',
  ];
  const lowerMsg = message.toLowerCase();
  return downtimeKeywords.some(keyword => lowerMsg.includes(keyword));
}

// Catch uncaught exceptions and promise rejections — log + email alert
process.on('uncaughtException', (err) => {
  error('Uncaught Exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  error('Unhandled Promise Rejection', { reason: String(reason), promise: String(promise) });
});
