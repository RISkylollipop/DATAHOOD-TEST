import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader, Empty } from '../../components/Loader';
import { formatNaira, networkLabel } from '../../config';
import { IcRefresh, IcWallet, IcUsers, IcBolt, IcCheck } from '../../components/Icons';

// ============================================================
//  Admin · Sales analysis
// ------------------------------------------------------------
//  Every figure comes from GET /admin/sales, which resolves the
//  window in Africa/Lagos and excludes wallet funding and admin
//  credits from revenue (see salesController.js for the rules).
//
//  Charts are hand-rolled SVG on purpose — the project has no
//  charting dependency and these two shapes (a bar series and a
//  multi-series line) don't justify adding one.
// ============================================================

const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7', label: 'Last 7 Days' },
  { id: 'thisweek', label: 'This Week' },
  { id: 'lastweek', label: 'Last Week' },
  { id: 'thismonth', label: 'This Month' },
  { id: 'lastmonth', label: 'Last Month' },
  { id: 'thisyear', label: 'This Year' },
  { id: 'custom', label: 'Custom Range' },
];

const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// "2026-08-07" -> "7 Aug". Parsed manually: new Date('YYYY-MM-DD') is UTC,
// which would shift the label back a day for anyone west of Greenwich.
function shortDay(key) {
  const [, m, d] = key.split('-').map(Number);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${MONTHS[m - 1]}`;
}

const pct = (v) => `${v > 0 ? '+' : ''}${v}%`;

// Tone maps to the theme's colour variables rather than utility classes —
// app.css has no .ok/.danger/.warn text helpers, only .badge-* pills.
const TONE_COLOR = {
  ok: 'var(--success)',
  danger: 'var(--danger)',
  warn: 'var(--warn)',
};

function StatCard({ label, value, sub, tone, icon: Icon }) {
  return (
    <div className="card stat">
      <div className="row between">
        <span className="k">{label}</span>
        {Icon ? <Icon size={17} /> : null}
      </div>
      <span className="v">{value}</span>
      {sub ? (
        <span className="small" style={{ color: TONE_COLOR[tone] || 'var(--text-muted)' }}>{sub}</span>
      ) : null}
    </div>
  );
}

/**
 * Vertical bar chart for daily revenue.
 * Uses a viewBox so it scales to any container width.
 */
function RevenueChart({ series }) {
  const H = 190;
  const W = Math.max(320, series.length * 46);
  const PAD_B = 26;
  const PAD_T = 12;
  const max = Math.max(...series.map((d) => d.revenue), 0);

  if (!max) {
    return <div className="small muted" style={{ padding: '28px 0', textAlign: 'center' }}>No revenue in this period.</div>;
  }

  const barW = Math.max(8, (W / series.length) * 0.55);
  const step = W / series.length;
  // Label every nth bar so a long month doesn't overlap into mush.
  const labelEvery = Math.ceil(series.length / 12);

  return (
    <div className="table-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Daily revenue">
        {[0.25, 0.5, 0.75, 1].map((f) => {
          const y = PAD_T + (H - PAD_T - PAD_B) * (1 - f);
          return <line key={f} x1={0} y1={y} x2={W} y2={y} stroke="currentColor" strokeOpacity="0.10" strokeWidth="1" />;
        })}
        {series.map((d, i) => {
          const h = max ? (H - PAD_T - PAD_B) * (d.revenue / max) : 0;
          const x = i * step + (step - barW) / 2;
          const y = H - PAD_B - h;
          return (
            <g key={d.day}>
              <rect x={x} y={y} width={barW} height={h} rx="3" fill="currentColor" fillOpacity="0.75">
                <title>{`${shortDay(d.day)} — ${formatNaira(d.revenue)} (${d.count} sales)`}</title>
              </rect>
              {i % labelEvery === 0 && (
                <text x={i * step + step / 2} y={H - 8} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.55">
                  {shortDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Transaction-count trend as a line + point series.
 */
function TrendChart({ series }) {
  const H = 190;
  const W = Math.max(320, series.length * 46);
  const PAD_B = 26;
  const PAD_T = 12;
  const max = Math.max(...series.map((d) => d.count), 0);

  if (!max) {
    return <div className="small muted" style={{ padding: '28px 0', textAlign: 'center' }}>No transactions in this period.</div>;
  }

  const step = series.length > 1 ? W / (series.length - 1) : W;
  const yFor = (c) => PAD_T + (H - PAD_T - PAD_B) * (1 - c / max);
  const pts = series.map((d, i) => [series.length > 1 ? i * step : W / 2, yFor(d.count)]);
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0]},${H - PAD_B} L${pts[0][0]},${H - PAD_B} Z`;
  const labelEvery = Math.ceil(series.length / 12);

  return (
    <div className="table-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Transaction trend">
        {[0.25, 0.5, 0.75, 1].map((f) => {
          const y = PAD_T + (H - PAD_T - PAD_B) * (1 - f);
          return <line key={f} x1={0} y1={y} x2={W} y2={y} stroke="currentColor" strokeOpacity="0.10" strokeWidth="1" />;
        })}
        <path d={area} fill="currentColor" fillOpacity="0.12" />
        <path d={line} fill="none" stroke="currentColor" strokeOpacity="0.85" strokeWidth="2" />
        {pts.map(([x, y], i) => (
          <g key={series[i].day}>
            <circle cx={x} cy={y} r="3" fill="currentColor">
              <title>{`${shortDay(series[i].day)} — ${series[i].count} transactions`}</title>
            </circle>
            {i % labelEvery === 0 && (
              <text x={x} y={H - 8} textAnchor="middle" fontSize="10" fill="currentColor" fillOpacity="0.55">
                {shortDay(series[i].day)}
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Horizontal share bars for the breakdown tables. */
function ShareBar({ value, max }) {
  const w = max ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div style={{ height: 6, borderRadius: 999, background: 'currentColor', opacity: 0.12 }}>
      <div style={{ width: `${w}%`, height: '100%', borderRadius: 999, background: 'currentColor', opacity: 0.75 }} />
    </div>
  );
}

export default function AdminSales() {
  const toast = useToast();
  const [range, setRange] = useState('today');
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = range === 'custom' ? { range, from, to } : { range };
      const r = await api.get('/admin/sales', params);
      setData(r.data);
    } catch (err) {
      toast.error('Could not load sales', err.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [range, from, to, toast]);

  // `load` changes identity when from/to change, so depending on it directly
  // would refetch on every keystroke in the custom date inputs. Key the effect
  // on the range instead; custom ranges refetch only via the Apply button.
  useEffect(() => {
    if (range !== 'custom') load();
  }, [range]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxService = useMemo(
    () => Math.max(...(data?.byService || []).map((s) => s.revenue), 0),
    [data]
  );
  const maxNetwork = useMemo(
    () => Math.max(...(data?.byNetwork || []).map((n) => n.revenue), 0),
    [data]
  );
  const maxTier = useMemo(
    () => Math.max(...(data?.byTier || []).map((t) => t.revenue), 0),
    [data]
  );

  const g = data?.growth;
  const growthTone = (v) => (v > 0 ? 'ok' : v < 0 ? 'danger' : 'muted');

  return (
    <div>
      <div className="row between">
        <div>
          <h1 className="page-title">Sales analysis</h1>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            {data ? `${data.range.label} · ${data.salesCount} sales` : 'Revenue, profit and trends'}
          </p>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={load} disabled={loading}>
          <IcRefresh size={15} /> Refresh
        </button>
      </div>

      {/* ---- range picker ---- */}
      <div className="card">
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {RANGES.map((r) => (
            <button
              key={r.id}
              className={`btn btn-sm ${range === r.id ? '' : 'btn-soft'}`}
              onClick={() => setRange(r.id)}
            >
              {r.label}
            </button>
          ))}
        </div>

        {range === 'custom' && (
          <div className="row mt-1" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ margin: 0 }}>
              <label>From</label>
              <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field" style={{ margin: 0 }}>
              <label>To</label>
              <input type="date" value={to} min={from} max={todayISO()} onChange={(e) => setTo(e.target.value)} />
            </div>
            <button className="btn btn-sm" onClick={load} disabled={loading}>Apply</button>
          </div>
        )}
      </div>

      {loading ? <Loader /> : !data ? (
        <Empty title="No sales data" message="Could not load the sales analysis." />
      ) : (
        <>
          {/* ---- headline ---- */}
          <div className="grid grid-4 mt-1">
            <StatCard
              label="Gross sales" value={formatNaira(data.grossSales)} icon={IcWallet}
              sub={g ? `${pct(g.salesPct)} vs previous ${data.range.label.toLowerCase()}` : null}
              tone={g ? growthTone(g.salesPct) : null}
            />
            <StatCard
              label="Profit" value={formatNaira(data.totalProfit)} icon={IcBolt}
              sub={`${data.profitMargin}% margin`}
            />
            <StatCard
              label="Sales count" value={data.salesCount} icon={IcCheck}
              sub={g ? `${pct(g.countPct)} vs previous` : null}
              tone={g ? growthTone(g.countPct) : null}
            />
            <StatCard
              label="Average order" value={formatNaira(data.averageOrderValue)}
              sub={`${data.successRate}% success rate`}
            />
          </div>

          <div className="grid grid-4 mt-1">
            <StatCard label="Customers who bought" value={data.uniqueCustomers} icon={IcUsers}
              sub={`${formatNaira(data.averagePerCustomer)} each`} />
            <StatCard label="New signups" value={data.newUsers}
              sub={`${data.totalUsers} total users`} />
            <StatCard label="Wallet funding in" value={formatNaira(data.walletFunding)}
              sub={`${data.fundingCount} deposits · excluded from sales`} />
            <StatCard label="Avg. revenue / active day" value={formatNaira(data.averageDailyRevenue)}
              sub={data.bestDay ? `Best: ${shortDay(data.bestDay.day)} (${formatNaira(data.bestDay.revenue)})` : null} />
          </div>

          {/* ---- failure health ---- */}
          <div className="grid grid-4 mt-1">
            <StatCard label="Failed" value={data.failedCount} tone="danger"
              sub={`${formatNaira(data.failedValue)} not collected`} />
            <StatCard label="Processing" value={data.processingCount} tone="warn"
              sub={`${formatNaira(data.processingValue)} awaiting provider`} />
            <StatCard label="Refunded" value={data.refundedCount} tone="warn"
              sub={`${formatNaira(data.refundedValue)} returned`} />
            <StatCard label="Peak hour"
              value={data.peakHour ? `${pad(data.peakHour.hour)}:00` : '—'}
              sub={data.peakHour ? `${formatNaira(data.peakHour.revenue)} in that hour` : 'No sales yet'} />
          </div>

          {/* ---- graphs ---- */}
          <div className="card mt-1">
            <h3 className="mt-0 small strong" style={{ marginBottom: 10 }}>Revenue</h3>
            <RevenueChart series={data.daily} />
          </div>

          <div className="card mt-1">
            <h3 className="mt-0 small strong" style={{ marginBottom: 10 }}>Transaction trend</h3>
            <TrendChart series={data.daily} />
          </div>

          {/* ---- breakdowns ---- */}
          <div className="grid grid-2 mt-1">
            <div className="card">
              <h3 className="mt-0 small strong" style={{ marginBottom: 10 }}>By service</h3>
              {data.byService.length === 0 ? (
                <div className="small muted">No sales in this period.</div>
              ) : (
                <table className="table">
                  <thead><tr><th>Service</th><th>Revenue</th><th>Profit</th><th>Count</th></tr></thead>
                  <tbody>
                    {data.byService.map((s) => (
                      <tr key={s.service}>
                        <td>
                          <div className="strong small">{s.service}</div>
                          <ShareBar value={s.revenue} max={maxService} />
                        </td>
                        <td className="small">{formatNaira(s.revenue)}</td>
                        <td className="small">{formatNaira(s.profit)}</td>
                        <td className="small muted">{s.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h3 className="mt-0 small strong" style={{ marginBottom: 10 }}>By network</h3>
              {data.byNetwork.length === 0 ? (
                <div className="small muted">No airtime or data sales in this period.</div>
              ) : (
                <table className="table">
                  <thead><tr><th>Network</th><th>Revenue</th><th>Profit</th><th>Count</th></tr></thead>
                  <tbody>
                    {data.byNetwork.map((n) => (
                      <tr key={n.network}>
                        <td>
                          <div className="strong small">{networkLabel(n.network)}</div>
                          <ShareBar value={n.revenue} max={maxNetwork} />
                        </td>
                        <td className="small">{formatNaira(n.revenue)}</td>
                        <td className="small">{formatNaira(n.profit)}</td>
                        <td className="small muted">{n.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div className="grid grid-2 mt-1">
            <div className="card">
              <h3 className="mt-0 small strong" style={{ marginBottom: 10 }}>By customer tier</h3>
              {data.byTier.length === 0 ? (
                <div className="small muted">No sales in this period.</div>
              ) : (
                <table className="table">
                  <thead><tr><th>Tier</th><th>Revenue</th><th>Count</th></tr></thead>
                  <tbody>
                    {data.byTier.map((t) => (
                      <tr key={t.tier}>
                        <td>
                          <div className="strong small">{t.tier}</div>
                          <ShareBar value={t.revenue} max={maxTier} />
                        </td>
                        <td className="small">{formatNaira(t.revenue)}</td>
                        <td className="small muted">{t.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="card">
              <h3 className="mt-0 small strong" style={{ marginBottom: 10 }}>Top customers</h3>
              {data.topCustomers.length === 0 ? (
                <div className="small muted">No sales in this period.</div>
              ) : (
                <table className="table">
                  <thead><tr><th>#</th><th>Customer</th><th>Spend</th><th>Orders</th></tr></thead>
                  <tbody>
                    {data.topCustomers.map((c, i) => (
                      <tr key={c.sId}>
                        <td className="small muted">{i + 1}</td>
                        <td>
                          <div className="strong small">{c.name}</div>
                          {c.email ? <div className="small muted">{c.email}</div> : null}
                        </td>
                        <td className="small">{formatNaira(c.revenue)}</td>
                        <td className="small muted">{c.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
