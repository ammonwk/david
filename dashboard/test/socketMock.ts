type Listener = (...args: any[]) => void;

function createChannel() {
  const listeners = new Map<string, Set<Listener>>();

  const on = (event: string, listener: Listener) => {
    const set = listeners.get(event) ?? new Set<Listener>();
    set.add(listener);
    listeners.set(event, set);
    return channel;
  };

  const off = (event: string, listener: Listener) => {
    const set = listeners.get(event);
    if (!set) return channel;
    set.delete(listener);
    if (set.size === 0) listeners.delete(event);
    return channel;
  };

  const trigger = (event: string, ...args: any[]) => {
    const set = listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      listener(...args);
    }
  };

  const channel = { listeners, on, off, trigger };
  return channel;
}

export function createSocketMock() {
  const socketChannel = createChannel();
  const ioChannel = createChannel();
  const emitted: Array<{ event: string; args: unknown[] }> = [];

  const socket = {
    connected: false,
    io: ioChannel,
    on: socketChannel.on,
    off: socketChannel.off,
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ event, args });
      return socket;
    },
    trigger: socketChannel.trigger,
    getEmitted: () => [...emitted],
  };

  return {
    socket,
    ioChannel,
    emitted,
    io: vi.fn(() => socket),
  };
}
