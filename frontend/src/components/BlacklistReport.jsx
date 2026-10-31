// ============================================================
//  BlacklistReport — let a user report an email or phone number
// ------------------------------------------------------------
//  Posts to the SAME endpoint the admin panel uses,
//  POST /api/blacklist/submit. The server decides the status: an
//  admin token approves instantly, everyone else lands as 'pending'
//  and an email goes to the operator. Nothing this component sends
//  can change that, and it deliberately has no way to try.
//
//  It lives on Support rather than behind its own nav entry because
//  that is where someone goes the moment they have been defrauded —
//  and because the endpoint needs no login, so the logged-out
//  /support page can carry it too. A visitor who has been scammed by
//  a seller does not have an account to log into.
// ============================================================

import React, { useState } from 'react';
import { api } from '../api/client';
import { IcBan, IcCheck } from './Icons';

// Mirrors classify() in backend/controllers/blacklistController.js. This is
// a courtesy check only — it exists so the user is told "that isn't a valid
// number" before a round trip, not as a control. The server re-derives the
// type from the value it receives and ignores anything decided here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function looksValid(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return false;
  if (EMAIL_RE.test(v)) return true;
  let digits = v.replace(/\D/g, '');
  if (digits.startsWith('234')) digits = '0' + digits.slice(3);
  return digits.length === 11;
}

export default function BlacklistReport() {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  // One inline result rather than a toast: the outcome here is a sentence
  // ("a person will read this before anything happens"), and a toast that
  // disappears after three seconds is the wrong place to explain that a
  // report is NOT an instant block.
  const [result, setResult] = useState(null); // { kind, text }

  const submit = async (e) => {
    e.preventDefault();
    const v = value.trim();
    if (!looksValid(v)) {
      setResult({
        kind: 'error',
        text: 'Enter a valid email address, or an 11-digit phone number starting 0.',
      });
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const res = await api.post('/blacklist/submit', {
        value: v,
        reason: reason.trim() || undefined,
      });
      setResult({
        kind: 'ok',
        // Report what the SERVER decided. An admin using this same form on
        // the public page gets an instant block, and telling them it is
        // "awaiting review" would send them looking for a queue entry that
        // does not exist.
        text: res.data?.status === 'approved'
          ? `${v} has been blacklisted.`
          : res.msg || 'Thank you. Your report has been sent for review.',
      });
      setValue('');
      setReason('');
    } catch (err) {
      // 409 is not a failure from the reporter's point of view — the thing
      // they wanted has already happened, or is already queued. Showing it
      // as an error invites them to submit again, which is exactly the
      // duplicate the 409 exists to prevent.
      setResult({
        kind: err.status === 409 ? 'ok' : 'error',
        text: err.message || 'Could not send that right now. Please try again.',
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="card card-pad-lg mt-2">
      <h3 className="row mt-0" style={{ gap: 8, alignItems: 'center' }}>
        <IcBan size={20} /> Report an email or phone number
      </h3>
      <p className="muted small">
        If someone has defrauded you or is abusing the platform, send us the
        email address or phone number they used. Reports are reviewed by an
        administrator before anything is blocked — submitting one does not
        block the account by itself, and we may contact you about it.
      </p>

      <form onSubmit={submit}>
        <div className="field">
          <label className="label" htmlFor="bl-value">Email or phone number</label>
          <input
            id="bl-value"
            className="input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="someone@example.com or 08012345678"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="bl-reason">
            What happened? <span className="muted small">(optional)</span>
          </label>
          <input
            id="bl-reason"
            className="input"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Took payment and did not deliver"
            maxLength={255}
          />
        </div>
        <button className="btn" disabled={sending}>
          {sending ? <span className="spinner" /> : <>Send report</>}
        </button>
      </form>

      {result && (
        // aria-live so a screen reader announces the outcome; without it the
        // only feedback is visual and the form looks like it did nothing.
        <p
          className={`small mt-2 ${result.kind === 'ok' ? 'text-success' : 'text-danger'}`}
          role="status"
          aria-live="polite"
          style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 0 }}
        >
          {result.kind === 'ok' && <IcCheck size={15} />}
          {result.text}
        </p>
      )}
    </div>
  );
}
