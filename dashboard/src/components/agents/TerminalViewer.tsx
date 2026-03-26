import { useEffect, useRef, useState, useCallback } from 'react';
import { Copy, Check, ArrowDown } from 'lucide-react';
import { useAgentOutput } from '../../hooks/useSocket';
import { api } from '../../lib/api';
import { getLineClasses, getLineLabel, normalizeAgentOutput } from './terminalOutput';

interface TerminalViewerProps {
  agentId: string;
  isActive: boolean;
}

/**
 * Terminal-style output viewer with auto-scroll, ANSI-ish color support,
 * blinking cursor for active agents, and copy-to-clipboard.
 */
export function TerminalViewer({ agentId, isActive }: TerminalViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);
  const [copied, setCopied] = useState(false);
  const [historicalLines, setHistoricalLines] = useState<string[]>([]);

  // Live-streamed lines from Socket.IO
  const liveLines = useAgentOutput(agentId);

  // Fetch historical output
  useEffect(() => {
    let cancelled = false;
    api.getAgentOutput(agentId).then((data) => {
      if (!cancelled) setHistoricalLines(data.output);
    }).catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, [agentId]);

  const allLines = [...historicalLines, ...liveLines];
  const displayLines = normalizeAgentOutput(allLines);

  // Auto-scroll
  useEffect(() => {
    if (userScrolled) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [allLines.length, userScrolled]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setUserScrolled(!atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    setUserScrolled(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // Copy to clipboard
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(allLines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  }, [allLines]);

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-[var(--border-color)] bg-[#0d1117]">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-[#21262d] px-3 py-1.5">
        <span className="text-xs font-medium text-slate-500">Live Output</span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className="rounded p-1 text-slate-500 transition-colors hover:bg-[#21262d] hover:text-slate-300"
            title="Copy output"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* Output */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-[12px] leading-[1.6]"
        style={{ fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', ui-monospace, monospace" }}
      >
        {displayLines.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-xs text-slate-600">
            {isActive ? 'Waiting for output...' : 'No output recorded.'}
          </div>
        ) : (
          displayLines.map((line, i) => (
            <div
              key={i}
              className={`mb-1 flex gap-2 rounded-md px-2 py-1 ${getLineClasses(line.kind)}`}
            >
              {getLineLabel(line.kind) && (
                <span className="mt-0.5 shrink-0 text-[9px] font-semibold uppercase tracking-[0.18em] text-inherit/70">
                  {getLineLabel(line.kind)}
                </span>
              )}
              <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                {line.text || ' '}
              </span>
            </div>
          ))
        )}

        {/* Blinking cursor for active agents */}
        {isActive && (
          <span className="inline-block h-[14px] w-[7px] animate-pulse rounded-sm bg-slate-400" />
        )}
      </div>

      {/* Scroll-to-bottom indicator */}
      {userScrolled && isActive && (
        <button
          onClick={scrollToBottom}
          className="flex items-center justify-center gap-1 border-t border-[#21262d] py-1 text-[10px] text-blue-400 transition-colors hover:text-blue-300"
        >
          <ArrowDown className="h-3 w-3" />
          New output available
        </button>
      )}
    </div>
  );
}
