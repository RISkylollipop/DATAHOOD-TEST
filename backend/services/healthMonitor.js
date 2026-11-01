// ============================================================
//  Health Monitor — active downtime detection
// ------------------------------------------------------------
//  Periodically checks:
//    1. Database connectivity (your site's health)
//    2. Each configured VTU/payment provider's reachability
//  On failure -> email alert. On recovery -> "back online" email.
//
//  Runs on an interval you set (default 5 min). Because it needs
//  real outbound network, it only does meaningful provider checks
//  when running on your live server.
// ============================================================

import sequelize from '../config/database.js';
import { testProviderConnection } from './providerService.js';
import { sendDowntimeAlert, sendEmail, adminAlertRecipient } from './emailService.js';
import * as logger from '../utils/logger.js';

// Tracks current up/down state so we only email on STATE CHANGE,
// not every single check (avoids inbox flooding).
const state = {
  database: { up: true, since: Date.now() },
  providers: {}, // keyed by host -> { up, since }
};

async function checkDatabase() {
  try {
    await sequelize.authenticate();
    if (!state.database.up) {
      // Recovered
      state.database = { up: true, since: Date.now() };
      await sendEmail({
        to: adminAlertRecipient(),
        subject: '✅ [RECOVERED] KwaraPolyData database is back online',
        text: `Database connection restored at ${new Date().toISOString()}.`,
      });
      logger.info('Database recovered');

      
    }
  } catch (err) {
    if (state.database.up) {
      // Just went down
      state.database = { up: false, since: Date.now() };
      await sendDowntimeAlert('Database connection lost', { error: err.message });
      logger.error('Database connection lost', { error: err.message, stack: err.stack });
    }
  }
}

/**
 * Check a list of provider hosts (pulled from your config/DB).
 * @param {Array<{name:string, host:string}>} providers
 */
async function checkProviders(providers = []) {
  for (const { name, host } of providers) {
    const result = await testProviderConnection(host);
    const prev = state.providers[host]?.up ?? true;

    if (result.reachable && !prev) {
      state.providers[host] = { up: true, since: Date.now() };
      await sendEmail({
        to: adminAlertRecipient(),
        subject: `✅ [RECOVERED] Provider ${name} is back online`,
        text: `${name} (${host}) is reachable again at ${new Date().toISOString()}.`,
      });
      logger.info(`Provider ${name} recovered`, { host });
    } else if (!result.reachable && prev) {
      state.providers[host] = { up: false, since: Date.now() };
      await sendDowntimeAlert(`Provider ${name} is unreachable`, { host, error: result.error });
      logger.providerError(name, 'health-check', result.error || 'unreachable', { host });
    }
  }
}

/**
 * Start the monitor. Pass a function that returns the current provider list
 * (so it always reflects what's configured in the admin panel).
 */
export function startHealthMonitor(getProviders, intervalMs = 5 * 60 * 1000) {
  const run = async () => {
    await checkDatabase();
    try {
      const providers = await getProviders();
      await checkProviders(providers);
    } catch (err) {
      logger.error('Health monitor provider check failed', { error: err.message, stack: err.stack });
    }
  };

  // Run once at startup, then on interval
  run();
  const handle = setInterval(run, intervalMs);
  logger.info('Health monitor started', { intervalMs });
  return handle;
}
