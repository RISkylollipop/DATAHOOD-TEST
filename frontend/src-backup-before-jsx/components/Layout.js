import React, { useState } from 'react';
import { NavLink, useNavigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ModeToggle } from './ThemeControls';
import {
  IcDashboard, IcPhone, IcData, IcBolt, IcTv, IcShield,
  IcWallet, IcHistory, IcUser, IcLogout, IcMenu, IcBell,
} from './Icons';
import { TIERS } from '../config';

const NAV = [
  { to: '/app', end: true, label: 'Dashboard', icon: IcDashboard },
  { to: '/app/airtime', label: 'Airtime', icon: IcPhone },
  { to: '/app/data', label: 'Data', icon: IcData },
  { to: '/app/electricity', label: 'Electricity', icon: IcBolt },
  { to: '/app/cable', label: 'Cable TV', icon: IcTv },
  { to: '/app/verify', label: 'Verification', icon: IcShield },
];
const NAV2 = [
  { to: '/app/wallet', label: 'Fund Wallet', icon: IcWallet },
  { to: '/app/transactions', label: 'Transactions', icon: IcHistory },
  { to: '/app/profile', label: 'Profile', icon: IcUser },
];

export function Layout() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const initials = user ? `${(user.firstName || '?')[0] || ''}${(user.lastName || '')[0] || ''}`.toUpperCase() : '?';

  const link = ({ to, end, label, icon: Icon }) => (
    <NavLink key={to} to={to} end={end} className="nav-link" onClick={close}>
      <Icon size={19} /> {label}
    </NavLink>
  );

  return (
    <div className="shell">
      {open && <div className="sidebar-backdrop" onClick={close} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="side-brand">
          <img src="/favicon.svg" alt="" width={28} height={28} /> DATAHOOD
        </div>
        <nav>
          {NAV.map(link)}
          <div className="nav-section">Account</div>
          {NAV2.map(link)}
        </nav>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="row">
            <button className="icon-btn menu-btn" onClick={() => setOpen((o) => !o)}><IcMenu size={18} /></button>
            <div>
              <div className="strong">Hi, {user?.firstName || 'there'} 👋</div>
              <div className="small muted">{TIERS[user?.type] || 'User'} account</div>
            </div>
          </div>
          <div className="row">
            <ModeToggle />
            <button className="icon-btn" title="Notifications"><IcBell size={18} /></button>
            <div className="avatar" title={`${user?.firstName} ${user?.lastName}`}>{initials}</div>
            <button className="icon-btn" title="Log out" onClick={() => { logout(); nav('/login'); }}>
              <IcLogout size={18} />
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
