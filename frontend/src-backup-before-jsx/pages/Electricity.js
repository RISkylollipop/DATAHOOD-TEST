import React, { useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { PinModal } from '../components/PinModal';
import { formatNaira, DISCOS, METER_TYPES } from '../config';
import { usePurchaseRef } from '../hooks/usePurchaseRef';
import { IcBolt } from '../components/Icons';

export default function Electricity() {
  const { updateUser } = useAuth();
  const toast = useToast();
  const [form, setForm] = useState({ provider: '', metertype: 'prepaid', meternumber: '', phone: '', amount: '' });
  const [verified, setVerified] = useState(null);
  const [verifying, setVerifying] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  // Stable across retries of this one purchase — see usePurchaseRef.
  const purchaseRef = usePurchaseRef('ELE');
  const set = (k) => (e) => { setForm({ ...form, [k]: e.target.value }); setVerified(null); };

  const verify = async () => {
    if (!form.provider) return toast.error('Select a DisCo.');
    if (!form.meternumber) return toast.error('Enter the meter number.');
    setVerifying(true);
    try {
      const res = await api.post('/electricity/verify', {
        provider: form.provider, meternumber: form.meternumber, metertype: form.metertype,
      });
      setVerified(res.data || { name: 'Verified' });
      toast.success('Meter verified', res.data?.customerName || res.data?.name || '');
    } catch (err) {
      toast.error('Verification failed', err.message);
    } finally {
      setVerifying(false);
    }
  };

  const openPin = () => {
    if (!form.provider || !form.meternumber) return toast.error('Complete meter details.');
    if (!/^0\d{10}$/.test(form.phone)) return toast.error('Enter a valid phone number.');
    if (Number(form.amount) < 500) return toast.error('Minimum amount is ₦500.');
    setPinOpen(true);
  };

  const submit = async (pin) => {
    setBusy(true);
    try {
      const res = await api.post('/electricity/purchase', {
        provider: form.provider, phone: form.phone, metertype: form.metertype,
        meternumber: form.meternumber, amount: Number(form.amount), transref: purchaseRef.value(), pin,
      });
      setPinOpen(false);
      setDone(res.data || {});
      if (res.data?.newBalance != null) updateUser({ wallet: res.data.newBalance });
      toast.success('Token generated!', res.data?.token ? `Token: ${res.data.token}` : '');
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
      <h1 className="page-title">Electricity</h1>
      <p className="page-sub">Buy prepaid tokens or pay postpaid bills.</p>

      <div className="grid grid-2">
        <div className="card card-pad-lg">
          <div className="field">
            <label className="label">Distribution company</label>
            <select className="select" value={form.provider} onChange={set('provider')}>
              <option value="">Select DisCo…</option>
              {DISCOS.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label">Meter type</label>
            <div className="seg">
              {METER_TYPES.map((m) => (
                <button key={m.id} type="button" className={form.metertype === m.id ? 'active' : ''}
                  onClick={() => { setForm({ ...form, metertype: m.id }); setVerified(null); }}>{m.name}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="label">Meter number</label>
            <div className="row">
              <input className="input" value={form.meternumber} onChange={set('meternumber')} placeholder="Enter meter number" />
              <button className="btn btn-ghost" onClick={verify} disabled={verifying} style={{ whiteSpace: 'nowrap' }}>
                {verifying ? <span className="spinner spinner-brand" /> : 'Verify'}
              </button>
            </div>
            {custName && <div className="hint text-success">✓ {custName}</div>}
          </div>
          <div className="field">
            <label className="label">Phone number</label>
            <input className="input" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="08012345678" inputMode="numeric" />
          </div>
          <div className="field">
            <label className="label">Amount</label>
            <input className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="₦" inputMode="numeric" />
          </div>
          <button className="btn btn-block mt-1" onClick={openPin}><IcBolt size={18} /> Pay</button>
        </div>

        <div className="card card-pad-lg">
          {done ? (
            <>
              <h3 className="text-success">✓ Payment successful</h3>
              <p className="muted">{formatNaira(done.amountPaid || form.amount)} — {form.metertype}</p>
              {done.token && (
                <div className="card" style={{ background: 'var(--brand-soft)' }}>
                  <div className="small muted">Token</div>
                  <div className="strong" style={{ fontSize: 20, letterSpacing: 1 }}>{done.token}</div>
                </div>
              )}
              {done.units && <p className="small mt-1">Units: <span className="strong">{done.units}</span></p>}
              <button className="btn btn-ghost mt-2" onClick={() => setDone(null)}>New payment</button>
            </>
          ) : (
            <>
              <h3>Notes</h3>
              <p className="muted small">Always verify the meter number to confirm the customer name before paying. Prepaid returns a token; postpaid settles the outstanding bill. Failed electricity payments are refunded automatically.</p>
            </>
          )}
        </div>
      </div>

      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onConfirm={submit}
        action={`buy ${DISCOS.find((d) => String(d.id) === String(form.provider))?.name || 'electricity'} ${form.metertype} units`}
        amount={formatNaira(form.amount)} target={`meter ${form.meternumber}`} connector="for" busy={busy} />
    </>
  );
}
