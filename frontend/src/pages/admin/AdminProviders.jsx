import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader, Empty } from '../../components/Loader';
import { Modal } from '../../components/Modal';
import { IcServer, IcPlus } from '../../components/Icons';

const CATEGORY_LABELS = {
  airtime: 'Airtime', data: 'Data', cable: 'Cable TV', electricity: 'Electricity',
  exam: 'Exam PINs', rechargepin: 'Recharge PINs', 
  payment: 'Payment', whatsapp: 'WhatsApp', wallet: 'Wallet',
};

// bvn: 'BVN', nin: 'Verification (NIN etc.)',

// Setup notes for the two categories where a field does not mean the obvious
// thing. Deliberately terse: this sits inside a form, and a paragraph above an
// input is skipped rather than read. Only what you cannot guess while filling
// the row in belongs here — the reasoning lives in these comments instead.
//
// WhatsApp: the backend reads the row's NAME to pick which API to call, so a
// descriptive name like "WhatsApp Receipts" resolves to no driver and receipts
// silently never send.
// Wallet: the balance endpoint differs per vendor. The seed pre-fills
// /api/user/ because it is a common convention, not because it is correct;
// when it is wrong the card says so and this is the field that fixes it.
const CATEGORY_HINTS = {
  whatsapp: {
    title: 'Name this row "Meta" or "Termii"',
    body: [
      'The name picks the API. Meta: token in Secret key, Extra config '
        + '{"phoneNumberId":"…","templateName":"…"} (template must be approved, '
        + 'four placeholders). Termii: key in API key, Extra config {"senderId":"…"}.',
    ],
  },
  wallet: {
    title: 'One row per vendor — no default',
    body: [
      'Name it exactly like the vendor\'s other rows. Base URL is their balance '
        + 'endpoint from their docs; the pre-filled /api/user/ is a guess, so replace '
        + 'it if the card reports no balance field. API key can stay blank — the '
        + 'vendor\'s existing key is reused.',
    ],
  },
};

const EMPTY = {
  name: '', category: 'airtime', baseUrl: '', apiKey: '', secretKey: '',
  authStyle: 'token', status: 'inactive', isDefault: false, extraConfig: '',
};

export default function AdminProviders() {
  const toast = useToast();
  const [providers, setProviders] = useState([]);
  const [categories, setCategories] = useState([]);
  // Categories the server will not accept a default for. Read from the API
  // rather than restated here, so the two cannot drift apart.
  const [noDefault, setNoDefault] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('');
  const [modal, setModal] = useState(null); // { mode:'create'|'edit', form }
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/admin/providers', filter ? { category: filter } : {})
      .then((r) => {
        setProviders(r.data || []);
        if (r.categories) setCategories(r.categories);
        if (r.noDefaultCategories) setNoDefault(r.noDefaultCategories);
      })
      .catch(() => toast.error('Could not load providers'))
      .finally(() => setLoading(false));
  }, [filter, toast]);

  useEffect(() => { load(); }, [load]);

  const openCreate = () => setModal({ mode: 'create', form: { ...EMPTY, category: filter || 'airtime' } });
  const openEdit = (p) => setModal({
    mode: 'edit', id: p.id,
    form: {
      name: p.name, category: p.category, baseUrl: p.baseUrl || '',
      apiKey: '', secretKey: '', authStyle: p.authStyle || 'token',
      status: p.status, isDefault: p.isDefault,
      extraConfig: p.extraConfig ? JSON.stringify(p.extraConfig, null, 2) : '',
      apiKeyHint: p.apiKeyHint, secretKeyHint: p.secretKeyHint,
    },
  });

  const setField = (k, v) => setModal((m) => ({ ...m, form: { ...m.form, [k]: v } }));

  const save = async () => {
    const f = modal.form;
    if (!f.name) return toast.error('Provider name is required.');
    let extraConfig;
    if (f.extraConfig && f.extraConfig.trim()) {
      try { extraConfig = JSON.parse(f.extraConfig); }
      catch { return toast.error('Extra config must be valid JSON.'); }
    }
    const payload = {
      name: f.name, category: f.category, baseUrl: f.baseUrl,
      authStyle: f.authStyle, status: f.status, isDefault: f.isDefault,
      ...(extraConfig !== undefined ? { extraConfig } : {}),
      ...(f.apiKey ? { apiKey: f.apiKey } : {}),
      ...(f.secretKey ? { secretKey: f.secretKey } : {}),
    };
    setSaving(true);
    try {
      if (modal.mode === 'create') await api.post('/admin/providers', payload);
      else await api.put(`/admin/providers/${modal.id}`, payload);
      toast.success(modal.mode === 'create' ? 'Provider added' : 'Provider updated');
      setModal(null);
      load();
    } catch (err) {
      toast.error('Save failed', err.message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (p) => {
    try {
      await api.patch(`/admin/providers/${p.id}/toggle`);
      toast.success(`Provider ${p.status === 'active' ? 'deactivated' : 'activated'}`);
      load();
    } catch (err) {
      toast.error('Could not change status', err.message);
    }
  };

  const test = async (p) => {
    setTesting(p.id);
    try {
      const r = await api.post(`/admin/providers/${p.id}/test`);
      if (r.data?.reachable) toast.success('Provider reachable', p.baseUrl);
      else toast.error('Provider unreachable', p.baseUrl);
      load();
    } catch (err) {
      toast.error('Test failed', err.message);
    } finally {
      setTesting(null);
    }
  };

  return (
    <>
      <div className="row between wrap mb-2">
        <div>
          <h1 className="page-title" style={{ marginBottom: 2 }}>Providers</h1>
          <p className="page-sub" style={{ margin: 0 }}>Connect and manage your fulfillment & service APIs.</p>
        </div>
        <button className="btn" onClick={openCreate}><IcPlus size={18} /> Add provider</button>
      </div>

      <div className="row wrap mb-2" style={{ gap: 8 }}>
        <button className={`btn btn-sm ${filter === '' ? '' : 'btn-soft'}`} onClick={() => setFilter('')}>All</button>
        {categories.map((c) => (
          <button key={c} className={`btn btn-sm ${filter === c ? '' : 'btn-soft'}`} onClick={() => setFilter(c)}>
            {CATEGORY_LABELS[c] || c}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? <Loader /> : providers.length === 0 ? (
          <Empty title="No providers" message="Add a provider to start fulfilling this service.">
            <button className="btn mt-1" onClick={openCreate}><IcPlus size={16} /> Add provider</button>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Category</th><th>Base URL</th><th>Keys</th><th>Status</th><th>Health</th><th></th></tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id}>
                    <td className="strong">{p.name} {p.isDefault && <span className="badge badge-muted">default</span>}</td>
                    <td className="small muted" style={{ textTransform: 'capitalize' }}>{p.category}</td>
                    <td className="small muted" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.baseUrl || '—'}</td>
                    <td className="small muted">{p.hasApiKey ? p.apiKeyHint : '—'}</td>
                    <td><span className={`badge ${p.status === 'active' ? 'badge-success' : 'badge-muted'}`}>{p.status}</span></td>
                    <td className="small muted">{p.lastStatus || '—'}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => openEdit(p)}>Edit</button>
                        <button className="btn btn-soft btn-sm" onClick={() => toggle(p)}>{p.status === 'active' ? 'Disable' : 'Enable'}</button>
                        <button className="btn btn-soft btn-sm" disabled={testing === p.id || !p.baseUrl} onClick={() => test(p)}>
                          {testing === p.id ? <span className="spinner" /> : 'Test'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Modal open={!!modal} onClose={() => !saving && setModal(null)}
        title={modal?.mode === 'create' ? 'Add provider' : 'Edit provider'} maxWidth={560}>
        {modal && (
          <div>
            {CATEGORY_HINTS[modal.form.category] && (
              <div className="card card-pad mb-2" style={{ background: 'var(--surface-2, rgba(0,0,0,.03))' }}>
                <div className="small strong">{CATEGORY_HINTS[modal.form.category].title}</div>
                {CATEGORY_HINTS[modal.form.category].body.map((p) => (
                  <p className="muted small mt-1" key={p.slice(0, 24)} style={{ margin: '6px 0 0' }}>{p}</p>
                ))}
              </div>
            )}
            <div className="grid grid-2">
              <div className="field" style={{ margin: 0 }}>
                <label className="label">Name</label>
                <input className="input" value={modal.form.name} onChange={(e) => setField('name', e.target.value)} placeholder="e.g. VTPass" />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label className="label">Category</label>
                <select className="select" value={modal.form.category} disabled={modal.mode === 'edit'}
                  onChange={(e) => setField('category', e.target.value)}>
                  {(categories.length ? categories : Object.keys(CATEGORY_LABELS)).map((c) => (
                    <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label className="label">Base URL</label>
              <input className="input" value={modal.form.baseUrl} onChange={(e) => setField('baseUrl', e.target.value)} placeholder="https://api.provider.com" />
            </div>
            <div className="grid grid-2">
              <div className="field" style={{ margin: 0 }}>
                <label className="label">API key {modal.form.apiKeyHint && <span className="muted small">(current: {modal.form.apiKeyHint})</span>}</label>
                <input className="input" value={modal.form.apiKey} onChange={(e) => setField('apiKey', e.target.value)}
                  placeholder={modal.mode === 'edit' ? 'Leave blank to keep' : 'API key'} />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label className="label">Secret key {modal.form.secretKeyHint && <span className="muted small">(current: {modal.form.secretKeyHint})</span>}</label>
                <input className="input" value={modal.form.secretKey} onChange={(e) => setField('secretKey', e.target.value)}
                  placeholder={modal.mode === 'edit' ? 'Leave blank to keep' : 'Secret (optional)'} />
              </div>
            </div>
            <div className="grid grid-2">
              <div className="field" style={{ margin: 0 }}>
                <label className="label">Auth style</label>
                <select className="select" value={modal.form.authStyle} onChange={(e) => setField('authStyle', e.target.value)}>
                  <option value="token">Token header</option>
                  <option value="bearer">Bearer</option>
                  <option value="basic">Basic</option>
                  <option value="query">Query param</option>
                </select>
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label className="label">Status</label>
                <select className="select" value={modal.form.status} onChange={(e) => setField('status', e.target.value)}>
                  <option value="inactive">Inactive</option>
                  <option value="active">Active</option>
                </select>
              </div>
            </div>
            {/* Hidden, not disabled, for categories the server refuses to
                default — a greyed-out checkbox reads as "not yet", when the
                honest answer is that the idea does not apply here. */}
            {!noDefault.includes(modal.form.category) && (
              <label className="row" style={{ gap: 8, alignItems: 'center', margin: '8px 0' }}>
                <input type="checkbox" checked={modal.form.isDefault} onChange={(e) => setField('isDefault', e.target.checked)} />
                <span className="small">Set as default provider for this category</span>
              </label>
            )}
            <div className="field">
              <label className="label">Extra config (JSON) <span className="muted small">— endpoint paths, prices, etc.</span></label>
              <textarea className="input" rows={4} style={{ fontFamily: 'monospace', fontSize: 12 }}
                value={modal.form.extraConfig} onChange={(e) => setField('extraConfig', e.target.value)}
                placeholder='{"paths":{"airtime":"/topup"}}' />
            </div>
            {/* Sticky, so the action is on screen the moment the dialog opens.
                A save button that only appears after you scroll past a long
                form reads as a missing button, not as a hidden one.
                bottom:0 pins it to the scrollport edge; the bottom padding
                fills the modal's own 24px inset with surface colour so content
                cannot show through underneath, and the matching negative
                margin cancels that padding when the form is short enough not
                to scroll, leaving the resting layout unchanged. */}
            <div style={{
              position: 'sticky', bottom: 0, background: 'var(--surface)',
              paddingTop: 12, paddingBottom: 24, marginBottom: -24, marginTop: 4,
            }}>
              <button className="btn btn-block" onClick={save} disabled={saving}>
                {saving ? <span className="spinner" /> : (modal.mode === 'create' ? 'Add provider' : 'Save changes')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
