// ============================================================
//  Plan Controller — admin management of data/cable/electricity plans
// ------------------------------------------------------------
//  Mirrors the legacy PHP plan-management behavior and adds the
//  enable/disable toggle that the old admin panel lacked. Powers:
//    - Data plans (dataplans table: SME/Gifting/Corporate per network)
//    - Cable plans (cableplans table: GOTV/DSTV/Startimes packages)
//    - Electricity DisCos (electricityid table: manage available DisCos)
//
//  Two levels of enable/disable exist, and they are not interchangeable:
//
//   * TYPE level — networkid.smeStatus/giftingStatus/corporateStatus turns a
//     whole plan type off for one network (e.g. all MTN SME at once).
//   * PLAN level — dataplans.status ('enabled' | 'disabled') turns one bundle
//     off. Added by sql/dataplan_status_migration.sql because the legacy
//     table had no such column and the old panel could only DELETE a row,
//     which threw away the pricing history behind past transactions.
//
//  cableplans rows still have no status column of their own; cable is gated
//  at provider level (cableid.providerStatus), same as electricityid.
// ============================================================

import { DataPlan, CablePlan, Network } from '../models/index.js';
import { sequelize } from '../models/index.js';
import * as logger from '../utils/logger.js';
import { handleSchemaDrift } from '../utils/dbErrors.js';

// ---------- DATA PLANS ----------

/**
 * GET /api/admin/plans/data?network=1
 * Lists all data plans, optionally filtered by network (1-4).
 */
export async function listDataPlans(req, res) {
  try {
    const where = {};
    if (req.query.network) where.datanetwork = parseInt(req.query.network);
    const plans = await DataPlan.findAll({
      where,
      order: [['datanetwork', 'ASC'], ['type', 'ASC'], ['pId', 'ASC']],
    });
    return res.json({
      status: 'success',
      data: plans.map((p) => ({
        pId: p.pId,
        name: p.name,
        price: p.price,
        userprice: p.userprice,
        agentprice: p.agentprice,
        vendorprice: p.vendorprice,
        planid: p.planid,
        type: p.type,
        datanetwork: p.datanetwork,
        day: p.day,
        status: p.status,
        enabled: p.status === 'enabled',
      })),
    });
  } catch (err) {
    // A missing column here means a migration was never applied, and it
    // looks exactly like an emptied catalogue from the admin panel. Name it.
    if (handleSchemaDrift(res, err, { where: 'listDataPlans', audience: 'admin' })) return;
    logger.error('listDataPlans failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load data plans.' });
  }
}

/**
 * POST /api/admin/plans/data
 * body: { name, price, userprice, agentprice, vendorprice, planid, type, datanetwork, day }
 */
export async function createDataPlan(req, res) {
  const { name, price, userprice, agentprice, vendorprice, planid, type, datanetwork, day } = req.body;
  try {
    if (!name || !price || !userprice || !agentprice || !vendorprice || !planid || !type || !datanetwork || !day) {
      return res.status(400).json({ status: 'fail', msg: 'All plan fields are required.' });
    }
    const plan = await DataPlan.create({
      name: String(name).trim(),
      price: String(price),
      userprice: String(userprice),
      agentprice: String(agentprice),
      vendorprice: String(vendorprice),
      planid: String(planid),
      type: String(type),
      datanetwork: parseInt(datanetwork),
      day: String(day),
      status: req.body.status === 'disabled' ? 'disabled' : 'enabled',
    });
    logger.info('Data plan created', { pId: plan.pId, name });
    return res.status(201).json({ status: 'success', msg: 'Data plan added.', data: { pId: plan.pId } });
  } catch (err) {
    logger.error('createDataPlan failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not add data plan.' });
  }
}

/**
 * PUT /api/admin/plans/data/:id
 */
export async function updateDataPlan(req, res) {
  try {
    const plan = await DataPlan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ status: 'fail', msg: 'Data plan not found.' });

    const { name, price, userprice, agentprice, vendorprice, planid, type, datanetwork, day } = req.body;
    if (name !== undefined) plan.name = String(name).trim();
    if (price !== undefined) plan.price = String(price);
    if (userprice !== undefined) plan.userprice = String(userprice);
    if (agentprice !== undefined) plan.agentprice = String(agentprice);
    if (vendorprice !== undefined) plan.vendorprice = String(vendorprice);
    if (planid !== undefined) plan.planid = String(planid);
    if (type !== undefined) plan.type = String(type);
    if (datanetwork !== undefined) plan.datanetwork = parseInt(datanetwork);
    if (day !== undefined) plan.day = String(day);
    if (req.body.status !== undefined) {
      plan.status = req.body.status === 'disabled' ? 'disabled' : 'enabled';
    }

    await plan.save();
    logger.info('Data plan updated', { pId: plan.pId });
    return res.json({ status: 'success', msg: 'Data plan updated.' });
  } catch (err) {
    logger.error('updateDataPlan failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not update data plan.' });
  }
}

/**
 * PATCH /api/admin/plans/data/:id/toggle
 * Flips a single plan between enabled and disabled.
 *
 * This is the correct tool when a provider pauses one bundle: the row keeps
 * its pricing and stays attached to every past transaction, but customers
 * stop seeing it and cannot buy it. Prefer this over deleteDataPlan, which
 * destroys pricing history.
 */
export async function toggleDataPlan(req, res) {
  try {
    const plan = await DataPlan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ status: 'fail', msg: 'Data plan not found.' });

    plan.status = plan.status === 'enabled' ? 'disabled' : 'enabled';
    await plan.save();

    logger.info('Data plan toggled', { pId: plan.pId, name: plan.name, status: plan.status });
    return res.json({
      status: 'success',
      msg: `${plan.name} ${plan.status === 'enabled' ? 'enabled' : 'disabled'}.`,
      data: { pId: plan.pId, status: plan.status },
      enabled: plan.status === 'enabled',
    });
  } catch (err) {
    logger.error('toggleDataPlan failed', { error: err.message, stack: err.stack, pId: req.params.id });
    return res.status(500).json({ status: 'fail', msg: 'Could not toggle data plan.' });
  }
}

/**
 * DELETE /api/admin/plans/data/:id
 *
 * Hard delete. Kept for genuine mistakes (a plan added in error), but the
 * toggle above is what should be used when a provider merely pauses a bundle
 * — deleting orphans the pricing history behind past transactions.
 */
export async function deleteDataPlan(req, res) {
  try {
    const plan = await DataPlan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ status: 'fail', msg: 'Data plan not found.' });
    await plan.destroy();
    logger.info('Data plan deleted', { pId: req.params.id });
    return res.json({ status: 'success', msg: 'Data plan removed.' });
  } catch (err) {
    logger.error('deleteDataPlan failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not remove data plan.' });
  }
}

/**
 * PATCH /api/admin/plans/data/network/:networkId/toggle/:type
 * Toggles the network-level enable/disable for a data plan TYPE (SME/Gifting/Corporate).
 * type: sme | gifting | corporate
 * This flips networkid.smeStatus / giftingStatus / corporateStatus (On <-> Off).
 */
export async function toggleDataPlanType(req, res) {
  const { networkId, type } = req.params;
  try {
    const network = await Network.findByPk(parseInt(networkId));
    if (!network) return res.status(404).json({ status: 'fail', msg: 'Network not found.' });

    let field;
    if (type === 'sme') field = 'smeStatus';
    else if (type === 'gifting') field = 'giftingStatus';
    else if (type === 'corporate') field = 'corporateStatus';
    else return res.status(400).json({ status: 'fail', msg: 'Invalid plan type. Use: sme, gifting, corporate.' });

    network[field] = network[field] === 'On' ? 'Off' : 'On';
    await network.save();

    logger.info('Data plan type toggled', { networkId, type, newStatus: network[field] });
    return res.json({
      status: 'success',
      msg: `${type.toUpperCase()} plans ${network[field] === 'On' ? 'enabled' : 'disabled'}.`,
      enabled: network[field] === 'On',
    });
  } catch (err) {
    logger.error('toggleDataPlanType failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not toggle plan type.' });
  }
}

/**
 * GET /api/admin/plans/data/networks
 * Lists the 4 networks with their per-type On/Off status, so the admin UI can
 * render enable/disable toggles for SME / Gifting / Corporate per network.
 */
export async function listDataNetworks(req, res) {
  try {
    const nets = await Network.findAll({
      attributes: [
        'nId', 'network', 'networkStatus', 'vtuStatus',
        'smeStatus', 'giftingStatus', 'corporateStatus', 'sharesellStatus',
      ],
      order: [['nId', 'ASC']],
    });
    return res.json({
      status: 'success',
      data: nets.map((n) => ({
        nId: n.nId,
        network: n.network,
        networkStatus: n.networkStatus,
        sme: n.smeStatus === 'On',
        gifting: n.giftingStatus === 'On',
        corporate: n.corporateStatus === 'On',
      })),
    });
  } catch (err) {
    logger.error('listDataNetworks failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load networks.' });
  }
}

// ---------- CABLE PLANS ----------

/**
 * GET /api/admin/plans/cable?provider=1
 * Lists all cable plans, optionally filtered by provider (1=GOTV, 2=DSTV, 3=STARTIMES).
 */
export async function listCablePlans(req, res) {
  try {
    const where = {};
    if (req.query.provider) where.cableprovider = parseInt(req.query.provider);
    const plans = await CablePlan.findAll({
      where,
      order: [['cableprovider', 'ASC'], ['cpId', 'ASC']],
    });
    return res.json({
      status: 'success',
      data: plans.map((p) => ({
        cpId: p.cpId,
        name: p.name,
        price: p.price,
        userprice: p.userprice,
        agentprice: p.agentprice,
        vendorprice: p.vendorprice,
        planid: p.planid,
        type: p.type,
        cableprovider: p.cableprovider,
        day: p.day,
      })),
    });
  } catch (err) {
    logger.error('listCablePlans failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load cable plans.' });
  }
}

/**
 * POST /api/admin/plans/cable
 */
export async function createCablePlan(req, res) {
  const { name, price, userprice, agentprice, vendorprice, planid, type, cableprovider, day } = req.body;
  try {
    if (!name || !price || !userprice || !agentprice || !vendorprice || !planid || !cableprovider || !day) {
      return res.status(400).json({ status: 'fail', msg: 'All plan fields are required (type is optional).' });
    }
    const plan = await CablePlan.create({
      name: String(name).trim(),
      price: String(price),
      userprice: String(userprice),
      agentprice: String(agentprice),
      vendorprice: String(vendorprice),
      planid: String(planid),
      type: type ? String(type) : null,
      cableprovider: parseInt(cableprovider),
      day: String(day),
    });
    logger.info('Cable plan created', { cpId: plan.cpId, name });
    return res.status(201).json({ status: 'success', msg: 'Cable plan added.', data: { cpId: plan.cpId } });
  } catch (err) {
    logger.error('createCablePlan failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not add cable plan.' });
  }
}

/**
 * PUT /api/admin/plans/cable/:id
 */
export async function updateCablePlan(req, res) {
  try {
    const plan = await CablePlan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ status: 'fail', msg: 'Cable plan not found.' });

    const { name, price, userprice, agentprice, vendorprice, planid, type, cableprovider, day } = req.body;
    if (name !== undefined) plan.name = String(name).trim();
    if (price !== undefined) plan.price = String(price);
    if (userprice !== undefined) plan.userprice = String(userprice);
    if (agentprice !== undefined) plan.agentprice = String(agentprice);
    if (vendorprice !== undefined) plan.vendorprice = String(vendorprice);
    if (planid !== undefined) plan.planid = String(planid);
    if (type !== undefined) plan.type = type ? String(type) : null;
    if (cableprovider !== undefined) plan.cableprovider = parseInt(cableprovider);
    if (day !== undefined) plan.day = String(day);

    await plan.save();
    logger.info('Cable plan updated', { cpId: plan.cpId });
    return res.json({ status: 'success', msg: 'Cable plan updated.' });
  } catch (err) {
    logger.error('updateCablePlan failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not update cable plan.' });
  }
}

/**
 * DELETE /api/admin/plans/cable/:id
 */
export async function deleteCablePlan(req, res) {
  try {
    const plan = await CablePlan.findByPk(req.params.id);
    if (!plan) return res.status(404).json({ status: 'fail', msg: 'Cable plan not found.' });
    await plan.destroy();
    logger.info('Cable plan deleted', { cpId: req.params.id });
    return res.json({ status: 'success', msg: 'Cable plan removed.' });
  } catch (err) {
    logger.error('deleteCablePlan failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not remove cable plan.' });
  }
}

/**
 * PATCH /api/admin/plans/cable/provider/:providerId/toggle
 * Toggles the cableid.providerStatus (On <-> Off) for the whole provider.
 * providerId: 1=GOTV, 2=DSTV, 3=STARTIMES
 */
export async function toggleCableProvider(req, res) {
  const { providerId } = req.params;
  try {
    // cableid table has cId as PK, which maps to the provider enum (1/2/3).
    const [result] = await sequelize.query(
      'SELECT cId, provider, providerStatus FROM cableid WHERE cId = ?',
      { replacements: [parseInt(providerId)], type: sequelize.QueryTypes.SELECT }
    );
    if (!result) return res.status(404).json({ status: 'fail', msg: 'Cable provider not found.' });

    const newStatus = result.providerStatus === 'On' ? 'Off' : 'On';
    await sequelize.query('UPDATE cableid SET providerStatus = ? WHERE cId = ?', {
      replacements: [newStatus, parseInt(providerId)],
    });

    logger.info('Cable provider toggled', { providerId, provider: result.provider, newStatus });
    return res.json({
      status: 'success',
      msg: `${result.provider} ${newStatus === 'On' ? 'enabled' : 'disabled'}.`,
      enabled: newStatus === 'On',
    });
  } catch (err) {
    logger.error('toggleCableProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not toggle cable provider.' });
  }
}

// ---------- ELECTRICITY DisCos ----------

/**
 * GET /api/admin/plans/cable/providers
 * Lists the cable providers (GOTV/DSTV/Startimes) with On/Off status so the
 * admin UI can render the provider-level enable/disable toggles.
 */
export async function listCableProviders(req, res) {
  try {
    const rows = await sequelize.query(
      'SELECT cId, cableid, provider, providerStatus FROM cableid ORDER BY cId ASC',
      { type: sequelize.QueryTypes.SELECT }
    );
    return res.json({
      status: 'success',
      data: rows.map((r) => ({
        cId: r.cId,
        cableid: r.cableid,
        provider: r.provider,
        enabled: r.providerStatus === 'On',
      })),
    });
  } catch (err) {
    logger.error('listCableProviders failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load cable providers.' });
  }
}

/**
 * GET /api/admin/plans/electricity
 * Lists all electricity DisCos from the electricityid table.
 */
export async function listElectricityProviders(req, res) {
  try {
    const providers = await sequelize.query(
      'SELECT eId, electricityid, provider, abbreviation, providerStatus FROM electricityid ORDER BY eId ASC',
      { type: sequelize.QueryTypes.SELECT }
    );
    return res.json({
      status: 'success',
      data: providers.map((p) => ({
        eId: p.eId,
        electricityid: p.electricityid,
        provider: p.provider,
        abbreviation: p.abbreviation,
        enabled: p.providerStatus === 'On',
      })),
    });
  } catch (err) {
    logger.error('listElectricityProviders failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load electricity providers.' });
  }
}

/**
 * POST /api/admin/plans/electricity
 * body: { electricityid, provider, abbreviation }
 */
export async function createElectricityProvider(req, res) {
  const { electricityid, provider, abbreviation } = req.body;
  try {
    if (!electricityid || !provider || !abbreviation) {
      return res.status(400).json({ status: 'fail', msg: 'electricityid, provider, and abbreviation are required.' });
    }
    await sequelize.query(
      'INSERT INTO electricityid (electricityid, provider, abbreviation, providerStatus) VALUES (?, ?, ?, ?)',
      { replacements: [String(electricityid), String(provider), String(abbreviation), 'On'] }
    );
    logger.info('Electricity provider created', { provider });
    return res.status(201).json({ status: 'success', msg: 'Electricity provider added.' });
  } catch (err) {
    logger.error('createElectricityProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not add electricity provider.' });
  }
}

/**
 * PUT /api/admin/plans/electricity/:id
 */
export async function updateElectricityProvider(req, res) {
  const { electricityid, provider, abbreviation } = req.body;
  try {
    const [existing] = await sequelize.query('SELECT eId FROM electricityid WHERE eId = ?', {
      replacements: [parseInt(req.params.id)],
      type: sequelize.QueryTypes.SELECT,
    });
    if (!existing) return res.status(404).json({ status: 'fail', msg: 'Electricity provider not found.' });

    const updates = [];
    const replacements = [];
    if (electricityid !== undefined) { updates.push('electricityid = ?'); replacements.push(String(electricityid)); }
    if (provider !== undefined) { updates.push('provider = ?'); replacements.push(String(provider)); }
    if (abbreviation !== undefined) { updates.push('abbreviation = ?'); replacements.push(String(abbreviation)); }

    if (updates.length === 0) return res.json({ status: 'success', msg: 'No changes.' });

    replacements.push(parseInt(req.params.id));
    await sequelize.query(`UPDATE electricityid SET ${updates.join(', ')} WHERE eId = ?`, { replacements });

    logger.info('Electricity provider updated', { eId: req.params.id });
    return res.json({ status: 'success', msg: 'Electricity provider updated.' });
  } catch (err) {
    logger.error('updateElectricityProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not update electricity provider.' });
  }
}

/**
 * DELETE /api/admin/plans/electricity/:id
 */
export async function deleteElectricityProvider(req, res) {
  try {
    const [existing] = await sequelize.query('SELECT eId FROM electricityid WHERE eId = ?', {
      replacements: [parseInt(req.params.id)],
      type: sequelize.QueryTypes.SELECT,
    });
    if (!existing) return res.status(404).json({ status: 'fail', msg: 'Electricity provider not found.' });

    await sequelize.query('DELETE FROM electricityid WHERE eId = ?', { replacements: [parseInt(req.params.id)] });
    logger.info('Electricity provider deleted', { eId: req.params.id });
    return res.json({ status: 'success', msg: 'Electricity provider removed.' });
  } catch (err) {
    logger.error('deleteElectricityProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not remove electricity provider.' });
  }
}

/**
 * PATCH /api/admin/plans/electricity/:id/toggle
 * Toggles electricityid.providerStatus (On <-> Off).
 */
export async function toggleElectricityProvider(req, res) {
  try {
    const [provider] = await sequelize.query('SELECT eId, provider, providerStatus FROM electricityid WHERE eId = ?', {
      replacements: [parseInt(req.params.id)],
      type: sequelize.QueryTypes.SELECT,
    });
    if (!provider) return res.status(404).json({ status: 'fail', msg: 'Electricity provider not found.' });

    const newStatus = provider.providerStatus === 'On' ? 'Off' : 'On';
    await sequelize.query('UPDATE electricityid SET providerStatus = ? WHERE eId = ?', {
      replacements: [newStatus, parseInt(req.params.id)],
    });

    logger.info('Electricity provider toggled', { eId: req.params.id, provider: provider.provider, newStatus });
    return res.json({
      status: 'success',
      msg: `${provider.provider} ${newStatus === 'On' ? 'enabled' : 'disabled'}.`,
      enabled: newStatus === 'On',
    });
  } catch (err) {
    logger.error('toggleElectricityProvider failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not toggle electricity provider.' });
  }
}
