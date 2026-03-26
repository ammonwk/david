import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { WSEventType, ActivityEvent, PoolStatusData } from 'david-shared';

const MAX_OUTPUT_LINES = 5000;

// Singleton socket connection
let socket: Socket | null = null;

function getSocket(): Socket {
  if (!socket) {
    socket = io({
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
    });
  }
  return socket;
}

/**
 * Subscribe to a specific Socket.IO event type.
 * The handler is called whenever the event fires.
 * Automatically unsubscribes on unmount.
 */
export function useSocketEvent<T = unknown>(
  eventType: WSEventType | 'activity:new' | 'activity:history',
  handler: (data: T) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const s = getSocket();
    const listener = (data: T) => {
      handlerRef.current(data);
    };
    s.on(eventType, listener);
    return () => {
      s.off(eventType, listener);
    };
  }, [eventType]);
}

/**
 * Get a real-time activity feed from the server.
 * Receives an initial batch via 'activity:history' and live updates via 'activity:new'.
 */
export function useActivityFeed(maxItems: number = 100): ActivityEvent[] {
  const [events, setEvents] = useState<ActivityEvent[]>([]);

  useSocketEvent<ActivityEvent[]>('activity:history', (history) => {
    setEvents(history.slice(0, maxItems));
  });

  useSocketEvent<ActivityEvent>('activity:new', (event) => {
    setEvents((prev) => [event, ...prev].slice(0, maxItems));
  });

  return events;
}

/**
 * Watch a specific agent's live output stream.
 * Joins the agent's room on mount and leaves on unmount or when agentId changes.
 */
export function useAgentOutput(agentId: string | null): string[] {
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!agentId) {
      setLines([]);
      return;
    }

    const s = getSocket();
    setLines([]);

    s.emit('agent:watch', agentId);

    const listener = (data: { agentId: string; line: string }) => {
      if (data.agentId === agentId) {
        setLines((prev) => {
          const next = [...prev, data.line];
          // Keep only the most recent lines to prevent memory bloat
          if (next.length > MAX_OUTPUT_LINES) {
            return next.slice(next.length - MAX_OUTPUT_LINES);
          }
          return next;
        });
      }
    };

    s.on('agent:output', listener);

    return () => {
      s.emit('agent:unwatch', agentId);
      s.off('agent:output', listener);
    };
  }, [agentId]);

  return lines;
}

/**
 * Get the current agent pool status, updated in real-time.
 */
export function usePoolStatus(): PoolStatusData | null {
  const [status, setStatus] = useState<PoolStatusData | null>(null);

  useSocketEvent<PoolStatusData>('pool:status-update', (data) => {
    setStatus(data);
  });

  return status;
}

/**
 * Track the Socket.IO connection state.
 */
export function useConnectionStatus(): 'connected' | 'disconnected' | 'reconnecting' {
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'reconnecting'>(() => {
    const s = getSocket();
    return s.connected ? 'connected' : 'disconnected';
  });

  useEffect(() => {
    const s = getSocket();

    const onConnect = () => setStatus('connected');
    const onDisconnect = () => setStatus('disconnected');
    const onReconnecting = () => setStatus('reconnecting');

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.io.on('reconnect_attempt', onReconnecting);

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.io.off('reconnect_attempt', onReconnecting);
    };
  }, []);

  return status;
}

/**
 * Reconnection state for the banner and full-state sync.
 *
 * Tracks how long the client has been disconnected and, on reconnect,
 * emits a 'sync:request' event so the server sends a full state snapshot.
 */
export function useReconnectionState(): {
  isDisconnected: boolean;
  reconnecting: boolean;
  timeSinceDisconnect: number | null;
} {
  const [isDisconnected, setIsDisconnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [timeSinceDisconnect, setTimeSinceDisconnect] = useState<number | null>(null);
  const disconnectedAtRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const s = getSocket();

    const clearTimer = () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };

    const onDisconnect = () => {
      const now = Date.now();
      disconnectedAtRef.current = now;
      setIsDisconnected(true);
      setReconnecting(false);
      setTimeSinceDisconnect(0);

      // Tick every second to update elapsed time
      clearTimer();
      timerRef.current = setInterval(() => {
        setTimeSinceDisconnect(Date.now() - now);
      }, 1000);
    };

    const onReconnecting = () => {
      setReconnecting(true);
    };

    const onConnect = () => {
      const wasDisconnected = disconnectedAtRef.current !== null;

      disconnectedAtRef.current = null;
      setIsDisconnected(false);
      setReconnecting(false);
      setTimeSinceDisconnect(null);
      clearTimer();

      // Request a full state snapshot to catch up on missed events
      if (wasDisconnected) {
        s.emit('sync:request');
      }
    };

    s.on('disconnect', onDisconnect);
    s.io.on('reconnect_attempt', onReconnecting);
    s.on('connect', onConnect);

    return () => {
      s.off('disconnect', onDisconnect);
      s.io.off('reconnect_attempt', onReconnecting);
      s.off('connect', onConnect);
      clearTimer();
    };
  }, []);

  return { isDisconnected, reconnecting, timeSinceDisconnect };
}
