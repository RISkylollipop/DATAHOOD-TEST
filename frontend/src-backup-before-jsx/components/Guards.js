import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export function ProtectedRoute({ children }) {
  const { isAuthed, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return null;
  if (!isAuthed) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return children;
}

export function AdminRoute({ children }) {
  const { isAdmin, ready } = useAuth();
  if (!ready) return null;
  if (!isAdmin) return <Navigate to="/admin/login" replace />;
  return children;
}
