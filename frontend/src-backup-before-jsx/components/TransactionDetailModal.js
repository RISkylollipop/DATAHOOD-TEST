// ============================================================
//  TransactionDetailModal — shared admin transaction detail card
// ------------------------------------------------------------
//  Used by both the Transactions page and the Overview dashboard so
//  an admin can open a transaction's full detail (old balance, new
//  balance, status, and the performing user + email) and change its
//  status from one place. Mirrors the legacy transaction-details.php
//  page: 4 actions — Successful, Successful & Debit, Failed,
//  Failed & Refund.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/ToastContext';
import { Modal } from './Modal';
import { formatNaira, formatDate } from '../config';

function StatusBadge({ label }) {
  const cls = label === 'successful' ? 'badge-success'
    : label === 'failed' ? 'badge-danger'
    : label === 'refunded' || label === 'processing' ? 'badge-warn' : 'badge-muted';
  return <span className={`badge ${cls}`}>{label || 'unknown'}</span>;
}

// The 4 legacy admin actions. `moves` flags the two that move money and
// therefore need an explicit confirm step.
const ACTIONS = [
  { key: 'success', label: 'Successful', cls: '', moves: false },
  { key: 'success_debit', label: 'Successful & Debit', cls: 'btn-soft', moves: true, verb: 'debit' },
  { key: 'failed', label: 'Failed', cls: 'btn-soft', moves: false },
  { key: 'failed_refund', label: 'Failed & Refund', cls: 'btn-danger', moves: true, verb: 'refund' },
];

export default function TransactionDetailModal({ transref, initial = null, onClose, onChanged }) {
  const toast = useToast();
  const [txn, setTxn] = useState(initial);
  const [loading, setLoading] = useState(!initial);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null); // pending money action awaiting confirm

  const ref = transref || initial?.transref;

  // Always refetch the authoritative detail on open (status/balances may have
  // changed since the list was loaded, or we were opened with just a ref).
  const loadDetail = useCallback(() => {
    if (!ref) return;
    setLoading(!initial);
    api.get(`/admin/transactions/${encodeURIComponent(ref)}`)
      .then((r) => setTxn(r.data))
      .catch(() => { if (!initial) toast.error('Could not load transaction'); })
      .finally(() => setLoading(false));
  }, [ref, initial, toast]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const apply = async (action) => {
    setBusy(true);
    try {
      const r = await api.patch(`/admin/transactions/${encodeURIComponent(ref)}/status`, { action });
      toast.success(r.msg || 'Transaction updated');
      if (r.data) setTxn(r.data);
      setConfirm(null);
      onChanged && onChanged();
    } catch (err) {
      toast.error('Update failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  const onAction = (a) => {
    if (a.moves) setConfirm(a);   // money movement → confirm first
    else apply(a.key);            // label-only → apply immediately
  };

  const amount = Number(txn?.amount || 0);

  return (
    <Modal open onClose={() => !busy && onClose()} title="Transaction detail" maxWidth={520}>
      {loading || !txn ? (
        <div className="center" style={{ padding: 24 }}><span className="spinner" /></div>
      ) : (
        <>
          <div className="kv">
            <div className="kv-row"><span className="muted small">Reference</span><span className="strong small" style={{ fontFamily: 'monospace' }}>{txn.transref}</span></div>
            <div className="kv-row"><span className="muted small">Service</span><span className="strong small">{txn.servicename}</span></div>
            <div className="kv-row"><span className="muted small">Description</span><span className="strong small" style={{ textAlign: 'right', maxWidth: 300 }}>{txn.servicedesc}</span></div>
            <div className="kv-row"><span className="muted small">Amount</span><span className="strong small">{formatNaira(amount)}</span></div>
            <div className="kv-row"><span className="muted small">Old balance</span><span className="strong small">{formatNaira(txn.oldbal)}</span></div>
            <div className="kv-row"><span className="muted small">New balance</span><span className="strong small">{formatNaira(txn.newbal)}</span></div>
            <div className="kv-row"><span className="muted small">Status</span><StatusBadge label={txn.statusLabel} /></div>
            <div className="kv-row"><span className="muted small">Date</span><span className="strong small">{formatDate(txn.date)}</span></div>
          </div>

          {/* Performed by User : Email */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 12, marginTop: 12 }}>
            <div className="muted small" style={{ marginBottom: 4 }}>Performed by User</div>
            <div className="strong">{txn.userName || `User #${txn.sId}`}</div>
            {txn.userEmail && <div className="small muted">{txn.userEmail}</div>}
            {txn.userPhone && <div className="small muted">{txn.userPhone}</div>}
          </div>

          {/* Change status */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }}>
            {confirm ? (
              <div className="card" style={{ background: 'var(--surface-2, transparent)', padding: 12 }}>
                <div className="small" style={{ marginBottom: 10 }}>
                  {confirm.verb === 'debit'
                    ? <>This will mark the transaction <b>successful</b> and <b>debit {formatNaira(amount)}</b> from {txn.userName || 'the user'}'s main wallet.</>
                    : <>This will mark the transaction <b>failed</b> and <b>refund {formatNaira(amount)}</b> to {txn.userName || 'the user'}'s main wallet.</>}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className={`btn btn-sm ${confirm.verb === 'refund' ? 'btn-danger' : ''}`} disabled={busy} onClick={() => apply(confirm.key)}>
                    {busy ? <span className="spinner" /> : `Confirm ${confirm.label}`}
                  </button>
                  <button className="btn btn-soft btn-sm" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="strong small" style={{ marginBottom: 8 }}>Change transaction status</div>
                <div className="row wrap" style={{ gap: 8 }}>
                  {ACTIONS.map((a) => (
                    <button key={a.key} className={`btn btn-sm ${a.cls}`} disabled={busy} onClick={() => onAction(a)}>
                      {a.label}
                    </button>
                  ))}
                </div>
                <p className="muted small" style={{ marginTop: 8, marginBottom: 0 }}>
                  “Successful &amp; Debit” takes the amount from the user; “Failed &amp; Refund” returns it. Each is applied once per transaction.
                </p>
              </>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
