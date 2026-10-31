import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { formatNaira, formatDate, TIERS, gatewayLabel } from '../config';
import { Loader, Empty } from '../components/Loader';
import { useBalanceMask, MaskedAmount, MaskToggle } from '../components/MaskedBalance';
import {
  IcPhone, IcData, IcBolt, IcTv, IcShield, IcWallet, IcPlus, IcCard, IcCopy,
} from '../components/Icons';

const ACTIONS = [
  { to: '/app/airtime', label: 'Airtime', icon: IcPhone },
  { to: '/app/data', label: 'Data', icon: IcData },
  { to: '/app/electricity', label: 'Electricity', icon: IcBolt },
  { to: '/app/cable', label: 'Cable TV', icon: IcTv },
  // { to: '/app/verify', label: 'Verify ID', icon: IcShield },
  { to: '/app/wallet', label: 'Fund', icon: IcWallet },
];

function StatusBadge({ label }) {
  const cls = label === 'successful' ? 'badge-success'
    : label === 'failed' ? 'badge-danger'
    : label === 'refunded' ? 'badge-warn'
    : label === 'processing' ? 'badge-warn' : 'badge-muted';
  return <span className={`badge ${cls}`}>{label}</span>;
}

export default function Dashboard() {
  const { user, updateUser } = useAuth();
  const { hidden, toggle } = useBalanceMask();
  const [wallet, setWallet] = useState(null);
  const [stats, setStats] = useState(null);
  const [recent, setRecent] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [w, s, t, a] = await Promise.all([
          api.get('/wallet'),
          api.get('/wallet/stats'),
          api.get('/transactions', { limit: 6 }),
          // Reserved accounts belong on the dashboard too — funding is the
        
          api.get('/payment/accounts').catch(() => ({ data: { accounts: [] } })),
        ]);
        setWallet(w.data);
        if (w.data) updateUser({ wallet: w.data.mainBalance, refWallet: w.data.referralBalance });
        setStats(s.data);
        setRecent(t.data.transactions || []);
        setAccounts(a.data?.accounts || []);
      } catch { /* toast handled globally */ } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const copy = (text) => navigator.clipboard?.writeText(text);

  if (loading) return <Loader full />;

  return (
    <>
      <div className="grid grid-3 mb-2">
        <div className="balance-card" style={{ gridColumn: 'span 1' }}>
          <div className="row between" style={{ alignItems: 'center' }}>
            <div className="label">Wallet balance</div>
            <MaskToggle hidden={hidden} onToggle={toggle} light />
          </div>
          <div className="amt"><MaskedAmount value={wallet?.mainBalance} hidden={hidden} render={formatNaira} /></div>
          <div className="row between mt-1">
            <span className="small" style={{ opacity: 0.85 }}>
              Bonus: <MaskedAmount value={wallet?.referralBalance} hidden={hidden} render={formatNaira} />
            </span>
            <Link to="/app/wallet" className="btn btn-sm" style={{ background: 'rgba(255,255,255,0.2)' }}>
              <IcPlus size={15} /> Fund
            </Link>
          </div>
        </div>
        <div className="card stat">
          <span className="k">Spent (30 days)</span>
          <span className="v">{formatNaira(stats?.totalSpent)}</span>
          <span className="small muted">{stats?.totalTransactions || 0} transactions</span>
        </div>
        <div className="card stat">
          <span className="k">Account tier</span>
          <span className="v">{TIERS[user?.type] || 'User'}</span>
          
          <span className="small muted">
            {stats?.successCount || 0} successful · {stats?.failedCount || 0} failed
            {' · '}
            <Link to="/app/pricing">{user?.type === 3 ? 'Pricing' : 'Compare tiers'}</Link>
          </span>
        </div>
      </div>

      <h3>Quick actions</h3>
      <div className="tiles mb-2">
        {ACTIONS.map(({ to, label, icon: Icon }) => (
          <Link key={to} to={to} className="tile">
            <div className="ic"><Icon size={22} /></div>
            <div className="t">{label}</div>
          </Link>
        ))}
      </div>

      {/* Reserved (dedicated) bank accounts. Shown here so a returning user
          can fund without hunting for the Fund page. Hidden entirely when
          the user has none, rather than showing an empty shell. */}
      {accounts.length > 0 && (
        <div className="card mb-2">
          <div className="row between mb-2">
            <h3 className="mt-0 row" style={{ marginBottom: 0, gap: 8, alignItems: 'center' }}>
              <IcCard size={20} /> Your funding accounts
            </h3>
            <Link to="/app/wallet" className="small">Fund wallet</Link>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Transfer to any of these from your bank app — your wallet is credited automatically.
          </p>
          <div className="grid grid-3">
            {accounts.map((a, i) => (
              <div key={i} className="card" style={{ background: 'var(--brand-soft)' }}>
                <div className="row between" style={{ alignItems: 'baseline' }}>
                  <div className="small muted">{a.bankName}</div>
                  {/* Named because a user may hold accounts at several
                      gateways, and the bank alone no longer identifies one. */}
                  <div className="small muted">{gatewayLabel(a.gateway)}</div>
                </div>
                <div className="row between" style={{ alignItems: 'center' }}>
                  <div className="strong" style={{ fontSize: 20, letterSpacing: 1 }}>{a.accountNumber}</div>
                  <button className="btn btn-ghost btn-sm" title="Copy account number"
                    onClick={() => copy(a.accountNumber)}><IcCopy size={15} /></button>
                </div>
                <div className="small">{a.accountName}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="row between mb-2">
          <h3 className="mt-0" style={{ marginBottom: 0 }}>Recent transactions</h3>
          <Link to="/app/transactions" className="small">View all</Link>
        </div>
        {recent.length === 0 ? (
          <Empty title="No transactions yet" message="Your purchases will appear here." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Service</th><th>Amount</th><th>Status</th><th>Date</th></tr>
              </thead>
              <tbody>
                {recent.map((t) => (
                  <tr key={t.transref}>
                    <td>
                      <div className="strong">{t.servicename}</div>
                      <div className="small muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.servicedesc}</div>
                    </td>
                    <td className="strong">{formatNaira(t.amount)}</td>
                    <td><StatusBadge label={t.statusLabel} /></td>
                    <td className="small muted">{formatDate(t.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
