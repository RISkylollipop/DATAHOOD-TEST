// ============================================================
//  scripts/pricing_diagnose.js — why is the pricing page empty?
// ------------------------------------------------------------
//  GET /api/catalog/pricing can return an empty `networks` array for
//  several unrelated reasons, and they are indistinguishable from the
//  browser: the page just renders no tables. This reproduces the
//  controller's own logic against the live DB and names the failing
//  condition instead of leaving it to guesswork.
//
//  Reuses config/database.js so it shares the app's credentials and
//  pool — "works for the API but not for the script" cannot happen.
//  Prints no connection details: nothing here should end up pasted
//  into a chat or an issue.
//
//  Usage:  node scripts/pricing_diagnose.js
// ============================================================

import sequelize from '../config/database.js';
import Network from '../models/Network.js';
import DataPlan from '../models/DataPlan.js';
import SiteSettings from '../models/SiteSettings.js';

function line() {
  process.stdout.write('-'.repeat(58) + '\n');
}

async function main() {
  await sequelize.authenticate();
  process.stdout.write('\nPricing diagnostic\n');
  line();

  const [nets, plans, settings] = await Promise.all([
    Network.findAll({ attributes: ['nId', 'network', 'networkStatus'], order: [['nId', 'ASC']] }),
    DataPlan.findAll({ attributes: ['pId', 'name', 'datanetwork', 'status'] }),
    SiteSettings.findByPk(1),
  ]);

  const enabled = plans.filter((p) => p.status === 'enabled');

  process.stdout.write(`networks rows        : ${nets.length}\n`);
  process.stdout.write(`dataplans rows       : ${plans.length}\n`);
  process.stdout.write(`  status='enabled'   : ${enabled.length}\n`);
  process.stdout.write(`  other status       : ${plans.length - enabled.length}\n`);
  process.stdout.write(`site_settings row 1  : ${settings ? 'present' : 'MISSING'}\n`);
  line();

  // Per-network breakdown. The controller groups plans by datanetwork -> nId,
  // so a plan whose datanetwork matches no network row is invisible however
  // healthy it looks in the admin list.
  const seen = new Set();
  for (const n of nets) {
    const mine = enabled.filter((p) => p.datanetwork === n.nId);
    seen.add(n.nId);
    const flag = mine.length === 0 ? '  <-- contributes nothing' : '';
    process.stdout.write(
      `nId ${n.nId}  ${String(n.network).padEnd(9)} status=${String(n.networkStatus).padEnd(4)} `
      + `enabled plans=${mine.length}${flag}\n`,
    );
  }

  const orphans = enabled.filter((p) => !seen.has(p.datanetwork));
  if (orphans.length) {
    line();
    process.stdout.write(`WARNING: ${orphans.length} enabled plan(s) point at a datanetwork with no\n`);
    process.stdout.write('networks row, so they can never appear. Sample:\n');
    for (const p of orphans.slice(0, 5)) {
      process.stdout.write(`  pId ${p.pId} datanetwork=${p.datanetwork} name=${p.name}\n`);
    }
  }

  // Mirror of the controller's final shape, including the surviving
  // `.filter(n => n.plans.length > 0)`.
  const published = nets
    .map((n) => ({ nId: n.nId, count: enabled.filter((p) => p.datanetwork === n.nId).length }))
    .filter((n) => n.count > 0);

  line();
  process.stdout.write(`API would publish ${published.length} network table(s).\n\n`);

  if (published.length === 0) {
    process.stdout.write('DIAGNOSIS: the page will render its empty state.\n');
    if (nets.length === 0) {
      process.stdout.write('  Cause: the networks table is empty. Seed it first.\n');
    } else if (enabled.length === 0) {
      process.stdout.write(
        plans.length === 0
          ? '  Cause: dataplans is empty. Import/seed your plans.\n'
          : "  Cause: no plan has status='enabled'. Enable them under Admin -> Plans.\n",
      );
    } else {
      process.stdout.write('  Cause: enabled plans exist but none match a real nId (see above).\n');
    }
  } else {
    process.stdout.write('DIAGNOSIS: pricing data is fine. If the page still looks empty,\n');
    process.stdout.write('the fault is client-side — check the browser Network tab for the\n');
    process.stdout.write('/api/catalog/pricing call (a wrong API base URL is the usual cause).\n');
  }

  const off = nets.filter((n) => n.networkStatus !== 'On').length;
  if (off > 0) {
    process.stdout.write(
      `\nNote: ${off} network(s) are not 'On'. Their prices still publish (by design)\n`
      + "but the page badges them 'Temporarily unavailable'.\n",
    );
  }

  const fees = { agent: settings?.agentupgrade, vendor: settings?.vendorupgrade };
  if (!Number(fees.agent) || !Number(fees.vendor)) {
    process.stdout.write(
      `\nNote: upgrade fees read agent=${fees.agent ?? 'null'} vendor=${fees.vendor ?? 'null'}; `
      + 'the tier cards will show N0.\n',
    );
  }

  process.stdout.write('\n');
}

main()
  .then(() => sequelize.close())
  .catch(async (err) => {
    process.stderr.write(`\nDiagnostic failed: ${err.message}\n`);
    if (/Unknown column/i.test(err.message)) {
      process.stderr.write('That is schema drift — run: node scripts/migrate.js\n');
    }
    await sequelize.close().catch(() => {});
    process.exitCode = 1;
  });
