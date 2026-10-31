import React from 'react';
import { useTheme } from '../context/ThemeContext';
import { IcSun, IcMoon } from './Icons';

export function ModeToggle() {
  const { mode, toggleMode } = useTheme();
  return (
    <button className="icon-btn" onClick={toggleMode} title={mode === 'dark' ? 'Switch to light' : 'Switch to dark'}>
      {mode === 'dark' ? <IcSun size={18} /> : <IcMoon size={18} />}
    </button>
  );
}

export function ThemePicker({ onPick }) {
  const { theme, setTheme, themes } = useTheme();
  return (
    <div className="theme-dots">
      {themes.map((t) => (
        <span
          key={t.id}
          className={`theme-dot ${theme === t.id ? 'active' : ''}`}
          style={{ background: t.color }}
          title={t.name}
          onClick={() => { setTheme(t.id); onPick && onPick(t.id); }}
        />
      ))}
    </div>
  );
}
