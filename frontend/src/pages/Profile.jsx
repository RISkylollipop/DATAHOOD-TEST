import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { THEMES, TIERS } from '../config';
import { IcUser, IcSun, IcMoon, IcLogout } from '../components/Icons';
import SecurityPanel from '../components/SecurityPanel';

export default function Profile() {
  const { user, logout } = useAuth();
  const { theme, setTheme, mode, setMode } = useTheme();
  const fields = [
    ['First name', user?.firstName],
    ['Last name', user?.lastName],
    ['Email', user?.email],
    ['Phone', user?.phone],
    ['State', user?.state],
    ['Account tier', TIERS[user?.type] || 'User'],
  ];

  return (
    <>
      <h1 className="page-title">Profile & Settings</h1>
      <p className="page-sub">Your account details and appearance preferences.</p>

      <div className="grid grid-2">
        <div className="card card-pad-lg">
          <div className="row mb-2" style={{ gap: 12, alignItems: 'center' }}>
            <div className="ic" style={{ width: 52, height: 52, borderRadius: 14, background: 'var(--brand-soft)', color: 'var(--brand)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <IcUser size={26} />
            </div>
            <div>
              <div className="strong" style={{ fontSize: 18 }}>{user?.firstName} {user?.lastName}</div>
              <div className="small muted">{user?.email}</div>
            </div>
          </div>
          <div className="kv">
            {fields.map(([k, v]) => (
              <div className="kv-row" key={k}>
                <span className="muted small">{k}</span>
                <span className="strong small">{v || '—'}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="card card-pad-lg">
          <h3>Appearance</h3>
          <div className="field">
            <label className="label">Theme colour</label>
            <div className="row wrap" style={{ gap: 10 }}>
              {THEMES.map((t) => (
                <button key={t.id} type="button" title={t.name}
                  onClick={() => setTheme(t.id)}
                  className="theme-dot"
                  style={{
                    width: 34, height: 34, borderRadius: '50%', background: t.color,
                    border: theme === t.id ? '3px solid var(--text)' : '3px solid transparent',
                    cursor: 'pointer',
                  }} />
              ))}
            </div>
          </div>
          <div className="field">
            <label className="label">Mode</label>
            <div className="seg">
              <button type="button" className={mode === 'light' ? 'active' : ''} onClick={() => setMode('light')}>
                <IcSun size={16} /> Light
              </button>
              <button type="button" className={mode === 'dark' ? 'active' : ''} onClick={() => setMode('dark')}>
                <IcMoon size={16} /> Dark
              </button>
            </div>
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16, marginTop: 8 }}>
            <button className="btn btn-danger" onClick={logout}><IcLogout size={18} /> Log out</button>
          </div>
        </div>
      </div>

      {/* Full width: the PIN and password forms need the room, and this is
          the one card on the page that performs writes. */}
      <div className="mt-2">
        <SecurityPanel />
      </div>
    </>
  );
}
