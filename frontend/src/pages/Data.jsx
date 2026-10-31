import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { PinModal } from '../components/PinModal';
import { Loader, Empty } from '../components/Loader';
import { formatNaira, networkLabel, validatePhone } from '../config';
import { usePurchaseRef } from '../hooks/usePurchaseRef';
import { IcData, IcCheck, IcShield, IcRefresh } from '../components/Icons';

// The three data groups, in display order. `flag` is the per-network status
// field that decides whether the group is offered at all (admin toggle).
const PLAN_TYPES = [
  { id: 'SME', label: 'SME', flag: 'smeStatus' },
  { id: 'Gifting', label: 'Gifting', flag: 'giftingStatus' },
  { id: 'Corporate', label: 'Corporate', flag: 'corporateStatus' },
];

// Map a stability value to a badge style + human label.
const STABILITY = {
  stable: { cls: 'badge-success', text: 'Stable' },
  unstable: { cls: 'badge-warn', text: 'Unstable' },
  down: { cls: 'badge-danger', text: 'Down' },
};

export default function Data() {
  const { updateUser } = useAuth();
  const toast = useToast();
  const [networks, setNetworks] = useState([]);
  const [network, setNetwork] = useState('');
  const [planType, setPlanType] = useState('');
  const [plans, setPlans] = useState([]);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [ported, setPorted] = useState(false);
  const [selected, setSelected] = useState(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Stable across retries of this one purchase — see usePurchaseRef.
  const purchaseRef = usePurchaseRef('DAT');
  const [done, setDone] = useState(null);

  const loadNetworks = () => {
    // network-status carries the admin On/Off flags, the T2 display label,
    // AND the live stability signal — one call feeds the whole form.
    return api.get('/catalog/network-status')
      .then((r) => setNetworks(r.data || []))
      .catch(() => toast.error('Could not load networks'));
  };

  useEffect(() => {
    loadNetworks().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The currently selected network object (holds status flags + stability).
  const selectedNet = useMemo(
    () => networks.find((n) => String(n.nId) === String(network)) || null,
    [networks, network]
  );

  // Which plan-type buttons to show: only groups the admin has left On for
  // this network. A disabled group is hidden entirely (button + its plans).
  const availableTypes = useMemo(() => {
    if (!selectedNet) return [];
    return PLAN_TYPES.filter((t) => selectedNet[t.flag] === 'On');
  }, [selectedNet]);

  // When network changes: reset selection, load its plans, default the type.
  useEffect(() => {
    setSelected(null);
    setPlanType('');
    if (!network) { setPlans([]); return; }
    setLoadingPlans(true);
    api.get('/catalog/dataplans', { network })
      .then((r) => setPlans(r.data || []))
      .catch(() => toast.error('Could not load data plans'))
      .finally(() => setLoadingPlans(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [network]);

  // Default the plan type to the first available group once we know them.
  useEffect(() => {
    if (availableTypes.length && !planType) setPlanType(availableTypes[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableTypes]);

  // Plans shown = plans for this network, filtered to the chosen type, and
  // defensively excluding any type the admin has switched Off.
  const visiblePlans = useMemo(() => {
    const enabled = new Set(availableTypes.map((t) => t.id));
    return plans.filter((p) => enabled.has(p.type) && (!planType || p.type === planType));
  }, [plans, planType, availableTypes]);

  // Realtime phone check against the selected network's DB name.
  const phoneCheck = useMemo(
    () => validatePhone(phone, selectedNet?.network),
    [phone, selectedNet]
  );

  const stability = selectedNet ? STABILITY[selectedNet.stability] : null;

  const openPin = () => {
    if (!selected) return toast.error('Select a data plan.');
    if (!/^0\d{10}$/.test(phone)) return toast.error('Enter a valid 11-digit phone number.');
    // Block a clear network mismatch unless the user marks the line as ported.
    if (!ported && phoneCheck.complete && phoneCheck.detected && !phoneCheck.valid) {
      return toast.error(phoneCheck.msg || 'Phone number does not match the selected network.');
    }
    setPinOpen(true);
  };

  const submit = async (pin) => {
    setBusy(true);
    try {
      const res = await api.post('/data/purchase', {
        network: Number(network),
        phone,
        dataplan: selected.pId,
        transref: purchaseRef.value(),
        pin,
        ported_number: ported,
      });
      setPinOpen(false);
      setDone(res.data || {});
      if (res.data?.newBalance != null) updateUser({ wallet: res.data.newBalance });
      toast.success('Data delivered!', `${selected.name} to ${phone}`);
      purchaseRef.reset(); // this purchase is done — the next one starts fresh
      setPhone('');
      setSelected(null);
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
  if (phone) {
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
      <h1 className="page-title">Buy Data</h1>
      <p className="page-sub">Affordable data bundles on every network.</p>

      <div className="card mb-2">
        <div className="grid grid-2">
          <div className="field" style={{ margin: 0 }}>
            <label className="label">Network</label>
            <select className="select" value={network} onChange={(e) => setNetwork(e.target.value)}>
              <option value="">Select network…</option>
              {networks
                .filter((n) => n.networkStatus === 'On')
                .map((n) => <option key={n.nId} value={n.nId}>{n.label || networkLabel(n.network)}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0 }}>
            <label className="label">Phone number</label>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="08012345678" inputMode="numeric" maxLength={11} />
            <div className="row between wrap" style={{ marginTop: 4, gap: 8 }}>
              <span>{phoneHint}</span>
              <label className="small muted" style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={ported} onChange={(e) => setPorted(e.target.checked)} />
                Number is ported
              </label>
            </div>
          </div>
        </div>

        {/* Network stability indicator — shown once a network is chosen. */}
        {selectedNet && stability && (
          <div className="row between wrap" style={{ marginTop: 12, gap: 8 }}>
            <span className="row" style={{ gap: 8, alignItems: 'center' }}>
              <IcShield size={16} />
              <span className="small muted">Network status</span>
              <span className={`badge ${stability.cls}`}>{stability.text}</span>
              {selectedNet.successRate != null && selectedNet.sample >= 4 && (
                <span className="small muted">{selectedNet.successRate}% success recently</span>
              )}
            </span>
            <button className="btn-soft small" onClick={loadNetworks} title="Refresh network status">
              <IcRefresh size={14} /> Refresh
            </button>
          </div>
        )}
      </div>

      {/* Plan-type selector (SME / Gifting / Corporate) — admin-disabled
          groups are hidden entirely. */}
      {network && availableTypes.length > 0 && (
        <div className="seg mb-2" role="tablist">
          {availableTypes.map((t) => (
            <button key={t.id}
              className={planType === t.id ? 'active' : ''}
              onClick={() => { setPlanType(t.id); setSelected(null); }}>
              {(selectedNet?.label || '')} {t.label}
            </button>
          ))}
        </div>
      )}

      {!network ? (
        <Empty title="Select a network" message="Choose a network above to see available data plans." />
      ) : loadingPlans ? (
        <Loader full />
      ) : availableTypes.length === 0 ? (
        <Empty title="Temporarily unavailable" message="No data groups are open for this network right now." />
      ) : visiblePlans.length === 0 ? (
        <Empty title="No plans available" message="No plans in this group yet. Try another plan type." />
      ) : (
        <div className="grid grid-3">
          {visiblePlans.map((p) => (
            <div key={p.pId}
              className="card"
              style={{ cursor: 'pointer', borderColor: selected?.pId === p.pId ? 'var(--brand)' : 'var(--border)', borderWidth: 2 }}
              onClick={() => setSelected(p)}>
              <div className="row between">
                <span className="badge badge-muted">{p.type}</span>
                {selected?.pId === p.pId && <span className="text-brand"><IcCheck size={18} /></span>}
              </div>
              <div className="strong mt-1" style={{ fontSize: 18 }}>{p.name}</div>
              <div className="small muted">{p.day} day{p.day === '1' ? '' : 's'}</div>
              <div className="text-brand strong mt-1" style={{ fontSize: 20 }}>{formatNaira(p.price)}</div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className="card mt-2 row between wrap">
          <div>
            <div className="small muted">Selected</div>
            <div className="strong">{selected.name} — {formatNaira(selected.price)}</div>
          </div>
          <button className="btn" onClick={openPin}><IcData size={18} /> Buy now</button>
        </div>
      )}

      {done && (
        <div className="card mt-2 center">
          <h3 className="text-success">✓ Data delivered</h3>
          <p className="muted">{formatNaira(done.amountPaid)} — {done.plan || selected?.name}</p>
          {done.newBalance != null && <p className="small">New balance: <span className="strong">{formatNaira(done.newBalance)}</span></p>}
        </div>
      )}

      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onConfirm={submit}
        action={`purchase ${selected ? selected.name : 'Data'}`}
        amount={selected ? formatNaira(selected.price) : ''} target={phone} connector="to" busy={busy} />
    </>
  );
}
