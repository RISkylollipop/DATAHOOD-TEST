// ============================================================
//  Backend — Server Entry Point
// ============================================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import { testConnection } from './config/database.js';
import models from './models/index.js'; // register models + associations
import { reportSchemaDrift } from './utils/schemaGuard.js';
import { assertSecureBoot } from './utils/bootGuard.js';
import { startRetentionJob } from './services/retentionService.js';
import { SESSION_HEADERS } from './utils/sessionToken.js';
import * as logger from './utils/logger.js';

// Routes
import authRoutes from './routes/auth.js';
import blacklistRoutes from './routes/blacklist.js';
import providerRoutes from './routes/providers.js';
import airtimeRoutes from './routes/airtime.js';
import dataRoutes from './routes/data.js';
import billsRoutes from './routes/bills.js';
import walletRoutes from './routes/wallet.js';
import paymentRoutes from './routes/payment.js';
import verifyRoutes from './routes/verify.js';
import catalogRoutes from './routes/catalog.js';
import planRoutes from './routes/plans.js';
import salesRoutes from './routes/sales.js';
import userRoutes from './routes/users.js';
import profileRoutes from './routes/profile.js';
import newsletterRoutes from './routes/newsletter.js';

dotenv.config();

// ---------- Refuse to serve in an insecure configuration ----------
// Runs before anything binds a port. Every check inside is invisible at
// runtime: a placeholder JWT_SECRET signs perfectly valid tokens, an
// http:// origin on the CORS allow-list works fine, DEBUG_SQL=true just
// writes a bigger log file. Nothing fails, so nothing gets noticed.
// In production a failure exits(1); in development it warns and
// continues, because a dev box that refuses to boot gets "fixed" by
// deleting the guard.
assertSecureBoot();

const app = express();

const IS_PROD = process.env.NODE_ENV === 'production';

// ---------- Trust the reverse proxy (SECURITY-AUDIT H4) ----------
// Behind Nginx / cPanel / any proxy, the real client IP arrives in
// X-Forwarded-For. Trust exactly ONE proxy hop so per-IP rate limits
// and logged IPs are the real client, not the proxy — and can't be
// spoofed by adding extra X-Forwarded-For entries. If you chain more
// proxies (e.g. Cloudflare -> Nginx), raise this number to match.
app.set('trust proxy', 1);

// ---------- Security & core middleware ----------
app.use(helmet());
app.use(compression());

const allowedOrigins = (process.env.CLIENT_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// SECURITY-AUDIT H1: fail CLOSED. In production we refuse to boot with an
// empty CLIENT_ORIGINS list rather than silently allowing every origin.
if (IS_PROD && allowedOrigins.length === 0) {
  logger.error('FATAL: CLIENT_ORIGINS is empty in production. Set it to your HTTPS domain(s). Refusing to start with an open CORS policy.');
  process.exit(1);
}

app.use(cors({
  origin: (origin, cb) => {
    // Allow non-browser tools with no Origin header (curl/Postman, health
    // checks, same-origin server calls). Browser cross-origin requests must
    // be on the explicit allow-list. We NO LONGER open to all when the list
    // is empty (that only ever happens in non-prod now).
    if (!origin || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    if (!IS_PROD && allowedOrigins.length === 0) {
      // Dev convenience only: no list configured locally → allow.
      return cb(null, true);
    }
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
  // Without this the browser DROPS the renewal header. A cross-origin
  // response carries X-Session-Token, but script access to any header
  // outside the CORS-safelisted set is denied unless it is named here —
  // so the frontend would never see a renewed token and every session
  // would die 15 minutes after login regardless of activity. The
  // frontend and backend are deployed separately here, so this is the
  // normal path, not an edge case. Names come from sessionToken.js so
  // the two cannot drift apart.
  exposedHeaders: SESSION_HEADERS,
}));

// Capture the raw body so payment webhooks can verify HMAC signatures
// against the exact bytes the gateway signed (not a re-serialized object).
app.use(express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
// Explicit small limit. Nothing in this API takes a form post — the
// frontend sends JSON everywhere — so this parser exists only to answer
// stray requests politely. An unbounded (or generous) form parser is a
// free memory-pressure primitive: it buffers the whole body before any
// route, auth check or rate limit gets a say.
//
// `extended: false` on purpose too. The extended parser builds nested
// objects from bracket syntax (a[b][c]=1), which is how prototype-
// pollution payloads arrive in a body; the simple parser produces flat
// string values only.
app.use(express.urlencoded({ extended: false, limit: '32kb', parameterLimit: 100 }));

// ---------- Global rate limit ----------
// This is a BLUNT anti-runaway device, not the real brute-force control —
// that lives in middleware/rateLimit.js, keyed per (IP + account) on the
// sensitive auth routes. So this ceiling is deliberately generous.
//
// Why not 300: a single dashboard page load fires several /api calls, so
// ordinary admin browsing used to exhaust a 300/15min budget and then lock
// the operator out of /auth/login as collateral damage. Worse, this limiter
// keys on IP alone, and Nigerian mobile carriers put many subscribers behind
// one CGNAT address — so a low ceiling can lock out a whole carrier pool of
// legitimate users at once.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,                // ~80 req/min sustained per IP
  standardHeaders: true,
  legacyHeaders: false,
  // Two classes of request are deliberately exempt from this budget:
  //
  //  1. Health probes. Uptime monitors poll /api/health constantly (every
  //     10s = 90 hits per window). Never let liveness probes eat a real
  //     user's budget.
  //  2. Auth routes. They carry their own per-IP ceiling
  //     (authTrafficLimiter) plus strict per-account limiters, so counting
  //     them here only creates a way for unrelated read traffic to lock
  //     people out of logging in — which is exactly what happened when a
  //     refetch loop on one admin page drained the window.
  //
  // req.path is relative to the /api mount, so it reads '/auth/login' here.
  // The optional prefix keeps this correct if the mount point ever changes.
  skip: (req) => req.path === '/health'
    || req.path === '/api/health'
    || /^\/(api\/)?auth\//.test(req.path),
  handler: (req, res) => res.status(429).json({
    status: 'fail',
    msg: 'Too many requests. Please wait a moment and try again.',
  }),
});
app.use('/api', limiter);

// ---------- Health check (used by uptime monitors) ----------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Datahood-api', time: new Date().toISOString() });
});

// ---------- Routes ----------
app.use('/api', authRoutes);
app.use('/api', blacklistRoutes);
app.use('/api', providerRoutes);
app.use('/api', airtimeRoutes);
app.use('/api', dataRoutes);
app.use('/api', billsRoutes);
app.use('/api', walletRoutes);
app.use('/api', paymentRoutes);
app.use('/api', verifyRoutes);
app.use('/api', catalogRoutes);
app.use('/api', planRoutes);
app.use('/api', salesRoutes);
app.use('/api', userRoutes);
app.use('/api', profileRoutes);
app.use('/api', newsletterRoutes);

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ status: 'fail', msg: 'Endpoint not found.' });
});

// ---------- Central error handler ----------
// Logs to file (never console), returns a safe message.
//
// The stack goes in the LOG, never in the response: this is the one place
// with no other clue about where the failure came from, since `at` here would
// read "server.js" for every unhandled error in the entire codebase. The
// logger reads the throw site off it into a `thrownAt` field.
//
// `next` is unused but must stay in the signature — Express identifies an
// error handler by its arity, and a 3-argument version silently stops being
// one, which would turn every unhandled error into a hung request.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled request error', {
    error: err.message,
    method: req.method,
    path: req.path,
    stack: err.stack,
  });
  res.status(500).json({ status: 'fail', msg: 'Something went wrong. Please try again.' });
});

// ---------- Boot ----------
const PORT = process.env.PORT || 5000;

async function start() {
  const dbOk = await testConnection();
  if (!dbOk) {
    logger.error('Server start aborted: database unreachable');
    // Still listen so the health endpoint can report, but warn loudly in logs.
  }
  // Name a pending migration in the log BEFORE the first request fails.
  // Logs and continues rather than refusing to boot: drift in one table
  // must not take down the endpoints that still work, and a server that
  // won't start also takes away the admin panel needed to diagnose it.
  if (dbOk) {
    await reportSchemaDrift(models).catch((err) => {
      logger.warn('Schema guard failed to run', { error: err.message });
    });
  }

  app.listen(PORT, () => {
    logger.boot(`🚀 Datahood API running on port ${PORT}`);
  });

  // Retention sweeps: redact old verification photos/details, purge
  // identifiers, clear spent OTPs. Daily, first run one interval in (see
  // the note in retentionService — a restart loop must not fire it every
  // few seconds). Only start it once the DB is actually reachable.
  if (dbOk) {
    startRetentionJob();
  } else {
    logger.warn('Retention job not started: database was unreachable at boot');
  }
}

start();

export default app;