import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Loader } from '../../components/Loader';
import { formatNaira, formatDate } from '../../config';
import { IcServer, IcBan, IcHistory, IcCard, IcWallet, IcRefresh } from '../../components/Icons';
import TransactionDetailModal from '../../components/TransactionDetailModal';

function StatusBadge({ label }) {
  const cls = label === 'successful' ? 'badge-success'
    : label === 'failed' ? 'badge-danger'
    : label === 'refunded' || label === 'processing' ? 'badge-warn' : 'badge-muted';
  return <span className={`badge ${cls}`}>{label}</span>;
}

// One balance card per fulfillment provider that has an API key configured.
function BalanceCard({ provider }) {
  const [state, setState] = useState({ loading: true, balance: null, error: null });

  const fetchBalance = useCallback(() => {
    setState({ loading: true, balance: null, error: null });
    api.get(`/admin/providers/${provider.id}/balance`)
      .then((r) => setState({ loading: false, balance: r.data?.balance ?? 0, error: null }))
      .catch((err) => setState({ loading: false, balance: null, error: err.message || 'Unavailable' }));
  }, [provider.id]);

  useEffect(() => { fetchBalance(); }, [fetchBalance]);

  return (
    <div className="card stat">
      <div className="row between">
        <span className="k">{provider.name}</span>
        <button className="btn btn-ghost btn-sm" title="Refresh balance" onClick={fetchBalance} disabled={state.loading}>
          {state.loading ? <span className="spinner" /> : <IcRefresh size={15} />}
        </button>
      </div>
      {state.loading ? (
        <span className="v muted">…</span>
      ) : state.error ? (
        <>
          <span className="v" style={{ fontSize: 16, color: 'var(--danger, #c0392b)' }}>Unavailable</span>
          <span className="small muted">{state.error}</span>
        </>
      ) : (
        <>
          <span className="v">{formatNaira(state.balance)}</span>
          <span className="small muted" style={{ textTransform: 'capitalize' }}>{provider.category} · account credit</span>
        </>
      )}
    </div>
  );
}

export default function AdminOverview() {
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState([]);
  const [blCounts, setBlCounts] = useState({ approved: 0, pending: 0 });
  const [txns, setTxns] = useState([]);
  const [txnPage, setTxnPage] = useState({ total: 0 });
  const [detailRef, setDetailRef] = useState(null);
  const [detailSeed, setDetailSeed] = useState(null);

  const loadTxns = useCallback(() => {
    api.get('/admin/transactions', { limit: 8 })
      .then((t) => {
        setTxns(t.data.transactions || []);
        setTxnPage(t.data.pagination || { total: 0 });
      })
      .catch(() => { /* toast handled globally */ });
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [p, b, t] = await Promise.all([
          api.get('/admin/providers'),
          api.get('/admin/blacklist'),
          api.get('/admin/transactions', { limit: 8 }),
        ]);
        setProviders(p.data || []);
        setBlCounts(b.counts || { approved: 0, pending: 0 });
        setTxns(t.data.transactions || []);
        setTxnPage(t.data.pagination || { total: 0 });
      } catch { /* toast handled */ } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <Loader full />;

  const activeProviders = providers.filter((p) => p.status === 'active').length;
  const gateways = providers.filter((p) => p.category === 'payment');

  // Providers whose wallet balance we can show: fulfillment categories with an
  // API key set. Dedupe by NAME so Maskawasub (which has one row per category
  // sharing the same key) only appears once.
  const FULFILLMENT = ['airtime', 'data', 'cable', 'electricity'];
  const balanceProviders = [];
  const seenNames = new Set();
  for (const p of providers) {
    if (!p.hasApiKey || !FULFILLMENT.includes(p.category)) continue;
    if (seenNames.has(p.name)) continue;
    seenNames.add(p.name);
    balanceProviders.push(p);
  }

  const cards = [
    { label: 'Active providers', value: `${activeProviders}/${providers.length}`, icon: IcServer, to: '/admin/providers' },
    { label: 'Payment gateways', value: gateways.length, icon: IcCard, to: '/admin/gateways' },
    { label: 'Blacklisted', value: blCounts.approved, icon: IcBan, to: '/admin/blacklist', sub: `${blCounts.pending} pending` },
    { label: 'Transactions', value: txnPage.total || 0, icon: IcHistory, to: '/admin/transactions' },
  ];

  return (
    <>
      <h1 className="page-title">Overview</h1>
      <p className="page-sub">System health and recent activity at a glance.</p>

      <div className="grid grid-4 mb-2">
        {cards.map((c) => (
          <Link key={c.label} to={c.to} className="card stat" style={{ textDecoration: 'none' }}>
            <div className="row between">
              <span className="k">{c.label}</span>
              <span className="text-brand"><c.icon size={18} /></span>
            </div>
            <span className="v">{c.value}</span>
            {c.sub && <span className="small muted">{c.sub}</span>}
          </Link>
        ))}
      </div>

      {/* Provider wallet balances — the account credit you hold with each
          fulfillment provider (Maskawasub / Premiumsub / etc). */}
      <div className="row between mb-1" style={{ alignItems: 'center' }}>
        <h3 className="mt-0 row" style={{ marginBottom: 0, gap: 8, alignItems: 'center' }}>
          <IcWallet size={19} /> Provider wallet balances
        </h3>
      </div>
      {balanceProviders.length === 0 ? (
        <div className="card mb-2">
          <p className="muted small" style={{ margin: 0 }}>
            No fulfillment providers with API keys yet. Add a provider (with its API key) under{' '}
            <Link to="/admin/providers">Providers</Link> to see your account credit here.
          </p>
        </div>
      ) : (
        <div className="grid grid-4 mb-2">
          {balanceProviders.map((p) => <BalanceCard key={p.id} provider={p} />)}
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <div className="row between mb-2">
            <h3 className="mt-0" style={{ marginBottom: 0 }}>Recent transactions</h3>
            <Link to="/admin/transactions" className="small">View all</Link>
          </div>
          {txns.length === 0 ? (
            <p className="muted small">No transactions yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>User</th><th>Service</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
                <tbody>
                  {txns.map((t) => (
                    <tr key={t.transref} style={{ cursor: 'pointer' }} onClick={() => { setDetailSeed(t); setDetailRef(t.transref); }}>
                      <td className="small">{t.userName || `#${t.sId}`}</td>
                      <td className="strong">{t.servicename}</td>
                      <td>{formatNaira(t.amount)}</td>
                      <td><StatusBadge label={t.statusLabel} /></td>
                      <td className="small muted">{formatDate(t.date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="row between mb-2">
            <h3 className="mt-0" style={{ marginBottom: 0 }}>Providers</h3>
            <Link to="/admin/providers" className="small">Manage</Link>
          </div>
          {providers.length === 0 ? (
            <div className="center" style={{ padding: 20 }}>
              <IcServer size={28} />
              <p className="muted small mt-1">No providers configured yet. Add your API providers to start fulfilling orders.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Name</th><th>Category</th><th>Status</th></tr></thead>
                <tbody>
                  {providers.slice(0, 8).map((p) => (
                    <tr key={p.id}>
                      <td className="strong">{p.name} {p.isDefault && <span className="badge badge-muted">default</span>}</td>
                      <td className="small muted" style={{ textTransform: 'capitalize' }}>{p.category}</td>
                      <td><span className={`badge ${p.status === 'active' ? 'badge-success' : 'badge-muted'}`}>{p.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {detailRef && (
        <TransactionDetailModal
          transref={detailRef}
          initial={detailSeed}
          onClose={() => { setDetailRef(null); setDetailSeed(null); }}
          onChanged={loadTxns}
        />
      )}
    </>
  );
}
