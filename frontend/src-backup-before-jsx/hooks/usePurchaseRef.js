import { useRef, useCallback } from 'react';
import { makeRef } from '../config';

// ============================================================
//  usePurchaseRef — one reference per purchase INTENT, not per attempt
// ------------------------------------------------------------
//  Every purchase page used to call makeRef('AIR') inline:
//
//      transref: makeRef('AIR')       // <-- new value on every attempt
//
//  So a retry — a double tap, a "Confirm" pressed again after the
//  connection dropped, a wifi-to-mobile handover mid-request — arrived
//  at the backend wearing a reference it had never seen. Every guard
//  that keys on the reference was therefore looking at what appeared to
//  be a brand new purchase, and the user was charged twice.
//
//  This hook holds ONE reference for as long as the user is trying to
//  make one purchase. Retries reuse it, so the backend's idempotency
//  middleware recognises them and replays the original outcome instead
//  of buying again. reset() is called only after a confirmed success,
//  which is what starts the next purchase on a fresh reference.
//
//  It deliberately does NOT reset on failure. A failure the backend
//  answered has already released the key server-side, so reusing the
//  reference is harmless; and a failure it did NOT answer is exactly
//  the case where reusing it saves the user from a double charge.
//
//  Usage:
//      const ref = usePurchaseRef('AIR');
//      ...
//      await api.post('/airtime/purchase', { ..., transref: ref.value() });
//      ref.reset();   // only after success
// ============================================================
export function usePurchaseRef(prefix) {
  const held = useRef(null);

  // Created lazily on first read so that merely opening the page does
  // not mint a reference, and stable across re-renders.
  const value = useCallback(() => {
    if (!held.current) held.current = makeRef(prefix);
    return held.current;
  }, [prefix]);

  const reset = useCallback(() => {
    held.current = null;
  }, []);

  return { value, reset };
}

export default usePurchaseRef;
