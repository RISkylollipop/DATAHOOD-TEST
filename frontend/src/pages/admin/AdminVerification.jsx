import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader } from '../../components/Loader';
import { IcShield } from '../../components/Icons';

const TYPES = [
  { key: 'nin', label: 'NIN' },
  { key: 'bvn', label: 'BVN' },
  { key: 'passport', label: 'Passport' },
  { key: 'drivers_license', label: "Driver's License" },
  { key: 'voters_card', label: "Voter's Card" },
  { key: 'phone', label: 'Phone' },
];
const TIERS = [['user', 'User'], ['agent', 'Agent'], ['vendor', 'Vendor']];

export default function AdminVerification() {
  const toast = useToast();
  const [provider, setProvider] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [authStyle, setAuthStyle] = useState('token');
  const [active, setActive] = useState(false);
  const [prices, setPrices] = useState({});
  const [paths, setPaths] = useState({});
  const [buyPrices, setBuyPrices] = useState({});

  useEffect(() => {
    api.get('/admin/providers', { category: 'nin' })
      .then((r) => {
        const p = (r.data || [])[0];
        if (p) {
          setProvider(p);
          setBaseUrl(p.baseUrl || '');
          setAuthStyle(p.authStyle || 'token');
          setActive(p.status === 'active');
          const cfg = p.extraConfig || {};
          setPrices(cfg.prices || {});
          setPaths(cfg.paths || {});
          setBuyPrices(cfg.buyPrices || {});
        }
      })
      .catch(() => toast.error('Could not load verification provider'))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setPrice = (type, tier, val) => {
    setPrices((p) => ({ ...p, [type]: { ...(p[type] || {}), [tier]: val === '' ? undefined : Number(val) } }));
  };

  const save = async () => {
    setSaving(true);
    // Clean prices: drop empty rows
    const cleanPrices = {};
    Object.entries(prices).forEach(([t, row]) => {
      const kept = {};
      TIERS.forEach(([tk]) => { if (row?.[tk] != null && !Number.isNaN(row[tk])) kept[tk] = Number(row[tk]); });
      if (Object.keys(kept).length) cleanPrices[t] = kept;
    });
    const cleanBuy = {};
    Object.entries(buyPrices).forEach(([t, v]) => { if (v !== '' && v != null && !Number.isNaN(Number(v))) cleanBuy[t] = Number(v); });
    const cleanPaths = {};
    Object.entries(paths).forEach(([t, v]) => { if (v) cleanPaths[t] = v; });

    const payload = {
      baseUrl, authStyle, status: active ? 'active' : 'inactive', isDefault: true,
      extraConfig: { prices: cleanPrices, paths: cleanPaths, buyPrices: cleanBuy },
      ...(apiKey ? { apiKey } : {}),
    };
    try {
      if (provider) await api.put(`/admin/providers/${provider.id}`, payload);
      else await api.post('/admin/providers', { name: 'Verification', category: 'nin', ...payload });
      toast.success('Verification settings saved');
      setApiKey('');
    } catch (err) {
      toast.error('Save failed', err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loader full />;

  return (
    <>
      <h1 className="page-title">Verification</h1>
      <p className="page-sub">Connect an identity provider and set per-type, per-tier pricing.</p>

      <div className="card card-pad-lg mb-2">
        <h3 className="row mt-0" style={{ gap: 8, alignItems: 'center' }}><IcShield size={20} /> Provider connection</h3>
        <div className="grid grid-2">
          <div className="field" style={{ margin: 0 }}>
            <label className="label">Base URL</label>
            <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.verifyprovider.com" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label className="label">Auth style</label>
            <select className="select" value={authStyle} onChange={(e) => setAuthStyle(e.target.value)}>
              <option value="token">Token header</option>
              <option value="bearer">Bearer</option>
              <option value="basic">Basic</option>
              <option value="query">Query param</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label className="label">API key {provider?.apiKeyHint && <span className="muted small">(current: {provider.apiKeyHint})</span>}</label>
          <input className="input" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={provider ? 'Leave blank to keep' : 'API key'} />
        </div>
        <label className="row" style={{ gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span className="small">Verification service active</span>
        </label>
      </div>

      <div className="card">
        <h3 className="mt-0">Pricing per identity type</h3>
        <p className="muted small">Set the charge for each tier. Leave blank to disable that type. Buy price is optional (for profit tracking).</p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                {TIERS.map(([, l]) => <th key={l}>{l} price</th>)}
                <th>Buy price</th>
                <th>Path override</th>
              </tr>
            </thead>
            <tbody>
              {TYPES.map((t) => (
                <tr key={t.key}>
                  <td className="strong">{t.label}</td>
                  {TIERS.map(([tk]) => (
                    <td key={tk}>
                      <input className="input" style={{ width: 90 }} inputMode="numeric"
                        value={prices[t.key]?.[tk] ?? ''} onChange={(e) => setPrice(t.key, tk, e.target.value)} placeholder="₦" />
                    </td>
                  ))}
                  <td>
                    <input className="input" style={{ width: 90 }} inputMode="numeric"
                      value={buyPrices[t.key] ?? ''} onChange={(e) => setBuyPrices((b) => ({ ...b, [t.key]: e.target.value }))} placeholder="₦" />
                  </td>
                  <td>
                    <input className="input" style={{ width: 110 }}
                      value={paths[t.key] ?? ''} onChange={(e) => setPaths((p) => ({ ...p, [t.key]: e.target.value }))} placeholder="e.g. vnin" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button className="btn mt-2" onClick={save} disabled={saving}>
          {saving ? <span className="spinner" /> : 'Save verification settings'}
        </button>
      </div>
    </>
  );
}
