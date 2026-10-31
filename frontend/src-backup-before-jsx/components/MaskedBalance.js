import React, { useCallback, useEffect, useState } from 'react';
import { IcEye, IcEyeOff } from './Icons';

// ============================================================
//  Wallet balance masking — lets the user hide their balance
//  behind dots (e.g. in public / on a shared screen). The choice
//  persists across reloads (localStorage) and stays in sync across
//  every mounted balance card via a window event, so toggling on
//  the dashboard also hides it on the wallet page and vice-versa.
// ============================================================

const KEY = 'datahood_hide_balance';
const EVT = 'datahood:balancemask';

function read() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function useBalanceMask() {
  const [hidden, setHidden] = useState(read);

  useEffect(() => {
    const sync = () => setHidden(read());
    window.addEventListener(EVT, sync);
    // storage event fires for changes from other tabs
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const toggle = useCallback(() => {
    const next = !read();
    try { localStorage.setItem(KEY, next ? '1' : '0'); } catch { /* ignore */ }
    setHidden(next);
    window.dispatchEvent(new Event(EVT));
  }, []);

  return { hidden, toggle };
}

// Renders an amount that can be masked. `render` should turn the raw
// value into its display string (e.g. formatNaira). When hidden we show
// a fixed run of dots so the width doesn't leak the number of digits.
export function MaskedAmount({ value, hidden, render }) {
  if (hidden) return <span aria-label="hidden balance">••••••</span>;
  return <>{render ? render(value) : value}</>;
}

// The eye toggle button. `light` tints it for use on the dark balance-card.
export function MaskToggle({ hidden, onToggle, light, size = 18, style }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={hidden ? 'Show balance' : 'Hide balance'}
      aria-label={hidden ? 'Show balance' : 'Hide balance'}
      className="icon-btn"
      style={{
        background: light ? 'rgba(255,255,255,0.2)' : 'transparent',
        color: light ? '#fff' : 'inherit',
        border: 'none',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 4,
        borderRadius: 8,
        ...style,
      }}
    >
      {hidden ? <IcEyeOff size={size} /> : <IcEye size={size} />}
    </button>
  );
}
