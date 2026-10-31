import React, { useState, useRef, useEffect } from 'react';
import { Modal } from './Modal';

// Reusable 4-digit transaction PIN prompt. Calls onConfirm(pin) and
// shows a spinner while the parent's promise resolves.
//
// The confirmation line is built from `action` / `amount` / `target`:
//
//   action="purchase Airtime"  amount="₦100.00"  target="08012345678"
//   → "You are about to purchase Airtime of ₦100.00 to 08012345678"
//
// `connector` swaps the preposition for the services where "to" reads
// wrong ("for meter 1234567890", "for IUC 7012345678"). When no `action`
// is given it falls back to the older amount-only line, so any call site
// that has not been updated still renders something sensible.
export function PinModal({
  open, onClose, onConfirm, title = 'Enter transaction PIN',
  amount, action, target, connector = 'to', busy,
}) {
  const [digits, setDigits] = useState(['', '', '', '']);
  const refs = [useRef(), useRef(), useRef(), useRef()];

  useEffect(() => {
    if (open) {
      setDigits(['', '', '', '']);
      setTimeout(() => refs[0].current && refs[0].current.focus(), 60);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setAt = (i, v) => {
    if (!/^\d?$/.test(v)) return;
    const next = [...digits];
    next[i] = v;
    setDigits(next);
    if (v && i < 3) refs[i + 1].current && refs[i + 1].current.focus();
  };

  const onKey = (i, e) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs[i - 1].current.focus();
    if (e.key === 'Enter') submit();
  };

  const submit = () => {
    const pin = digits.join('');
    if (pin.length === 4) onConfirm(pin);
  };

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={title}>
      {action ? (
        <p className="muted center" style={{ marginTop: -6 }}>
          You are about to <span className="strong">{action}</span>
          {amount != null && <> of <span className="strong text-brand">{amount}</span></>}
          {target && <> {connector} <span className="strong">{target}</span></>}
        </p>
      ) : (
        amount != null && (
          <p className="muted center" style={{ marginTop: -6 }}>
            You are about to pay <span className="strong text-brand">{amount}</span>
          </p>
        )
      )}
      <div className="pin-boxes">
        {digits.map((d, i) => (
          <input
            key={i} ref={refs[i]} value={d} inputMode="numeric" maxLength={1}
            type="password" onChange={(e) => setAt(i, e.target.value)} onKeyDown={(e) => onKey(i, e)}
            disabled={busy}
          />
        ))}
      </div>
      <button className="btn btn-block" onClick={submit} disabled={busy || digits.join('').length !== 4}>
        {busy ? <span className="spinner" /> : 'Confirm'}
      </button>
      <button className="btn btn-ghost btn-block mt-1" onClick={onClose} disabled={busy}>Cancel</button>
    </Modal>
  );
}
