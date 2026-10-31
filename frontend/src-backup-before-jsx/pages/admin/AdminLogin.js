import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { IcShield } from '../../components/Icons';

export default function AdminLogin() {
  const { adminLogin } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!username || !password) return toast.error('Enter your username and password.');
    setBusy(true);
    try {
      await adminLogin(username, password);
      toast.success('Welcome back');
      navigate('/admin');
    } catch (err) {
      toast.error('Login failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap" style={{ gridTemplateColumns: '1fr' }}>
      <div className="auth-panel center" style={{ maxWidth: 420, margin: '0 auto' }}>
        <div className="ic" style={{ width: 56, height: 56, borderRadius: 16, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
          <IcShield size={28} />
        </div>
        <h1 style={{ marginBottom: 4 }}>Admin sign in</h1>
        <p className="muted mb-2">Restricted access. Authorized personnel only.</p>
        <form onSubmit={submit} style={{ textAlign: 'left' }}>
          <div className="field">
            <label className="label">Username</label>
            <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" autoComplete="username" />
          </div>
          <div className="field">
            <label className="label">Password</label>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" autoComplete="current-password" />
          </div>
          <button className="btn btn-block mt-1" disabled={busy}>
            {busy ? <span className="spinner" /> : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
