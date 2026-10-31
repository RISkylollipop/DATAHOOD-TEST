import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { IcCheck } from '../components/Icons';

const FEATURES = [
  'Instant airtime & data across all networks',
  'Pay electricity & cable bills in seconds',
  'Verify NIN, BVN, Passport & more — with PDF slips',
  'Wallet funding via virtual account',
];

export default function Login() {
  const { login } = useAuth();
  const toast = useToast();
  const nav = useNavigate();
  const loc = useLocation();
  const [form, setForm] = useState({ identifier: '', password: '' });
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await login(form.identifier.trim(), form.password);
      toast.success('Welcome back!');
      nav(loc.state?.from || '/app', { replace: true });
    } catch (err) {
      toast.error('Login failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-side">
        <div className="auth-logo"><img src="/favicon.svg" alt="" width={30} /> DATAHOOD</div>
        <div>
          <h1>Everything you need,<br />in one wallet.</h1>
          <ul className="feat-list">
            {FEATURES.map((f) => <li key={f}><IcCheck size={18} /> {f}</li>)}
          </ul>
        </div>
        <div className="small" style={{ opacity: 0.8 }}>© {new Date().getFullYear()} DATAHOOD. All rights reserved.</div>
      </div>

      <div className="auth-form-col">
        <form className="auth-form" onSubmit={submit}>
          <h2>Sign in</h2>
          <p className="muted mt-0">Welcome back. Enter your details to continue.</p>
          <div className="field">
            <label className="label">Phone or Email</label>
            <input className="input" value={form.identifier} autoFocus
              onChange={(e) => setForm({ ...form, identifier: e.target.value })}
              placeholder="08012345678" required />
          </div>
          <div className="field">
            <label className="label">Password</label>
            <input className="input" type="password" value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="••••••••" required />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: -4 }}>
            <Link to="/forgot-password" className="small muted">Forgot password?</Link>
          </div>
          <button className="btn btn-block mt-1" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Sign in'}
          </button>
          <p className="center mt-2 muted">
            New here? <Link to="/register">Create an account</Link>
          </p>
          <p className="center small"><Link to="/admin/login" className="muted">Admin login</Link></p>
        </form>
      </div>
    </div>
  );
}
