import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Search,
  Map,
  Bot,
  GitPullRequest,
  ScrollText,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Navigation items — spec 7.2 page names
// ---------------------------------------------------------------------------

interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  shortcut: string;
}

const navItems: NavItem[] = [
  { to: '/command-center', icon: LayoutDashboard, label: 'Command Center', shortcut: '1' },
  { to: '/logs', icon: Search, label: 'Log Scanner', shortcut: '2' },
  { to: '/map', icon: Map, label: 'Codebase Map', shortcut: '3' },
  { to: '/agents', icon: Bot, label: 'Agent Monitor', shortcut: '4' },
  { to: '/prs', icon: GitPullRequest, label: 'PR Pipeline', shortcut: '5' },
  { to: '/prompts', icon: ScrollText, label: 'Agent Prompts', shortcut: '6' },
];

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function Sidebar() {
  const [expanded, setExpanded] = useState(false);

  return (
    <aside
      onMouseEnter={() => setExpanded(true)}
      onMouseLeave={() => setExpanded(false)}
      className="
        flex h-full flex-col overflow-y-auto
        border-r border-[var(--border-color)]
        bg-[var(--bg-secondary)] transition-[width] duration-200 ease-out
      "
      style={{ width: expanded ? 200 : 56 }}
    >
      {/* Navigation */}
      <nav className="flex flex-1 flex-col gap-1 overflow-hidden px-2 py-3">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => `
              group relative flex items-center gap-3 rounded-lg
              transition-all duration-150
              ${expanded ? 'px-3 py-2' : 'justify-center px-0 py-2'}
              ${
                isActive
                  ? 'bg-[var(--accent-blue)]/10 text-[var(--accent-blue)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }
            `}
          >
            {({ isActive }) => (
              <>
                {/* Active indicator: accent bar on left edge */}
                {isActive && (
                  <div
                    className="
                      absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2
                      rounded-r-full bg-[var(--accent-blue)]
                      shadow-[0_0_8px_rgba(59,130,246,0.5)]
                    "
                  />
                )}

                <Icon
                  className={`
                    h-[18px] w-[18px] shrink-0 transition-colors duration-150
                    ${isActive ? 'text-[var(--accent-blue)]' : 'group-hover:text-[var(--text-primary)]'}
                  `}
                  strokeWidth={isActive ? 2 : 1.5}
                />

                {/* Label — only when expanded */}
                <span
                  className={`
                    truncate text-[13px] font-medium whitespace-nowrap
                    transition-opacity duration-150
                    ${expanded ? 'opacity-100' : 'w-0 opacity-0 overflow-hidden'}
                  `}
                >
                  {label}
                </span>

                {/* Tooltip when collapsed */}
                {!expanded && (
                  <div
                    className="
                      pointer-events-none absolute left-full ml-2
                      rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5
                      text-xs font-medium text-[var(--text-primary)]
                      opacity-0 shadow-lg shadow-black/20
                      ring-1 ring-[var(--border-color)]
                      transition-opacity duration-100
                      group-hover:pointer-events-auto group-hover:opacity-100
                      z-50 whitespace-nowrap
                    "
                  >
                    {label}
                  </div>
                )}
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}
