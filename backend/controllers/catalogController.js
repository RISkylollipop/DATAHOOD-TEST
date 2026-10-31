// ============================================================
//  Catalog Controller — read-only data the purchase forms need
// ------------------------------------------------------------
//  Populates the frontend dropdowns: networks, data plans and
//  cable plans. Prices are resolved to the logged-in user's tier
//  (user / agent / vendor) so the UI shows the right amount.
// ============================================================

import { Network, DataPlan, CablePlan, SiteSettings, Subscriber } from '../models/index.js';
import { sequelize } from '../models/index.js';
import * as logger from '../utils/logger.js';
import { handleSchemaDrift } from '../utils/dbErrors.js';

function tierPrice(row, sType) {
  if (sType === 3) return row.vendorprice;
  if (sType === 2) return row.agentprice;
  return row.userprice;
}

// Display-only branding: 9MOBILE is shown as "T2" in the new UI, but the DB
// value/id stays 9MOBILE so provider mappings keep working (see Network model).
function networkLabel(name) {
  const k = String(name || '').toUpperCase();
  if (k === '9MOBILE' || k === 'ETISALAT') return 'T2';
  return name;
}

// ---------- GET /api/catalog/networks ----------
export async function getNetworks(req, res) {
  try {
    const nets = await Network.findAll({
      attributes: [
        'nId', 'network', 'networkStatus', 'vtuStatus',
        'smeStatus', 'giftingStatus', 'corporateStatus', 'sharesellStatus',
      ],
      order: [['nId', 'ASC']],
    });
    return res.json({ status: 'success', data: nets });
  } catch (err) {
    logger.error('getNetworks failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load networks.' });
  }
}

// ---------- GET /api/catalog/network-status ----------
//  Lightweight "network stability" signal for the purchase forms.
//  Combines two sources:
//    1. Admin On/Off toggles (networkStatus / vtuStatus / data-type flags).
//    2. Recent real-world success rate, derived from the last ~90 minutes of
//       Airtime + Data transactions (the network name is embedded in
//       servicedesc; transactions have no network FK).
//  Public + cheap: one aggregate query, no per-network loop of round-trips.
export async function getNetworkStatus(req, res) {
  try {
    const nets = await Network.findAll({
      attributes: [
        'nId', 'network', 'networkStatus', 'vtuStatus', 'sharesellStatus',
        'smeStatus', 'giftingStatus', 'corporateStatus',
      ],
      order: [['nId', 'ASC']],
    });

    // Pull recent finished txns once, then bucket them per network in JS.
    // status 0 = success, 2 = failed (5 = processing -> ignored, not yet decided).
    const windowStart = new Date(Date.now() - 90 * 60 * 1000);
    const recent = await sequelize.query(
      `SELECT servicedesc, status FROM transactions
         WHERE servicename IN ('Airtime', 'Data')
           AND status IN (0, 2)
           AND date >= :windowStart`,
      { replacements: { windowStart }, type: sequelize.QueryTypes.SELECT }
    );

    const data = nets.map((n) => {
      const key = String(n.network || '').toUpperCase();
      // Match the network by name inside servicedesc. Names are distinct
      // enough (MTN / GLO / AIRTEL / 9MOBILE) that substring matching is safe.
      let ok = 0;
      let fail = 0;
      for (const row of recent) {
        if (String(row.servicedesc || '').toUpperCase().includes(key)) {
          if (row.status === 0) ok += 1;
          else fail += 1;
        }
      }
      const sample = ok + fail;
      const successRate = sample > 0 ? Math.round((ok / sample) * 100) : null;

      // Admin switch wins: if the whole network is Off, it is down regardless.
      let stability;
      if (n.networkStatus !== 'On') {
        stability = 'down';
      } else if (sample < 4) {
        // Too little traffic to judge — treat as stable (don't scare users).
        stability = 'stable';
      } else if (successRate >= 90) {
        stability = 'stable';
      } else if (successRate >= 60) {
        stability = 'unstable';
      } else {
        stability = 'down';
      }

      return {
        nId: n.nId,
        network: n.network,          // raw DB value (kept as 9MOBILE)
        label: networkLabel(n.network), // display value (T2 for 9MOBILE)
        networkStatus: n.networkStatus,
        vtuStatus: n.vtuStatus,
        sharesellStatus: n.sharesellStatus,
        smeStatus: n.smeStatus,
        giftingStatus: n.giftingStatus,
        corporateStatus: n.corporateStatus,
        stability,                   // 'stable' | 'unstable' | 'down'
        successRate,                 // 0-100, or null when no recent sample
        sample,                      // number of recent txns considered
      };
    });

    return res.json({ status: 'success', data });
  } catch (err) {
    logger.error('getNetworkStatus failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load network status.' });
  }
}

// ---------- GET /api/catalog/dataplans?network=nId ----------
export async function getDataPlans(req, res) {
  const sType = req.user?.sType || 1;
  const { network } = req.query;
  try {
    // Only enabled plans reach customers. When a provider pauses a bundle the
    // admin disables it rather than deleting the row (pricing history and past
    // transactions must survive), so it has to be filtered out here as well as
    // blocked at purchase time in dataController.
    const where = { status: 'enabled' };
    if (network) where.datanetwork = parseInt(network);
    const plans = await DataPlan.findAll({ where, order: [['datanetwork', 'ASC'], ['pId', 'ASC']] });
    const data = plans.map((p) => ({
      pId: p.pId,
      name: p.name,
      type: p.type,
      day: p.day,
      network: p.datanetwork,
      price: tierPrice(p, sType),
    }));
    return res.json({ status: 'success', data });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'getDataPlans' })) return;
    logger.error('getDataPlans failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load data plans.' });
  }
}

// ---------- GET /api/catalog/pricing ----------
//  PUBLIC price list — no login required.
//
//  Serves two audiences from one payload:
//   1. Visitors who have not signed up and want to compare rates first.
//   2. Existing customers, who see their own tier highlighted alongside
//      what they would pay as Agent/Vendor — the upgrade incentive.
//
//  Every tier price is returned for every plan; the frontend decides what to
//  emphasise. The buying price (`price`) is NEVER exposed — that is our margin
//  and must not leak to customers or competitors.
export async function getPublicPricing(req, res) {
  try {
    // optionalAuth only decodes the token; look up the tier ourselves so an
    // anonymous visitor and a logged-in customer share one code path.
    let yourTier = null;
    if (req.auth?.role === 'user' && req.auth.sId) {
      const me = await Subscriber.findByPk(req.auth.sId, { attributes: ['sType'] });
      yourTier = me?.sType || null;
    }

    const [nets, plans, settings] = await Promise.all([
      Network.findAll({
        attributes: ['nId', 'network', 'networkStatus'],
        order: [['nId', 'ASC']],
      }),
      DataPlan.findAll({
        where: { status: 'enabled' },
        order: [['datanetwork', 'ASC'], ['pId', 'ASC']],
      }),
      SiteSettings.findByPk(1),
    ]);

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    // Group plans under their network so the UI renders one table per network
    // without having to do the grouping itself.
    //
    // Deliberately NOT filtered by networkStatus. This is a price *reference*,
    // not a buy form: a plan costs what it costs whether or not the network is
    // currently purchasable. Filtering here caused two real failures — admins
    // toggle networks Off during a provider outage, which blanked the whole
    // public price list at the worst possible moment, and Network.networkStatus
    // defaults to 'Off', so a freshly seeded catalogue published nothing at all.
    // The status travels as `available` instead and the UI badges it, which
    // tells the customer the truth rather than hiding the network.
    const networks = nets
      .map((n) => ({
        nId: n.nId,
        network: n.network,
        label: networkLabel(n.network),
        available: n.networkStatus === 'On',
        plans: plans
          .filter((p) => p.datanetwork === n.nId)
          .map((p) => {
            const user = num(p.userprice);
            const agent = num(p.agentprice);
            const vendor = num(p.vendorprice);
            return {
              pId: p.pId,
              name: p.name,
              type: p.type,
              day: p.day,
              user,
              agent,
              vendor,
              // Saving vs the standard User price — the number that actually
              // motivates an upgrade, so compute it once server-side instead
              // of leaving every client to derive it.
              agentSaving: Math.max(0, user - agent),
              vendorSaving: Math.max(0, user - vendor),
            };
          }),
      }))
      .filter((n) => n.plans.length > 0);

    return res.json({
      status: 'success',
      data: {
        networks,
        // One-off fees to move up a tier, so the page can show
        // "upgrade for N5,000" beside the savings.
        upgrade: {
          agent: num(settings?.agentupgrade),
          vendor: num(settings?.vendorupgrade),
        },
        yourTier,
      },
    });
  } catch (err) {
    if (handleSchemaDrift(res, err, { where: 'getPublicPricing' })) return;
    logger.error('getPublicPricing failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load pricing.' });
  }
}

// ---------- GET /api/catalog/cableplans?provider=cpId ----------
export async function getCablePlans(req, res) {
  const sType = req.user?.sType || 1;
  const { provider } = req.query;
  try {
    const where = {};
    if (provider) where.cableprovider = parseInt(provider);
    const plans = await CablePlan.findAll({ where, order: [['cableprovider', 'ASC'], ['cpId', 'ASC']] });
    const data = plans.map((p) => ({
      cpId: p.cpId,
      name: p.name,
      type: p.type,
      day: p.day,
      provider: p.cableprovider,
      price: tierPrice(p, sType),
    }));
    return res.json({ status: 'success', data });
  } catch (err) {
    logger.error('getCablePlans failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load cable plans.' });
  }
}

// ---------- GET /api/catalog/electricity ----------
//  Public list of ENABLED electricity DisCos for the purchase form.
//  Reflects the admin enable/disable toggle (electricityid.providerStatus).
//  Falls back gracefully to an empty list if the legacy table is absent.
export async function getElectricityProviders(req, res) {
  try {
    const rows = await sequelize.query(
      "SELECT eId, electricityid, provider, abbreviation FROM electricityid WHERE providerStatus = 'On' ORDER BY provider ASC",
      { type: sequelize.QueryTypes.SELECT }
    );
    const data = rows.map((r) => ({
      // slug mirrors the legacy PHP: lowercase provider with spaces -> hyphens.
      id: String(r.provider).toLowerCase().replace(/\s+/g, '-'),
      eId: r.eId,
      electricityid: r.electricityid,
      name: r.provider,
      abbreviation: r.abbreviation,
    }));
    return res.json({ status: 'success', data });
  } catch (err) {
    logger.error('getElectricityProviders failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load electricity providers.' });
  }
}

// ---------- GET /api/settings/public ----------
//  Non-sensitive site config used across the UI (branding, limits,
//  bank details for manual funding, social links).
export async function getPublicSettings(req, res) {
  try {
    const s = await SiteSettings.findByPk(1);
    if (!s) return res.json({ status: 'success', data: {} });
    return res.json({
      status: 'success',
      data: {
        sitename: s.sitename,
        siteurl: s.siteurl,
        phone: s.phone,
        email: s.email,
        whatsapp: s.whatsapp,
        whatsappgroup: s.whatsappgroup,
        facebook: s.facebook,
        twitter: s.twitter,
        instagram: s.instagram,
        telegram: s.telegram,
        sitecolor: s.sitecolor,
        agentupgrade: s.agentupgrade,
        vendorupgrade: s.vendorupgrade,
        wallettowalletcharges: s.wallettowalletcharges,
        electricitycharges: s.electricitycharges,
        airtimemin: s.airtimemin,
        airtimemax: s.airtimemax,
        accountname: s.accountname,
        accountno: s.accountno,
        bankname: s.bankname,
      },
    });
  } catch (err) {
    logger.error('getPublicSettings failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load settings.' });
  }
}
