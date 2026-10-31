import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader, Empty } from '../../components/Loader';
import { formatNaira, formatDate } from '../../config';
import TransactionDetailModal from '../../components/TransactionDetailModal';

function StatusBadge({ label }) {
  const cls = label === 'successful' ? 'badge-success'
    : label === 'failed' ? 'badge-danger'
    : label === 'refunded' || label === 'processing' ? 'badge-warn' : 'badge-muted';
  return <span className={`badge ${cls}`}>{label}</span>;
}

const FILTERS = [
  ['', 'All'], ['0', 'Successful'], ['5', 'Processing'], ['2', 'Failed'], ['1', 'Refunded'],
];

export default function AdminTransactions() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, totalPages: 1, total: 0 });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [detailRef, setDetailRef] = useState(null);   // transref currently open
  const [detailSeed, setDetailSeed] = useState(null);  // list row to seed the modal

  const load = useCallback(() => {
    setLoading(true);
    const params = { page, limit: 20 };
    if (status !== '') params.status = status;
    if (search) params.search = search;
    api.get('/admin/transactions', params)
      .then((r) => {
        setRows(r.data.transactions || []);
        setPagination(r.data.pagination || { page: 1, totalPages: 1, total: 0 });
      })
      .catch(() => toast.error('Could not load transactions'))
      .finally(() => setLoading(false));
  }, [page, status, search, toast]);

  useEffect(() => { load(); }, [load]);

  const openDetail = (t) => { setDetailSeed(t); setDetailRef(t.transref); };
  const closeDetail = () => { setDetailRef(null); setDetailSeed(null); };

  return (
    <>
      <h1 className="page-title">Transactions</h1>
      <p className="page-sub">All transactions across every user. Open one to view its detail and change its status.</p>

      <div className="row between wrap mb-2" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          {FILTERS.map(([v, l]) => (
            <button key={v} className={`btn btn-sm ${status === v ? '' : 'btn-soft'}`}
              onClick={() => { setStatus(v); setPage(1); }}>{l}</button>
          ))}
        </div>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search ref / service / email / phone…"
          value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
      </div>

      <div className="card">
        {loading ? <Loader /> : rows.length === 0 ? (
          <Empty title="No transactions" message="Nothing matches this filter." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Ref</th><th>User</th><th>Service</th><th>Amount</th><th>Old → New</th><th>Status</th><th>Date</th></tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.transref} style={{ cursor: 'pointer' }} onClick={() => openDetail(t)}>
                    <td className="small muted" style={{ fontFamily: 'monospace' }}>{t.transref}</td>
                    <td className="small">
                      <div className="strong">{t.userName || `#${t.sId}`}</div>
                      {t.userEmail && <div className="muted" style={{ fontSize: 11 }}>{t.userEmail}</div>}
                    </td>
                    <td>
                      <div className="strong">{t.servicename}</div>
                      <div className="small muted" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.servicedesc}</div>
                    </td>
                    <td className="strong">{formatNaira(t.amount)}</td>
                    <td className="small muted" style={{ whiteSpace: 'nowrap' }}>{formatNaira(t.oldbal)} → {formatNaira(t.newbal)}</td>
                    <td><StatusBadge label={t.statusLabel} /></td>
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

      {detailRef && (
        <TransactionDetailModal
          transref={detailRef}
          initial={detailSeed}
          onClose={closeDetail}
          onChanged={load}
        />
      )}
    </>
  );
}

