import React from 'react';

export function Loader({ full }) {
  if (full) {
    return <div className="loader-full"><span className="spinner spinner-brand" style={{ width: 34, height: 34 }} /></div>;
  }
  return <span className="spinner spinner-brand" />;
}

export function Empty({ title = 'Nothing here yet', message, children }) {
  return (
    <div className="empty">
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      {message && <div className="small mt-1">{message}</div>}
      {children}
    </div>
  );
}
