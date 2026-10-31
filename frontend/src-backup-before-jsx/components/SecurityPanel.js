// ============================================================
//  SecurityPanel — password + transaction PIN self-service
// ------------------------------------------------------------
//  Backs the six /profile/* endpoints. Three rules shape this file:
//
//  1. changePassword invalidates the caller's OWN token. The backend
//     bumps sTokenVersion to sign out other devices, and this device
//     is one of them. So on `reauth: true` we must send the user back
//     to sign in — leaving them here would mean every later request
//     401s and client.js ejects them mid-action.
//  2. A PIN is exactly 4 digits, matching PinModal. Inputs strip
//     non-digits so a pasted "1 2 3 4" cannot quietly become a
//     different PIN than the user believes they typed.
//  3. Only one form is open at a time. These flows share an account
//     and a lockout counter, so letting two run at once invites the
//     user to burn PIN attempts in one panel while another is mid-save.
// ============================================================

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { IcShield, IcCheck, IcRefresh } from './Icons';

// Which PIN form is showing. IDLE means just the summary + buttons.
const PIN_VIEW = { IDLE: '', SET: 'set', CHANGE: 'change', RESET: 'reset' };

const RESEND_SECONDS = 60; // mirrors OTP_RESEND_COOLDOWN_MS in otpService.js

/** Keep only digits, max 4 — used by every PIN box here. */
const digits4 = (v) => String(v).replace(/\D/g, '').slice(0, 4);

export default function SecurityPanel() {
  const { logout } = useAuth();
  const toast = useToast();

  const [loading, setLoading] = useState(true);
  const [sec, setSec] = useState(null);
  // Holds the name of the in-flight request so only that button spins,
  // rather than freezing every form on the page.
  const [busy, setBusy] = useState('');

  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState({ cur: '', next: '', conf: '' });

  const [pinView, setPinView] = useState(PIN_VIEW.IDLE);
  const [sp, setSp] = useState({ pass: '', pin: '', conf: '' });
  const [cp, setCp] = useState({ cur: '', next: '', conf: '' });
  const [rp, setRp] = useState({ code: '', pin: '', conf: '' });
  const [cooldown, setCooldown] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await api.get('/profile/security');
      setSec(res.data);
    } catch (err) {
      toast.error('Could not load security settings', err.message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // Resend countdown. The id lives in a ref so each tick re-renders the
  // number and nothing else.
  const timerRef = useRef(null);
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    timerRef.current = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timerRef.current);
  }, [cooldown]);

  // Opening one form closes the others, and clears whatever was typed in
  // them — half-filled credentials should not linger in memory.
  const openPassword = (on) => {
    setPwOpen(on);
    if (on) setPinView(PIN_VIEW.IDLE);
    else setPw({ cur: '', next: '', conf: '' });
  };
  const openPin = (view) => {
    setPinView(view);
    setPwOpen(false);
    setSp({ pass: '', pin: '', conf: '' });
    setCp({ cur: '', next: '', conf: '' });
    setRp({ code: '', pin: '', conf: '' });
  };

  // ---------- password ----------

  const submitPassword = async (e) => {
    e.preventDefault();
    if (pw.next !== pw.conf) {
      toast.error('Passwords do not match', 'Re-enter the same password in both boxes.');
      return;
    }
    setBusy('pw');
    try {
      const res = await api.post('/profile/change-password', {
        currentPassword: pw.cur,
        newPassword: pw.next,
      });
      openPassword(false);
      toast.success('Password updated', res.msg);
      // The backend told us this token is now stale. Give the toast a beat
      // to be read, then bounce to sign-in rather than letting the next
      // request 401 and look like a crash.
      if (res.reauth) setTimeout(() => logout(), 1600);
    } catch (err) {
      toast.error('Could not change password', err.message);
    } finally {
      setBusy('');
    }
  };

  // ---------- PIN ----------

  const submitSetPin = async (e) => {
    e.preventDefault();
    if (sp.pin !== sp.conf) {
      toast.error('PINs do not match', 'Enter the same 4 digits in both boxes.');
      return;
    }
    setBusy('sp');
    try {
      const res = await api.post('/profile/set-pin', { password: sp.pass, pin: sp.pin });
      openPin(PIN_VIEW.IDLE);
      toast.success('PIN set', res.msg);
      load();
    } catch (err) {
      toast.error('Could not set PIN', err.message);
      // 409 means a PIN already exists — our cached status was stale, so
      // refresh it and let the UI offer Change instead of Set.
      if (err.status === 409) { openPin(PIN_VIEW.IDLE); load(); }
    } finally {
      setBusy('');
    }
  };

  const submitChangePin = async (e) => {
    e.preventDefault();
    if (cp.next !== cp.conf) {
      toast.error('PINs do not match', 'Enter the same 4 digits in both boxes.');
      return;
    }
    setBusy('cp');
    try {
      const res = await api.post('/profile/change-pin', { currentPin: cp.cur, newPin: cp.next });
      openPin(PIN_VIEW.IDLE);
      toast.success('PIN updated', res.msg);
      load();
    } catch (err) {
      toast.error('Could not change PIN', err.message);
      // A 429 here is the shared purchase-path lockout, not a rate limiter.
      // Re-read status so the panel shows the countdown and stops offering
      // attempts that cannot succeed.
      if (err.status === 429) { openPin(PIN_VIEW.IDLE); load(); }
    } finally {
      setBusy('');
    }
  };

  const requestPinReset = async () => {
    setBusy('req');
    try {
      const res = await api.post('/profile/pin/request-reset', {});
      setCooldown(RESEND_SECONDS);
      setPinView(PIN_VIEW.RESET);
      toast.success('Code sent', res.msg);
    } catch (err) {
      // The 60s cooldown replies with the real remaining time, so seed the
      // countdown from it instead of guessing.
      if (err.status === 429 && err.body?.retryAfterSec) {
        setCooldown(err.body.retryAfterSec);
        setPinView(PIN_VIEW.RESET);
      }
      toast.error('Could not send code', err.message);
    } finally {
      setBusy('');
    }
  };

  const submitResetPin = async (e) => {
    e.preventDefault();
    if (rp.pin !== rp.conf) {
      toast.error('PINs do not match', 'Enter the same 4 digits in both boxes.');
      return;
    }
    setBusy('rp');
    try {
      const res = await api.post('/profile/pin/reset', { code: rp.code, newPin: rp.pin });
      openPin(PIN_VIEW.IDLE);
      toast.success('PIN reset', res.msg);
      load();
    } catch (err) {
      toast.error('Could not reset PIN', err.message);
    } finally {
      setBusy('');
    }
  };

  // ---------- render ----------

  if (loading) {
    return (
      <div className="card card-pad-lg">
        <h3 className="mt-0"><IcShield size={18} /> Security</h3>
        <div className="center mt-2"><span className="spinner" /></div>
      </div>
    );
  }

  const pinSet = !!sec?.pinSet;
  const locked = !!sec?.pinLocked;
  const lockMins = Math.ceil((sec?.pinRetryAfterSec || 0) / 60);

  return (
    <div className="card card-pad-lg">
      <h3 className="mt-0"><IcShield size={18} /> Security</h3>

      {/* ---- Password ---- */}
      <div className="kv-row" style={{ alignItems: 'center' }}>
        <div>
          <div className="strong small">Account password</div>
          <div className="muted small">Used to sign in. Changing it signs you out everywhere.</div>
        </div>
        <button className="btn btn-sm btn-soft" onClick={() => openPassword(!pwOpen)}>
          {pwOpen ? 'Cancel' : 'Change'}
        </button>
      </div>

      {pwOpen && (
        <form onSubmit={submitPassword} className="mt-1">
          <div className="field">
            <label className="label">Current password</label>
            <input className="input" type="password" autoFocus autoComplete="current-password"
              value={pw.cur} onChange={(e) => setPw({ ...pw, cur: e.target.value })}
              placeholder="••••••••" required />
          </div>
          <div className="field">
            <label className="label">New password</label>
            <input className="input" type="password" autoComplete="new-password"
              value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })}
              placeholder="At least 6 characters" minLength={6} required />
          </div>
          <div className="field">
            <label className="label">Confirm new password</label>
            <input className="input" type="password" autoComplete="new-password"
              value={pw.conf} onChange={(e) => setPw({ ...pw, conf: e.target.value })}
              placeholder="••••••••" minLength={6} required />
          </div>
          {pw.conf && pw.next !== pw.conf && (
            <p className="small" style={{ color: 'var(--danger)', marginTop: -6 }}>Passwords do not match.</p>
          )}
          <p className="muted small">You'll be asked to sign in again with the new password.</p>
          <button className="btn btn-block" disabled={busy === 'pw' || !pw.cur || !pw.next || pw.next !== pw.conf}>
            {busy === 'pw' ? <span className="spinner" /> : 'Update password'}
          </button>
        </form>
      )}

      <div className="divider" />

      {/* ---- Transaction PIN ---- */}
      <div className="kv-row" style={{ alignItems: 'center' }}>
        <div>
          <div className="strong small">
            Transaction PIN{' '}
            {pinSet
              ? <span className="badge badge-success">Set</span>
              : <span className="badge badge-warn">Not set</span>}
          </div>
          <div className="muted small">
            {pinSet
              ? 'Required to confirm every purchase.'
              : 'Your account is still on the default PIN (1234). Choose your own now.'}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          {pinView !== PIN_VIEW.IDLE
            ? <button className="btn btn-sm btn-ghost" onClick={() => openPin(PIN_VIEW.IDLE)}>Cancel</button>
            : (
              <>
                <button className="btn btn-sm btn-soft"
                  onClick={() => openPin(pinSet ? PIN_VIEW.CHANGE : PIN_VIEW.SET)}>
                  {pinSet ? 'Change' : 'Set PIN'}
                </button>
                {pinSet && sec?.canResetPinByEmail && (
                  <button className="btn btn-sm btn-ghost" onClick={requestPinReset} disabled={busy === 'req'}>
                    {busy === 'req' ? <span className="spinner" /> : 'Forgot PIN?'}
                  </button>
                )}
              </>
            )}
        </div>
      </div>

      {locked && (
        <p className="small mt-1" style={{ color: 'var(--warn)' }}>
          PIN entry is locked after repeated wrong attempts. Try again in {lockMins} minute(s),
          or reset it by email.
        </p>
      )}

      {pinView === PIN_VIEW.SET && (
        <form onSubmit={submitSetPin} className="mt-1">
          <p className="muted small mt-0">
            Confirm your account password, then choose a 4-digit PIN. Avoid 1234 and repeated digits.
          </p>
          <div className="field">
            <label className="label">Account password</label>
            <input className="input" type="password" autoFocus autoComplete="current-password"
              value={sp.pass} onChange={(e) => setSp({ ...sp, pass: e.target.value })}
              placeholder="••••••••" required />
          </div>
          <PinField label="New PIN" value={sp.pin} onChange={(v) => setSp({ ...sp, pin: v })} autoFocus={false} />
          <PinField label="Confirm new PIN" value={sp.conf} onChange={(v) => setSp({ ...sp, conf: v })} />
          {sp.conf.length === 4 && sp.pin !== sp.conf && (
            <p className="small" style={{ color: 'var(--danger)', marginTop: -6 }}>PINs do not match.</p>
          )}
          <button className="btn btn-block" disabled={busy === 'sp' || !sp.pass || sp.pin.length !== 4 || sp.pin !== sp.conf}>
            {busy === 'sp' ? <span className="spinner" /> : 'Set PIN'}
          </button>
        </form>
      )}

      {pinView === PIN_VIEW.CHANGE && (
        <form onSubmit={submitChangePin} className="mt-1">
          <PinField label="Current PIN" value={cp.cur} onChange={(v) => setCp({ ...cp, cur: v })} autoFocus />
          <PinField label="New PIN" value={cp.next} onChange={(v) => setCp({ ...cp, next: v })} />
          <PinField label="Confirm new PIN" value={cp.conf} onChange={(v) => setCp({ ...cp, conf: v })} />
          {cp.conf.length === 4 && cp.next !== cp.conf && (
            <p className="small" style={{ color: 'var(--danger)', marginTop: -6 }}>PINs do not match.</p>
          )}
          <button className="btn btn-block"
            disabled={busy === 'cp' || locked || cp.cur.length !== 4 || cp.next.length !== 4 || cp.next !== cp.conf}>
            {busy === 'cp' ? <span className="spinner" /> : 'Update PIN'}
          </button>
        </form>
      )}

      {pinView === PIN_VIEW.RESET && (
        <form onSubmit={submitResetPin} className="mt-1">
          <p className="muted small mt-0">
            We sent a 6-digit code to <strong>{sec?.resetEmail}</strong>. It expires in 10 minutes.
          </p>
          <div className="field">
            <label className="label">6-digit code</label>
            <input className="input" autoFocus inputMode="numeric" autoComplete="one-time-code"
              value={rp.code} maxLength={6} placeholder="123456" required
              onChange={(e) => setRp({ ...rp, code: e.target.value.replace(/\D/g, '').slice(0, 6) })}
              style={{ letterSpacing: '0.4em', fontSize: 20, textAlign: 'center' }} />
          </div>
          <PinField label="New PIN" value={rp.pin} onChange={(v) => setRp({ ...rp, pin: v })} />
          <PinField label="Confirm new PIN" value={rp.conf} onChange={(v) => setRp({ ...rp, conf: v })} />
          {rp.conf.length === 4 && rp.pin !== rp.conf && (
            <p className="small" style={{ color: 'var(--danger)', marginTop: -6 }}>PINs do not match.</p>
          )}
          <button className="btn btn-block"
            disabled={busy === 'rp' || rp.code.length !== 6 || rp.pin.length !== 4 || rp.pin !== rp.conf}>
            {busy === 'rp' ? <span className="spinner" /> : 'Reset PIN'}
          </button>
          <p className="center mt-1">
            {cooldown > 0
              ? <span className="small muted">Resend available in {cooldown}s</span>
              : <button type="button" className="btn btn-ghost btn-sm" onClick={requestPinReset} disabled={busy === 'req'}>
                  <IcRefresh size={15} /> Resend code
                </button>}
          </p>
        </form>
      )}

      <div className="divider" />
      <p className="muted small mt-0">
        <IcCheck size={14} /> Your password and PIN are stored hashed — nobody, including support,
        can read them back.
      </p>
    </div>
  );
}

/**
 * A 4-digit PIN box. Split out because the same rules apply in all three
 * forms: masked, numeric keypad on mobile, non-digits stripped on the way
 * in (a pasted "1-2-3-4" must not silently become a different PIN).
 */
function PinField({ label, value, onChange, autoFocus = false }) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      <input
        className="input"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        autoFocus={autoFocus}
        maxLength={4}
        placeholder="••••"
        value={value}
        onChange={(e) => onChange(digits4(e.target.value))}
        required
        style={{ letterSpacing: '0.6em', fontSize: 20, textAlign: 'center' }}
      />
    </div>
  );
}


