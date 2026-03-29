import { useEffect, useRef, useMemo, useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Command,
  Bug,
  GitPullRequest,
  Bot,
  Network,
  Scan,
  ShieldCheck,
  MapPin,
  Pause,
  Play,
  Sun,
  Moon,
  Clock,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useTheme } from '../../hooks/useTheme';
import { useCommandPalette, type RecentItem } from '../../hooks/useCommandPalette';
import type {
  BugReport,
  PullRequestRecord,
  AgentRecord,
  TopologyNode,
} from 'david-shared';

// ── Types ──────────────────────────────────────────────────

interface CommandItem {
  id: string;
  label: string;
  description?: string;
  category: 'Actions' | 'Agents' | 'Bugs' | 'PRs' | 'Topology Nodes' | 'Recent';
  icon: typeof Search;
  onSelect: () => void;
  path?: string;
}

// ── Component ──────────────────────────────────────────────

export function CommandPalette() {
  const navigate = useNavigate();
  const { theme, toggle: toggleTheme } = useTheme();
  const {
    isOpen,
    close,
    searchQuery,
    setSearchQuery,
    selectedIndex,
    setSelectedIndex,
    recentItems,
    addRecent,
  } = useCommandPalette();

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [schedulerPaused, setSchedulerPaused] = useState(false);

  // Dynamic data for search results
  const [bugs, setBugs] = useState<BugReport[]>([]);
  const [prs, setPRs] = useState<PullRequestRecord[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [nodes, setNodes] = useState<TopologyNode[]>([]);
  const [dataLoaded, setDataLoaded] = useState(false);

  // Load data when palette opens
  useEffect(() => {
    if (!isOpen) {
      setDataLoaded(false);
      return;
    }

    // Focus the input
    requestAnimationFrame(() => inputRef.current?.focus());

    // Fetch data for search
    let cancelled = false;

    async function loadData() {
      try {
        const [bugsRes, prsRes, agentsRes, topoRes] = await Promise.allSettled([
          api.getBugReports(),
          api.getPRs(),
          api.getAgents(),
          api.getTopology(),
        ]);

        if (cancelled) return;

        if (bugsRes.status === 'fulfilled') setBugs(bugsRes.value);
        if (prsRes.status === 'fulfilled') setPRs(prsRes.value);
        if (agentsRes.status === 'fulfilled') setAgents(agentsRes.value.agents);
        if (topoRes.status === 'fulfilled') setNodes(topoRes.value.nodes);
        setDataLoaded(true);
      } catch {
        // Data loading is best-effort; actions still work
        setDataLoaded(true);
      }
    }

    loadData();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Fetch scheduler status on open
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    api.getSchedule().then((s) => {
      if (!cancelled) setSchedulerPaused(!s.scan.enabled);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  // ── Build items ────────────────────────────────────────────

  const actionItems: CommandItem[] = useMemo(
    () => [
      {
        id: 'action-scan',
        label: 'Trigger Log Scan',
        description: 'Start a new log scan with default settings',
        category: 'Actions',
        icon: Scan,
        onSelect: () => {
          api.triggerScan({ timeSpan: '1h', severity: 'all' });
          close();
        },
      },
      {
        id: 'action-audit',
        label: 'Trigger Codebase Audit',
        description: 'Audit all topology nodes at configured granularity',
        category: 'Actions',
        icon: ShieldCheck,
        onSelect: () => {
          api.triggerAudit({});
          close();
        },
      },
      {
        id: 'action-map',
        label: 'Re-map Codebase',
        description: 'Rebuild the topology map from scratch',
        category: 'Actions',
        icon: MapPin,
        onSelect: () => {
          api.triggerMapping();
          close();
        },
      },
      {
        id: 'action-scheduler',
        label: schedulerPaused ? 'Resume Scheduler' : 'Pause Scheduler',
        description: schedulerPaused
          ? 'Re-enable automatic scans and audits'
          : 'Temporarily stop automatic scans and audits',
        category: 'Actions',
        icon: schedulerPaused ? Play : Pause,
        onSelect: () => {
          api.updateSchedule({
            scan: { enabled: schedulerPaused },
            audit: { enabled: schedulerPaused },
          });
          setSchedulerPaused(!schedulerPaused);
          close();
        },
      },
      {
        id: 'action-theme',
        label: 'Toggle Theme',
        description: `Currently: ${theme}`,
        category: 'Actions',
        icon: theme === 'dark' ? Sun : Moon,
        onSelect: () => {
          toggleTheme();
          close();
        },
      },
    ],
    [schedulerPaused, theme, toggleTheme, close],
  );

  const searchItems: CommandItem[] = useMemo(() => {
    if (!searchQuery.trim()) return [];

    const q = searchQuery.toLowerCase();
    const items: CommandItem[] = [];

    // Bugs
    bugs
      .filter(
        (b) =>
          b.pattern.toLowerCase().includes(q) ||
          b.status.toLowerCase().includes(q) ||
          b.severity.toLowerCase().includes(q),
      )
      .slice(0, 5)
      .forEach((b) =>
        items.push({
          id: `bug-${b._id}`,
          label: b.pattern,
          description: `${b.severity} - ${b.status}`,
          category: 'Bugs',
          icon: Bug,
          path: `/logs`,
          onSelect: () => {
            addRecent({ id: `bug-${b._id}`, label: b.pattern, category: 'Bugs', path: '/logs' });
            navigate('/logs');
            close();
          },
        }),
      );

    // PRs
    prs
      .filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.branch.toLowerCase().includes(q) ||
          String(p.prNumber).includes(q),
      )
      .slice(0, 5)
      .forEach((p) =>
        items.push({
          id: `pr-${p._id}`,
          label: `#${p.prNumber} ${p.title}`,
          description: `${p.status} - ${p.branch}`,
          category: 'PRs',
          icon: GitPullRequest,
          path: '/prs',
          onSelect: () => {
            addRecent({
              id: `pr-${p._id}`,
              label: `#${p.prNumber} ${p.title}`,
              category: 'PRs',
              path: '/prs',
            });
            navigate('/prs');
            close();
          },
        }),
      );

    // Agents
    agents
      .filter(
        (a) =>
          a.type.toLowerCase().includes(q) ||
          a.status.toLowerCase().includes(q) ||
          a.taskId.toLowerCase().includes(q),
      )
      .slice(0, 5)
      .forEach((a) =>
        items.push({
          id: `agent-${a._id}`,
          label: `${a.type} agent`,
          description: `${a.status} - ${a.taskId}`,
          category: 'Agents',
          icon: Bot,
          path: '/agents',
          onSelect: () => {
            addRecent({
              id: `agent-${a._id}`,
              label: `${a.type} agent`,
              category: 'Agents',
              path: '/agents',
            });
            navigate('/agents');
            close();
          },
        }),
      );

    // Topology Nodes
    nodes
      .filter(
        (n) =>
          n.name.toLowerCase().includes(q) ||
          n.description.toLowerCase().includes(q),
      )
      .slice(0, 5)
      .forEach((n) =>
        items.push({
          id: `node-${n.id}`,
          label: n.name,
          description: n.description,
          category: 'Topology Nodes',
          icon: Network,
          path: '/map',
          onSelect: () => {
            addRecent({
              id: `node-${n.id}`,
              label: n.name,
              category: 'Topology Nodes',
              path: '/map',
            });
            navigate('/map');
            close();
          },
        }),
      );

    return items;
  }, [searchQuery, bugs, prs, agents, nodes, navigate, close, addRecent]);

  // Recent items (shown when search is empty)
  const recentCommandItems: CommandItem[] = useMemo(() => {
    if (searchQuery.trim()) return [];
    return recentItems.map((r) => ({
      id: `recent-${r.id}`,
      label: r.label,
      description: r.category,
      category: 'Recent' as const,
      icon: Clock,
      path: r.path,
      onSelect: () => {
        if (r.path) navigate(r.path);
        close();
      },
    }));
  }, [searchQuery, recentItems, navigate, close]);

  // Filtered action items
  const filteredActions = useMemo(() => {
    if (!searchQuery.trim()) return actionItems;
    const q = searchQuery.toLowerCase();
    return actionItems.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.description?.toLowerCase().includes(q) ?? false),
    );
  }, [searchQuery, actionItems]);

  // Combined flattened list for keyboard navigation
  const allItems = useMemo(() => {
    return [...recentCommandItems, ...filteredActions, ...searchItems];
  }, [recentCommandItems, filteredActions, searchItems]);

  // Group items by category for display
  const groupedItems = useMemo(() => {
    const groups: Map<string, CommandItem[]> = new Map();
    for (const item of allItems) {
      const existing = groups.get(item.category) ?? [];
      existing.push(item);
      groups.set(item.category, existing);
    }
    return groups;
  }, [allItems]);

  // ── Keyboard navigation ────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < allItems.length - 1 ? prev + 1 : 0,
          );
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : allItems.length - 1,
          );
          break;
        case 'Enter':
          e.preventDefault();
          if (allItems[selectedIndex]) {
            allItems[selectedIndex].onSelect();
          }
          break;
        case 'Escape':
          e.preventDefault();
          close();
          break;
      }
    },
    [allItems, selectedIndex, setSelectedIndex, close],
  );

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector('[data-selected="true"]');
    if (selected) {
      selected.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // ── Render ─────────────────────────────────────────────────

  if (!isOpen) return null;

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-start justify-center pt-[15vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-fade-in" />

      {/* Palette */}
      <div
        className="relative w-full max-w-xl animate-palette-enter rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl shadow-black/40"
        onKeyDown={handleKeyDown}
        role="dialog"
        aria-label="Command palette"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-[var(--border-color)] px-4">
          <Search className="h-5 w-5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search commands, bugs, PRs, agents..."
            className="h-12 flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <kbd className="hidden sm:flex items-center gap-1 rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          className="max-h-80 overflow-y-auto overscroll-contain py-2"
          role="listbox"
        >
          {allItems.length === 0 && searchQuery.trim() && (
            <div className="px-4 py-8 text-center text-sm text-[var(--text-muted)]">
              No results for "{searchQuery}"
            </div>
          )}

          {Array.from(groupedItems.entries()).map(([category, items]) => (
            <div key={category}>
              {/* Category header */}
              <div className="px-4 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                {category}
              </div>

              {/* Items */}
              {items.map((item) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <button
                    key={item.id}
                    role="option"
                    aria-selected={isSelected}
                    data-selected={isSelected}
                    className={`
                      flex w-full items-center gap-3 px-4 py-2.5 text-left
                      transition-colors duration-150
                      ${
                        isSelected
                          ? 'bg-[var(--accent-blue)]/10 text-[var(--text-primary)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                      }
                    `}
                    onClick={() => item.onSelect()}
                    onMouseEnter={() => setSelectedIndex(currentIndex)}
                  >
                    <item.icon
                      className={`h-4 w-4 shrink-0 ${
                        isSelected
                          ? 'text-[var(--accent-blue)]'
                          : 'text-[var(--text-muted)]'
                      }`}
                      strokeWidth={1.5}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{item.label}</div>
                      {item.description && (
                        <div className="truncate text-xs text-[var(--text-muted)]">
                          {item.description}
                        </div>
                      )}
                    </div>
                    {isSelected && (
                      <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" strokeWidth={1.5} />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer with keyboard hints */}
        <div className="flex items-center gap-4 border-t border-[var(--border-color)] px-4 py-2 text-[11px] text-[var(--text-muted)]">
          <span className="flex items-center gap-1">
            <ArrowUp className="h-3 w-3" />
            <ArrowDown className="h-3 w-3" />
            navigate
          </span>
          <span className="flex items-center gap-1">
            <CornerDownLeft className="h-3 w-3" />
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="rounded border border-[var(--border-color)] bg-[var(--bg-tertiary)] px-1 text-[10px]">esc</kbd>
            close
          </span>
          <span className="ml-auto flex items-center gap-1">
            <Command className="h-3 w-3" />K to toggle
          </span>
        </div>
      </div>
    </div>
  );
}
