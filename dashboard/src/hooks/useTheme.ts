import { useState, useEffect, useCallback } from 'react';
import { applyTheme, getSystemTheme, type Theme } from '../lib/theme';

const STORAGE_KEY = 'david-theme';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // localStorage unavailable (SSR, permissions, etc.)
  }
  return 'system';
}

function persistTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // silently ignore
  }
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  // Resolve 'system' to an actual 'light' | 'dark' value
  const resolvedTheme: 'light' | 'dark' =
    theme === 'system' ? getSystemTheme() : theme;

  // Apply theme on mount and whenever theme changes
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Listen for OS-level preference changes when in 'system' mode
  useEffect(() => {
    if (theme !== 'system') return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme(getSystemTheme());
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    persistTheme(next);
  }, []);

  // Cycle: light -> dark -> system
  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme =
        prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light';
      persistTheme(next);
      return next;
    });
  }, []);

  return { theme, resolvedTheme, toggle, setTheme } as const;
}
