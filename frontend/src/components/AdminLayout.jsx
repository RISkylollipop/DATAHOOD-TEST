import React, { useState } from 'react';
import { NavLink, useNavigate, Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ModeToggle } from './ThemeControls';
import {
  IcDashboard, IcServer, IcCard, IcUsers, IcHistory, IcBan, IcLogout, IcMenu, IcShield, IcLayers,
  IcBolt, IcLock, IcUser, IcGlobe, IcMail,
} from './Icons';

const NAV = [
  { to: '/admin', end: true, label: 'Overview', icon: IcDashboard },
  { to: '/admin/users', label: 'Users', icon: IcUsers },
  { to: '/admin/providers', label: 'Providers', icon: IcServer },
  { to: '/admin/plans', label: 'Plans', icon: IcLayers },
  { to: '/admin/gateways', label: 'Payment Gateways', icon: IcCard },
  // { to: '/admin/verification', label: 'Verification', icon: IcShield },
  { to: '/admin/transactions', label: 'Transactions', icon: IcHistory },
  { to: '/admin/sales', label: 'Sales', icon: IcBolt },
  { to: '/admin/blacklist', label: 'Blacklist', icon: IcBan },
  { to: '/admin/settings', label: 'Site Settings', icon: IcGlobe },
  { to: '/admin/newsletter', label: 'Newsletter', icon: IcMail },
  // Account pair, last: Profile before Security deliberately. Security refuses
  // 2FA enrolment until an email address exists, and Profile is where one is
  // set — reading top-to-bottom walks the operator through it in the order
  // the server will accept.
  { to: '/admin/profile', label: 'My Profile', icon: IcUser },
  { to: '/admin/security', label: 'Security', icon: IcLock },
];

export function AdminLayout() {
  const { admin, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div className="shell">
      {open && <div className="sidebar-backdrop" onClick={close} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="side-brand"><IcShield size={24} /> Admin</div>
        <nav>
          {NAV.map(({ to, end, label, icon: Icon }) => (
            <NavLink key={to} to={to} end={end} className="nav-link" onClick={close}>
              <Icon size={19} /> {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row">
            <button className="icon-btn menu-btn" onClick={() => setOpen((o) => !o)}><IcMenu size={18} /></button>
            <div>
              <div className="strong">{admin?.name || 'Administrator'}</div>
              <div className="small muted">Control panel</div>
            </div>
          </div>
          <div className="row">
            <ModeToggle />
            <button className="icon-btn" title="Log out" onClick={() => { logout(); nav('/admin/login'); }}>
              <IcLogout size={18} />
            </button>
          </div>
        </header>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}
