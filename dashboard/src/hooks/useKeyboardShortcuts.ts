import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const PAGE_SHORTCUTS: Record<string, string> = {
  '1': '/command-center',
  '2': '/logs',
  '3': '/map',
  '4': '/agents',
  '5': '/prs',
};

export function useKeyboardShortcuts() {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't fire when user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Cmd+K / Ctrl+K is handled by CommandPalette — don't interfere
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') return;

      // Page navigation: 1-5
      if (PAGE_SHORTCUTS[e.key]) {
        e.preventDefault();
        navigate(PAGE_SHORTCUTS[e.key]);
        return;
      }

      // Esc: close any open drawer/modal — dispatch a custom event that drawers can listen to
      if (e.key === 'Escape') {
        window.dispatchEvent(new CustomEvent('david:escape'));
        return;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [navigate]);
}
