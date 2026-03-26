import util from 'util';

let installed = false;

function formatTimestamp(date: Date): string {
  return date.toISOString();
}

export function installTimestampedConsole(): void {
  if (installed) return;
  installed = true;

  const methods: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = [
    'log',
    'info',
    'warn',
    'error',
    'debug',
  ];

  for (const method of methods) {
    const original = console[method].bind(console);

    console[method] = (...args: unknown[]) => {
      const timestamp = formatTimestamp(new Date());
      const rendered = args.length > 0 ? util.format(...args) : '';
      original(`[${timestamp}] ${rendered}`);
    };
  }
}
