export const darkTheme = {
  '--bg-primary': '#0a0a0f',
  '--bg-secondary': '#12121a',
  '--bg-tertiary': '#1a1a2e',
  '--bg-card': '#16162a',
  '--border-color': '#2a2a4a',
  '--text-primary': '#e2e8f0',
  '--text-secondary': '#94a3b8',
  '--text-muted': '#64748b',
  '--accent-blue': '#3b82f6',
  '--accent-purple': '#7c3aed',
  '--accent-violet': '#8b5cf6',
  '--accent-green': '#10b981',
  '--accent-amber': '#f59e0b',
  '--accent-yellow': '#f59e0b',
  '--accent-orange': '#f97316',
  '--accent-red': '#ef4444',
};

export const lightTheme = {
  '--bg-primary': '#f8f9fa',
  '--bg-secondary': '#ffffff',
  '--bg-tertiary': '#f1f3f5',
  '--bg-card': '#ffffff',
  '--border-color': '#dee2e6',
  '--text-primary': '#1a1a2e',
  '--text-secondary': '#495057',
  '--text-muted': '#868e96',
  '--accent-blue': '#2563eb',
  '--accent-purple': '#6d28d9',
  '--accent-violet': '#7c3aed',
  '--accent-green': '#059669',
  '--accent-amber': '#d97706',
  '--accent-yellow': '#d97706',
  '--accent-orange': '#ea580c',
  '--accent-red': '#dc2626',
};

export type Theme = 'light' | 'dark' | 'system';

export function applyTheme(theme: 'light' | 'dark'): void {
  const vars = theme === 'dark' ? darkTheme : lightTheme;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
  root.setAttribute('data-theme', theme);
}

export function getSystemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}
