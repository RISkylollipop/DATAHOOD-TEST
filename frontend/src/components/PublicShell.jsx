// ============================================================
//  PublicShell — header + page frame for signed-out pages
// ------------------------------------------------------------
//  Used by /terms, /privacy and the newsletter confirm/unsubscribe
//  pages. These are reached by people who are NOT signed in — from a
//  footer link, a search result, or a link inside an email — so they
//  cannot use components/Layout.jsx, which assumes a session and renders
//  the app sidebar.
//
//  Extracted rather than copied: this markup previously lived inside
//  Legal.jsx, and a third page needing the same header is exactly the
//  point where a copy starts drifting from its original.
// ============================================================

import { Link } from 'react-router-dom';
import '../styles/Landing.css';

export function PublicShell({ title, narrow = true, children }) {
  return (
    <div className="lp">
      <header className="lp-header">
        <div className="lp-container lp-header-inner">
          <Link to="/" className="lp-brand" aria-label="DATAHOOD home">
            <img src="/logo-mark.png" alt="" width={32} height={32} className="brand-mark" />
            <span>DATAHOOD</span>
          </Link>
          <div className="lp-header-cta">
            <Link to="/login" className="btn btn-ghost btn-sm">Sign in</Link>
            <Link to="/register" className="btn btn-sm">Get started</Link>
          </div>
        </div>
      </header>
      <main className="lp-section">
        <div className={`lp-container ${narrow ? 'lp-narrow' : ''} lp-legal`}>
          <h1>{title}</h1>
          {children}
          <p className="lp-legal-back"><Link to="/">&larr; Back to home</Link></p>
        </div>
      </main>
    </div>
  );
}
