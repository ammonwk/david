import { useState, useEffect, useCallback } from 'react';

const RECENT_KEY = 'david-command-palette-recent';
const MAX_RECENT = 5;

export interface RecentItem {
  id: string;
  label: string;
  category: string;
  path?: string;
}

function readRecent(): RecentItem[] {
  try {
    const stored = localStorage.getItem(RECENT_KEY);
    if (stored) return JSON.parse(stored).slice(0, MAX_RECENT);
  } catch {
    // ignore
  }
  return [];
}

function persistRecent(items: RecentItem[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(items.slice(0, MAX_RECENT)));
  } catch {
    // ignore
  }
}

export function useCommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [recentItems, setRecentItems] = useState<RecentItem[]>(readRecent);

  const open = useCallback(() => {
    setIsOpen(true);
    setSearchQuery('');
    setSelectedIndex(0);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setSearchQuery('');
    setSelectedIndex(0);
  }, []);

  const addRecent = useCallback((item: RecentItem) => {
    setRecentItems((prev) => {
      const filtered = prev.filter((r) => r.id !== item.id);
      const next = [item, ...filtered].slice(0, MAX_RECENT);
      persistRecent(next);
      return next;
    });
  }, []);

  // Global keyboard shortcut: Cmd+K / Ctrl+K to open
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen((prev) => {
          if (!prev) {
            // Opening: reset state
            setSearchQuery('');
            setSelectedIndex(0);
          }
          return !prev;
        });
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // Reset selected index when search query changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [searchQuery]);

  return {
    isOpen,
    open,
    close,
    searchQuery,
    setSearchQuery,
    selectedIndex,
    setSelectedIndex,
    recentItems,
    addRecent,
  } as const;
}
