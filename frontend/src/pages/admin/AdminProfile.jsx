// ============================================================
//  Admin profile — the account's own details.
// ------------------------------------------------------------
//  Three panels, each mirroring a backend gate rather than inventing its
//  own rules:
//
//    Details   name + phone, authorised by the current password
//    Email     the recovery address — one code to the new address, plus an
//              approval code to the current one once an address exists
//    Password  bumps the server-side token version, so a replacement token
//              comes back and MUST be adopted
//
//  The email panel is the reason this screen exists. AdminSecurity refuses
//  2FA enrolment without sysEmail, and before this there was nowhere to set
//  one — the gate was right and there was no door behind it.
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { Loader } from '../../components/Loader';
import { IcUser, IcMail, IcLock, IcCheck, IcRefresh, IcShield } from '../../components/Icons';

export default function AdminProfile() {
  const toast = useToast();
  const { updateAdmin, rotateAdminToken } = useAuth();

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Details
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [detailsPassword, setDetailsPassword] = useState('');

  // Email change. `ticket` is the server's signed record of which address is
  // pending; it binds the emailed code to that address, so it has to survive
  // between the two requests.
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [ticket, setTicket] = useState(null);       // { ticket, email, approvalRequired }
  const [emailCode, setEmailCode] = useState('');
  const [approvalCode, setApprovalCode] = useState('');

  // Password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/auth/admin/profile')
      .then((r) => {
        const d = r.data || {};
        setProfile(d);
        setName(d.name || '');
        setPhone(d.phone || '');
      })
      .catch((err) => toast.error('Could not load your profile', err.message))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const saveDetails = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.put('/auth/admin/profile', {
        currentPassword: detailsPassword,
        name: name.trim(),
        phone: phone.trim(),
      });
      toast.success('Profile updated', r.msg);
      setDetailsPassword('');
      if (r.data?.admin) {
        setProfile((p) => ({ ...(p || {}), ...r.data.admin }));
        // Keep the topbar in step — it reads admin.name from context, so
        // without this the header shows the old name until the next login.
        updateAdmin(r.data.admin);
      }
    } catch (err) {
      toast.error('Could not update your profile', err.message);
    } finally {
      setBusy(false);
    }
  };

  const requestEmail = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/auth/admin/profile/email/request', {
        currentPassword: emailPassword,
        email: newEmail.trim(),
      });
      setTicket(r.data || null);
      setEmailCode('');
      setApprovalCode('');
      // The password has done its job; holding it in state past this point
      // only widens what a stray screenshot or a React devtools session
      // would expose.
      setEmailPassword('');
      toast.success('Check your inbox', r.msg);
    } catch (err) {
      toast.error('Could not start the email change', err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmEmail = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/auth/admin/profile/email/confirm', {
        ticket: ticket?.ticket,
        email: ticket?.email,
        code: emailCode.trim(),
        approvalCode: approvalCode.trim(),
      });
      toast.success('Email address updated', r.msg);
      setTicket(null);
      setNewEmail('');
      setEmailCode('');
      setApprovalCode('');
      if (r.data?.admin) {
        setProfile((p) => ({
          ...(p || {}),
          ...r.data.admin,
          // Setting an address is exactly what unblocks 2FA enrolment, so
          // reflect it immediately rather than making them reload to find
          // the Security screen has come alive.
          canEnable2fa: Boolean(r.data.admin.email),
        }));
        updateAdmin(r.data.admin);
      }
    } catch (err) {
      toast.error('Could not change your email', err.message);
    } finally {
      setBusy(false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      return toast.error('Those passwords do not match.');
    }
    setBusy(true);
    try {
      const r = await api.post('/auth/admin/password', { currentPassword, newPassword });
      // FIRST, before any re-render can throw: adopt the replacement token.
      // The server bumped this account's token version to sign out other
      // devices, which also killed the token this request was made with.
      // Miss this and the next admin request 401s and client.jsx wipes the
      // session — the change succeeded but it looks like being thrown out.
      rotateAdminToken(r.data?.token);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password updated', r.msg);
    } catch (err) {
      toast.error('Could not change your password', err.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <Loader />;

  const hasEmail = Boolean(profile?.email);

  return (
    <>
      <div className="row between wrap mb-2">
        <div>
          <div className="page-title">My Profile</div>
          <div className="page-sub">Your administrator account details and sign-in credentials.</div>
        </div>
        <button className="btn btn-soft btn-sm" onClick={load} disabled={busy}>
          <IcRefresh size={15} /> Refresh
        </button>
      </div>

      {/* The reason this screen exists. Without an address, 2FA enrolment is
          refused by the server and the Security screen is a dead end — so
          say so here, where the fix is. */}
      {!hasEmail && (
        <div className="card card-pad-lg mb-2" style={{ borderColor: 'var(--warn)' }}>
          <div className="row" style={{ gap: 10 }}>
            <IcShield size={20} />
            <div>
              <div className="strong">No email address on this account</div>
              <p className="muted small mt-0">
                Two-factor authentication cannot be switched on until you add one. It is
                where the code to switch it off again would be sent — without a mailbox,
                enrolling would be a one-way door.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ---------- account summary ---------- */}
      <div className="card card-pad-lg mb-2">
        <div className="row between wrap">
          <div className="row" style={{ gap: 10 }}>
            <IcUser size={20} />
            <div>
              <div className="strong">{profile?.name || 'Administrator'}</div>
              <div className="small muted">
                {profile?.username}
                {profile?.email ? ` · ${profile.email}` : ' · no email address'}
              </div>
            </div>
          </div>
          <span className={`badge ${profile?.totpEnabled ? 'badge-success' : 'badge-warn'}`}>
            {profile?.totpEnabled ? <><IcCheck size={13} /> 2FA on</> : '2FA off'}
          </span>
        </div>
      </div>

      {/* ---------- details ---------- */}
      <div className="card card-pad-lg mb-2">
        <div className="strong mb-2">Display details</div>
        <form onSubmit={saveDetails}>
          <div className="field">
            <label className="label" htmlFor="ap-name">Name</label>
            <input
              id="ap-name"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={50}
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-phone">Phone</label>
            <input
              id="ap-phone"
              className="input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              inputMode="tel"
              autoComplete="tel"
              maxLength={20}
              placeholder="Optional"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-dpass">Confirm with your password</label>
            <input
              id="ap-dpass"
              className="input"
              type="password"
              value={detailsPassword}
              onChange={(e) => setDetailsPassword(e.target.value)}
              autoComplete="current-password"
            />
            {/* Explaining the friction stops it reading as a pointless hoop. */}
            <p className="muted small mt-0">
              Your name appears in the audit log, so changing it needs more than an open session.
            </p>
          </div>
          <button className="btn" disabled={busy || !detailsPassword || !name.trim()}>
            {busy ? <span className="spinner" /> : 'Save details'}
          </button>
        </form>
      </div>

      {/* ---------- email ---------- */}
      <div className="card card-pad-lg mb-2">
        <div className="row" style={{ gap: 10 }}>
          <IcMail size={20} />
          <div className="strong">{hasEmail ? 'Change email address' : 'Add an email address'}</div>
        </div>
        <p className="muted small mt-1">
          {hasEmail
            ? 'Recovery codes go here, including the code that disables two-factor authentication. Changing it needs a code sent to the new address and an approval code sent to your current one.'
            : 'This is where recovery codes are sent, including the code that would disable two-factor authentication if you lost your phone.'}
        </p>

        {!ticket && (
          <form onSubmit={requestEmail} className="mt-1">
            <div className="field">
              <label className="label" htmlFor="ap-email">
                {hasEmail ? 'New email address' : 'Email address'}
              </label>
              <input
                id="ap-email"
                className="input"
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
              />
            </div>
            <div className="field">
              <label className="label" htmlFor="ap-epass">Confirm with your password</label>
              <input
                id="ap-epass"
                className="input"
                type="password"
                value={emailPassword}
                onChange={(e) => setEmailPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <button className="btn" disabled={busy || !emailPassword || !newEmail.trim()}>
              {busy ? <span className="spinner" /> : 'Send confirmation code'}
            </button>
          </form>
        )}

        {ticket && (
          <form onSubmit={confirmEmail} className="mt-1">
            <p className="small">
              Enter the code sent to <strong>{ticket.email}</strong>
              {ticket.approvalRequired && ticket.currentEmail
                ? <> and the approval code sent to <strong>{ticket.currentEmail}</strong></>
                : null}.
            </p>
            <div className="field">
              <label className="label" htmlFor="ap-code">Code sent to the new address</label>
              <input
                id="ap-code"
                className="input"
                value={emailCode}
                onChange={(e) => setEmailCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                style={{ letterSpacing: '0.18em', fontSize: 18 }}
              />
            </div>
            {ticket.approvalRequired && (
              <div className="field">
                <label className="label" htmlFor="ap-approve">Approval code sent to your current address</label>
                <input
                  id="ap-approve"
                  className="input"
                  value={approvalCode}
                  onChange={(e) => setApprovalCode(e.target.value)}
                  placeholder="123456"
                  inputMode="numeric"
                  maxLength={6}
                  style={{ letterSpacing: '0.18em', fontSize: 18 }}
                />
                <p className="muted small mt-0">
                  This proves it is really you, and not someone using your signed-in session.
                </p>
              </div>
            )}
            <div className="row wrap">
              <button
                className="btn"
                disabled={busy || !emailCode.trim() || (ticket.approvalRequired && !approvalCode.trim())}
              >
                {busy ? <span className="spinner" /> : 'Confirm email address'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setTicket(null); setEmailCode(''); setApprovalCode(''); }}
                disabled={busy}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {/* ---------- password ---------- */}
      <div className="card card-pad-lg">
        <div className="row" style={{ gap: 10 }}>
          <IcLock size={20} />
          <div className="strong">Change password</div>
        </div>
        <p className="muted small mt-1">
          Every other signed-in device is signed out. This one stays.
        </p>
        <form onSubmit={changePassword} className="mt-1">
          <div className="field">
            <label className="label" htmlFor="ap-cur">Current password</label>
            <input
              id="ap-cur"
              className="input"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-new">New password</label>
            <input
              id="ap-new"
              className="input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <p className="muted small mt-0">At least 8 characters.</p>
          </div>
          <div className="field">
            <label className="label" htmlFor="ap-conf">Repeat new password</label>
            <input
              id="ap-conf"
              className="input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <button
            className="btn"
            disabled={busy || !currentPassword || newPassword.length < 8 || !confirmPassword}
          >
            {busy ? <span className="spinner" /> : 'Change password'}
          </button>
        </form>
      </div>
    </>
  );
}
