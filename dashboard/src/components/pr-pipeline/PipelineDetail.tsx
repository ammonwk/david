import { useEffect, useState, useCallback, Fragment } from 'react';
import {
  X,
  ExternalLink,
  GitPullRequest,
  Bug,
  Cpu,
  FileCode,
  ChevronDown,
  ChevronRight,
  MessageSquare,
  AlertTriangle,
  Terminal,
} from 'lucide-react';
import type { BugReport, PullRequestRecord, AgentRecord } from 'david-shared';
import { api } from '../../lib/api';
import { TerminalViewer } from '../agents/TerminalViewer';
import type { PipelineCardData } from './PipelineCard';

// ── Props ────────────────────────────────────────────────────

interface PipelineDetailProps {
  card: PipelineCardData | null;
  onClose: () => void;
}

// ── Collapsible Diff Section ─────────────────────────────────

function DiffFileSection({ filename, content }: { filename: string; content: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-[var(--border-color)] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 bg-[var(--bg-secondary)] px-3 py-2 text-left text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
        )}
        <FileCode className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
        <span className="truncate font-mono">{filename}</span>
      </button>
      {open && (
        <pre className="max-h-64 overflow-auto bg-[var(--bg-primary)] p-3 font-mono text-xs leading-relaxed">
          {content.split('\n').map((line, i) => {
            let cls = 'text-[var(--text-secondary)]';
            if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-emerald-400 bg-emerald-500/5';
            else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-red-400 bg-red-500/5';
            else if (line.startsWith('@@')) cls = 'text-blue-400';
            return (
              <div key={i} className={cls}>
                {line}
              </div>
            );
          })}
        </pre>
      )}
    </div>
  );
}

function parseDiffSections(diff: string): Array<{ filename: string; content: string }> {
  if (!diff) return [];

  const sections: Array<{ filename: string; content: string }> = [];
  const parts = diff.split(/^diff --git /m).filter(Boolean);

  for (const part of parts) {
    const lines = part.split('\n');
    // Try to extract filename from the first line "a/path b/path"
    const headerMatch = lines[0]?.match(/a\/(.+?)\s+b\/(.+)/);
    const filename = headerMatch ? headerMatch[2] : lines[0]?.trim() ?? 'unknown';
    sections.push({ filename, content: lines.slice(1).join('\n') });
  }

  // Fallback: if no diff sections were parsed, treat the whole diff as one section
  if (sections.length === 0 && diff.trim()) {
    sections.push({ filename: 'changes', content: diff });
  }

  return sections;
}

// ── Section Header ──────────────────────────────────────────

function SectionHeader({
  icon: Icon,
  label,
}: {
  icon: React.FC<{ className?: string }>;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <Icon className="h-4 w-4 text-[var(--accent-blue)]" />
      <h3 className="text-sm font-semibold text-[var(--text-primary)]">{label}</h3>
    </div>
  );
}

// ── Agent Trace with Embedded Terminal ───────────────────────

function AgentTraceCard({ agent }: { agent: AgentRecord }) {
  const [showTerminal, setShowTerminal] = useState(false);
  const isActive = agent.status === 'running' || agent.status === 'queued';

  return (
    <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] overflow-hidden">
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-[var(--bg-tertiary)] px-2.5 py-0.5 text-xs font-medium text-[var(--text-secondary)] ring-1 ring-[var(--border-color)]">
              {agent.type}
            </span>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${
                agent.status === 'completed'
                  ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                  : agent.status === 'running'
                    ? 'bg-blue-500/10 text-blue-400 ring-blue-500/20'
                    : agent.status === 'failed'
                      ? 'bg-red-500/10 text-red-400 ring-red-500/20'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)] ring-[var(--border-color)]'
              }`}
            >
              {agent.status}
            </span>
          </div>
          {agent.restarts > 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              {agent.restarts} restart{agent.restarts !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {agent.result && (
          <p className="mb-2 text-sm leading-relaxed text-[var(--text-secondary)]">
            {agent.result.summary}
          </p>
        )}

        {/* Toggle terminal feed */}
        {agent._id && (
          <button
            onClick={() => setShowTerminal(!showTerminal)}
            className="flex items-center gap-1.5 text-xs font-medium text-[var(--accent-blue)] transition-colors hover:text-blue-300"
          >
            <Terminal className="h-3.5 w-3.5" />
            {showTerminal ? 'Hide' : 'Show'} conversation
            {showTerminal ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        )}
      </div>

      {/* Embedded terminal viewer */}
      {showTerminal && agent._id && (
        <div className="h-80 border-t border-[var(--border-color)]">
          <TerminalViewer agentId={agent._id} isActive={isActive} />
        </div>
      )}
    </div>
  );
}

// ── Main Component ──────────────────────────────────────────

export function PipelineDetail({ card, onClose }: PipelineDetailProps) {
  const [bugReport, setBugReport] = useState<BugReport | null>(null);
  const [pr, setPr] = useState<PullRequestRecord | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchDetails = useCallback(async (cardData: PipelineCardData) => {
    setLoading(true);
    setBugReport(null);
    setPr(null);
    setAgents([]);

    try {
      // Fetch all bug reports and find matching one
      const bugs = await api.getBugReports();
      const matchedBug = bugs.find(
        (b) => b._id === cardData.id || b.pattern === cardData.title,
      );
      if (matchedBug) {
        setBugReport(matchedBug);

        // Fetch PR if linked
        if (matchedBug.prId) {
          try {
            const prs = await api.getPRs();
            const matchedPr = prs.find((p) => p._id === matchedBug.prId);
            if (matchedPr) setPr(matchedPr);
          } catch {
            // PR might not exist yet
          }
        }

        // Fetch agents — check both the live pool and DB (for completed agents)
        try {
          const found: AgentRecord[] = [];
          const seenIds = new Set<string>();

          // First, check the live pool for any running agents on this task
          const pool = await api.getAgents();
          for (const a of pool.agents) {
            if (a.taskId === matchedBug._id || a._id === matchedBug.fixAgentId) {
              if (a._id && !seenIds.has(a._id)) {
                seenIds.add(a._id);
                found.push(a);
              }
            }
          }

          // If the bug has a fixAgentId and we didn't find it in the pool,
          // fetch it directly (falls back to MongoDB for completed agents)
          if (matchedBug.fixAgentId && !seenIds.has(matchedBug.fixAgentId)) {
            try {
              const agent = await api.getAgent(matchedBug.fixAgentId);
              if (agent) found.push(agent);
            } catch {
              // Agent record might have been cleaned up
            }
          }

          setAgents(found);
        } catch {
          // Agents might not be available
        }
      }
    } catch (err) {
      console.error('Failed to fetch pipeline details:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (card) {
      fetchDetails(card);
    }
  }, [card, fetchDetails]);

  // Close on Escape
  useEffect(() => {
    if (!card) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [card, onClose]);

  if (!card) return null;

  const diffSections = pr ? parseDiffSections(pr.diff) : [];

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Slide-in panel */}
      <div
        className="
          fixed right-0 top-0 z-50 h-full w-full max-w-2xl
          overflow-y-auto border-l border-[var(--border-color)]
          bg-[var(--bg-primary)] shadow-2xl
          animate-slide-in-right
        "
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--border-color)] bg-[var(--bg-primary)]/95 backdrop-blur-sm px-6 py-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-blue)]/10 ring-1 ring-[var(--accent-blue)]/20">
              <Bug className="h-4.5 w-4.5 text-[var(--accent-blue)]" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold text-[var(--text-primary)]">
                {card.title}
              </h2>
              <p className="text-xs text-[var(--text-muted)]">
                Pipeline Detail
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="ml-3 shrink-0 rounded-lg p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            aria-label="Close detail panel"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="space-y-6 p-6">
          {loading ? (
            <div className="space-y-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="animate-pulse space-y-2">
                  <div className="h-4 w-32 rounded bg-[var(--bg-tertiary)]" />
                  <div className="h-16 rounded bg-[var(--bg-tertiary)]" />
                </div>
              ))}
            </div>
          ) : (
            <>
              {/* Bug Report Section */}
              {bugReport && (
                <section>
                  <SectionHeader icon={Bug} label="Bug Report" />
                  <div className="space-y-3 rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4">
                    <div>
                      <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                        Pattern
                      </h4>
                      <p className="text-sm text-[var(--text-primary)]">
                        {bugReport.pattern}
                      </p>
                    </div>

                    <div>
                      <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                        Evidence
                      </h4>
                      <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                        {bugReport.evidence}
                      </p>
                    </div>

                    <div>
                      <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                        Suspected Root Cause
                      </h4>
                      <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                        {bugReport.suspectedRootCause}
                      </p>
                    </div>

                    {bugReport.verificationResult && (
                      <div>
                        <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                          Verification
                        </h4>
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${
                              bugReport.verificationResult.confirmed
                                ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                                : 'bg-red-500/10 text-red-400 ring-red-500/20'
                            }`}
                          >
                            {bugReport.verificationResult.confirmed
                              ? 'Confirmed'
                              : 'Not confirmed'}
                          </span>
                          <span className="text-xs text-[var(--text-muted)]">
                            via {bugReport.verificationResult.method}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-[var(--text-secondary)]">
                          {bugReport.verificationResult.details}
                        </p>
                      </div>
                    )}

                    {bugReport.affectedFiles.length > 0 && (
                      <div>
                        <h4 className="mb-1 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
                          Affected Files
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {bugReport.affectedFiles.map((f, i) => (
                            <code
                              key={i}
                              className="rounded bg-[var(--bg-tertiary)] px-2 py-0.5 font-mono text-xs text-[var(--text-secondary)]"
                            >
                              {f}
                            </code>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Agent Trace Section */}
              {agents.length > 0 && (
                <section>
                  <SectionHeader icon={Cpu} label="Agent Trace" />
                  <div className="space-y-2">
                    {agents.map((agent) => (
                      <AgentTraceCard key={agent._id} agent={agent} />
                    ))}
                  </div>
                </section>
              )}

              {/* Diff Viewer Section */}
              {pr && diffSections.length > 0 && (
                <section>
                  <SectionHeader icon={FileCode} label="Diff" />
                  <div className="space-y-2">
                    {diffSections.map((section, i) => (
                      <DiffFileSection
                        key={i}
                        filename={section.filename}
                        content={section.content}
                      />
                    ))}
                  </div>
                </section>
              )}

              {/* PR Details Section */}
              {pr && (
                <section>
                  <SectionHeader icon={GitPullRequest} label="Pull Request" />
                  <div className="rounded-xl border border-[var(--border-color)] bg-[var(--bg-card)] p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <a
                        href={pr.prUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 font-mono text-sm font-medium text-[var(--accent-blue)] transition-colors hover:text-blue-300"
                      >
                        #{pr.prNumber} {pr.title}
                        <ExternalLink className="h-3 w-3 opacity-60" />
                      </a>
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ${
                          pr.status === 'merged'
                            ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
                            : pr.status === 'open'
                              ? 'bg-blue-500/10 text-blue-400 ring-blue-500/20'
                              : 'bg-red-500/10 text-red-400 ring-red-500/20'
                        }`}
                      >
                        {pr.status}
                      </span>
                    </div>

                    {pr.description && (
                      <p className="text-sm leading-relaxed text-[var(--text-secondary)]">
                        {pr.description}
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
                      <span>
                        Branch:{' '}
                        <code className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[var(--text-secondary)]">
                          {pr.branch}
                        </code>
                      </span>
                      <span>
                        Verified via:{' '}
                        <span className="text-[var(--text-secondary)]">
                          {pr.verificationMethod}
                        </span>
                      </span>
                      {pr.resolution && (
                        <span>
                          Resolution:{' '}
                          <span
                            className={
                              pr.resolution === 'accepted'
                                ? 'text-emerald-400'
                                : 'text-red-400'
                            }
                          >
                            {pr.resolution}
                          </span>
                        </span>
                      )}
                    </div>

                    {/* Rejection feedback */}
                    {pr.rejectionFeedback && (
                      <div className="flex items-start gap-2 rounded-lg bg-red-500/5 p-3 ring-1 ring-red-500/10">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                        <div>
                          <h4 className="mb-0.5 text-xs font-medium text-red-400">
                            Rejection Reason
                          </h4>
                          <p className="text-sm text-red-300">
                            {pr.rejectionFeedback}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* Empty state */}
              {!bugReport && !pr && !loading && (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <MessageSquare className="mb-3 h-10 w-10 text-[var(--text-muted)]" />
                  <p className="text-sm text-[var(--text-muted)]">
                    No detailed information available for this item yet.
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Animation keyframes injected via style tag */}
      <style>{`
        @keyframes slide-in-right {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slide-in-right 0.25s ease-out;
        }
      `}</style>
    </>
  );
}
