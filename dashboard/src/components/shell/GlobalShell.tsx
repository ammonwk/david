import { Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { EventTicker } from './EventTicker';
import { CommandPalette } from './CommandPalette';
import { useToast } from './ToastManager';
import { useSocketEvent, useReconnectionState } from '../../hooks/useSocket';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import type { BugEventData, PREventData, AgentEventData } from 'david-shared';

// ── Socket-to-toast bridge ─────────────────────────────────
// Listens for high-signal WebSocket events and surfaces them
// as toast notifications so the user never misses critical updates.

function SocketToastBridge() {
  const { addToast } = useToast();

  useSocketEvent<BugEventData>('bug:reported', (data) => {
    addToast({
      type: 'bug-found',
      message: `Bug found: ${data.pattern} (${data.severity})`,
      actionPath: '/logs',
    });
  });

  useSocketEvent<PREventData>('pr:created', (data) => {
    addToast({
      type: 'pr-created',
      message: `PR #${data.prNumber} created: ${data.title}`,
      actionPath: '/prs',
    });
  });

  useSocketEvent<PREventData>('pr:merged', (data) => {
    addToast({
      type: 'pr-merged',
      message: `PR #${data.prNumber} merged: ${data.title}`,
      actionPath: '/prs',
    });
  });

  useSocketEvent<PREventData>('pr:closed', (data) => {
    addToast({
      type: 'pr-closed',
      message: `PR #${data.prNumber} closed: ${data.title}`,
      actionPath: '/prs',
    });
  });

  useSocketEvent<AgentEventData>('agent:failed', (data) => {
    addToast({
      type: 'agent-failed',
      message: `Agent failed: ${data.type} agent (${data.agentId.slice(0, 8)})`,
      actionPath: '/agents',
    });
  });

  return null;
}

/**
 * GlobalShell — the application-level layout wrapping every page.
 *
 * Uses CSS Grid to eliminate all hardcoded pixel offsets:
 *
 *   grid-template-rows:    auto 1fr auto   (topbar, content, ticker)
 *   grid-template-columns: auto 1fr        (sidebar, content)
 *
 * Structure:
 *   ┌────────────────────────────────────────────┐
 *   │  TopBar (col-span-2)                       │
 *   ├──────┬─────────────────────────────────────┤
 *   │ Side │                                     │
 *   │ bar  │   Main Content (Outlet)             │
 *   │      │                                     │
 *   ├──────┴─────────────────────────────────────┤
 *   │  EventTicker (col-span-2)                  │
 *   └────────────────────────────────────────────┘
 *
 * Also renders:
 *   - Reconnection banner (col-span-2, between TopBar and content)
 *   - CommandPalette (Cmd+K overlay)
 *   - SocketToastBridge (socket events → toast notifications)
 *   - ToastProvider is wrapped at the App level (see App.tsx)
 */
export function GlobalShell() {
  const { isDisconnected, reconnecting, timeSinceDisconnect } = useReconnectionState();
  useKeyboardShortcuts();

  return (
    <div className="h-screen grid grid-rows-[auto_auto_1fr_auto] grid-cols-[auto_1fr] bg-[var(--bg-primary)] overflow-hidden">
      {/* TopBar spans full width */}
      <div className="col-span-2 row-start-1">
        <TopBar />
      </div>

      {/* Reconnection banner — spans full width, between TopBar and content */}
      {(isDisconnected || reconnecting) && (
        <div className="col-span-2 row-start-2 flex items-center justify-center gap-2 bg-amber-500/10 border-b border-amber-500/30 px-4 py-1.5 text-xs text-amber-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Reconnecting{timeSinceDisconnect ? ` (${Math.floor(timeSinceDisconnect / 1000)}s)` : '...'}
        </div>
      )}

      {/* Sidebar in left column */}
      <div className="row-start-3">
        <Sidebar />
      </div>

      {/* Main content fills remaining space */}
      <main className="row-start-3 min-h-0 overflow-y-auto p-6">
        <Outlet />
      </main>

      {/* EventTicker spans full width */}
      <div className="col-span-2 row-start-4">
        <EventTicker />
      </div>

      {/* Command palette overlay (Cmd+K / Ctrl+K) */}
      <CommandPalette />

      {/* Bridge: socket events → toast notifications */}
      <SocketToastBridge />
    </div>
  );
}
