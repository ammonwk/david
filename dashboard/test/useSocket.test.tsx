import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSocketMock } from './socketMock';

async function loadHooks() {
  vi.resetModules();

  const mock = createSocketMock();
  vi.doMock('socket.io-client', () => ({
    io: mock.io,
  }));

  const hooks = await import('../src/hooks/useSocket');
  return { ...hooks, mock };
}

describe('useSocket hooks', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('updates the latest event handler without re-subscribing', async () => {
    const { useSocketEvent, mock } = await loadHooks();
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    const { rerender, unmount } = renderHook(
      ({ handler }) => useSocketEvent('activity:new', handler),
      { initialProps: { handler: firstHandler } },
    );

    rerender({ handler: secondHandler });

    act(() => {
      mock.socket.trigger('activity:new', { id: 'evt-1' });
    });

    expect(firstHandler).not.toHaveBeenCalled();
    expect(secondHandler).toHaveBeenCalledWith({ id: 'evt-1' });

    unmount();
  });

  it('tracks activity feed state and preserves the max item window', async () => {
    const { useActivityFeed, mock } = await loadHooks();
    const history = [
      { id: 'a', message: 'one' },
      { id: 'b', message: 'two' },
      { id: 'c', message: 'three' },
    ];

    const { result } = renderHook(() => useActivityFeed(2));

    act(() => {
      mock.socket.trigger('activity:history', history);
    });

    expect(result.current).toEqual([
      { id: 'a', message: 'one' },
      { id: 'b', message: 'two' },
    ]);

    act(() => {
      mock.socket.trigger('activity:new', { id: 'd', message: 'four' });
    });

    expect(result.current).toEqual([
      { id: 'd', message: 'four' },
      { id: 'a', message: 'one' },
    ]);
  });

  it('subscribes to agent output, filters by agent id, and trims the buffer', async () => {
    const { useAgentOutput, mock } = await loadHooks();

    const { result, rerender, unmount } = renderHook(
      ({ agentId }) => useAgentOutput(agentId),
      { initialProps: { agentId: 'agent-1' as string | null } },
    );

    expect(mock.emitted).toContainEqual({ event: 'agent:watch', args: ['agent-1'] });

    act(() => {
      mock.socket.trigger('agent:output', { agentId: 'agent-2', line: 'ignored' });
      mock.socket.trigger('agent:output', { agentId: 'agent-1', line: 'first' });
    });

    expect(result.current).toEqual(['first']);

    act(() => {
      for (let i = 0; i < 5005; i += 1) {
        mock.socket.trigger('agent:output', { agentId: 'agent-1', line: `line-${i}` });
      }
    });

    expect(result.current).toHaveLength(5000);
    expect(result.current[0]).toBe('line-5');
    expect(result.current.at(-1)).toBe('line-5004');

    rerender({ agentId: null });
    expect(mock.emitted).toContainEqual({ event: 'agent:unwatch', args: ['agent-1'] });

    unmount();
  });

  it('tracks connection and reconnection state', async () => {
    const { useConnectionStatus, useReconnectionState, mock } = await loadHooks();

    mock.socket.connected = false;

    const connection = renderHook(() => useConnectionStatus());
    expect(connection.result.current).toBe('disconnected');

    act(() => {
      mock.socket.trigger('connect');
    });
    expect(connection.result.current).toBe('connected');

    const reconnection = renderHook(() => useReconnectionState());
    expect(reconnection.result.current).toEqual({
      isDisconnected: false,
      reconnecting: false,
      timeSinceDisconnect: null,
    });

    vi.useFakeTimers();

    act(() => {
      mock.socket.trigger('disconnect');
    });

    expect(reconnection.result.current.isDisconnected).toBe(true);
    expect(reconnection.result.current.timeSinceDisconnect).toBe(0);

    act(() => {
      mock.ioChannel.trigger('reconnect_attempt');
    });
    expect(reconnection.result.current.reconnecting).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(reconnection.result.current.timeSinceDisconnect).toBe(1000);

    act(() => {
      mock.socket.trigger('connect');
    });

    expect(reconnection.result.current).toEqual({
      isDisconnected: false,
      reconnecting: false,
      timeSinceDisconnect: null,
    });
    expect(mock.emitted).toContainEqual({ event: 'sync:request', args: [] });

    vi.useRealTimers();
  });
});
