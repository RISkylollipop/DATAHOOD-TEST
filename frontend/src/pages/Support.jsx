// ============================================================
//  Support — every way to reach a human, driven by SiteSettings.
// ------------------------------------------------------------
//  Renders in two contexts:
//    /app/support  → inside the authenticated Layout (has a sidebar)
//    /support      → standalone, reachable without logging in
//  The standalone case is the important one. Someone locked out of
//  their account, or watching a debit that never delivered, cannot get
//  behind the login wall to find a phone number.
// ============================================================

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useSiteSettings, supportChannels, socialLinks } from '../hooks/useSiteSettings';
import BlacklistReport from '../components/BlacklistReport';
import {
  IcSupport, IcMail, IcWhatsapp, IcTelegram, IcPhone,
  IcExternal, IcHistory, IcGlobe,
} from '../components/Icons';
import '../styles/Support.css';

const ICONS = {
  whatsapp: IcWhatsapp,
  whatsappgroup: IcWhatsapp,
  phone: IcPhone,
  email: IcMail,
  telegram: IcTelegram,
};

function ChannelCard({ ch }) {
  const Icon = ICONS[ch.key] || IcSupport;
  return (
    <a
      className="support-channel"
      href={ch.href}
      {...(ch.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      <span className="support-channel-icon"><Icon size={22} /></span>
      <span className="support-channel-body">
        <span className="support-channel-label">
          {ch.label}
          {ch.external && <IcExternal size={13} />}
        </span>
        <span className="support-channel-value">{ch.value}</span>
        {ch.hint && <span className="support-channel-hint">{ch.hint}</span>}
      </span>
    </a>
  );
}

export default function Support() {
  const { settings, loading } = useSiteSettings();
  const location = useLocation();
  const inApp = location.pathname.startsWith('/app');

  const channels = supportChannels(settings);
  const socials = socialLinks(settings);
  const brand = settings.sitename || 'DATAHOOD';

  const body = (
    <>
      <div className="support-head">
        <h1 className="support-title"><IcSupport size={26} /> Contact support</h1>
        <p className="muted">
          Reach us on any channel below. Quote your transaction reference and we
          can trace a purchase in seconds instead of asking you for it first.
        </p>
      </div>

      {loading && <div className="card card-pad-lg muted">Loading contact details…</div>}

      {!loading && channels.length > 0 && (
        <div className="support-grid">
          {channels.map((ch) => <ChannelCard key={ch.key} ch={ch} />)}
        </div>
      )}

      {!loading && channels.length === 0 && (
        <div className="card card-pad-lg">
          <p className="strong mt-0">Contact details are not configured yet.</p>
          <p className="muted small" style={{ marginBottom: 0 }}>
            An administrator needs to fill in the phone, email and WhatsApp
            fields under site settings before they appear here.
          </p>
        </div>
      )}

      <div className="card card-pad-lg mt-2">
        <h3 className="mt-0">Before you message us</h3>
        <p className="muted small">
          Most reports resolve faster with one detail attached. Have this ready:
        </p>
        <div className="kv">
          <div className="kv-row">
            <span className="muted small">Failed or pending purchase</span>
            <span className="small">The transaction reference</span>
          </div>
          <div className="kv-row">
            <span className="muted small">Wallet funding not showing</span>
            <span className="small">Your bank transfer receipt and the time sent</span>
          </div>
          <div className="kv-row">
            <span className="muted small">Wrong number recharged</span>
            <span className="small">The reference and the number you meant to use</span>
          </div>
          <div className="kv-row">
            <span className="muted small">Cannot log in</span>
            <span className="small">The email or phone number on the account</span>
          </div>
        </div>
        {inApp && (
          <Link className="btn btn-soft mt-2" to="/app/transactions">
            <IcHistory size={16} /> Find a transaction reference
          </Link>
        )}
      </div>

      <div className="card card-pad-lg mt-2">
        <h3 className="mt-0">A note on safety</h3>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {brand} staff will never ask for your password, your transaction PIN,
          or an OTP — not on WhatsApp, not on a call, not by email. Anyone who
          does is not us. We also never ask you to send money to a personal
          account; wallet funding only ever goes to the account shown inside
          your dashboard.
        </p>
      </div>

      {/* Follows the safety note deliberately: that paragraph tells someone
          what a scam looks like, and this is the thing to do once they have
          met one. Rendered in BOTH contexts — the endpoint needs no login,
          and a visitor scammed by a seller may have no account at all. */}
      <BlacklistReport />

      {socials.length > 0 && (
        <div className="support-socials">
          <span className="muted small"><IcGlobe size={14} /> Follow {brand}</span>
          {socials.map((sc) => (
            <a key={sc.key} className="btn btn-ghost btn-sm" href={sc.href}
              target="_blank" rel="noopener noreferrer">{sc.label}</a>
          ))}
        </div>
      )}
    </>
  );

  if (inApp) return <div className="support-page">{body}</div>;

  return (
    <div className="support-standalone">
      <div className="support-standalone-inner">
        <Link className="support-back" to="/login">← Back to login</Link>
        <div className="support-page">{body}</div>
      </div>
    </div>
  );
}
