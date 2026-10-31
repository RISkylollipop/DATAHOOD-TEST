import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, getToken, setToken, getSessionIdleMs, isTokenExpired } from '../api/client';
import { startIdleWatch, clearIdleStamp, DEFAULT_IDLE_MS } from '../utils/idleSession';
import { useTheme } from './ThemeContext';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

const USER_KEY = 'datahood_user';
const ADMIN_KEY = 'datahood_admin';

/**
 * Drop a session that is already over before the app renders anything.
 *
 * The cached user in localStorage outlives the token, so restoring it blindly
 * produced a dashboard that looked signed in, fired its opening requests, and
 * collected a 401 for each — the user's "Could not load wallet" was three
 * parallel calls on a token that had expired 74 minutes earlier while the
 * browser was closed. Deciding this BEFORE the first render is what turns
 * that into an ordinary login screen.
 *
 * Runs at module scope, not in an effect, because useState initialisers below
 * read this storage on the very first render — an effect would be too late.
 */
function discardExpiredSession() {
  if (typeof window === 'undefined' || !isTokenExpired()) return;
  try { sessionStorage.setItem('datahood_logout_reason', 'expired'); } catch { /* ignore */ }
  try {
    setToken('');
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(ADMIN_KEY);
  } catch { /* private mode */ }
}

export function AuthProvider({ children }) {
  const { setTheme } = useTheme();
  const [user, setUser] = useState(() => {
    discardExpiredSession();
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

  // Every path that adopts a NEW token clears the idle stamp first, so the
  // watchdog starts a fresh window instead of inheriting the previous
  // session's. This is load-bearing: the watchdog now PRESERVES an existing
  // stamp (it has to, or closing the browser hides a real absence), which
  // means a leftover stamp from an hour ago would be read as "idle since
  // then" and sign the user out seconds after a successful login — the very
  // symptom being fixed here.
  const login = useCallback(async (identifier, password) => {
    const res = await api.post('/auth/login', { identifier, password });
    clearIdleStamp();
    setToken(res.token);
    persistUser(res.user);
    localStorage.removeItem(ADMIN_KEY);
    setAdmin(null);
    if (res.user?.theme) setTheme(res.user.theme);
    return res.user;
  }, [persistUser, setTheme]);

  const register = useCallback(async (form) => {
    const res = await api.post('/auth/register', form);
    clearIdleStamp();
    setToken(res.token);
    persistUser(res.user);
    return res.user;
  }, [persistUser]);

  // Shared tail of both admin sign-in paths: adopt the session the backend
  // just issued. Kept in one place so the 2FA route can never accidentally
  // skip a step the password-only route performs (or vice versa).
  const adoptAdminSession = useCallback((token, adminRow) => {
    clearIdleStamp(); // fresh window — see the note on login()
    setToken(token);
    setAdmin(adminRow);
    localStorage.setItem(ADMIN_KEY, JSON.stringify(adminRow));
    localStorage.removeItem(USER_KEY);
    setUser(null);
    return adminRow;
  }, []);

  /**
   * Password step.
   *
   * When the account has 2FA enabled the backend answers with
   * { twoFactorRequired: true, challenge } and NO token — deliberately, since
   * an ordinary admin token already opens every admin route, so handing one
   * over before the second factor would make 2FA decorative. So this must NOT
   * touch the token here: calling setToken(undefined) would clear a session
   * and setAdmin(undefined) would leave the app believing it is signed in as
   * nobody. Return the challenge and let the caller collect the code.
   */
  const adminLogin = useCallback(async (username, password) => {
    const res = await api.post('/auth/admin/login', { username, password });
    if (res.twoFactorRequired) {
      return { twoFactorRequired: true, challenge: res.challenge, msg: res.msg };
    }
    return { twoFactorRequired: false, admin: adoptAdminSession(res.token, res.admin) };
  }, [adoptAdminSession]);

  /**
   * Second step: redeem the challenge for a real session.
   *
   * `code` is either the 6-digit authenticator code or a backup code; the
   * backend tries them in that order, so the UI does not need two fields.
   * Failures arrive as 400 (challenge dead — start over) or 422 (wrong code —
   * stay put), never 401, so client.jsx's auto-logout does not fire mid-flow.
   */
  const verifyAdmin2fa = useCallback(async (challenge, code) => {
    const res = await api.post('/auth/admin/2fa/verify', { challenge, code });
    const data = res.data || {};
    adoptAdminSession(data.token, data.admin);
    return { admin: data.admin, usedBackupCode: !!data.usedBackupCode };
  }, [adoptAdminSession]);

  const logout = useCallback(() => {
    setToken('');
    clearIdleStamp();
    persistUser(null);
    setAdmin(null);
    localStorage.removeItem(ADMIN_KEY);
  }, [persistUser]);

  // ---- 15-minute idle timeout ----
  //
  // Only while someone is actually signed in: an unauthenticated visitor
  // reading the landing page has no session to end, and running the timer
  // there would fire a pointless logout and a "signed out" notice at them.
  //
  // The watchdog tracks real interaction, NOT requests. The server does the
  // latter (it slides the token forward on traffic), and traffic is not proof
  // of a person — a screen polling a running job would otherwise keep an
  // unattended session alive indefinitely. Each half sees what the other
  // cannot, so a session ends when EITHER decides it should. The watchdog is
  // also handed the token's own expiry, since the reverse gap exists too:
  // interaction without traffic leaves a live person holding a dead token.
  const signedIn = !!user || !!admin;
  useEffect(() => {
    if (!signedIn) return undefined;
    return startIdleWatch({
      // The server tells us its real window via X-Session-Expires-In; fall
      // back to 15 minutes until the first renewal header arrives.
      idleMs: getSessionIdleMs() || DEFAULT_IDLE_MS,
      // Second death, separate from idleness: the token can be past its
      // expiry while interaction is fresh, because renewal rides on REQUESTS
      // and reading a long page makes none. Without this the watchdog stays
      // silent and the next click collects a 401 instead.
      //
      // A FULL WINDOW of grace, not isTokenExpired's usual 5 minutes. `exp`
      // was written against the server's clock and is read here against the
      // browser's, and this check runs on a live page rather than only at
      // load — so on a machine whose clock runs fast, the tighter grace would
      // sign the user out seconds after a successful login, over and over,
      // and look exactly like login being broken. With a window of margin it
      // can only fire on the case it is for: someone interacting steadily for
      // ~30 minutes while making no requests at all.
      isSessionDead: () => isTokenExpired(getSessionIdleMs() || DEFAULT_IDLE_MS),
      onExpire: (reason) => {
        // Recorded before logout so the login screen can say why the user is
        // suddenly looking at it. sessionStorage, not local: the explanation
        // belongs to this tab and should not resurface in a new window days
        // later. Cleared by the login screen once shown.
        //
        // The reason comes FROM the watchdog rather than being assumed here.
        // It was hardcoded 'idle', which was a lie in the token-expiry case
        // above — telling someone who had been working the whole time that
        // they were inactive. Both screens already render either string.
        try { sessionStorage.setItem('datahood_logout_reason', reason || 'idle'); } catch { /* ignore */ }
        logout();
      },
    });
  }, [signedIn, logout]);

  const updateUser = useCallback((patch) => {
    setUser((u) => {
      const next = { ...u, ...patch };
      localStorage.setItem(USER_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const updateAdmin = useCallback((patch) => {
    setAdmin((a) => {
      const next = { ...a, ...patch };
      localStorage.setItem(ADMIN_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  /**
   * Swap in a replacement admin token mid-session.
   *
   * Some admin actions bump the account's token version on the server to
   * evict other sessions — enabling 2FA does, because the usual reason to
   * enable it is a suspected compromise, and the intruder's stolen token
   * would otherwise keep working for days. That bump also invalidates the
   * token the ACTING admin is holding, so the endpoint hands back a fresh
   * one and it has to be adopted here.
   *
   * Skipping this is not a subtle failure but it is a silent one: nothing
   * breaks until the next admin request, which 401s, and client.jsx then
   * wipes the session — potentially while the once-only backup codes are
   * still on screen.
   */
  const rotateAdminToken = useCallback((token) => {
    if (token) setToken(token);
  }, []);

  const value = {
    user, admin, ready,
    isAuthed: !!getToken() && !!user,
    isAdmin: !!getToken() && !!admin,
    login, register, adminLogin, verifyAdmin2fa, logout,
    updateUser, updateAdmin, rotateAdminToken, setUser: persistUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
