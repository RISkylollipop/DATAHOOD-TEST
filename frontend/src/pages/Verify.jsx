import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { PinModal } from '../components/PinModal';
import { Loader, Empty } from '../components/Loader';
import { formatNaira, formatDate } from '../config';
import { usePurchaseRef } from '../hooks/usePurchaseRef';
import { IcShield, IcDownload } from '../components/Icons';

export default function Verify() {
  const { updateUser } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [types, setTypes] = useState([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [pinOpen, setPinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState([]);
  // Stable across retries of this one check — see usePurchaseRef.
  const purchaseRef = usePurchaseRef('VER');

  const loadHistory = () => {
    api.get('/verify/history', { limit: 8 })
      .then((r) => setHistory(r.data.records || []))
      .catch(() => {});
  };

  useEffect(() => {
    api.get('/verify/types')
      .then((r) => {
        setTypes(r.data.types || []);
        setConfigured(r.data.configured);
      })
      .catch(() => toast.error('Could not load verification types'))
      .finally(() => setLoading(false));
    loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = (t) => { setSelected(t); setQuery(''); setResult(null); };

  const openPin = () => {
    if (!selected) return toast.error('Select an identity type.');
    if (!query.trim()) return toast.error(`Enter the ${selected.label} number.`);
    if (selected.expectedDigits && !new RegExp(`^\\d{${selected.expectedDigits}}$`).test(query.trim())) {
      return toast.error(`${selected.label} must be ${selected.expectedDigits} digits.`);
    }
    setPinOpen(true);
  };

  const submit = async (pin) => {
    setBusy(true);
    try {
      const res = await api.post('/verify', {
        type: selected.type, query: query.trim(), transref: purchaseRef.value(), pin,
      });
      setPinOpen(false);
      setResult(res.data);
      if (res.data?.newBalance != null) updateUser({ wallet: res.data.newBalance });
      toast.success('Verification successful', res.data?.result?.fullName || '');
      purchaseRef.reset(); // this check is done — the next one starts fresh
      loadHistory();
    } catch (err) {
      toast.error('Verification failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  const downloadSlip = async (vId) => {
    try {
      await api.download(`/verify/${vId}/slip`, `verification-${vId}.pdf`);
    } catch (err) {
      toast.error('Could not download slip', err.message);
    }
  };

  if (loading) return <Loader full />;

  return (
    <>
      <h1 className="page-title">Identity Verification</h1>
      <p className="page-sub">Verify NIN, BVN, passport, driver's license, voter's card and phone.</p>

      {!configured && (
        <div className="card mb-2" style={{ borderColor: 'var(--warn)', background: 'var(--warn-soft)' }}>
          <div className="strong">Verification is not yet configured</div>
          <div className="small muted">An administrator needs to connect a verification provider before this service is available.</div>
        </div>
      )}

      <div className="grid grid-2">
        <div className="card card-pad-lg">
          <label className="label">Identity type</label>
          <div className="tiles mb-2">
            {types.map((t) => (
              <button key={t.type} type="button"
                className="tile" disabled={!t.available}
                style={{
                  borderColor: selected?.type === t.type ? 'var(--brand)' : 'var(--border)',
                  borderWidth: 2, opacity: t.available ? 1 : 0.45, cursor: t.available ? 'pointer' : 'not-allowed',
                }}
                onClick={() => t.available && pick(t)}>
                <div className="ic"><IcShield size={20} /></div>
                <div className="t">{t.label}</div>
                {t.price != null && <div className="small muted">{formatNaira(t.price)}</div>}
              </button>
            ))}
          </div>

          {selected && (
            <>
              <div className="field">
                <label className="label">{selected.label} number</label>
                <input className="input" value={query} onChange={(e) => setQuery(e.target.value)}
                  placeholder={selected.expectedDigits ? `${selected.expectedDigits}-digit number` : `Enter ${selected.label}`}
                  inputMode="numeric" />
              </div>
              <div className="row between mt-1">
                <span className="muted small">Fee: <span className="strong text-brand">{formatNaira(selected.price)}</span></span>
                <button className="btn" onClick={openPin}><IcShield size={18} /> Verify</button>
              </div>
            </>
          )}
        </div>

        <div className="card card-pad-lg">
          {result ? (
            <>
              <h3 className="text-success">✓ {result.result?.fullName || 'Verified'}</h3>
              <div className="kv mt-1">
                {Object.entries(result.result || {}).filter(([k]) => k !== 'photoBase64').map(([k, v]) => (
                  <div className="kv-row" key={k}>
                    <span className="muted small" style={{ textTransform: 'capitalize' }}>{k.replace(/([A-Z])/g, ' $1')}</span>
                    <span className="strong small">{String(v)}</span>
                  </div>
                ))}
              </div>
              <div className="row mt-2" style={{ gap: 10 }}>
                <button className="btn" onClick={() => downloadSlip(result.vId)}><IcDownload size={18} /> Download slip</button>
                <button className="btn btn-ghost" onClick={() => navigate(`/app/verify/${result.vId}`)}>View details</button>
              </div>
            </>
          ) : (
            <>
              <h3>About verification</h3>
              <p className="muted small">Select an identity type, enter the number and confirm with your PIN. On success you receive a verified PDF slip. Failed checks are automatically refunded.</p>
            </>
          )}
        </div>
      </div>

      <div className="card mt-2">
        <div className="row between mb-2">
          <h3 className="mt-0" style={{ marginBottom: 0 }}>Recent verifications</h3>
        </div>
        {history.length === 0 ? (
          <Empty title="No verifications yet" message="Your verification history will appear here." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Type</th><th>Query</th><th>Name</th><th>Amount</th><th>Date</th><th></th></tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.vId} style={{ cursor: 'pointer' }} onClick={() => navigate(`/app/verify/${h.vId}`)}>
                    <td><span className="badge badge-muted">{h.label}</span></td>
                    <td className="small">{h.query}</td>
                    <td className="small strong">{h.fullName || '—'}</td>
                    <td className="strong">{formatNaira(h.amount)}</td>
                    <td className="small muted">{formatDate(h.date)}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); downloadSlip(h.vId); }}>
                        <IcDownload size={15} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PinModal open={pinOpen} onClose={() => setPinOpen(false)} onConfirm={submit}
        action={`run a ${selected ? selected.label : ''} check`.replace(/\s+/g, ' ')}
        amount={selected ? formatNaira(selected.price) : ''} target={query.trim()} connector="on" busy={busy} />
    </>
  );
}
