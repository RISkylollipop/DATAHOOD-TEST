import React, { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader } from '../../components/Loader';
import { Modal } from '../../components/Modal';
import { IcCard } from '../../components/Icons';

export default function AdminGateways() {
  const toast = useToast();
  const [gateways, setGateways] = useState([]);
  const [configured, setConfigured] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    setLoading(true);
    Promise.all([api.get('/admin/payment/gateways'), api.get('/admin/providers', { category: 'payment' })])
      .then(([g, p]) => { setGateways(g.data || []); setConfigured(p.data || []); })
      .catch(() => toast.error('Could not load gateways'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const configFor = (key) => configured.find((c) => c.name === key.toLowerCase());

  const openConfig = (gw) => {
    const existing = configFor(gw.key);
    // requireBvn is stored in extraConfig and defaults to whatever the
    // adapter says, so an untouched gateway keeps its built-in behaviour.
    const savedBvn = existing?.extraConfig?.requireBvn;
    const form = {
      baseUrl: existing?.baseUrl || '',
      apiKey: '',
      secretKey: '',
      isActive: existing?.status === 'active',
      isDefault: !!existing?.isDefault,
      requireBvn: savedBvn === undefined || savedBvn === null || savedBvn === ''
        ? !!gw.needsBvn
        : savedBvn === true || savedBvn === 'true',
    };
    (gw.requiredConfig || []).forEach((rc) => { if (!(rc in form)) form[rc] = existing?.extraConfig?.[rc] || ''; });
    setModal({ gw, form, existing });
  };

  const setField = (k, v) => setModal((m) => ({ ...m, form: { ...m.form, [k]: v } }));

  const save = async () => {
    const { gw, form } = modal;
    const config = { ...form };
    delete config.isActive;
    delete config.isDefault;
    setSaving(true);
    try {
      await api.post('/admin/payment/gateways', {
        gateway: gw.key,
        config,
        isActive: form.isActive,
        isDefault: form.isDefault,
      });
      toast.success('Gateway configured', gw.name);
      setModal(null);
      load();
    } catch (err) {
      toast.error('Could not save gateway', err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Loader full />;

  return (
    <>
      <h1 className="page-title">Payment Gateways</h1>
      <p className="page-sub">Configure the providers that fund user wallets via virtual accounts.</p>

      <div className="grid grid-3">
        {gateways.map((gw) => {
          const cfg = configFor(gw.key);
          const active = cfg?.status === 'active';
          return (
            <div key={gw.key} className="card card-pad-lg">
              <div className="row between mb-2">
                <div className="ic" style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <IcCard size={22} />
                </div>
                <span className={`badge ${active ? 'badge-success' : 'badge-muted'}`}>{active ? 'Active' : cfg ? 'Inactive' : 'Not set up'}</span>
              </div>
              <h3 className="mt-0">{gw.name}</h3>
              <p className="muted small">Requires: {(gw.requiredConfig || []).join(', ') || 'API credentials'}</p>
              {cfg?.apiKeyHint && <p className="small muted">Key: {cfg.apiKeyHint}</p>}
              <button className="btn btn-block mt-1" onClick={() => openConfig(gw)}>{cfg ? 'Update' : 'Configure'}</button>
            </div>
          );
        })}
        {gateways.length === 0 && <p className="muted">No gateway adapters available.</p>}
      </div>

      <Modal open={!!modal} onClose={() => !saving && setModal(null)} title={modal ? `Configure ${modal.gw.name}` : ''} maxWidth={500}>
        {modal && (
          <div>
            <div className="field">
              <label className="label">Base URL <span className="muted small">(optional)</span></label>
              <input className="input" value={modal.form.baseUrl} onChange={(e) => setField('baseUrl', e.target.value)} placeholder="https://api.gateway.com" />
            </div>
            <div className="field">
              <label className="label">API key {modal.existing?.apiKeyHint && <span className="muted small">(current: {modal.existing.apiKeyHint})</span>}</label>
              <input className="input" value={modal.form.apiKey} onChange={(e) => setField('apiKey', e.target.value)} placeholder={modal.existing ? 'Leave blank to keep' : 'API key'} />
            </div>
            <div className="field">
              <label className="label">Secret key {modal.existing?.secretKeyHint && <span className="muted small">(current: {modal.existing.secretKeyHint})</span>}</label>
              <input className="input" value={modal.form.secretKey} onChange={(e) => setField('secretKey', e.target.value)} placeholder={modal.existing ? 'Leave blank to keep' : 'Secret key'} />
            </div>
            {(modal.gw.requiredConfig || []).filter((rc) => !['apiKey', 'secretKey', 'baseUrl'].includes(rc)).map((rc) => (
              <div className="field" key={rc}>
                <label className="label" style={{ textTransform: 'capitalize' }}>{rc.replace(/([A-Z])/g, ' $1')}</label>
                <input className="input" value={modal.form[rc] || ''} onChange={(e) => setField(rc, e.target.value)} placeholder={rc} />
              </div>
            ))}
            {/* Active and default are separate switches. Several gateways can
                be active at once — users may hold an account at each — but
                only one is the recommended default. */}
            <label className="row" style={{ gap: 8, alignItems: 'center', margin: '8px 0' }}>
              <input type="checkbox" checked={modal.form.isActive} onChange={(e) => setField('isActive', e.target.checked)} />
              <span className="small">Active — users can generate accounts on this gateway</span>
            </label>
            <label className="row" style={{ gap: 8, alignItems: 'center', margin: '8px 0' }}>
              <input type="checkbox" checked={modal.form.isDefault} disabled={!modal.form.isActive}
                onChange={(e) => setField('isDefault', e.target.checked)} />
              <span className="small">
                Recommended — preselected on the Fund page
                <span className="muted"> (only one gateway can hold this)</span>
              </span>
            </label>
            {/* Whether a BVN is needed depends on the merchant contract, not
                the gateway software — two Monnify contracts can differ. Set
                it here rather than in code, and the Fund page follows. */}
            <label className="row" style={{ gap: 8, alignItems: 'center', margin: '8px 0' }}>
              <input type="checkbox" checked={modal.form.requireBvn}
                onChange={(e) => setField('requireBvn', e.target.checked)} />
              <span className="small">
                Require BVN — ask the user for a BVN when generating this account
                <span className="muted"> (passed to {modal.gw.name}, never stored)</span>
              </span>
            </label>
            <button className="btn btn-block" onClick={save} disabled={saving}>
              {saving ? <span className="spinner" /> : 'Save gateway'}
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
