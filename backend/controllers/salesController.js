// ============================================================
//  Sales Controller — admin sales analysis
// ------------------------------------------------------------
//  GET /api/admin/sales?range=today|yesterday|last7|thisweek|
//      lastweek|thismonth|lastmonth|thisyear|custom&from=&to=
//
//  Every window is resolved in Africa/Lagos (WAT, UTC+1), the
//  business timezone. Resolving in UTC would put "today" an hour
//  behind local midnight and silently move late-night sales into
//  the wrong day.
//
//  What counts as a SALE:
//    Airtime, Data, Electricity, Cable TV, Verification
//  What does NOT (and why):
//    'Wallet Funding'  — money entering the wallet. Counting it
//                        double-counts, because the same naira is
//                        counted again when it buys a bundle.
//    'Admin Credit' / 'Admin Debit' — manual balance corrections.
//    'Debit' / 'Refund'             — walletOps audit rows.
// ============================================================

import { Op } from 'sequelize';
import { Transaction, Subscriber } from '../models/index.js';
import { PURCHASE_SERVICES } from '../utils/serviceNames.js';
import * as logger from '../utils/logger.js';

// Services that represent real revenue. Shared with the admin refund
// guard in walletOps rather than re-listed here: the two lists have to
// mean the same thing (a row that is a sale is a row that can be
// refunded), and two copies of a list like this drift the moment a sixth
// service is added.
const SALES_SERVICES = PURCHASE_SERVICES;

// Non-sales rows we still want counted separately (funding inflow).
const FUNDING_SERVICE = 'Wallet Funding';

const TIER_LABELS = { 1: 'User', 2: 'Agent', 3: 'Vendor' };

// Lagos is UTC+1 year-round (no DST), so a fixed offset is exact.
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const money = (n) => Math.round(n * 100) / 100;

/**
 * Wall-clock Y/M/D in Lagos for a given instant.
 */
function lagosParts(instant) {
  const shifted = new Date(instant.getTime() + LAGOS_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    dow: shifted.getUTCDay(),
  };
}

/**
 * The UTC instant corresponding to 00:00:00.000 Lagos time on a
 * given Lagos calendar date.
 */
function lagosMidnightUTC(y, m, d) {
  return new Date(Date.UTC(y, m, d, 0, 0, 0, 0) - LAGOS_OFFSET_MS);
}

/**
 * Resolve a named range into [from, to) UTC instants.
 * Half-open on the upper bound so no row is double-counted at a
 * boundary and no millisecond is missed.
 */
function resolveRange(range, fromRaw, toRaw) {
  const now = new Date();
  const { y, m, d, dow } = lagosParts(now);
  const startOfToday = lagosMidnightUTC(y, m, d);
  const DAY = 24 * 60 * 60 * 1000;

  switch (range) {
    case 'today':
      return { from: startOfToday, to: new Date(startOfToday.getTime() + DAY), label: 'Today' };

    case 'yesterday':
      return {
        from: new Date(startOfToday.getTime() - DAY),
        to: startOfToday,
        label: 'Yesterday',
      };

    case 'last7':
      // Rolling 7 days INCLUDING today.
      return {
        from: new Date(startOfToday.getTime() - 6 * DAY),
        to: new Date(startOfToday.getTime() + DAY),
        label: 'Last 7 Days',
      };

    case 'thisweek': {
      // Week starts Monday (Nigerian business convention).
      const backToMonday = (dow + 6) % 7;
      const weekStart = new Date(startOfToday.getTime() - backToMonday * DAY);
      return { from: weekStart, to: new Date(startOfToday.getTime() + DAY), label: 'This Week' };
    }

    case 'lastweek': {
      const backToMonday = (dow + 6) % 7;
      const thisMonday = new Date(startOfToday.getTime() - backToMonday * DAY);
      return {
        from: new Date(thisMonday.getTime() - 7 * DAY),
        to: thisMonday,
        label: 'Last Week',
      };
    }

    case 'thismonth':
      return {
        from: lagosMidnightUTC(y, m, 1),
        to: new Date(startOfToday.getTime() + DAY),
        label: 'This Month',
      };

    case 'lastmonth':
      // Day 1 of next month is a safe upper bound; JS normalizes month -1/12.
      return {
        from: lagosMidnightUTC(y, m - 1, 1),
        to: lagosMidnightUTC(y, m, 1),
        label: 'Last Month',
      };

    case 'thisyear':
      return {
        from: lagosMidnightUTC(y, 0, 1),
        to: new Date(startOfToday.getTime() + DAY),
        label: 'This Year',
      };

    case 'custom': {
      if (!fromRaw || !toRaw) return { error: 'Custom range needs both from and to dates.' };
      const f = String(fromRaw).slice(0, 10).split('-').map(Number);
      const t = String(toRaw).slice(0, 10).split('-').map(Number);
      if (f.length !== 3 || t.length !== 3 || f.some(Number.isNaN) || t.some(Number.isNaN)) {
        return { error: 'Dates must be in YYYY-MM-DD format.' };
      }
      const from = lagosMidnightUTC(f[0], f[1] - 1, f[2]);
      // Inclusive of the whole `to` day.
      const to = new Date(lagosMidnightUTC(t[0], t[1] - 1, t[2]).getTime() + DAY);
      if (to <= from) return { error: 'The end date must not be before the start date.' };
      return { from, to, label: 'Custom Range' };
    }

    default:
      return { error: 'Unknown range.' };
  }
}

/** Lagos calendar day key (YYYY-MM-DD) for bucketing a timestamp. */
function dayKey(instant) {
  const { y, m, d } = lagosParts(instant);
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Every Lagos day key in [from, to), so gaps render as zero on the graph. */
function dayKeysBetween(from, to) {
  const keys = [];
  const DAY = 24 * 60 * 60 * 1000;
  const { y, m, d } = lagosParts(from);
  let cursor = lagosMidnightUTC(y, m, d);
  while (cursor < to) {
    keys.push(dayKey(cursor));
    cursor = new Date(cursor.getTime() + DAY);
  }
  return keys;
}

/** Pull the network name out of a data/airtime description. */
function networkFromDesc(desc, servicename) {
  if (!desc) return null;
  if (servicename === 'Data') {
    const m = /^Purchase of (\S+)/i.exec(desc);
    return m ? m[1].toUpperCase() : null;
  }
  if (servicename === 'Airtime') {
    const m = /^(\S+) Airtime/i.exec(desc);
    return m ? m[1].toUpperCase() : null;
  }
  return null;
}

export async function getSalesAnalysis(req, res) {
  try {
    const range = String(req.query.range || 'today');
    const resolved = resolveRange(range, req.query.from, req.query.to);
    if (resolved.error) {
      return res.status(400).json({ status: 'fail', msg: resolved.error });
    }
    const { from, to, label } = resolved;

    // Previous window of equal length, for period-over-period growth.
    const span = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - span);

    const [rows, prevRows, totalUsers, newUsers] = await Promise.all([
      Transaction.findAll({
        where: { date: { [Op.gte]: from, [Op.lt]: to } },
        include: [
          {
            model: Subscriber,
            attributes: ['sId', 'sType', 'sFname', 'sLname', 'sEmail'],
            required: false,
          },
        ],
        order: [['date', 'ASC']],
      }),
      Transaction.findAll({
        where: { date: { [Op.gte]: prevFrom, [Op.lt]: from } },
        attributes: ['servicename', 'amount', 'status', 'profit'],
      }),
      Subscriber.count(),
      Subscriber.count({ where: { sRegDate: { [Op.gte]: from, [Op.lt]: to } } }),
    ]);

    // ---- accumulators ----
    let grossSales = 0;
    let totalProfit = 0;
    let salesCount = 0;
    let failedCount = 0;
    let failedValue = 0;
    let processingCount = 0;
    let processingValue = 0;
    let refundedCount = 0;
    let refundedValue = 0;
    let fundingTotal = 0;
    let fundingCount = 0;

    const byService = {};
    const byNetwork = {};
    const byTier = {};
    const byDay = {};
    const byCustomer = {};
    const hourHist = new Array(24).fill(0);

    for (const key of dayKeysBetween(from, to)) {
      byDay[key] = { day: key, revenue: 0, profit: 0, count: 0 };
    }

    for (const t of rows) {
      const svc = t.servicename || 'Other';
      const amt = num(t.amount);
      const isSale = SALES_SERVICES.includes(svc);
      // Association has no explicit alias, so the accessor casing depends on
      // the Sequelize version. Probe the same three keys walletController does.
      const sub = t.subscriber || t.subscribers || t.Subscriber || null;

      if (svc === FUNDING_SERVICE && t.status === 0) {
        fundingTotal += amt;
        fundingCount += 1;
        continue;
      }
      if (!isSale) continue;

      // Non-successful sales are tracked but excluded from revenue.
      if (t.status === 2) {
        failedCount += 1;
        failedValue += amt;
        continue;
      }
      if (t.status === 5) {
        processingCount += 1;
        processingValue += amt;
        continue;
      }
      if (t.status === 1) {
        refundedCount += 1;
        refundedValue += amt;
        continue;
      }
      if (t.status !== 0) continue;

      const profit = num(t.profit);
      grossSales += amt;
      totalProfit += profit;
      salesCount += 1;

      // by service
      if (!byService[svc]) byService[svc] = { service: svc, revenue: 0, profit: 0, count: 0 };
      byService[svc].revenue += amt;
      byService[svc].profit += profit;
      byService[svc].count += 1;

      // by network (airtime + data only)
      const net = networkFromDesc(t.servicedesc, svc);
      if (net) {
        if (!byNetwork[net]) byNetwork[net] = { network: net, revenue: 0, profit: 0, count: 0 };
        byNetwork[net].revenue += amt;
        byNetwork[net].profit += profit;
        byNetwork[net].count += 1;
      }

      // by tier
      const tier = TIER_LABELS[sub?.sType] || 'User';
      if (!byTier[tier]) byTier[tier] = { tier, revenue: 0, count: 0 };
      byTier[tier].revenue += amt;
      byTier[tier].count += 1;

      // daily series
      const dk = dayKey(t.date);
      if (!byDay[dk]) byDay[dk] = { day: dk, revenue: 0, profit: 0, count: 0 };
      byDay[dk].revenue += amt;
      byDay[dk].profit += profit;
      byDay[dk].count += 1;

      // hour-of-day histogram (peak trading hour)
      const { h } = (() => {
        const shifted = new Date(new Date(t.date).getTime() + LAGOS_OFFSET_MS);
        return { h: shifted.getUTCHours() };
      })();
      hourHist[h] += amt;

      // top customers
      const cid = t.sId;
      if (!byCustomer[cid]) {
        const fullName = sub ? [sub.sFname, sub.sLname].filter(Boolean).join(' ').trim() : '';
        byCustomer[cid] = {
          sId: cid,
          name: fullName || `User #${cid}`,
          email: sub?.sEmail || null,
          revenue: 0,
          count: 0,
        };
      }
      byCustomer[cid].revenue += amt;
      byCustomer[cid].count += 1;
    }

    // ---- previous period (revenue + profit only) ----
    let prevSales = 0;
    let prevProfit = 0;
    let prevCount = 0;
    for (const t of prevRows) {
      if (t.status !== 0 || !SALES_SERVICES.includes(t.servicename)) continue;
      prevSales += num(t.amount);
      prevProfit += num(t.profit);
      prevCount += 1;
    }

    const pctChange = (curr, prev) => {
      if (prev === 0) return curr === 0 ? 0 : 100;
      return Math.round(((curr - prev) / prev) * 1000) / 10;
    };

    const attempted = salesCount + failedCount + refundedCount + processingCount;
    const dailySeries = Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day));
    const activeDays = dailySeries.filter((d) => d.count > 0).length;
    const bestDay = dailySeries.reduce(
      (best, d) => (best === null || d.revenue > best.revenue ? d : best),
      null
    );
    const peakHour = hourHist.reduce(
      (best, v, i) => (v > best.revenue ? { hour: i, revenue: v } : best),
      { hour: 0, revenue: 0 }
    );

    return res.json({
      status: 'success',
      data: {
        range: { key: range, label, from: from.toISOString(), to: to.toISOString() },

        // --- headline (1-8) ---
        grossSales: money(grossSales),
        totalProfit: money(totalProfit),
        salesCount,
        averageOrderValue: money(salesCount ? grossSales / salesCount : 0),
        profitMargin: grossSales ? Math.round((totalProfit / grossSales) * 1000) / 10 : 0,
        successRate: attempted ? Math.round((salesCount / attempted) * 1000) / 10 : 0,
        uniqueCustomers: Object.keys(byCustomer).length,
        averagePerCustomer: money(
          Object.keys(byCustomer).length ? grossSales / Object.keys(byCustomer).length : 0
        ),

        // --- failure / pending health (9-14) ---
        failedCount,
        failedValue: money(failedValue),
        processingCount,
        processingValue: money(processingValue),
        refundedCount,
        refundedValue: money(refundedValue),

        // --- wallet inflow (15-16) ---
        walletFunding: money(fundingTotal),
        fundingCount,

        // --- users (17-18) ---
        totalUsers,
        newUsers,

        // --- period-over-period (19-20) ---
        growth: {
          salesPct: pctChange(grossSales, prevSales),
          profitPct: pctChange(totalProfit, prevProfit),
          countPct: pctChange(salesCount, prevCount),
          prevGrossSales: money(prevSales),
          prevTotalProfit: money(prevProfit),
          prevSalesCount: prevCount,
        },

        // --- derived highlights ---
        bestDay: bestDay && bestDay.revenue > 0 ? { ...bestDay, revenue: money(bestDay.revenue) } : null,
        averageDailyRevenue: money(activeDays ? grossSales / activeDays : 0),
        peakHour: peakHour.revenue > 0 ? { hour: peakHour.hour, revenue: money(peakHour.revenue) } : null,

        // --- graph series ---
        daily: dailySeries.map((d) => ({
          day: d.day,
          revenue: money(d.revenue),
          profit: money(d.profit),
          count: d.count,
        })),

        // --- breakdowns ---
        byService: Object.values(byService)
          .map((s) => ({ ...s, revenue: money(s.revenue), profit: money(s.profit) }))
          .sort((a, b) => b.revenue - a.revenue),
        byNetwork: Object.values(byNetwork)
          .map((n) => ({ ...n, revenue: money(n.revenue), profit: money(n.profit) }))
          .sort((a, b) => b.revenue - a.revenue),
        byTier: Object.values(byTier)
          .map((t) => ({ ...t, revenue: money(t.revenue) }))
          .sort((a, b) => b.revenue - a.revenue),
        topCustomers: Object.values(byCustomer)
          .map((c) => ({ ...c, revenue: money(c.revenue) }))
          .sort((a, b) => b.revenue - a.revenue)
          .slice(0, 10),
      },
    });
  } catch (err) {
    logger.error('getSalesAnalysis failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ status: 'fail', msg: 'Could not load sales analysis.' });
  }
}
