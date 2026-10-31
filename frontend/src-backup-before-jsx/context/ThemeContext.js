import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { THEMES } from '../config';

const ThemeContext = createContext(null);
export const useTheme = () => useContext(ThemeContext);

const THEME_KEY = 'datahood_theme';
const MODE_KEY = 'datahood_mode';

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => localStorage.getItem(THEME_KEY) || 'emerald');
  const [mode, setModeState] = useState(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved) return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    const valid = THEMES.some((t) => t.id === theme) ? theme : 'emerald';
    document.documentElement.setAttribute('data-theme', valid);
    localStorage.setItem(THEME_KEY, valid);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-mode', mode);
    localStorage.setItem(MODE_KEY, mode);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', mode === 'dark' ? '#0e1116' : '#0b6b3a');
  }, [mode]);

  const setTheme = useCallback((t) => setThemeState(t), []);
  const toggleMode = useCallback(() => setModeState((m) => (m === 'dark' ? 'light' : 'dark')), []);
  const setMode = useCallback((m) => setModeState(m), []);

  return (
    <ThemeContext.Provider value={{ theme, mode, setTheme, toggleMode, setMode, themes: THEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}
