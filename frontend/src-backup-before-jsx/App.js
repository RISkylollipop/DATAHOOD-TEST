import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute, AdminRoute } from './components/Guards';
import { Layout } from './components/Layout';
import { AdminLayout } from './components/AdminLayout';

import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import Dashboard from './pages/Dashboard';
import Airtime from './pages/Airtime';
import Data from './pages/Data';
import Electricity from './pages/Electricity';
import Cable from './pages/Cable';
import Verify from './pages/Verify';
import VerifyRecord from './pages/VerifyRecord';
import Wallet from './pages/Wallet';
import Transactions from './pages/Transactions';
import Profile from './pages/Profile';
import Pricing from './pages/Pricing';

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

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/app" replace />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/admin/login" element={<AdminLogin />} />

      <Route path="/app" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<Dashboard />} />
        <Route path="airtime" element={<Airtime />} />
        <Route path="data" element={<Data />} />
        <Route path="electricity" element={<Electricity />} />
        <Route path="cable" element={<Cable />} />
        <Route path="verify" element={<Verify />} />
        <Route path="verify/:vId" element={<VerifyRecord />} />
        <Route path="wallet" element={<Wallet />} />
        <Route path="pricing" element={<Pricing />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="profile" element={<Profile />} />
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
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
