import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useToast } from '../context/ToastContext';
import { Loader, Empty } from '../components/Loader';
import { Modal } from '../components/Modal';
import { formatNaira, formatDate, brandText } from '../config';
import { IcDownload } from '../components/Icons';
import { downloadReceiptImage } from '../utils/receiptImage';

function StatusBadge({ label }) {
  const cls = label === 'successful' ? 'badge-success'
    : label === 'failed' ? 'badge-danger'
    : label === 'refunded' ? 'badge-warn'
    : label === 'processing' ? 'badge-warn' : 'badge-muted';
  return <span className={`badge ${cls}`}>{label}</span>;
}

const FILTERS = [
  ['', 'All'], ['successful', 'Successful'], ['processing', 'Processing'],
  ['failed', 'Failed'], ['refunded', 'Refunded'],
];

export default function Transactions() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit: 15 };
    if (status) params.status = status;
    api.get('/transactions', params)
      .then((r) => {
        setRows(r.data.transactions || []);
        setPagination(r.data.pagination || { page: 1, totalPages: 1, total: 0 });
      })
      .catch(() => toast.error('Could not load transactions'))
      .finally(() => setLoading(false));
  }, [page, status, toast]);

  useEffect(() => { load(); }, [load]);

  const openDetail = async (ref) => {
    try {
      // encodeURIComponent: legacy refund/debit audit rows were written with
      // '/' in the ref (REFUND/<ref>/<ms>), which would split the URL path and
      // 404 the lookup. Encoding keeps it a single path segment.
      const r = await api.get(`/transactions/${encodeURIComponent(ref)}`);
      setDetail(r.data);
    } catch (err) {
      toast.error('Could not load transaction', err.message);
    }
  };

  const downloadReceipt = async (ref, format = 'pdf') => {
    setDownloading(true);
    try {
      if (format === 'image') {
        await downloadReceiptImage({ txn: detail, filename: `receipt-${ref}.png` });
      } else {
        await api.download(`/transactions/${encodeURIComponent(ref)}/receipt`, `receipt-${ref}.pdf`);
      }
    } catch (err) {
      toast.error('Could not download receipt', err.message);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <h1 className="page-title">Transactions</h1>
      <p className="page-sub">Every purchase and wallet movement on your account.</p>

      <div className="row wrap mb-2" style={{ gap: 8 }}>
        {FILTERS.map(([v, l]) => (
          <button key={v} type="button"
            className={`btn btn-sm ${status === v ? '' : 'btn-soft'}`}
            onClick={() => { setStatus(v); setPage(1); }}>{l}</button>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <Loader />
        ) : rows.length === 0 ? (
          <Empty title="No transactions" message="Nothing matches this filter yet." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Service</th><th>Amount</th><th>Status</th><th>Balance after</th><th>Date</th></tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.transref} style={{ cursor: 'pointer' }} onClick={() => openDetail(t.transref)}>
                    <td>
                      <div className="strong">{t.servicename}</div>
                      <div className="small muted" style={{ maxWidth: 340, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brandText(t.servicedesc)}</div>
                    </td>
                    <td className="strong">{formatNaira(t.amount)}</td>
                    <td><StatusBadge label={t.statusLabel} /></td>
                    <td className="small muted">{formatNaira(t.newbal)}</td>
                    <td className="small muted">{formatDate(t.date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pagination.totalPages > 1 && (
          <div className="row between mt-2">
            <span className="small muted">Page {pagination.page} of {pagination.totalPages} · {pagination.total} total</span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn-soft btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
              <button className="btn btn-soft btn-sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>

      <Modal open={!!detail} onClose={() => setDetail(null)} title="Transaction detail">
        {detail && (
          <>
            <div className="kv">
              <div className="kv-row"><span className="muted small">Service</span><span className="strong small">{detail.servicename}</span></div>
              <div className="kv-row"><span className="muted small">Description</span><span className="strong small">{brandText(detail.servicedesc)}</span></div>
              <div className="kv-row"><span className="muted small">Amount</span><span className="strong small">{formatNaira(detail.amount)}</span></div>
              <div className="kv-row"><span className="muted small">Status</span><StatusBadge label={detail.statusLabel} /></div>
              <div className="kv-row"><span className="muted small">Reference</span><span className="strong small">{detail.transref}</span></div>
              <div className="kv-row"><span className="muted small">Balance before</span><span className="strong small">{formatNaira(detail.oldbal)}</span></div>
              <div className="kv-row"><span className="muted small">Balance after</span><span className="strong small">{formatNaira(detail.newbal)}</span></div>
              <div className="kv-row"><span className="muted small">Date</span><span className="strong small">{formatDate(detail.date)}</span></div>
            </div>
            <div className="row" style={{ gap: 10, marginTop: 20 }}>
              <button className="btn btn-block" style={{ marginTop: 0 }} disabled={downloading}
                onClick={() => downloadReceipt(detail.transref, 'pdf')}>
                <IcDownload size={18} /> {downloading ? 'Preparing…' : 'Download Pdf'}
              </button>
              <button className="btn btn-soft btn-block" style={{ marginTop: 0 }} disabled={downloading}
                onClick={() => downloadReceipt(detail.transref, 'image')}>
                <IcDownload size={18} /> Image
              </button>
            </div>
            <p className="small muted center mt-1" style={{ marginTop: 8 }}>
              The receipt hides your wallet balance — safe to share as proof of this transaction.
            </p>
          </>
        )}
      </Modal>
    </>
  );
}
