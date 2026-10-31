import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useToast } from '../../context/ToastContext';
import { Loader, Empty } from '../../components/Loader';
import { formatDate } from '../../config';
import { IcBan, IcPlus, IcTrash } from '../../components/Icons';

const FILTERS = [['', 'All'], ['approved', 'Blacklisted'], ['pending', 'Pending'], ['rejected', 'Rejected']];

export default function AdminBlacklist() {
  const toast = useToast();
  const [entries, setEntries] = useState([]);
  const [counts, setCounts] = useState({ approved: 0, pending: 0 });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    if (status) params.status = status;
    if (search) params.search = search;
    api.get('/admin/blacklist', params)
      .then((r) => { setEntries(r.data || []); setCounts(r.counts || { approved: 0, pending: 0 }); })
      .catch(() => toast.error('Could not load blacklist'))
      .finally(() => setLoading(false));
  }, [status, search, toast]);

  useEffect(() => { load(); }, [load]);

  const add = async (e) => {
    e.preventDefault();
    if (!value.trim()) return toast.error('Enter an email or phone number.');
    setAdding(true);
    try {
      // Report what the SERVER did, not what we assume it did. The endpoint
      // is shared with the public form and decides the status itself, so a
      // flat "Entry blacklisted" would be a false confirmation the moment
      // that decision changes (or the admin session is no longer trusted).
      const res = await api.post('/blacklist/submit', { value: value.trim(), reason: reason.trim() || undefined });
      toast.success(
        res.data?.status === 'approved' ? 'Entry blacklisted' : 'Submitted for approval',
        value.trim(),
      );
      setValue(''); setReason('');
      load();
    } catch (err) {
      toast.error('Could not add entry', err.message);
    } finally {
      setAdding(false);
    }
  };

  const act = async (id, action) => {
    try {
      await api.patch(`/admin/blacklist/${id}/${action}`);
      toast.success(action === 'approve' ? 'Entry approved' : 'Submission rejected');
      load();
    } catch (err) {
      toast.error('Action failed', err.message);
    }
  };

  // Removal is permanent and un-blocks the value immediately, so it asks
  // first and names the value being freed — the rows all look alike, and
  // an accidental click here silently re-admits someone who was banned
  // for fraud. Rejecting a pending item is the reversible action; this
  // is not.
  const remove = async (entry) => {
    const wasBlocking = entry.status === 'approved';
    const ok = window.confirm(
      `Remove ${entry.value} from the blacklist?\n\n`
      + (wasBlocking
        ? 'This entry is currently blocking registration. Removing it lets this '
          + 'email/phone sign up again straight away.'
        : 'This entry is not currently blocking anything.')
      + '\n\nThis cannot be undone.',
    );
    if (!ok) return;
    setRemoving(entry.id);
    try {
      await api.del(`/admin/blacklist/${entry.id}`);
      toast.success('Removed from blacklist', entry.value);
      load();
    } catch (err) {
      toast.error('Could not remove entry', err.message);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <>
      <h1 className="page-title">Blacklist</h1>
      <p className="page-sub">Block emails and phone numbers from registering. {counts.pending > 0 && <span className="badge badge-warn">{counts.pending} pending review</span>}</p>

      <div className="grid grid-2 mb-2">
        <div className="card card-pad-lg">
          <h3 className="row mt-0" style={{ gap: 8, alignItems: 'center' }}><IcBan size={20} /> Add to blacklist</h3>
          <p className="muted small">Admin entries are blocked immediately.</p>
          <form onSubmit={add}>
            <div className="field">
              <label className="label">Email or phone</label>
              <input className="input" value={value} onChange={(e) => setValue(e.target.value)} placeholder="user@example.com or 0801…" />
            </div>
            <div className="field">
              <label className="label">Reason <span className="muted small">(optional)</span></label>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Fraud, chargeback, etc." />
            </div>
            <button className="btn btn-block" disabled={adding}>
              {adding ? <span className="spinner" /> : <><IcPlus size={18} /> Add entry</>}
            </button>
          </form>
        </div>

        <div className="grid grid-2" style={{ alignContent: 'start' }}>
          <div className="card stat"><span className="k">Blacklisted</span><span className="v">{counts.approved}</span></div>
          <div className="card stat"><span className="k">Pending review</span><span className="v">{counts.pending}</span></div>
        </div>
      </div>

      <div className="row between wrap mb-2" style={{ gap: 10 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          {FILTERS.map(([v, l]) => (
            <button key={v} className={`btn btn-sm ${status === v ? '' : 'btn-soft'}`} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search value…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      <div className="card">
        {loading ? <Loader /> : entries.length === 0 ? (
          <Empty title="No entries" message="Nothing matches this filter." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Value</th><th>Type</th><th>Reason</th><th>Status</th><th>Added</th><th></th></tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="strong">{e.value}</td>
                    <td className="small muted">{e.type}</td>
                    <td className="small muted">{e.reason || '—'}</td>
                    <td>
                      <span className={`badge ${e.status === 'approved' ? 'badge-danger' : e.status === 'pending' ? 'badge-warn' : 'badge-muted'}`}>
                        {e.status === 'approved' ? 'blacklisted' : e.status}
                      </span>
                    </td>
                    <td className="small muted">{formatDate(e.createdAt)}</td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        {e.status === 'pending' && (
                          <>
                            <button className="btn btn-sm" onClick={() => act(e.id, 'approve')}>Approve</button>
                            <button className="btn btn-soft btn-sm" onClick={() => act(e.id, 'reject')}>Reject</button>
                          </>
                        )}
                        {/* Available on EVERY row, not just pending: the whole
                            point is to lift a block that is already in force. */}
                        <button className="btn btn-ghost btn-sm" title={`Remove ${e.value}`}
                          aria-label={`Remove ${e.value} from blacklist`}
                          disabled={removing === e.id} onClick={() => remove(e)}>
                          {removing === e.id ? <span className="spinner" /> : <IcTrash size={16} />}
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
    </>
  );
}
