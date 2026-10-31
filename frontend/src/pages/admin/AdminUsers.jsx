import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader, Empty } from '../../components/Loader';
import { Modal } from '../../components/Modal';
import { formatNaira, formatDate, gatewayLabel } from '../../config';
import { IcUsers, IcCopy, IcRefresh, IcTrash, IcWallet } from '../../components/Icons';

const TYPE_OPTS = [
  { v: 1, label: 'User' },
  { v: 2, label: 'Agent' },
  { v: 3, label: 'Vendor' },
];
const STATUS_OPTS = [
  { v: 0, label: 'Active' },
  { v: 1, label: 'Blocked' },
  { v: 2, label: 'Pending account verification' },
  { v: 3, label: 'Pending email verification' },
];

function StatusBadge({ status, label }) {
  const cls = status === 0 ? 'badge-success' : status === 1 ? 'badge-danger' : 'badge-warn';
  return <span className={`badge ${cls}`}>{label}</span>;
}

export default function AdminUsers() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1, limit: 25 });
  const [loading, setLoading] = useState(true);

  // filters
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState(''); // debounced/committed search
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);

  // detail + action dialogs
  const [detail, setDetail] = useState(null);       // full user object
  const [detailLoading, setDetailLoading] = useState(false);
  const [action, setAction] = useState(null);       // { kind, ...form }
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/admin/users', {
      page, limit: 25,
      ...(type !== '' ? { type } : {}),
      ...(status !== '' ? { status } : {}),
      ...(query ? { search: query } : {}),
    })
      .then((r) => { setRows(r.data.users || []); setMeta(r.data); })
      .catch(() => toast.error('Could not load users'))
      .finally(() => setLoading(false));
  }, [page, type, status, query, toast]);

  useEffect(() => { load(); }, [load]);

  const runSearch = (e) => { e.preventDefault(); setPage(1); setQuery(search.trim()); };
  const resetFilters = () => { setSearch(''); setQuery(''); setType(''); setStatus(''); setPage(1); };

  const openDetail = async (id) => {
    setDetailLoading(true);
    setDetail({ sId: id, __loading: true });
    try {
      const r = await api.get(`/admin/users/${id}`);
      setDetail(r.data);
    } catch (err) {
      toast.error('Could not load user', err.message);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const refreshDetail = async () => {
    if (!detail?.sId) return;
    try { const r = await api.get(`/admin/users/${detail.sId}`); setDetail(r.data); } catch { /* noop */ }
  };

  const copy = (text, label) => {
    navigator.clipboard?.writeText(String(text)).then(
      () => toast.success('Copied', label),
      () => toast.error('Could not copy'),
    );
  };

  // ---- actions ----
  const doFund = async () => {
    const amount = Number(action.amount);
    if (!(amount > 0)) return toast.error('Enter a valid amount.');
    setBusy(true);
    try {
      const path = action.kind === 'credit' ? 'credit' : 'debit';
      await api.post(`/admin/users/${detail.sId}/${path}`, { amount, wallet: action.wallet, note: action.note });
      toast.success(`${action.kind === 'credit' ? 'Credited' : 'Debited'} ${action.wallet} wallet`, formatNaira(amount));
      setAction(null); await refreshDetail(); load();
    } catch (err) { toast.error('Failed', err.message); } finally { setBusy(false); }
  };

  const doEdit = async () => {
    setBusy(true);
    try {
      await api.put(`/admin/users/${detail.sId}`, {
        firstName: action.firstName, lastName: action.lastName, email: action.email,
        phone: action.phone, state: action.state, type: Number(action.type),
      });
      toast.success('User updated');
      setAction(null); await refreshDetail(); load();
    } catch (err) { toast.error('Update failed', err.message); } finally { setBusy(false); }
  };

  const doResetPassword = async () => {
    if ((action.password || '').length < 6) return toast.error('Password must be at least 6 characters.');
    setBusy(true);
    try {
      await api.post(`/admin/users/${detail.sId}/reset-password`, { password: action.password });
      toast.success('Password reset', 'The user must log in again.');
      setAction(null);
    } catch (err) { toast.error('Failed', err.message); } finally { setBusy(false); }
  };

  const doResetApiKey = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/admin/users/${detail.sId}/reset-apikey`);
      toast.success('API key regenerated');
      setDetail((d) => ({ ...d, apiKey: r.data?.apiKey || d.apiKey }));
      setAction(null);
    } catch (err) { toast.error('Failed', err.message); } finally { setBusy(false); }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await api.del(`/admin/users/${detail.sId}`);
      toast.success('Account deleted');
      setAction(null); setDetail(null); load();
    } catch (err) { toast.error('Delete failed', err.message); } finally { setBusy(false); }
  };

  const changeStatus = async (newStatus) => {
    try {
      await api.patch(`/admin/users/${detail.sId}/status`, { status: Number(newStatus) });
      toast.success('Status updated');
      setDetail((d) => ({ ...d, status: Number(newStatus), statusLabel: STATUS_OPTS.find((s) => s.v === Number(newStatus))?.label }));
      load();
    } catch (err) { toast.error('Failed', err.message); }
  };

  const changeType = async (newType) => {
    try {
      await api.patch(`/admin/users/${detail.sId}/type`, { type: Number(newType) });
      toast.success('Account type updated');
      setDetail((d) => ({ ...d, type: Number(newType), typeLabel: TYPE_OPTS.find((tp) => tp.v === Number(newType))?.label }));
      load();
    } catch (err) { toast.error('Failed', err.message); }
  };

  return (
    <>
      <div className="row between wrap mb-2">
        <div>
          <h1 className="page-title" style={{ marginBottom: 2 }}>Users</h1>
          <p className="page-sub" style={{ margin: 0 }}>Manage accounts, fund wallets, and control access.</p>
        </div>
        <div className="badge badge-muted">{meta.total} total</div>
      </div>

      {/* Filters */}
      <div className="card mb-2">
        <form className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }} onSubmit={runSearch}>
          <div className="field" style={{ margin: 0, flex: '1 1 220px' }}>
            <label className="label">Search</label>
            <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, phone or email" />
          </div>
          <div className="field" style={{ margin: 0, minWidth: 140 }}>
            <label className="label">Type</label>
            <select className="select" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
              <option value="">All types</option>
              {TYPE_OPTS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ margin: 0, minWidth: 180 }}>
            <label className="label">Status</label>
            <select className="select" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">All statuses</option>
              {STATUS_OPTS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
            </select>
          </div>
          <button className="btn" type="submit">Search</button>
          <button className="btn btn-soft" type="button" onClick={resetFilters}>Reset</button>
        </form>
      </div>

      {/* Table */}
      <div className="card">
        {loading ? <Loader /> : rows.length === 0 ? (
          <Empty title="No users found" message="Try adjusting your search or filters." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th><th>Phone</th><th>Wallet</th><th>Bonus</th>
                    <th>Type</th><th>Status</th><th>Registered</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.sId}>
                      <td>
                        <div className="strong">{u.name || '—'}</div>
                        <div className="small muted">{u.email || 'no email'}</div>
                      </td>
                      <td className="small">{u.phone}</td>
                      <td className="strong">{formatNaira(u.wallet)}</td>
                      <td className="small muted">{formatNaira(u.refWallet)}</td>
                      <td className="small">{u.typeLabel}</td>
                      <td><StatusBadge status={u.status} label={u.statusLabel} /></td>
                      <td className="small muted">{formatDate(u.regDate)}</td>
                      <td><button className="btn btn-soft btn-sm" onClick={() => openDetail(u.sId)}>Manage</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Pagination */}
            <div className="row between wrap mt-2" style={{ alignItems: 'center' }}>
              <div className="small muted">Page {meta.page} of {meta.pages}</div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn btn-soft btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</button>
                <button className="btn btn-soft btn-sm" disabled={page >= meta.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Detail modal */}
      <Modal open={!!detail} onClose={() => !busy && setDetail(null)} title="Manage user" maxWidth={640}>
        {detailLoading || detail?.__loading ? <Loader /> : detail && (
          <div>
            <div className="row between wrap" style={{ alignItems: 'flex-start', gap: 8 }}>
              <div>
                <div className="strong" style={{ fontSize: 18 }}>{detail.name}</div>
                <div className="small muted">{detail.phone} · {detail.email || 'no email'} · {detail.state}</div>
              </div>
              <StatusBadge status={detail.status} label={detail.statusLabel} />
            </div>

            {/* Balances */}
            <div className="grid grid-2 mt-2">
              <div className="card stat" style={{ background: 'var(--surface-2)' }}>
                <span className="k">Main wallet</span>
                <span className="v">{formatNaira(detail.wallet)}</span>
              </div>
              <div className="card stat" style={{ background: 'var(--surface-2)' }}>
                <span className="k">Bonus / referral</span>
                <span className="v">{formatNaira(detail.refWallet)}</span>
              </div>
            </div>

            {/* Meta grid */}
            <div className="kv mt-2">
              <div className="kv-row"><span className="muted small">Account type</span>
                <select className="select" style={{ maxWidth: 160 }} value={detail.type} onChange={(e) => changeType(e.target.value)}>
                  {TYPE_OPTS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
                </select>
              </div>
              <div className="kv-row"><span className="muted small">Account status</span>
                <select className="select" style={{ maxWidth: 260 }} value={detail.status} onChange={(e) => changeStatus(e.target.value)}>
                  {STATUS_OPTS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
                </select>
              </div>
              <div className="kv-row"><span className="muted small">Registered</span><span className="small strong">{formatDate(detail.regDate)}</span></div>
              <div className="kv-row"><span className="muted small">Last activity</span><span className="small strong">{detail.lastActivity ? formatDate(detail.lastActivity) : '—'}</span></div>
              <div className="kv-row"><span className="muted small">Referred by</span>
                <span className="small strong">{detail.referredBy ? `${detail.referredBy.name} (${detail.referredBy.phone})` : '—'}</span>
              </div>
              <div className="kv-row"><span className="muted small">Referrals made</span><span className="small strong">{detail.referralCount ?? 0}</span></div>
              <div className="kv-row"><span className="muted small">API key</span>
                <span className="small strong" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{detail.apiKey ? `${String(detail.apiKey).slice(0, 10)}…${String(detail.apiKey).slice(-6)}` : '—'}</code>
                  {detail.apiKey && <button className="btn btn-ghost btn-sm" onClick={() => copy(detail.apiKey, 'API key')}><IcCopy size={14} /></button>}
                </span>
              </div>
            </div>

            {/* Virtual accounts */}
            {detail.virtualAccounts?.length > 0 && (
              <div className="mt-2">
                <div className="label">Virtual accounts</div>
                {detail.virtualAccounts.map((a, i) => (
                  <div key={i} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                    <span className="small muted">
                      {a.bank}
                      {/* Which gateway issued it — a user may hold several,
                          so support's first question is answerable here. */}
                      {a.gateway && <span className="muted"> · {gatewayLabel(a.gateway)}</span>}
                    </span>
                    <span className="small strong" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      {a.number}<button className="btn btn-ghost btn-sm" onClick={() => copy(a.number, a.bank)}><IcCopy size={13} /></button>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Action buttons */}
            <div className="row wrap mt-2" style={{ gap: 8 }}>
              <button className="btn btn-sm" onClick={() => setAction({ kind: 'credit', wallet: 'main', amount: '', note: '' })}><IcWallet size={15} /> Credit</button>
              <button className="btn btn-soft btn-sm" onClick={() => setAction({ kind: 'debit', wallet: 'main', amount: '', note: '' })}>Debit</button>
              <button className="btn btn-soft btn-sm" onClick={() => setAction({
                kind: 'edit', firstName: detail.firstName, lastName: detail.lastName,
                email: detail.email, phone: detail.phone, state: detail.state, type: detail.type,
              })}>Edit details</button>
              <button className="btn btn-soft btn-sm" onClick={() => setAction({ kind: 'password', password: '' })}>Reset password</button>
              <button className="btn btn-soft btn-sm" onClick={() => setAction({ kind: 'apikey' })}><IcRefresh size={14} /> Reset API key</button>
              <button className="btn btn-soft btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setAction({ kind: 'delete' })}><IcTrash size={14} /> Delete</button>
            </div>

            {/* Recent transactions */}
            {detail.recentTransactions?.length > 0 && (
              <div className="mt-2">
                <div className="label">Recent activity</div>
                <div className="table-wrap">
                  <table className="table">
                    <tbody>
                      {detail.recentTransactions.map((t) => (
                        <tr key={t.transref}>
                          <td className="small"><div className="strong">{t.servicename}</div><div className="muted" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.servicedesc}</div></td>
                          <td className="small strong">{formatNaira(t.amount)}</td>
                          <td className="small muted">{formatDate(t.date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Action sub-dialog */}
      <Modal open={!!action} onClose={() => !busy && setAction(null)}
        title={action?.kind === 'credit' ? 'Credit wallet'
          : action?.kind === 'debit' ? 'Debit wallet'
          : action?.kind === 'edit' ? 'Edit user details'
          : action?.kind === 'password' ? 'Reset password'
          : action?.kind === 'apikey' ? 'Reset API key'
          : action?.kind === 'delete' ? 'Delete account' : ''}
        maxWidth={460}>
        {action && (action.kind === 'credit' || action.kind === 'debit') && (
          <div>
            <div className="field">
              <label className="label">Wallet</label>
              <select className="select" value={action.wallet} onChange={(e) => setAction((a) => ({ ...a, wallet: e.target.value }))}>
                <option value="main">Main wallet</option>
                <option value="bonus">Bonus / referral wallet</option>
              </select>
            </div>
            <div className="field">
              <label className="label">Amount (₦)</label>
              <input className="input" type="number" min="0" step="0.01" value={action.amount}
                onChange={(e) => setAction((a) => ({ ...a, amount: e.target.value }))} placeholder="0.00" autoFocus />
            </div>
            <div className="field">
              <label className="label">Note <span className="muted small">(optional)</span></label>
              <input className="input" value={action.note} onChange={(e) => setAction((a) => ({ ...a, note: e.target.value }))} placeholder="Reason / reference" />
            </div>
            <button className="btn btn-block" onClick={doFund} disabled={busy}>
              {busy ? <span className="spinner" /> : `${action.kind === 'credit' ? 'Credit' : 'Debit'} ${formatNaira(Number(action.amount) || 0)}`}
            </button>
          </div>
        )}

        {action && action.kind === 'edit' && (
          <div>
            <div className="grid grid-2">
              <div className="field" style={{ margin: 0 }}><label className="label">First name</label>
                <input className="input" value={action.firstName} onChange={(e) => setAction((a) => ({ ...a, firstName: e.target.value }))} /></div>
              <div className="field" style={{ margin: 0 }}><label className="label">Last name</label>
                <input className="input" value={action.lastName} onChange={(e) => setAction((a) => ({ ...a, lastName: e.target.value }))} /></div>
            </div>
            <div className="field"><label className="label">Email</label>
              <input className="input" value={action.email} onChange={(e) => setAction((a) => ({ ...a, email: e.target.value }))} /></div>
            <div className="grid grid-2">
              <div className="field" style={{ margin: 0 }}><label className="label">Phone</label>
                <input className="input" value={action.phone} onChange={(e) => setAction((a) => ({ ...a, phone: e.target.value }))} /></div>
              <div className="field" style={{ margin: 0 }}><label className="label">State</label>
                <input className="input" value={action.state} onChange={(e) => setAction((a) => ({ ...a, state: e.target.value }))} /></div>
            </div>
            <div className="field"><label className="label">Account type</label>
              <select className="select" value={action.type} onChange={(e) => setAction((a) => ({ ...a, type: e.target.value }))}>
                {TYPE_OPTS.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
              </select>
            </div>
            <button className="btn btn-block" onClick={doEdit} disabled={busy}>{busy ? <span className="spinner" /> : 'Save changes'}</button>
          </div>
        )}

        {action && action.kind === 'password' && (
          <div>
            <p className="muted small">Set a new password for this user. All their active sessions will be signed out.</p>
            <div className="field"><label className="label">New password</label>
              <input className="input" type="text" value={action.password}
                onChange={(e) => setAction((a) => ({ ...a, password: e.target.value }))} placeholder="At least 6 characters" autoFocus /></div>
            <button className="btn btn-block" onClick={doResetPassword} disabled={busy}>{busy ? <span className="spinner" /> : 'Reset password'}</button>
          </div>
        )}

        {action && action.kind === 'apikey' && (
          <div>
            <p className="muted small">Generate a brand-new API key for this user. Their current key stops working immediately.</p>
            <button className="btn btn-block" onClick={doResetApiKey} disabled={busy}>{busy ? <span className="spinner" /> : 'Regenerate API key'}</button>
          </div>
        )}

        {action && action.kind === 'delete' && (
          <div>
            <p className="muted small">This permanently deletes <span className="strong">{detail?.name}</span> and cannot be undone.</p>
            <button className="btn btn-block" style={{ background: 'var(--danger)' }} onClick={doDelete} disabled={busy}>
              {busy ? <span className="spinner" /> : 'Delete account permanently'}
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
