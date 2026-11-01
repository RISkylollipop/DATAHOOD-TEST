import { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { formatNaira } from '../config';
import '../styles/Pricing.css';

const TIER_LABELS = {
  1: 'User',
  2: 'Agent',
  3: 'Vendor',
};

function Pricing() {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [networks, setNetworks] = useState([]);
  const [upgradeFees, setUpgradeFees] = useState({ agent: 0, vendor: 0 });
  const [yourTier, setYourTier] = useState(null);
  const [error, setError] = useState('');

  // This component is mounted on TWO routes: /pricing (public, bare — nothing
  // around it) and /app/pricing (inside Layout, which already provides the
  // sidebar and top bar). Only the public copy needs its own navigation;
  // rendering it in both would double the chrome. Deriving it from the path
  // rather than from auth state on purpose — a logged-in user who follows a
  // shared /pricing link still gets a usable page instead of a dead end.
  const standalone = !location.pathname.startsWith('/app');

  useEffect(() => { loadPricing(); }, []);

  async function loadPricing() {
    try {
      const res = await api.get('/catalog/pricing');
      if (res.status === 'success') {
        setNetworks(res.data.networks || []);
        setUpgradeFees(res.data.upgrade || { agent: 0, vendor: 0 });
        setYourTier(res.data.yourTier);
      }
    } catch (err) {
      setError(err.message || 'Could not load pricing.');
    } finally {
      setLoading(false);
    }
  }

  const agent = Number(upgradeFees.agent || 0);
  const vendor = Number(upgradeFees.vendor || 0);

  // Included in the loading and error returns too, not just the success one:
  // an anonymous visitor whose request fails would otherwise be stranded on a
  // bare error message with no way back to the app.
  const topbar = standalone ? (
    <div className="pricing-topbar">
      <Link to="/login" className="pricing-brand">
        <img src="/logo-mark.png" alt="" className="brand-mark" width={26} height={26} />
        DATAHOOD
      </Link>
      <div className="pricing-topbar-actions">
        <Link to="/login" className="btn btn-ghost btn-sm">Sign in</Link>
        <Link to="/register" className="btn btn-sm">Create account</Link>
      </div>
    </div>
  ) : null;

  if (loading) {
    return (
      <div className="pricing-page">
        {topbar}
        <div className="pricing-loading">Loading pricing...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pricing-page">
        {topbar}
        <div className="pricing-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="pricing-page">
      {topbar}
      <header className="pricing-header">
        <h1>Data Plan Pricing</h1>
        <p className="pricing-intro">
          Compare prices across all three membership tiers. Upgrade your account to unlock
          better rates on every plan.
        </p>
      </header>

      {yourTier && (
        <div className="your-tier-card">
          <span className="your-tier-label">Your current tier:</span>
          <strong className="your-tier-name">{TIER_LABELS[yourTier] || 'User'}</strong>
        </div>
      )}

      <div className="tier-upgrade-cards">
        <div className="upgrade-card">
          <h3>Agent Tier</h3>
          <p className="upgrade-fee">{formatNaira(agent)}</p>
          <p className="upgrade-desc">One-time upgrade fee. Lower prices on every data plan.</p>
          {yourTier === 1 && (
            <button className="btn" onClick={() => navigate('/app/profile')}>
              Upgrade to Agent
            </button>
          )}
          {yourTier === 2 && <span className="badge badge-success">Current tier</span>}
          {yourTier === 3 && <span className="badge badge-muted">Below your tier</span>}
        </div>

        <div className="upgrade-card highlight">
          <h3>Vendor Tier</h3>
          <p className="upgrade-fee">{formatNaira(vendor)}</p>
          <p className="upgrade-desc">One-time upgrade fee. Best prices on every data plan.</p>
          {yourTier && yourTier < 3 && (
            <button className="btn" onClick={() => navigate('/app/profile')}>
              Upgrade to Vendor
            </button>
          )}
          {yourTier === 3 && <span className="badge badge-success">Current tier</span>}
        </div>
      </div>

      <div className="pricing-tables">
        {/* networks === [] is a real, reachable state, not a defensive
            afterthought: getPublicPricing only returns plans with
            status='enabled' and then drops any network left with none
            (`.filter(n => n.plans.length > 0)`). So a site whose plans are all
            disabled gets an empty array and, without this branch, an utterly
            blank page below the tier cards — which reads as "pricing is
            broken" rather than "an admin has not enabled any plans yet". */}
        {networks.length === 0 ? (
          <div className="pricing-empty">
            <h3>No plans are published yet</h3>
            <p>
              Data plans appear here as soon as they are enabled. If you are expecting
              prices, an administrator needs to enable plans under Admin → Plans.
            </p>
          </div>
        ) : networks.map((net) => (
          <section key={net.nId} className="network-pricing">
            <h2 className="network-name">
              {net.label}
              {/* `available === false` means an admin has toggled the network
                  off (usually a provider outage). We still show its prices —
                  they haven't changed — but saying so up front is kinder than
                  letting someone read the table, tap buy, and hit a rejection.
                  Checked with `=== false` so an older API response that omits
                  the field entirely doesn't badge every network as down. */}
              {net.available === false && (
                <span className="network-offline" title="Temporarily unavailable to purchase">
                  Temporarily unavailable
                </span>
              )}
            </h2>
            {net.plans.length === 0 ? (
              <p className="no-plans">No plans available for this network.</p>
            ) : (
              <div className="table-wrap">
                <table className="pricing-table">
                  <thead>
                    <tr>
                      <th className="col-plan">Plan</th>
                      <th className="col-type">Type</th>
                      <th className="col-validity">Validity</th>
                      <th className={`col-price ${yourTier === 1 ? 'highlight-tier' : ''}`}>
                        User
                      </th>
                      <th className={`col-price ${yourTier === 2 ? 'highlight-tier' : ''}`}>
                        Agent
                      </th>
                      <th className={`col-price ${yourTier === 3 ? 'highlight-tier' : ''}`}>
                        Vendor
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {net.plans.map((p) => {
                      const agentSave = Number(p.agentSaving || 0);
                      const vendorSave = Number(p.vendorSaving || 0);

                      return (
                        <tr key={p.pId}>
                          <td className="plan-name">{p.name}</td>
                          <td className="plan-type">{p.type || '—'}</td>
                          <td className="plan-validity">{p.day ? `${p.day} days` : '—'}</td>
                          <td className={`price ${yourTier === 1 ? 'your-price' : ''}`}>
                            {formatNaira(Number(p.user || 0))}
                          </td>
                          <td className={`price ${yourTier === 2 ? 'your-price' : ''}`}>
                            <div className="price-cell">
                              <span className="price-amount">{formatNaira(Number(p.agent || 0))}</span>
                              {agentSave > 0 && yourTier !== 2 && (
                                <span className="price-save">save {formatNaira(agentSave)}</span>
                              )}
                            </div>
                          </td>
                          <td className={`price ${yourTier === 3 ? 'your-price' : ''}`}>
                            <div className="price-cell">
                              <span className="price-amount">{formatNaira(Number(p.vendor || 0))}</span>
                              {vendorSave > 0 && yourTier !== 3 && (
                                <span className="price-save">save {formatNaira(vendorSave)}</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        ))}
      </div>

      {!yourTier && (
        <div className="pricing-cta">
          <h3>Ready to get started?</h3>
          <p>Create an account to buy data at User rates, or upgrade immediately for even better prices.</p>
          <div className="cta-buttons">
            <button className="btn btn-ghost" onClick={() => navigate('/register')}>
              Create Account
            </button>
            <button className="btn" onClick={() => navigate('/login')}>
              Log In
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Pricing;
