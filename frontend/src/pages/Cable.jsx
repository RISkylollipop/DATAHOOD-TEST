import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { PinModal } from '../components/PinModal';
import { Empty } from '../components/Loader';
import { formatNaira, CABLE_PROVIDERS } from '../config';
import { usePurchaseRef } from '../hooks/usePurchaseRef';
import { IcTv } from '../components/Icons';

export default function Cable() {
  const { updateUser } = useAuth();
  const toast = useToast();
  const [providerId, setProviderId] = useState('');
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [selected, setSelected] = useState(null);
  const [iuc, setIuc] = useState('');
  const [phone, setPhone] = useState('');
  const [subtype, setSubtype] = useState('renew');
  const [verified, setVerified] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  // Stable across retries of this one purchase — see usePurchaseRef.
  const purchaseRef = usePurchaseRef('CAB');

  const providerSlug = CABLE_PROVIDERS.find((c) => String(c.id) === String(providerId))?.slug;

  useEffect(() => {
    if (!providerId) { setPlans([]); return; }
    setLoadingPlans(true);
    setSelected(null);
    api.get('/catalog/cableplans', { provider: providerId })
      .then((r) => setPlans(r.data || []))
      .catch(() => toast.error('Could not load cable plans'))
      .finally(() => setLoadingPlans(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId]);

  const verify = async () => {
    if (!providerSlug) return toast.error('Select a provider.');
    if (!iuc) return toast.error('Enter the smartcard/IUC number.');
    setVerifying(true);
    try {
      const res = await api.post('/cable/verify', { provider: providerSlug, iucnumber: iuc });
      setVerified(res.data || { name: 'Verified' });
      toast.success('Smartcard verified', res.data?.customerName || res.data?.name || '');
    } catch (err) {
      toast.error('Verification failed', err.message);
    } finally {
      setVerifying(false);
    }
  };

  const openPin = () => {
    if (!selected) return toast.error('Select a package.');
    if (!iuc) return toast.error('Enter the smartcard number.');
    if (!/^0\d{10}$/.test(phone)) return toast.error('Enter a valid phone number.');
    setPinOpen(true);
  };

  const submit = async (pin) => {
    setBusy(true);
    try {
      const res = await api.post('/cable/purchase', {
        provider: providerSlug, phone, subtype, iucnumber: iuc,
        cableplan: selected.cpId, transref: purchaseRef.value(), pin,
      });
      setPinOpen(false);
      setDone(res.data || {});
      if (res.data?.newBalance != null) updateUser({ wallet: res.data.newBalance });
      toast.success('Subscription active!', selected.name);
      purchaseRef.reset(); // this purchase is done — the next one starts fresh
    } catch (err) {
      toast.error('Purchase failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  const custName = verified?.customerName || verified?.name || verified?.customer_name;

  return (
    <>
      <h1 className="page-title">Cable TV</h1>
      <p className="page-sub">Renew DSTV, GOTV and Startimes subscriptions.</p>

      <div className="card mb-2">
        <div className="grid grid-2">
          <div className="field" style={{ margin: 0 }}>
            <label className="label">Provider</label>
            <select className="select" value={providerId} onChange={(e) => { setProviderId(e.target.value); setVerified(null); }}>
              <option value="">Select provider…</option>
              {CABLE_PROVIDERS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label className="label">Smartcard / IUC number</label>
            <div className="row">
              <input className="input" value={iuc} onChange={(e) => { setIuc(e.target.value); setVerified(null); }} placeholder="Enter IUC number" />
              <button className="btn btn-ghost" onClick={verify} disabled={verifying} style={{ whiteSpace: 'nowrap' }}>
                {verifying ? <span className="spinner spinner-brand" /> : 'Verify'}
              </button>
            </div>
            {custName && <div className="hint text-success">✓ {custName}</div>}
          </div>
        </div>
        <div className="grid grid-2 mt-2">
          <div className="field" style={{ margin: 0 }}>
            <label className="label">Phone number</label>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="08012345678" inputMode="numeric" />
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label className="label">Action</label>
            <div className="seg">
              {[['renew', 'Renew'], ['change', 'Change plan']].map(([v, l]) => (
                <button key={v} type="button" className={subtype === v ? 'active' : ''} onClick={() => setSubtype(v)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {!providerId ? (
        <Empty title="Select a provider" message="Choose a provider above to see packages." />
      ) : loadingPlans ? (
        <Empty title="Loading packages…" />
      ) : plans.length === 0 ? (
        <Empty title="No packages" message="No cable packages configured for this provider yet." />
      ) : (
        <div className="grid grid-3">
          {plans.map((p) => (
            <div key={p.cpId} className="card"
              style={{ cursor: 'pointer', borderWidth: 2, borderColor: selected?.cpId === p.cpId ? 'var(--brand)' : 'var(--border)' }}
              onClick={() => setSelected(p)}>
              <div className="strong">{p.name}</div>
              <div className="text-brand strong mt-1" style={{ fontSize: 19 }}>{formatNaira(p.price)}</div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="card mt-2 row between wrap">
          <div>
            <div className="small muted">Selected package</div>
            <div className="strong">{selected.name} — {formatNaira(selected.price)}</div>
          </div>
          <button className="btn" onClick={openPin}><IcTv size={18} /> Subscribe</button>
        </div>
      )}

      {done && (
        <div className="card mt-2 center">
          <h3 className="text-success">✓ Subscription successful</h3>
          <p className="muted">{selected?.name} — {formatNaira(done.amountPaid || selected?.price)}</p>
        </div>
      )}

      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onConfirm={submit}
        action={`${subtype === 'change' ? 'change to' : 'renew'} ${selected ? selected.name : 'this plan'}`}
        amount={selected ? formatNaira(selected.price) : ''} target={`IUC ${iuc}`} connector="for" busy={busy} />
    </>
  );
}
