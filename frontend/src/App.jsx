import React, { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import applyCanonical from './hooks/useCanonical';
import { ProtectedRoute, AdminRoute } from './components/Guards';
import { Layout } from './components/Layout';
import { AdminLayout } from './components/AdminLayout';
import { useAuth } from './context/AuthContext';

import Landing from './pages/Landing';
import { Terms, Privacy } from './pages/Legal';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import Dashboard from './pages/Dashboard';
import Airtime from './pages/Airtime';
import Data from './pages/Data';
import Electricity from './pages/Electricity';
import Cable from './pages/Cable';
// import Verify from './pages/Verify';
// import VerifyRecord from './pages/VerifyRecord';
import Wallet from './pages/Wallet';
import Transactions from './pages/Transactions';
import Profile from './pages/Profile';
import Pricing from './pages/Pricing';
import Support from './pages/Support';
import NewsletterAction from './pages/NewsletterAction';

import AdminLogin from './pages/admin/AdminLogin';
import AdminOverview from './pages/admin/AdminOverview';
import AdminProviders from './pages/admin/AdminProviders';
import AdminPlans from './pages/admin/AdminPlans';
import AdminSales from './pages/admin/AdminSales';
import AdminUsers from './pages/admin/AdminUsers';
import AdminGateways from './pages/admin/AdminGateways';
import AdminVerification from './pages/admin/AdminVerification';
import AdminTransactions from './pages/admin/AdminTransactions';
import AdminBlacklist from './pages/admin/AdminBlacklist';
import AdminSecurity from './pages/admin/AdminSecurity';
import AdminProfile from './pages/admin/AdminProfile';
import AdminSiteSettings from './pages/admin/AdminSiteSettings';
import AdminNewsletter from './pages/admin/AdminNewsletter';

// An already-signed-in user asking for `/` wants their dashboard, not the
// marketing page — that was the behaviour before the landing page existed and
// there is no reason to make them click through a sales pitch to reach their
// wallet. Anonymous visitors get the landing page. Admins are sent to their
// own console for the same reason.
function RootRoute() {
  const { isAuthed, isAdmin } = useAuth();
  if (isAdmin) return <Navigate to="/admin" replace />;
  if (isAuthed) return <Navigate to="/app" replace />;
  return <Landing />;
}

/* Single-page app: one index.html serves every URL, so the canonical tag
   must be rewritten as the route changes. See the hook for why the
   production origin is hardcoded and why non-indexable routes get no tag
   at all. */
function useCanonical() {
  const { pathname } = useLocation();
  useEffect(() => { applyCanonical(pathname); }, [pathname]);
}

export default function App() {
  useCanonical();
  return (
    <Routes>
      {/* `/` used to be `<Navigate to="/app" />`, which sent every anonymous
          visitor through ProtectedRoute to the login screen — so search
          results, adverts and shared links all landed on a sign-in form for
          a product the visitor had not yet had described to them.
          RootRoute keeps the old behaviour for people who are already signed
          in (they want the dashboard, not the sales pitch) and shows the
          landing page to everyone else. */}
      <Route path="/" element={<RootRoute />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/pricing" element={<Pricing />} />
      {/* Linked from the landing footer. Content is still being written, but
          the routes exist so the links are never dead — see pages/Legal.jsx. */}
      <Route path="/terms" element={<Terms />} />
      <Route path="/privacy" element={<Privacy />} />
      {/* Public on purpose: someone locked out of their account, or
          chasing a debit that never delivered, must still be able to
          find a phone number without getting past the login wall. */}
      <Route path="/support" element={<Support />} />
      {/* Reached only by clicking a link inside an email, so they must work
          with no session and must never be swallowed by the catch-all
          redirect below — a dead unsubscribe link is what turns an annoyed
          reader into a spam complaint against the whole sending domain. */}
      <Route path="/newsletter/confirm" element={<NewsletterAction mode="confirm" />} />
      <Route path="/newsletter/unsubscribe" element={<NewsletterAction mode="unsubscribe" />} />
      <Route path="/admin/login" element={<AdminLogin />} />

      <Route path="/app" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="airtime" element={<Airtime />} />
        <Route path="data" element={<Data />} />
        <Route path="electricity" element={<Electricity />} />
        <Route path="cable" element={<Cable />} />
        {/* <Route path="verify" element={<Verify />} /> */}
        {/* <Route path="verify/:vId" element={<VerifyRecord />} /> */}
        <Route path="wallet" element={<Wallet />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="profile" element={<Profile />} />
        <Route path="support" element={<Support />} />
      </Route>

      <Route path="/admin" element={<AdminRoute><AdminLayout /></AdminRoute>}>
        <Route index element={<AdminOverview />} />
        <Route path="providers" element={<AdminProviders />} />
        <Route path="plans" element={<AdminPlans />} />
        <Route path="sales" element={<AdminSales />} />
        <Route path="users" element={<AdminUsers />} />
        <Route path="gateways" element={<AdminGateways />} />
        <Route path="verification" element={<AdminVerification />} />
        <Route path="transactions" element={<AdminTransactions />} />
        <Route path="blacklist" element={<AdminBlacklist />} />
        <Route path="settings" element={<AdminSiteSettings />} />
        <Route path="newsletter" element={<AdminNewsletter />} />
        <Route path="security" element={<AdminSecurity />} />
        <Route path="profile" element={<AdminProfile />} />
      </Route>

      {/* Unknown URL: fall back to `/`, which resolves per auth state above.
          Previously this pointed at /app, so a mistyped or stale public link
          dead-ended on the login form instead of the front page. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
