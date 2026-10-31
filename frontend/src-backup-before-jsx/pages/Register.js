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
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirm) return toast.error('Passwords do not match');
    if (form.password.length < 6) return toast.error('Password must be at least 6 characters');
    setBusy(true);
    try {
      const { confirm, ...payload } = form;
      await register(payload);
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
        <div className="auth-logo"><img src="/favicon.svg" alt="" width={30} /> DATAHOOD</div>
        <div>
          <h1>Create your<br />free account.</h1>
          <p style={{ opacity: 0.9, maxWidth: 360 }}>
            Join thousands buying airtime & data, paying bills, and verifying identities — all in one place.
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
          <button className="btn btn-block mt-1" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Create account'}
          </button>
          <p className="center mt-2 muted">Already have an account? <Link to="/login">Sign in</Link></p>
        </form>
      </div>
    </div>
  );
}
