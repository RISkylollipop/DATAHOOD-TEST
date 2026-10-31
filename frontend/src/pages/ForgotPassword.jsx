import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useToast } from '../context/ToastContext';
import { IcCheck } from '../components/Icons';

// Three steps in ONE component on purpose: the identifier and the verified
// ticket have to survive between them. Splitting this across routes would
// mean putting a live reset credential in the URL or in storage, where a
// shared browser or a copied link could pick it up.
const STEP = { REQUEST: 1, CODE: 2, PASSWORD: 3 };

const RESEND_SECONDS = 60; // mirrors OTP_RESEND_COOLDOWN_MS in otpService.js

export default function ForgotPassword() {
  const toast = useToast();
  const nav = useNavigate();

  const [step, setStep] = useState(STEP.REQUEST);
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [ticket, setTicket] = useState('');
  const [hint, setHint] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // One interval for the whole component, cleared on unmount. Storing the id
  // in a ref (not state) keeps the tick from re-rendering anything but the
  // countdown itself.
  const timerRef = useRef(null);
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    timerRef.current = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timerRef.current);
  }, [cooldown]);

  const sendCode = async (e) => {
    if (e) e.preventDefault();
    const id = identifier.trim();
    if (!id) return;
    setBusy(true);
    try {
      const res = await api.post('/auth/forgot-password', { identifier: id });
      if (res.hint) setHint(res.hint);
      setCooldown(RESEND_SECONDS);
      setStep(STEP.CODE);
      toast.success('Code sent', res.msg);
    } catch (err) {
      // The backend sends retryAfterSec with its 429 so the countdown can
      // start from the real remaining time rather than a guess.
      if (err.status === 429 && err.body?.retryAfterSec) {
        setCooldown(err.body.retryAfterSec);
        setStep(STEP.CODE);
      }
      toast.error('Could not send code', err.message);
    } finally {
      setBusy(false);
    }
  };

  const checkCode = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post('/auth/verify-reset-code', {
        identifier: identifier.trim(),
        code: code.trim(),
      });
      // The emailed code is spent by this call; step 3 redeems the ticket
      // it returned instead.
      setTicket(res.ticket || '');
      setStep(STEP.PASSWORD);
    } catch (err) {
      toast.error('Invalid code', err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    if (password !== confirm) {
      toast.error('Passwords do not match', 'Re-enter the same password in both boxes.');
      return;
    }
    if (password.length < 6) {
      toast.error('Password too short', 'Use at least 6 characters.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/auth/reset-password', {
        identifier: identifier.trim(),
        code: ticket || code.trim(),
        newPassword: password,
      });
      toast.success('Password updated', 'Sign in with your new password.');
      nav('/login', { replace: true });
    } catch (err) {
      toast.error('Could not reset password', err.message);
      // An expired or spent ticket cannot be recovered by retrying step 3 —
      // send the user back to request a fresh code rather than letting them
      // resubmit into the same failure.
      if (err.status === 400) {
        setTicket('');
        setCode('');
        setStep(STEP.CODE);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-side">
        <div className="auth-logo"><img src="/logo-mark.png" alt="" className="brand-mark" width={30} height={30} /> Noblesmegadata</div>
        <div>
          <h1>Locked out?<br />Let's fix that.</h1>
          <ul className="feat-list">
            <li><IcCheck size={18} /> We email a 6-digit code to the address on your account</li>
            <li><IcCheck size={18} /> The code expires after 10 minutes</li>
            <li><IcCheck size={18} /> Resetting signs you out everywhere else</li>
          </ul>
        </div>
        <div className="small" style={{ opacity: 0.8 }}>© {new Date().getFullYear()} Noblesmegadata. All rights reserved.</div>
      </div>

      <div className="auth-form-col">
        {step === STEP.REQUEST && (
          <form className="auth-form" onSubmit={sendCode}>
            <h2>Reset your password</h2>
            <p className="muted mt-0">
              Enter the phone number or email on your account and we'll send a code.
            </p>
            <div className="field">
              <label className="label">Phone or Email</label>
              <input className="input" value={identifier} autoFocus
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="08012345678" required />
            </div>
            <button className="btn btn-block mt-1" disabled={busy}>
              {busy ? <span className="spinner" /> : 'Send code'}
            </button>
            <p className="center mt-2 muted">
              Remembered it? <Link to="/login">Back to sign in</Link>
            </p>
          </form>
        )}

        {step === STEP.CODE && (
          <form className="auth-form" onSubmit={checkCode}>
            <h2>Enter the code</h2>
            <p className="muted mt-0">
              {hint
                ? <>We sent a 6-digit code to <strong>{hint}</strong>.</>
                : <>If that account exists, a 6-digit code is on its way.</>}
              {' '}It expires in 10 minutes.
            </p>
            <div className="field">
              <label className="label">6-digit code</label>
              <input className="input" value={code} autoFocus
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric" autoComplete="one-time-code"
                placeholder="123456" maxLength={6} required
                style={{ letterSpacing: '0.4em', fontSize: 20, textAlign: 'center' }} />
            </div>
            <button className="btn btn-block mt-1" disabled={busy || code.length !== 6}>
              {busy ? <span className="spinner" /> : 'Verify code'}
            </button>
            <p className="center mt-2 muted">
              {cooldown > 0
                ? <span className="small">Resend available in {cooldown}s</span>
                : <button type="button" className="btn btn-ghost btn-sm" onClick={sendCode} disabled={busy}>
                    Resend code
                  </button>}
            </p>
            <p className="center small">
              <button type="button" className="btn btn-ghost btn-sm"
                onClick={() => { setStep(STEP.REQUEST); setCode(''); }}>
                Use a different account
              </button>
            </p>
          </form>
        )}

        {step === STEP.PASSWORD && (
          <form className="auth-form" onSubmit={submitPassword}>
            <h2>Choose a new password</h2>
            <p className="muted mt-0">
              You'll be signed out on all other devices once this is saved.
            </p>
            <div className="field">
              <label className="label">New password</label>
              <input className="input" type="password" value={password} autoFocus
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••" minLength={6} required />
            </div>
            <div className="field">
              <label className="label">Confirm new password</label>
              <input className="input" type="password" value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••" minLength={6} required />
            </div>
            {confirm && password !== confirm && (
              <p className="small" style={{ color: 'var(--danger)', marginTop: -6 }}>
                Passwords do not match.
              </p>
            )}
            <button className="btn btn-block mt-1" disabled={busy || !password || password !== confirm}>
              {busy ? <span className="spinner" /> : 'Save new password'}
            </button>
            <p className="center mt-2 muted">
              <Link to="/login">Back to sign in</Link>
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
