import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { THEMES } from '../config';
import { api } from '../api/client';

const ThemeContext = createContext(null);
export const useTheme = () => useContext(ThemeContext);

const THEME_KEY = 'datahood_theme';
const MODE_KEY = 'datahood_mode';

export function ThemeProvider({ children }) {
  // `null` means "nobody has chosen" — distinct from a chosen theme that
  // happens to equal the default. Only the null case defers to the site
  // default from Site Settings; a real choice is never overwritten.
  const [theme, setThemeState] = useState(() => localStorage.getItem(THEME_KEY) || null);
  const [mode, setModeState] = useState(() => {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved) return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  // Adopt the operator's default from GET /settings/public, but only for a
  // visitor who has never picked a theme. Fetched directly rather than via
  // useSiteSettings so ThemeProvider does not have to sit inside anything;
  // the request is de-duplicated by that hook's module cache anyway, and a
  // failure here must never block rendering — hence the silent catch.
  useEffect(() => {
    if (localStorage.getItem(THEME_KEY)) return undefined;
    let alive = true;
    api.get('/settings/public')
      .then((res) => {
        if (!alive) return;
        const preferred = res?.data?.sitecolor;
        // Ignore the legacy hex format and anything unrecognised.
        if (preferred && THEMES.some((t) => t.id === preferred)) {
          setThemeState(preferred);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    // Until the site default arrives, render Emerald without writing it to
    // localStorage — persisting it here would record a "choice" the user
    // never made and permanently ignore the operator's default.
    const valid = THEMES.some((t) => t.id === theme) ? theme : 'emerald';
    document.documentElement.setAttribute('data-theme', valid);
    if (theme) localStorage.setItem(THEME_KEY, valid);
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

  // Consumers get the theme that is actually on screen, never null. The
  // profile theme picker compares this against each swatch id, and a null
  // would leave every swatch unselected until the settings fetch resolved.
  const activeTheme = THEMES.some((t) => t.id === theme) ? theme : 'emerald';

  return (
    <ThemeContext.Provider
      value={{ theme: activeTheme, mode, setTheme, toggleMode, setMode, themes: THEMES }}
    >
      {children}
    </ThemeContext.Provider>
  );
}
