type DisplayLineKind = 'assistant' | 'tool' | 'error' | 'warning' | 'system' | 'json';

export interface DisplayLine {
  kind: DisplayLineKind;
  text: string;
}

interface StructuredContentBlock {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

interface StructuredItem {
  id?: unknown;
  type?: unknown;
  text?: unknown;
  command?: unknown;
  exit_code?: unknown;
  status?: unknown;
  path?: unknown;
  changes?: unknown;
  [key: string]: unknown;
}

const TOOL_LINE_MAX = 180;

export function normalizeAgentOutput(lines: string[]): DisplayLine[] {
  const normalized: DisplayLine[] = [];

  for (const rawLine of lines) {
    const structured = parseStructuredLine(rawLine);
    if (structured.length > 0) {
      normalized.push(...structured);
      continue;
    }

    normalized.push(...splitPlainText(rawLine));
  }

  return normalized;
}

export function getLineClasses(kind: DisplayLineKind): string {
  switch (kind) {
    case 'tool':
      return 'bg-emerald-500/8 text-emerald-200 ring-1 ring-inset ring-emerald-500/15';
    case 'error':
      return 'bg-red-500/8 text-red-200 ring-1 ring-inset ring-red-500/20';
    case 'warning':
      return 'bg-amber-500/8 text-amber-100 ring-1 ring-inset ring-amber-500/20';
    case 'system':
      return 'bg-slate-800/60 text-slate-400 ring-1 ring-inset ring-slate-700/70';
    case 'json':
      return 'bg-sky-500/8 text-sky-200 ring-1 ring-inset ring-sky-500/20';
    case 'assistant':
    default:
      return 'text-slate-200';
  }
}

export function getLineLabel(kind: DisplayLineKind): string | null {
  switch (kind) {
    case 'tool':
      return 'TOOL';
    case 'error':
      return 'ERR';
    case 'warning':
      return 'WARN';
    case 'system':
      return 'SYS';
    case 'json':
      return 'JSON';
    default:
      return null;
  }
}

function parseStructuredLine(rawLine: string): DisplayLine[] {
  const trimmed = rawLine.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return [];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }

  const type = typeof parsed.type === 'string' ? parsed.type : '';
  const subtype = typeof parsed.subtype === 'string' ? parsed.subtype : '';

  if (type === 'assistant') {
    const message = parsed.message as { content?: StructuredContentBlock[] } | undefined;
    if (!Array.isArray(message?.content)) {
      return [];
    }

    return message.content.flatMap((block) => {
      if (block.type === 'text' && typeof block.text === 'string') {
        return splitText(block.text, 'assistant');
      }

      if (block.type === 'tool_use' && typeof block.name === 'string') {
        return [{ kind: 'tool', text: formatToolSummary(block.name, block.input) }];
      }

      return [];
    });
  }

  if (type === 'stream_event' && subtype === 'content_block_delta') {
    const delta = parsed.delta as { type?: unknown; text?: unknown } | undefined;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      return splitText(delta.text, 'assistant');
    }
    return [];
  }

  if (type === 'stream_event' && subtype === 'content_block_start') {
    const block = parsed.content_block as { type?: unknown; name?: unknown } | undefined;
    if (block?.type === 'tool_use' && typeof block.name === 'string') {
      return [{ kind: 'tool', text: formatToolSummary(block.name) }];
    }
    return [];
  }

  if (type === 'item.started' || type === 'item.completed') {
    const item = parsed.item as StructuredItem | undefined;
    if (!item || typeof item !== 'object') {
      return [];
    }

    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return splitText(item.text, 'assistant');
    }

    if (isCodexToolItem(item)) {
      return [{ kind: 'tool', text: formatToolSummary(String(item.type ?? 'tool'), item) }];
    }

    return [];
  }

  if (type === 'result' || type === 'turn.completed' || type === 'thread.started') {
    return [];
  }

  if (type === 'system' && subtype === 'init') {
    return [];
  }

  return [{ kind: 'json', text: truncate(compactJSON(parsed), TOOL_LINE_MAX) }];
}

function splitPlainText(rawLine: string): DisplayLine[] {
  return splitText(rawLine, classifyPlainText(rawLine));
}

function splitText(text: string, defaultKind: DisplayLineKind): DisplayLine[] {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => ({
    kind: line.trim() ? classifyPlainText(line, defaultKind) : defaultKind,
    text: line,
  }));
}

function classifyPlainText(line: string, fallback: DisplayLineKind = 'assistant'): DisplayLineKind {
  const trimmed = line.trimStart();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('$') || trimmed.startsWith('Tool:')) return 'tool';
  if (trimmed.startsWith('[lifecycle]') || trimmed.startsWith('[session]')) return 'system';
  if (/^error/i.test(trimmed) || /\bERROR\b/.test(trimmed) || /\bfailed\b/i.test(trimmed)) return 'error';
  if (/\bwarn(ing)?\b/i.test(trimmed)) return 'warning';
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json';
  return fallback;
}

function isCodexToolItem(item: StructuredItem): boolean {
  if (typeof item.type !== 'string' || item.type === 'agent_message') {
    return false;
  }

  return (
    item.type === 'command_execution' ||
    item.type === 'file_change' ||
    item.type.includes('tool') ||
    item.type.includes('function') ||
    item.type.includes('command') ||
    item.type.includes('file')
  );
}

function formatToolSummary(name: string, payload?: unknown): string {
  if (payload && typeof payload === 'object') {
    const record = payload as StructuredItem;
    const statusBits: string[] = [];

    if (typeof record.status === 'string' && record.status !== 'in_progress') {
      statusBits.push(record.status);
    }
    if (typeof record.exit_code === 'number' || typeof record.exit_code === 'string') {
      statusBits.push(`exit ${record.exit_code}`);
    }

    const statusSuffix = statusBits.length > 0 ? ` (${statusBits.join(', ')})` : '';

    if (typeof record.command === 'string' && record.command.trim()) {
      return `$ ${truncate(squashWhitespace(record.command), TOOL_LINE_MAX)}${statusSuffix}`;
    }

    if (typeof record.path === 'string' && record.path.trim()) {
      return `Tool: ${name} ${truncate(record.path, TOOL_LINE_MAX)}${statusSuffix}`;
    }

    if (Array.isArray(record.changes)) {
      return `Tool: ${name} ${record.changes.length} change(s)${statusSuffix}`;
    }

    if (typeof record.text === 'string' && record.text.trim()) {
      return `Tool: ${name} ${truncate(squashWhitespace(record.text), TOOL_LINE_MAX)}${statusSuffix}`;
    }

    const compact = compactJSON(record);
    if (compact !== '{}') {
      return `Tool: ${name} ${truncate(compact, TOOL_LINE_MAX)}${statusSuffix}`;
    }
  }

  return `Tool: ${name}`;
}

function compactJSON(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function squashWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max - 1)}…`;
}
