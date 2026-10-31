import React, { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { Loader } from '../../components/Loader';
import { formatNaira, formatDate } from '../../config';
import { IcServer, IcBan, IcHistory, IcCard, IcWallet, IcRefresh } from '../../components/Icons';
import { balanceCardProviders } from '../../utils/balanceCards';
import TransactionDetailModal from '../../components/TransactionDetailModal';

function StatusBadge({ label }) {
  const cls = label === 'successful' ? 'badge-success'
    : label === 'failed' ? 'badge-danger'
    : label === 'refunded' || label === 'processing' ? 'badge-warn' : 'badge-muted';
  return <span className={`badge ${cls}`}>{label}</span>;
}

// One balance card per vendor — the credit you hold with them.
//
// "Unavailable" is this component's word, never the server's: the API always
// answers with a reason, and the reason is the actionable half. Showing the
// headline alone is how a fixable path or IP problem looked like a dead
// feature for weeks. So the message is rendered underneath, in full.
function BalanceCard({ provider }) {
  const [state, setState] = useState({ loading: true, balance: null, error: null, source: null });

  const fetchBalance = useCallback(() => {
    setState({ loading: true, balance: null, error: null, source: null });
    api.get(`/admin/providers/${provider.id}/balance`)
      .then((r) => setState({
        loading: false, balance: r.data?.balance ?? 0, error: null, source: r.data?.source || null,
      }))
      .catch((err) => setState({
        loading: false, balance: null, source: null,
        error: err.message || 'Could not reach this provider.',
      }));
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
          {/* A working card is not the same as a configured one. 'guessed'
              means no Wallet row exists and the old /api/user/ assumption
              happened to hold — worth saying, because it breaks silently the
              day the vendor moves the path. */}
          <span className="small muted">
            {state.source === 'guessed' ? 'Account credit · path assumed' : 'Account credit'}
          </span>
        </>
      )}
    </div>
  );
}

// A wallet row that cannot fetch yet. Rendered INSTEAD of BalanceCard, chosen by
// the parent rather than branching inside it: an early return in BalanceCard
// would sit above its hooks, and skipping the fetch would mean calling useEffect
// conditionally. Picking the component keeps both paths hook-clean.
//
// Neutral, not red: nothing is broken, a field is blank. A danger colour here
// would send the operator hunting for a fault that does not exist.
function UnconfiguredCard({ provider }) {
  const msg = provider.needs === 'url'
    ? 'Add this vendor\'s balance endpoint as the Base URL on this Wallet row.'
    : 'No API key saved for this vendor yet — add it to any of their rows.';
  return (
    <div className="card stat">
      <div className="row between">
        <span className="k">{provider.name}</span>
      </div>
      <span className="v muted" style={{ fontSize: 16 }}>Not set up</span>
      <span className="small muted">
        {msg} <Link to="/admin/providers">Providers</Link>
      </span>
    </div>
  );
}

// balanceCardProviders lives in utils/balanceCards.js rather than here, so it
// can actually be run in verification — a function inside a .jsx file cannot
// be, since the build sandbox has no JSX parser.

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

  const balanceProviders = balanceCardProviders(providers);

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
            No wallet endpoints configured yet. Under <Link to="/admin/providers">Providers</Link>,
            add a <strong>Wallet</strong> row for each vendor with their balance URL as the Base URL
            — the API key from that vendor&apos;s other rows is reused automatically.
          </p>
        </div>
      ) : (
        <div className="grid grid-4 mb-2">
          {balanceProviders.map((p) => (p.needs
            ? <UnconfiguredCard key={p.id} provider={p} />
            : <BalanceCard key={p.id} provider={p} />))}
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
