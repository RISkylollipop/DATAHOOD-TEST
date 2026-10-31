import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { PinModal } from '../components/PinModal';
import { Loader } from '../components/Loader';
import { formatNaira, networkLabel, validatePhone } from '../config';
import { usePurchaseRef } from '../hooks/usePurchaseRef';
import { IcPhone, IcCheck, IcShield, IcRefresh } from '../components/Icons';

// Quick amount presets for airtime.
const PRESETS = [50, 100, 200, 500, 1000, 2000];

// Map a stability value to a badge style + human label.
const STABILITY = {
  stable: { cls: 'badge-success', text: 'Stable' },
  unstable: { cls: 'badge-warn', text: 'Unstable' },
  down: { cls: 'badge-danger', text: 'Down' },
};

export default function Airtime() {
  const { updateUser } = useAuth();
  const toast = useToast();
  const [networks, setNetworks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ network: '', networktype: 'VTU', phone: '', amount: '' });
  const [ported, setPorted] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);
  // One reference for this purchase, reused across retries so the backend
  // can tell a retry from a second purchase.
  const purchaseRef = usePurchaseRef('AIR');

  const loadNetworks = () => {
    // network-status carries admin On/Off flags, the T2 label and the live
    // stability signal in one call.
    return api.get('/catalog/network-status')
      .then((r) => setNetworks(r.data || []))
      .catch(() => toast.error('Could not load networks'));
  };

  useEffect(() => {
    loadNetworks().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const selectedNet = useMemo(
    () => networks.find((n) => String(n.nId) === String(form.network)) || null,
    [networks, form.network]
  );

  const phoneCheck = useMemo(
    () => validatePhone(form.phone, selectedNet?.network),
    [form.phone, selectedNet]
  );

  const stability = selectedNet ? STABILITY[selectedNet.stability] : null;

  const validate = () => {
    if (!form.network) return 'Select a network.';
    if (!/^0\d{10}$/.test(form.phone)) return 'Enter a valid 11-digit phone number.';
    if (!ported && phoneCheck.complete && phoneCheck.detected && !phoneCheck.valid) {
      return phoneCheck.msg || 'Phone number does not match the selected network.';
    }
    const amt = Number(form.amount);
    if (!amt || amt < 50) return 'Enter an amount of at least ₦50.';
    return null;
  };

  const openPin = () => {
    const err = validate();
    if (err) return toast.error(err);
    setPinOpen(true);
  };

  const submit = async (pin) => {
    setBusy(true);
    try {
      const res = await api.post('/airtime/purchase', {
        network: Number(form.network),
        networktype: form.networktype,
        phone: form.phone,
        amount: Number(form.amount),
        transref: purchaseRef.value(),
        pin,
        ported_number: ported,
      });
      setPinOpen(false);
      setDone(res.data || { amountPaid: form.amount });
      if (res.data?.newBalance != null) updateUser({ wallet: res.data.newBalance });
      toast.success('Airtime sent!', `${formatNaira(form.amount)} to ${form.phone}`);
      purchaseRef.reset(); // this purchase is done — the next one starts fresh
      setForm({ ...form, phone: '', amount: '' });
      setPorted(false);
      loadNetworks(); // refresh stability after a purchase
    } catch (err) {
      toast.error('Purchase failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loader full />;

  // Inline phone hint colour: green when it matches, warn on mismatch.
  let phoneHint = null;
  if (form.phone) {
    if (phoneCheck.valid) {
      phoneHint = <span className="small text-success">✓ {phoneCheck.msg}</span>;
    } else if (phoneCheck.complete && phoneCheck.msg) {
      phoneHint = <span className="small text-danger">{phoneCheck.msg}</span>;
    } else if (phoneCheck.detected) {
      phoneHint = <span className="small muted">{phoneCheck.label} detected…</span>;
    }
  }

  return (
    <>
      <h1 className="page-title">Buy Airtime</h1>
      <p className="page-sub">Top up any Nigerian line instantly.</p>

      <div className="grid grid-2">
        <div className="card card-pad-lg">
          <div className="field">
            <label className="label">Network</label>
            <select className="select" value={form.network} onChange={set('network')}>
              <option value="">Select network…</option>
              {networks
                .filter((n) => n.networkStatus === 'On')
                .map((n) => <option key={n.nId} value={n.nId}>{n.label || networkLabel(n.network)}</option>)}
            </select>
          </div>

          {/* Network stability indicator — shown once a network is chosen. */}
          {selectedNet && stability && (
            <div className="row between wrap" style={{ marginTop: -4, marginBottom: 12, gap: 8 }}>
              <span className="row" style={{ gap: 8, alignItems: 'center' }}>
                <IcShield size={16} />
                <span className="small muted">Network status</span>
                <span className={`badge ${stability.cls}`}>{stability.text}</span>
                {selectedNet.successRate != null && selectedNet.sample >= 4 && (
                  <span className="small muted">{selectedNet.successRate}% success recently</span>
                )}
              </span>
              <button className="btn-soft small" onClick={loadNetworks} title="Refresh network status" type="button">
                <IcRefresh size={14} /> Refresh
              </button>
            </div>
          )}

          <div className="field">
            <label className="label">Type</label>
            <div className="seg">
              {['VTU', 'Sharesell'].map((t) => (
                <button key={t} className={form.networktype === t ? 'active' : ''}
                  onClick={() => setForm({ ...form, networktype: t })} type="button">{t}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label className="label">Phone number</label>
            <input className="input" value={form.phone} onChange={set('phone')}
              placeholder="08012345678" inputMode="numeric" maxLength={11} />
            <div className="row between wrap" style={{ marginTop: 4, gap: 8 }}>
              <span>{phoneHint}</span>
              <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={ported} onChange={(e) => setPorted(e.target.checked)} />
                Number is ported
              </label>
            </div>
          </div>
          <div className="field">
            <label className="label">Amount</label>
            <input className="input" value={form.amount} onChange={set('amount')} placeholder="₦" inputMode="numeric" />
            <div className="row wrap mt-1" style={{ gap: 8 }}>
              {PRESETS.map((p) => (
                <button key={p} type="button" className="btn btn-soft btn-sm"
                  onClick={() => setForm({ ...form, amount: String(p) })}>₦{p}</button>
              ))}
            </div>
          </div>
          <button className="btn btn-block mt-2" onClick={openPin}><IcPhone size={18} /> Continue</button>
        </div>

        <div>
          {done ? (
            <div className="card card-pad-lg center">
              <div className="ic" style={{ width: 56, height: 56, margin: '0 auto 14px', borderRadius: 16, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <IcCheck size={28} />
              </div>
              <h3>Airtime delivered</h3>
              {/* Show the FACE VALUE delivered to the phone (done.amount), not
                  done.amountPaid — that is the discounted sum debited from the
                  wallet and reads as if less airtime arrived than actually did. */}
              <p className="muted">{formatNaira(done.amount)} sent successfully.</p>
              {done.amountPaid != null && (
                <p className="small muted">{formatNaira(done.amountPaid)} debited from wallet</p>
              )}
              {done.newBalance != null && <p className="small">New balance: <span className="strong">{formatNaira(done.newBalance)}</span></p>}
              <button className="btn btn-ghost mt-1" onClick={() => setDone(null)}>Buy again</button>
            </div>
          ) : (
            <div className="card card-pad-lg">
              <h3>How it works</h3>
              <p className="muted small">Select a network, enter the phone number and amount, confirm with your 4-digit PIN. Airtime is delivered instantly and your wallet is debited. Failed airtime is automatically refunded.</p>
            </div>
          )}
        </div>
      </div>

      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onConfirm={submit}
        action={`purchase ${selectedNet ? (selectedNet.label || networkLabel(selectedNet.network)) + ' ' : ''}Airtime`}
        amount={formatNaira(form.amount)} target={form.phone} connector="to" busy={busy} />
    </>
  );
}
