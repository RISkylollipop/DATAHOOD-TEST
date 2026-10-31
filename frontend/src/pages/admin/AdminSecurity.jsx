// ============================================================
//  Admin security — authenticator-app enrolment and removal.
// ------------------------------------------------------------
//  Mirrors the two-phase backend flow and does not try to simplify it:
//
//    setup()   stores an encrypted secret, 2FA still OFF
//    confirm() requires a live code, then flips it ON and returns the
//              backup codes ONCE
//
//  Collapsing that into one step would mean a mis-scanned QR locks the admin
//  out with a database edit as the only way back.
//
//  The backup codes are shown exactly once, in the confirm() response — only
//  their bcrypt hashes are stored, so no later request can recover them. The
//  UI therefore refuses to leave that panel until the admin ticks "saved".
// ============================================================

import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { Loader } from '../../components/Loader';
import { formatDate } from '../../config';
import { IcShield, IcCopy, IcCheck, IcRefresh } from '../../components/Icons';

export default function AdminSecurity() {
  const toast = useToast();
  const { updateAdmin, rotateAdminToken } = useAuth();

  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Enrolment
  const [enrol, setEnrol] = useState(null);   // { qrDataUrl, manualKey, account }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null);   // plaintext backup codes, once
  const [saved, setSaved] = useState(false);

  // Removal
  const [removing, setRemoving] = useState(false);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/auth/admin/2fa/status')
      .then((r) => setState(r.data || null))
      .catch((err) => toast.error('Could not load security status', err.message))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const startSetup = async () => {
    setBusy(true);
    try {
      const r = await api.post('/auth/admin/2fa/setup');
      setEnrol(r.data);
      setCode('');
    } catch (err) {
      toast.error('Could not start setup', err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async (e) => {
    e.preventDefault();
    if (!code.trim()) return toast.error('Enter the 6-digit code from your app.');
    setBusy(true);
    try {
      const r = await api.post('/auth/admin/2fa/confirm', { code: code.trim() });
      // FIRST, before anything else can throw or re-render: adopt the
      // replacement token. Enabling 2FA bumps the account's token version
      // server-side to evict any other live session, which also kills the
      // token this very request was made with. Miss this and the next admin
      // request 401s, client.jsx wipes the session, and this component
      // unmounts holding the only copy of the backup codes.
      rotateAdminToken(r.data?.token);
      setCodes(r.data?.backupCodes || []);
      setSaved(false);
      setEnrol(null);
      setCode('');
      // Deliberately NOT calling load() here.
      //
      // These backup codes exist in exactly one place: this response. Only
      // bcrypt hashes are stored, so no later request can recover them. A
      // refetch would set loading=true and hide the codes panel behind the
      // spinner at the moment they are created — and if that request came
      // back 401 (token expired this second), client.jsx wipes the token,
      // AuthContext logs out, this component unmounts, and the admin now has
      // 2FA switched ON having never seen a single backup code.
      //
      // Everything the status card needs is already in this response or
      // known locally, so patch it in rather than asking again.
      setState((s) => ({
        ...(s || {}),
        enabled: true,
        confirmedAt: new Date().toISOString(),
        backupCodesRemaining: (r.data?.backupCodes || []).length,
        secretReadable: true,
      }));
      if (r.data?.admin) updateAdmin(r.data.admin);
    } catch (err) {
      toast.error('That code was not accepted', err.message);
    } finally {
      setBusy(false);
    }
  };

  const requestOtp = async () => {
    setBusy(true);
    try {
      const r = await api.post('/auth/admin/2fa/disable/request');
      setOtpSent(true);
      // Issuing a new code supersedes the old one, so anything already typed
      // is now guaranteed wrong — and every wrong submission burns one of the
      // five attempts before the code locks out. Clear it rather than letting
      // the admin submit stale digits.
      setOtp('');
      toast.success('Code sent', r.msg);
    } catch (err) {
      toast.error('Could not send the code', err.message);
    } finally {
      setBusy(false);
    }
  };

  const confirmDisable = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.post('/auth/admin/2fa/disable', { password, otp: otp.trim() });
      toast.success('Two-factor authentication disabled', r.msg);
      setRemoving(false); setOtpSent(false); setPassword(''); setOtp('');
      load();
    } catch (err) {
      toast.error('Could not disable', err.message);
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async () => {
    try {
      await navigator.clipboard.writeText((codes || []).join('\n'));
      toast.success('Copied to clipboard');
    } catch {
      toast.error('Copy failed', 'Select the codes and copy them manually.');
    }
  };

  if (loading) return <Loader />;

  const enabled = !!state?.enabled;

  return (
    <>
      <div className="row between wrap mb-2">
        <div>
          <div className="page-title">Security</div>
          <div className="page-sub">Protect your admin account with an authenticator app.</div>
        </div>
        <button className="btn btn-soft btn-sm" onClick={load} disabled={busy}>
          <IcRefresh size={15} /> Refresh
        </button>
      </div>

      {/* ---------- backup codes: shown once, and only once ---------- */}
      {codes && (
        <div className="card card-pad-lg mb-2">
          <div className="strong mb-2">Save your backup codes</div>
          <p className="muted small">
            Each code works once, and only if your authenticator app is unavailable.
            We store one-way hashes, so this is the only time they can be shown.
            Print them or keep them in a password manager.
          </p>
          <div className="grid grid-2 mt-1" style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 15 }}>
            {codes.map((c) => <div key={c} style={{ padding: '6px 0', letterSpacing: '0.06em' }}>{c}</div>)}
          </div>
          <div className="row wrap mt-1">
            <button className="btn btn-soft btn-sm" onClick={copyCodes}><IcCopy size={15} /> Copy all</button>
          </div>
          <label className="row mt-1" style={{ gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            <span className="small">I have saved these codes somewhere safe</span>
          </label>
          <button className="btn btn-block mt-1" disabled={!saved} onClick={() => setCodes(null)}>
            Done
          </button>
        </div>
      )}

      {/* ---------- enrolment ---------- */}
      {enrol && !codes && (
        <div className="card card-pad-lg mb-2">
          <div className="strong mb-2">Scan this with your authenticator app</div>
          <p className="muted small">
            Google Authenticator, Authy, 1Password, Microsoft Authenticator — any app
            that scans a QR code will work. Two-factor authentication is not active
            until you enter a code below.
          </p>
          <div className="center mt-1">
            <img
              src={enrol.qrDataUrl}
              alt="Two-factor authentication QR code"
              width={216}
              height={216}
              style={{ background: '#fff', padding: 10, borderRadius: 12 }}
            />
          </div>
          <div className="field mt-1">
            <div className="label">Can&apos;t scan? Enter this key by hand</div>
            <div className="row between wrap" style={{ gap: 8 }}>
              <code style={{ letterSpacing: '0.08em', wordBreak: 'break-all' }}>{enrol.manualKey}</code>
              <button
                className="btn btn-soft btn-sm"
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(String(enrol.manualKey).replace(/\s/g, ''));
                    toast.success('Key copied');
                  } catch {
                    toast.error('Copy failed', 'Select the key and copy it manually.');
                  }
                }}
              >
                <IcCopy size={15} /> Copy
              </button>
            </div>
            <p className="muted small mt-0">Account: {enrol.account}</p>
          </div>
          <form onSubmit={confirmSetup}>
            <div className="field">
              <label className="label" htmlFor="tfa-confirm">Enter the 6-digit code</label>
              <input
                id="tfa-confirm"
                className="input"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                style={{ letterSpacing: '0.18em', fontSize: 18 }}
              />
            </div>
            <div className="row wrap">
              <button className="btn" disabled={busy}>
                {busy ? <span className="spinner" /> : 'Turn on two-factor'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setEnrol(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ---------- status ---------- */}
      {!enrol && !codes && (
        <div className="card card-pad-lg">
          <div className="row between wrap">
            <div className="row" style={{ gap: 10 }}>
              <IcShield size={20} />
              <div>
                <div className="strong">Authenticator app</div>
                <div className="small muted">
                  {enabled
                    ? `Enabled${state?.confirmedAt ? ` on ${formatDate(state.confirmedAt)}` : ''}`
                    : 'Not enabled — your password alone opens this panel'}
                </div>
              </div>
            </div>
            <span className={`badge ${enabled ? 'badge-success' : 'badge-warn'}`}>
              {enabled ? <><IcCheck size={13} /> On</> : 'Off'}
            </span>
          </div>

          {enabled && (
            <p className="muted small mt-1">
              {state?.backupCodesRemaining || 0} backup code
              {state?.backupCodesRemaining === 1 ? '' : 's'} remaining.
              {state?.backupCodesRemaining === 0
                ? ' With none left, a lost phone means an administrator has to clear this from the database.'
                : ''}
            </p>
          )}

          {/* The rotated-APP_ENCRYPTION_KEY case. Surfaced here rather than
              leaving the admin to discover it at their next sign-in, when
              their app's codes suddenly stop working. */}
          {enabled && state?.secretReadable === false && (
            <p className="small mt-1" style={{ color: 'var(--danger)' }}>
              This account&apos;s two-factor secret can no longer be read, so codes from your
              authenticator app will not work. Sign in with a backup code, then disable and
              re-enrol.
            </p>
          )}

          <div className="row wrap mt-1">
            {!enabled && (
              <button
                className="btn"
                onClick={startSetup}
                // No mailbox means requestDisable() will refuse with a 409
                // forever, so enrolling would be a one-way door: the only
                // exits left are the phone and ten backup codes, and losing
                // both costs a database edit. Refuse at the door instead of
                // discovering it at removal time.
                disabled={busy || state?.canDisableOnline === false}
              >
                {busy ? <span className="spinner" /> : 'Set up authenticator app'}
              </button>
            )}
            {enabled && !removing && (
              <button
                className="btn btn-ghost"
                onClick={() => setRemoving(true)}
                disabled={busy || state?.canDisableOnline === false}
              >
                Disable two-factor
              </button>
            )}
          </div>

          {state?.canDisableOnline === false && (
            <p className="muted small mt-1">
              {enabled
                ? 'This account has no email address, so two-factor authentication cannot be disabled here. Ask an administrator.'
                : 'This account has no email address. Add one before enabling two-factor authentication — without a mailbox there is no way to switch it off again if you lose your phone.'}
            </p>
          )}

          {/* Removal is deliberately harder than enrolment: password plus an
              emailed code. A stolen session must not be enough to strip off
              the protection that session theft is what 2FA exists to survive. */}
          {enabled && removing && (
            <form onSubmit={confirmDisable} className="mt-1">
              <p className="muted small">
                Confirm with your password and a code sent to your email address.
              </p>
              <div className="field">
                <label className="label" htmlFor="tfa-pass">Password</label>
                <input
                  id="tfa-pass"
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="field">
                <label className="label" htmlFor="tfa-otp">Email code</label>
                <div className="row wrap" style={{ gap: 8 }}>
                  <input
                    id="tfa-otp"
                    className="input"
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
                    placeholder="123456"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    style={{ flex: 1, minWidth: 140 }}
                  />
                  <button type="button" className="btn btn-soft btn-sm" onClick={requestOtp} disabled={busy}>
                    {otpSent ? 'Resend code' : 'Send code'}
                  </button>
                </div>
              </div>
              <div className="row wrap">
                <button className="btn btn-danger" disabled={busy || !password || !otp.trim()}>
                  {busy ? <span className="spinner" /> : 'Disable two-factor'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => { setRemoving(false); setPassword(''); setOtp(''); setOtpSent(false); }}
                  disabled={busy}
                >
                  Keep it on
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </>
  );
}
