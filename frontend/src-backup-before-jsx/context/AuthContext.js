import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken } from '../api/client';
import { useTheme } from './ThemeContext';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

const USER_KEY = 'datahood_user';
const ADMIN_KEY = 'datahood_admin';

export function AuthProvider({ children }) {
  const { setTheme } = useTheme();
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY)) || null; } catch { return null; }
  });
  const [admin, setAdmin] = useState(() => {
    try { return JSON.parse(localStorage.getItem(ADMIN_KEY)) || null; } catch { return null; }
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // If a token exists but no cached user, we still render; individual
    // pages will refetch. Mark ready immediately.
    setReady(true);
    const onUnauth = () => logout();
    window.addEventListener('datahood:unauthorized', onUnauth);
    return () => window.removeEventListener('datahood:unauthorized', onUnauth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistUser = useCallback((u) => {
    setUser(u);
    if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
    else localStorage.removeItem(USER_KEY);
  }, []);

  const login = useCallback(async (identifier, password) => {
    const res = await api.post('/auth/login', { identifier, password });
    setToken(res.token);
    persistUser(res.user);
    localStorage.removeItem(ADMIN_KEY);
    setAdmin(null);
    if (res.user?.theme) setTheme(res.user.theme);
    return res.user;
  }, [persistUser, setTheme]);

  const register = useCallback(async (form) => {
    const res = await api.post('/auth/register', form);
    setToken(res.token);
    persistUser(res.user);
    return res.user;
  }, [persistUser]);

  const adminLogin = useCallback(async (username, password) => {
    const res = await api.post('/auth/admin/login', { username, password });
    setToken(res.token);
    setAdmin(res.admin);
    localStorage.setItem(ADMIN_KEY, JSON.stringify(res.admin));
    localStorage.removeItem(USER_KEY);
    setUser(null);
    return res.admin;
  }, []);

  const logout = useCallback(() => {
    setToken('');
    persistUser(null);
    setAdmin(null);
    localStorage.removeItem(ADMIN_KEY);
  }, [persistUser]);

  const updateUser = useCallback((patch) => {
    setUser((u) => {
      const next = { ...u, ...patch };
      localStorage.setItem(USER_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const value = {
    user, admin, ready,
    isAuthed: !!getToken() && !!user,
    isAdmin: !!getToken() && !!admin,
    login, register, adminLogin, logout, updateUser, setUser: persistUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
