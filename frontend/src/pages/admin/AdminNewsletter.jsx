// ============================================================
//  Admin → Newsletter
// ------------------------------------------------------------
//  Compose and send to the marketing list, inspect who is on it, and see
//  what has already gone out.
//
//  Three decisions this screen makes that a plain "subject + body + Send"
//  form would not:
//
//   1. THE PREVIEW IS THE SERVER'S HTML, IN AN IFRAME.
//      The markup shown here is fetched from POST /admin/newsletter/preview
//      — the same bytes the recipient gets — rather than re-implemented in
//      JSX. A hand-built approximation drifts from the real template and
//      then lies with total confidence. The iframe is `sandbox`ed with no
//      permissions, so even a hole in the renderer could not run anything
//      in the admin's session.
//
//   2. SENDING ASKS FOR THE NUMBER, NOT FOR "OK".
//      This is the only button in the panel that cannot be undone and that
//      reaches strangers. Typing the recipient count is a deliberate speed
//      bump: it makes the operator look at how many people that actually is.
//
//   3. IT SHOWS PROGRESS FROM THE SERVER, NOT A SPINNER.
//      The send runs detached from the HTTP request, so the campaign row is
//      the truth. Polling it means a closed laptop does not stop the send,
//      and an operator who reloads mid-send sees where it got to instead of
//      wondering whether to press Send again.
// ============================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api/client';
import { formatDate } from '../../config';
import { useToast } from '../../context/ToastContext';
import { Loader, Empty } from '../../components/Loader';
import { Modal } from '../../components/Modal';
import {
  IcMail, IcUsers, IcRefresh, IcDownload, IcEye, IcClock,
} from '../../components/Icons';

// The markup cheat-sheet shown beside the editor. Kept in sync with the
// block syntax documented in backend/utils/richText.js — if you add syntax
// there, add the row here, because this list is the only place an operator
// will ever learn it.
const SYNTAX = [
  ['# Heading', 'Large heading (## and ### are smaller)'],
  ['**bold**', 'Bold text'],
  ['*italic*', 'Italic text'],
  ['- item', 'Bullet list'],
  ['1. item', 'Numbered list'],
  ['> note', 'Quoted / highlighted block'],
  ['---', 'Divider line'],
  ['[words](https://…)', 'Link'],
  ['[[Button|https://…]]', 'Big blue button, alone on its line'],
];

const STARTER = `# New data plans are live

Hi there,

We have just added cheaper **MTN** and **Airtel** bundles, and cable TV
renewals now go through instantly.

- MTN 1GB — now cheaper
- Airtel 2GB — now cheaper
- DSTV, GOtv and Startimes — instant

[[Top up your wallet|https://kwarapolydata.com.ng/app]]

Thanks for being with us.`;


function StatusBadge({ status }) {
  const map = {
    confirmed: 'badge-success',
    sent: 'badge-success',
    pending: 'badge-warn',
    sending: 'badge-warn',
    unsubscribed: 'badge-muted',
    failed: 'badge-danger',
  };
  return <span className={`badge ${map[status] || 'badge-muted'}`}>{status}</span>;
}

export default function AdminNewsletter() {
  const toast = useToast();
  const [tab, setTab] = useState('compose');

  const [stats, setStats] = useState(null);
  const [loadingStats, setLoadingStats] = useState(true);

  const loadStats = useCallback(() => {
    setLoadingStats(true);
    api.get('/admin/newsletter/stats')
      .then((r) => setStats(r.data))
      .catch((err) => toast.error('Could not load newsletter stats', err.message))
      .finally(() => setLoadingStats(false));
  }, [toast]);

  useEffect(() => { loadStats(); }, [loadStats]);

  return (
    <div>
      <div className="between mb-2">
        <div>
          <h2 className="page-title">Newsletter</h2>
          <p className="page-sub">
            Write once, send to everyone who confirmed their subscription.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={loadStats}>
          <IcRefresh /> Refresh
        </button>
      </div>

      {loadingStats && !stats ? <Loader /> : (
        <div className="grid grid-4 mb-2">
          <div className="card stat">
            <span className="k">Confirmed</span>
            <span className="v text-success">{stats?.confirmed ?? 0}</span>
            <span className="small muted">will receive campaigns</span>
          </div>
          <div className="card stat">
            <span className="k">Awaiting confirmation</span>
            <span className="v">{stats?.pending ?? 0}</span>
            <span className="small muted">clicked signup, not the link</span>
          </div>
          <div className="card stat">
            <span className="k">Unsubscribed</span>
            <span className="v muted">{stats?.unsubscribed ?? 0}</span>
            <span className="small muted">never mailed again</span>
          </div>
          <div className="card stat">
            <span className="k">Total on record</span>
            <span className="v">{stats?.total ?? 0}</span>
            <span className="small muted">all statuses</span>
          </div>
        </div>
      )}

      <div className="seg mb-2" role="tablist">
        <button type="button" className={tab === 'compose' ? 'active' : ''} onClick={() => setTab('compose')}>
          Compose
        </button>
        <button type="button" className={tab === 'people' ? 'active' : ''} onClick={() => setTab('people')}>
          Subscribers
        </button>
        <button type="button" className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History
        </button>
      </div>

      {tab === 'compose' && (
        <Compose
          confirmed={stats?.confirmed ?? 0}
          onSent={loadStats}
        />
      )}
      {tab === 'people' && <Subscribers />}
      {tab === 'history' && <History campaigns={stats?.campaigns || []} onRefresh={loadStats} />}
    </div>
  );
}

// ------------------------------------------------------------
//  Compose
// ------------------------------------------------------------
function Compose({ confirmed, onSent }) {
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState(STARTER);
  const [pv, setPv] = useState(null);
  const [previewing, setPreviewing] = useState(false);

  const [testing, setTesting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [sending, setSending] = useState(false);
  const [campaign, setCampaign] = useState(null);

  // Debounced server preview. Without the delay this fires a request per
  // keystroke, which on a slow connection means the preview shown is
  // whichever response happened to land last — often not the latest text.
  const timer = useRef(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setPreviewing(true);
      api.post('/admin/newsletter/preview', { subject, body })
        .then((r) => setPv(r.data))
        .catch(() => { /* preview is a convenience; never toast on it */ })
        .finally(() => setPreviewing(false));
    }, 450);
    return () => timer.current && clearTimeout(timer.current);
  }, [subject, body]);

  // Poll a running campaign. Stops as soon as the row leaves 'sending', so
  // a finished send does not keep a timer alive for the rest of the session.
  //
  // 4s, not 1s: the global limiter allows ~80 requests/min per IP, and a
  // large send can run for ten minutes. At 1s this one idle tab would spend
  // most of that budget and start 429-ing the operator's other admin pages.
  useEffect(() => {
    if (!campaign || campaign.status !== 'sending') return undefined;
    const id = setInterval(() => {
      api.get(`/admin/newsletter/campaigns/${campaign.id}`)
        .then((r) => {
          setCampaign(r.data);
          if (r.data.status !== 'sending') { onSent?.(); }
        })
        .catch(() => {});
    }, 4000);
    return () => clearInterval(id);
  }, [campaign, onSent]);

  const canSend = subject.trim() && body.trim() && confirmed > 0;

  const doTest = async () => {
    if (!subject.trim() || !body.trim()) {
      toast.error('Nothing to send', 'Add a subject and a message first.');
      return;
    }
    setTesting(true);
    try {
      const r = await api.post('/admin/newsletter/test', { subject, body });
      toast.success('Test sent', r.msg);
    } catch (err) {
      toast.error('Test failed', err.message);
    } finally {
      setTesting(false);
    }
  };

  const doSend = async () => {
    setSending(true);
    try {
      const r = await api.post('/admin/newsletter/send', {
        subject, body, confirmText: typed.trim(),
      });
      setConfirmOpen(false);
      setTyped('');
      setCampaign({
        id: r.data.campaignId,
        subject,
        status: 'sending',
        recipientCount: r.data.recipientCount,
        sentCount: 0,
        failedCount: 0,
      });
      toast.success('Sending', r.msg);
    } catch (err) {
      toast.error('Could not send', err.message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      {campaign && (
        <div className="card mb-2">
          <div className="between">
            <div>
              <strong>{campaign.status === 'sending' ? 'Sending now' : 'Last send'}</strong>
              <div className="small muted">{campaign.subject}</div>
            </div>
            <StatusBadge status={campaign.status} />
          </div>
          <div className="kv mt-0">
            <div className="kv-row"><span>Recipients</span><span>{campaign.recipientCount}</span></div>
            <div className="kv-row"><span>Delivered</span><span className="text-success">{campaign.sentCount}</span></div>
            {campaign.failedCount > 0 && (
              <div className="kv-row"><span>Failed</span><span className="text-danger">{campaign.failedCount}</span></div>
            )}
          </div>
          {campaign.status === 'sending' && (
            <p className="hint">
              This continues on the server. You can close this page — it will not stop the send.
            </p>
          )}
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <div className="field">
            <label className="label" htmlFor="nl-subject">Subject line</label>
            <input
              id="nl-subject"
              className="input"
              value={subject}
              maxLength={200}
              placeholder="New data plans are live"
              onChange={(e) => setSubject(e.target.value)}
            />
            <span className="hint">
              This is the one line that decides whether the email gets opened.
              {' '}{200 - subject.length} characters left.
            </span>
          </div>

          <div className="field">
            <label className="label" htmlFor="nl-body">Message</label>
            <textarea
              id="nl-body"
              className="input"
              rows={18}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13, lineHeight: 1.6, resize: 'vertical' }}
            />
            <span className="hint">
              {pv ? `${pv.words} words · about a ${pv.minutes} minute read` : 'Formatting guide below.'}
            </span>
          </div>

          <details>
            <summary className="small muted" style={{ cursor: 'pointer' }}>Formatting guide</summary>
            <ul className="feat-list">
              {SYNTAX.map(([code, what]) => (
                <li key={code}>
                  <code style={{ background: 'var(--surface-2)', padding: '2px 6px', borderRadius: 5 }}>{code}</code>
                  <span className="small muted" style={{ marginLeft: 8 }}>{what}</span>
                </li>
              ))}
            </ul>
            <p className="hint">
              Anything else you type is sent as plain text. HTML is not accepted on
              purpose — it renders differently in every email app, and pasting it
              here would let a stray tag reach every subscriber.
            </p>
          </details>

          <div className="row" style={{ marginTop: 18, gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-soft" onClick={doTest} disabled={testing}>
              <IcMail /> {testing ? 'Sending…' : 'Send test to myself'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!canSend}
              onClick={() => setConfirmOpen(true)}
            >
              <IcUsers /> Send to {confirmed} subscriber{confirmed === 1 ? '' : 's'}
            </button>
          </div>
          {confirmed === 0 && (
            <p className="hint text-danger">
              Nobody has confirmed a subscription yet, so there is no one to send to.
            </p>
          )}
        </div>

        <div className="card">
          <div className="between mb-1">
            <strong><IcEye /> Preview</strong>
            <span className="small muted">{previewing ? 'updating…' : 'exactly what is sent'}</span>
          </div>
          {pv?.fullHtml ? (
            <iframe
              title="Newsletter preview"
              srcDoc={pv.fullHtml}
              // No permissions at all. The content is already sanitised by
              // the server; this is the second lock, so that a bug in the
              // renderer still cannot reach the admin session around it.
              sandbox=""
              style={{
                width: '100%', height: 620, border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', background: '#f1f5f9',
              }}
            />
          ) : <Loader />}
          {pv?.text && (
            <details style={{ marginTop: 12 }}>
              <summary className="small muted" style={{ cursor: 'pointer' }}>
                Plain-text version (what watches and screen readers read)
              </summary>
              <pre className="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 12, borderRadius: 8, marginTop: 8 }}>
                {pv.text}
              </pre>
            </details>
          )}
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => !sending && setConfirmOpen(false)}
        title="Send this to everyone?"
      >
        <p>
          This sends <strong>{subject || '(no subject)'}</strong> to{' '}
          <strong>{confirmed}</strong> confirmed subscriber{confirmed === 1 ? '' : 's'}.
        </p>
        <p className="muted small">
          It cannot be recalled, edited or undone once it starts.
        </p>
        <div className="field">
          <label className="label" htmlFor="nl-confirm">
            Type <strong>{confirmed}</strong> to confirm
          </label>
          <input
            id="nl-confirm"
            className="input"
            value={typed}
            inputMode="numeric"
            autoComplete="off"
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="row" style={{ gap: 10, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirmOpen(false)} disabled={sending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={doSend}
            disabled={sending || typed.trim() !== String(confirmed)}
          >
            {sending ? 'Starting…' : 'Send now'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

// ------------------------------------------------------------
//  Subscribers
// ------------------------------------------------------------
function Subscribers() {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ page: 1, pages: 1, total: 0 });
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/admin/newsletter/subscribers', { page, status, q })
      .then((r) => {
        setRows(r.data.subscribers || []);
        setMeta({ page: r.data.page, pages: r.data.pages, total: r.data.total });
      })
      .catch((err) => toast.error('Could not load subscribers', err.message))
      .finally(() => setLoading(false));
  }, [page, status, q, toast]);

  // Debounced so typing in the search box does not fire a request per key.
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  const exportCsv = async () => {
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      await api.download('/admin/newsletter/export', `newsletter-subscribers-${stamp}.csv`);
    } catch (err) {
      toast.error('Export failed', err.message);
    }
  };

  return (
    <div className="card">
      <div className="between mb-2" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input
            className="input"
            placeholder="Search email…"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            style={{ maxWidth: 240 }}
          />
          <select
            className="input"
            value={status}
            onChange={(e) => { setStatus(e.target.value); setPage(1); }}
            style={{ maxWidth: 200 }}
          >
            <option value="">All statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Awaiting confirmation</option>
            <option value="unsubscribed">Unsubscribed</option>
          </select>
        </div>
        <button type="button" className="btn btn-soft btn-sm" onClick={exportCsv}>
          <IcDownload /> Export confirmed (CSV)
        </button>
      </div>

      {loading ? <Loader /> : rows.length === 0 ? (
        <Empty
          title="No subscribers here"
          message={q || status
            ? 'Nothing matches that filter.'
            : 'The signup box on the landing page feeds this list.'}
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Source</th>
                  <th>Consented</th>
                  <th>Confirmed</th>
                  <th>Last sent</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.email}</td>
                    <td>{r.name || '—'}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="small muted">{r.source}</td>
                    {/* Consent evidence, shown because it is the answer to
                        "why are we allowed to email this person?" */}
                    <td className="small muted" title={r.consentIp ? `from ${r.consentIp}` : ''}>
                      {formatDate(r.consentAt)}
                    </td>
                    <td className="small muted">{formatDate(r.confirmedAt)}</td>
                    <td className="small muted">{formatDate(r.lastSentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="between" style={{ marginTop: 14 }}>
            <span className="small muted">
              {meta.total} total · page {meta.page} of {meta.pages}
            </span>
            <div className="row" style={{ gap: 8 }}>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={meta.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={meta.page >= meta.pages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------
//  History
// ------------------------------------------------------------
function History({ campaigns, onRefresh }) {
  if (!campaigns.length) {
    return (
      <div className="card">
        <Empty
          title="Nothing sent yet"
          message="Campaigns you send will be listed here with their delivery counts."
        />
      </div>
    );
  }

  return (
    <div className="card">
      <div className="between mb-2">
        <strong><IcClock /> Recent campaigns</strong>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
          <IcRefresh /> Refresh
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Status</th>
              <th>Recipients</th>
              <th>Delivered</th>
              <th>Failed</th>
              <th>Started</th>
              <th>Finished</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => (
              <tr key={c.id}>
                <td>{c.subject}</td>
                <td><StatusBadge status={c.status} /></td>
                <td>{c.recipientCount}</td>
                <td className="text-success">{c.sentCount}</td>
                <td className={c.failedCount ? 'text-danger' : 'muted'}>{c.failedCount}</td>
                <td className="small muted">{formatDate(c.startedAt)}</td>
                <td className="small muted">{formatDate(c.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        A campaign is kept here whether it succeeded or not, so &quot;did Tuesday&apos;s
        email actually go out?&quot; has an answer that is not someone&apos;s memory.
      </p>
    </div>
  );
}
