// ============================================================
//  SupportLink — the words "contact support" as an actual route.
// ------------------------------------------------------------
//  Several places in the app told users to "contact support" as plain
//  prose, with nothing to click. This resolves to the best configured
//  channel (WhatsApp, then email) and falls back to the Support page,
//  so the link is never dead even when SiteSettings is empty.
// ============================================================

import React from 'react';
import { Link } from 'react-router-dom';
import { useSiteSettings, primarySupportHref } from '../hooks/useSiteSettings';

export function SupportLink({ children = 'contact support', className = 'support-inline-link' }) {
  const { settings } = useSiteSettings();
  const href = primarySupportHref(settings);

  // An internal path needs the router; wa.me / tel: / mailto: need a
  // plain anchor. Deciding by prefix keeps the caller from caring.
  if (href.startsWith('/')) {
    return <Link className={className} to={href}>{children}</Link>;
  }

  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}
