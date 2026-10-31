import { createContext, useContext, useState, useCallback, useMemo } from 'react';

const ToastContext = createContext(null);
export const useToast = () => useContext(ToastContext);

let idc = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const remove = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const push = useCallback((type, title, message) => {
    const id = ++idc;
    setToasts((t) => [...t, { id, type, title, message }]);
    setTimeout(() => remove(id), 4500);
  }, [remove]);

  // MUST stay referentially stable. Consumers list `toast` in useCallback /
  // useEffect dependency arrays (see AdminPlans, AdminUsers, Transactions...).
  // When this was a bare object literal it got a new identity on every render
  // of this provider — and this provider re-renders every time a toast is
  // pushed OR auto-removed. That turned one failed fetch into an unbounded
  // request storm: load fails -> toast.error -> setToasts -> provider
  // re-renders -> new `toast` -> new loader callback -> effect refires ->
  // load fails again. It drained the global rate-limit budget in seconds and
  // locked operators out of /auth/login as collateral damage.
  // `push` is a stable useCallback, so this memo never recomputes.
  const toast = useMemo(() => ({
    success: (title, message) => push('success', title, message),
    error: (title, message) => push('error', title, message),
    info: (title, message) => push('info', title, message),
  }), [push]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`} onClick={() => remove(t.id)}>
            <div className="tt">{t.title}</div>
            {t.message && <div className="tm">{t.message}</div>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
