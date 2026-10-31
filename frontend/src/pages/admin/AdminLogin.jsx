// ============================================================
//  Admin sign in — two steps when the account has 2FA enabled.
// ------------------------------------------------------------
//  The challenge token from step one is held in React state ONLY, never in
//  localStorage. It is a bearer credential, and persisting it would leave a
//  reusable half-authenticated token sitting in a store that any XSS can
//  read — for no benefit, since it expires in five minutes and the password
//  step is cheap to repeat.
//
//  A reload therefore sends the admin back to the password form. That is the
//  correct trade, and the reason the code field is not deep-linkable.
// ============================================================

import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { takeLogoutReason } from '../../utils/idleSession';
import { IcShield } from '../../components/Icons';

// Matches CHALLENGE_TTL in backend/controllers/admin2faController.js. Shown
// as a countdown so an expiry looks like an expiry rather than a broken code.
const CHALLENGE_SECONDS = 30;

export default function AdminLogin() {
  const { adminLogin, verifyAdmin2fa } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  
  const [endedReason] = useState(takeLogoutReason);

  const [challenge, setChallenge] = useState('');
  const [code, setCode] = useState('');
 
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const codeRef = useRef(null);


  useEffect(() => {
    if (challenge && codeRef.current) codeRef.current.focus();
  }, [challenge]);

  useEffect(() => {
    if (!deadline) return undefined;
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1000);
   
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [deadline]);

  const secondsLeft = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : CHALLENGE_SECONDS;

  const beginChallenge = (token) => {
    setChallenge(token);
   
    setDeadline(Date.now() + CHALLENGE_SECONDS * 1000);
    setNow(Date.now());
  };

  const restart = (msg) => {
    setChallenge('');
    setDeadline(0);
    setCode('');
    setPassword('');
    if (msg) toast.error('Start again', msg);
  };

  const submitPassword = async (e) => {
    e.preventDefault();
    if (!username || !password) return toast.error('Enter your username and password.');
    setBusy(true);
    try {
      const res = await adminLogin(username, password);
      if (res.twoFactorRequired) {
        beginChallenge(res.challenge);
        return;
      }
      toast.success('Welcome back');
      navigate('/admin');
    } catch (err) {
      toast.error('Login failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e) => {
    e.preventDefault();
    const entered = code.trim();
    if (!entered) return toast.error('Enter the code from your authenticator app.');
    setBusy(true);
    try {
      const { usedBackupCode } = await verifyAdmin2fa(challenge, entered);
      if (usedBackupCode) {
        // Not a toast that can be missed: a spent backup code is gone, and
        // the admin needs to know the count went down.
        toast.success('Signed in with a backup code', 'That code has been used up. Re-enrol your authenticator app soon.');
      } else {
        toast.success('Welcome back');
      }
      navigate('/admin');
    } catch (err) {
      // 400 means the challenge itself is dead — expired, or the password or
      // 2FA secret changed underneath it. Another code will never work, so
      // send them back rather than letting them retype into a void.
      if (err.status === 400) restart(err.message);
      else toast.error('Could not verify', err.message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  const mmss = `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, '0')}`;

  return (
    <div className="auth-wrap" style={{ gridTemplateColumns: '1fr' }}>
      <div className="auth-panel center" style={{ maxWidth: 420, margin: '0 auto' }}>
        <div className="ic" style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <IcShield size={28} />
        </div>

        {!challenge ? (
          <>
            <h1 style={{ marginBottom: 4 }}>Admin sign in</h1>
            <p className="muted mb-2">Restricted access. Authorized personnel only.</p>
            {endedReason === 'idle' && (
              <p className="note-warn" style={{ textAlign: 'left' }}>
                Signed out after 15 minutes of inactivity.
              </p>
            )}
            {endedReason === 'expired' && (
              <p className="note-warn" style={{ textAlign: 'left' }}>
                Your session ended. Please sign in again.
              </p>
            )}
            <form onSubmit={submitPassword} style={{ textAlign: 'left' }}>
              <div className="field">
                <label className="label" htmlFor="admin-username">Username</label>
                <input id="admin-username" className="input" 
                value={username} onChange={(e) => setUsername(e.target.value)} placeholder="" autoComplete="username" />
              </div>
              <div className="field">
                <label className="label" htmlFor="admin-password">Password</label>
                <input id="admin-password" className="input" type="password" 
                value={password} onChange={(e) => setPassword(e.target.value)} 
                placeholder="••••••••" autoComplete="current-password" />
              </div>
              <button className="btn btn-block mt-1" disabled={busy}>
                {busy ? <span className="spinner" /> : 'Sign in'}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 style={{ marginBottom: 4 }}>Two-factor code</h1>
            <p className="muted mb-2">
              Open your authenticator app and enter the current 6-digit code.
            </p>
            <form onSubmit={submitCode} style={{ textAlign: 'left' }}>
              <div className="field">
                <label className="label" htmlFor="admin-2fa-code">Code</label>
                <input
                  id="admin-2fa-code"
                  ref={codeRef}
                  className="input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  // Numeric keypad on mobile, but type=text so a hyphenated
                  // backup code can be typed into the same field.
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={12}
                  style={{ letterSpacing: '0.18em', fontSize: 18 }}
                />
                <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Lost your phone? Enter one of your backup codes instead.
                </p>
              </div>
              <button className="btn btn-block mt-1" disabled={busy || secondsLeft === 0}>
                {busy ? <span className="spinner" /> : 'Verify and sign in'}
              </button>
              <p className="muted center" style={{ fontSize: 12, marginTop: 10 }}>
                {secondsLeft === 0
                  ? 'This sign-in attempt expired.'
                  : `Expires in ${mmss}`}
              </p>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => restart()}
                disabled={busy}
              >
                Back to sign in
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
