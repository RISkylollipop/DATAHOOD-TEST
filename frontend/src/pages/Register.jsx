import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { NIGERIAN_STATES } from '../config';

export default function Register() {
  const { register } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const [form, setForm] = useState({
    firstName: '', lastName: '', email: '', phone: '', state: '', password: '', confirm: '', referral: '',
  });
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirm) return toast.error('Passwords do not match');
    if (form.password.length < 6) return toast.error('Password must be at least 6 characters');
    // The backend rejects a registration without this (422). Checking here
    // too is not duplication for its own sake — it turns a server error
    // into a sentence that names the box the user has to tick.
    if (!acceptedTerms) {
      return toast.error('Please accept the terms', 'Tick the box to confirm you agree to our Terms of Service and Privacy Policy.');
    }
    setBusy(true);
    try {
      const { confirm, ...payload } = form;
      await register({ ...payload, acceptedTerms: true });
      toast.success('Account created', 'Welcome to DATAHOOD!');
      nav('/app', { replace: true });
    } catch (err) {
      toast.error('Registration failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-side">
        <div className="auth-logo"><img src="/logo-mark.png" alt="" className="brand-mark" width={30} height={30} /> DATAHOOD</div>
        <div>
          <h1>Create your<br />free account.</h1>
          <p style={{ opacity: 0.9, maxWidth: 360 }}>
            Buy airtime and data, pay bills, and verify identities — all from
            one balance, on one dashboard.
          </p>
        </div>
        <div className="small" style={{ opacity: 0.8 }}>© {new Date().getFullYear()} DATAHOOD.</div>
      </div>

      <div className="auth-form-col">
        <form className="auth-form" onSubmit={submit}>
          <h2>Sign up</h2>
          <p className="muted mt-0">It only takes a minute.</p>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">First name</label>
              <input className="input" value={form.firstName} onChange={set('firstName')} required />
            </div>
            <div className="field">
              <label className="label">Last name</label>
              <input className="input" value={form.lastName} onChange={set('lastName')} required />
            </div>
          </div>
          <div className="field">
            <label className="label">Email</label>
            <input className="input" type="email" value={form.email} onChange={set('email')} required />
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">Phone</label>
              <input className="input" value={form.phone} onChange={set('phone')} placeholder="08012345678" required />
            </div>
            <div className="field">
              <label className="label">State</label>
              <select className="select" value={form.state} onChange={set('state')} required>
                <option value="">Select…</option>
                {NIGERIAN_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-2">
            <div className="field">
              <label className="label">Password</label>
              <input className="input" type="password" value={form.password} onChange={set('password')} required />
            </div>
            <div className="field">
              <label className="label">Confirm password</label>
              <input className="input" type="password" value={form.confirm} onChange={set('confirm')} required />
            </div>
          </div>
          <div className="field">
            <label className="label">Referral (phone) — optional</label>
            <input className="input" value={form.referral} onChange={set('referral')} placeholder="Referrer's phone" />
          </div>

          {/*
            Consent, recorded as evidence.

            Unticked by default and never auto-ticked: a pre-checked box is
            not consent, it is an assumption, and the whole point of storing
            consentAt/consentIp/consentVersion server-side is to be able to
            show later exactly what this person agreed to and when. The
            links open in a new tab so reading the policy does not throw
            away a half-filled form.
          */}
          <label className="consent-row">
            <input
              type="checkbox"
              checked={acceptedTerms}
              onChange={(e) => setAcceptedTerms(e.target.checked)}
              required
            />
            <span className="small">
              I agree to the{' '}
              <Link to="/terms" target="_blank" rel="noopener noreferrer">Terms of Service</Link>{' '}
              and the{' '}
              <Link to="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</Link>,
              and I consent to DATAHOOD processing my personal data as described there.
            </span>
          </label>

          <button className="btn btn-block mt-1" disabled={busy || !acceptedTerms}>
            {busy ? <span className="spinner" /> : 'Create account'}
          </button>
          <p className="center mt-2 muted">Already have an account? <Link to="/login">Sign in</Link></p>
          <p className="center small">
            <Link to="/pricing" className="muted">See data &amp; tier pricing</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
