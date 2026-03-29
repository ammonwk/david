import { useState, useEffect, useCallback, useRef } from 'react';
import type { PromptTemplate, PromptType, PromptVariable } from 'david-shared';
import {
  ScrollText,
  Save,
  RotateCcw,
  History,
  ChevronDown,
  ChevronRight,
  Check,
  AlertCircle,
  Loader2,
  Undo2,
  Info,
  Braces,
} from 'lucide-react';
import { api } from '../lib/api';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_ORDER: PromptType[] = ['log-analysis', 'audit', 'verify', 'fix', 'pr-description'];

const TYPE_ICONS: Record<PromptType, string> = {
  'log-analysis': 'LA',
  audit: 'AU',
  verify: 'VE',
  fix: 'FX',
  'pr-description': 'PR',
};

const TYPE_COLORS: Record<PromptType, string> = {
  'log-analysis': 'var(--accent-blue)',
  audit: 'var(--accent-purple, #a855f7)',
  verify: 'var(--accent-yellow, #eab308)',
  fix: 'var(--accent-green, #22c55e)',
  'pr-description': 'var(--accent-orange, #f97316)',
};

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export function PromptEditor() {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<PromptType | null>(null);
  const [editBody, setEditBody] = useState('');
  const [changeDesc, setChangeDesc] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [varsOpen, setVarsOpen] = useState(true);
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------

  const fetchTemplates = useCallback(async () => {
    try {
      setError(null);
      const data = await api.getPrompts();
      // Sort by the canonical order
      data.sort((a, b) => {
        const ai = TYPE_ORDER.indexOf(a._id as PromptType);
        const bi = TYPE_ORDER.indexOf(b._id as PromptType);
        return ai - bi;
      });
      setTemplates(data);

      // Auto-select first if nothing selected
      if (!selectedId && data.length > 0) {
        setSelectedId(data[0]._id as PromptType);
        setEditBody(data[0].body);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    fetchTemplates();
  }, []);

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  const selected = templates.find(t => t._id === selectedId) ?? null;

  const handleSelect = (id: PromptType) => {
    if (dirty && !confirm('You have unsaved changes. Discard them?')) return;
    setSelectedId(id);
    const t = templates.find(t => t._id === id);
    if (t) setEditBody(t.body);
    setDirty(false);
    setChangeDesc('');
    setSaveSuccess(false);
    setHistoryOpen(false);
  };

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  const handleSave = async () => {
    if (!selectedId || !dirty) return;
    setSaving(true);
    setSaveSuccess(false);
    setError(null);
    try {
      const updated = await api.updatePrompt(selectedId, {
        body: editBody,
        changeDescription: changeDesc || undefined,
      });
      setTemplates(prev => prev.map(t => t._id === updated._id ? updated : t));
      setDirty(false);
      setChangeDesc('');
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  // -------------------------------------------------------------------------
  // Revert to version
  // -------------------------------------------------------------------------

  const handleRevert = async (version: number) => {
    if (!selectedId) return;
    if (!confirm(`Revert to version ${version}? This will create a new version.`)) return;
    try {
      setError(null);
      const updated = await api.revertPrompt(selectedId, version);
      setTemplates(prev => prev.map(t => t._id === updated._id ? updated : t));
      setEditBody(updated.body);
      setDirty(false);
    } catch (err: any) {
      setError(err.message);
    }
  };

  // -------------------------------------------------------------------------
  // Reset to default
  // -------------------------------------------------------------------------

  const handleReset = async () => {
    if (!selectedId) return;
    if (!confirm('Reset to the hardcoded default? This will create a new version entry.')) return;
    try {
      setError(null);
      const updated = await api.resetPrompt(selectedId);
      setTemplates(prev => prev.map(t => t._id === updated._id ? updated : t));
      setEditBody(updated.body);
      setDirty(false);
    } catch (err: any) {
      setError(err.message);
    }
  };

  // -------------------------------------------------------------------------
  // Insert variable helper
  // -------------------------------------------------------------------------

  const insertVariable = (varName: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const marker = `{{${varName}}}`;
    const newBody = editBody.slice(0, start) + marker + editBody.slice(end);
    setEditBody(newBody);
    setDirty(true);
    // Restore cursor position after the inserted marker
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.selectionStart = textarea.selectionEnd = start + marker.length;
    });
  };

  // -------------------------------------------------------------------------
  // Keyboard shortcut: Ctrl+S / Cmd+S to save
  // -------------------------------------------------------------------------

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (dirty && !saving) handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [dirty, saving, handleSave]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--text-secondary)]">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading prompt templates...
      </div>
    );
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel: template list */}
      <div
        className="
          flex flex-col border-r border-[var(--border-color)]
          bg-[var(--bg-secondary)] overflow-y-auto
        "
        style={{ width: 280, minWidth: 280 }}
      >
        <div className="px-4 py-3 border-b border-[var(--border-color)]">
          <div className="flex items-center gap-2 text-[var(--text-primary)] font-semibold text-sm">
            <ScrollText className="h-4 w-4" />
            Agent Prompts
          </div>
          <p className="text-[11px] text-[var(--text-tertiary)] mt-1">
            Edit the instructions sent to investigation and fixing agents
          </p>
        </div>

        <div className="flex flex-col gap-1 p-2">
          {templates.map(t => {
            const type = t._id as PromptType;
            const isSelected = type === selectedId;
            const color = TYPE_COLORS[type];
            return (
              <button
                key={type}
                onClick={() => handleSelect(type)}
                className={`
                  text-left rounded-lg px-3 py-2.5 transition-all duration-150
                  ${isSelected
                    ? 'bg-[var(--accent-blue)]/10 ring-1 ring-[var(--accent-blue)]/30'
                    : 'hover:bg-[var(--bg-tertiary)]'
                  }
                `}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="
                      h-7 w-7 rounded-md flex items-center justify-center
                      text-[10px] font-bold shrink-0
                    "
                    style={{
                      backgroundColor: `${color}20`,
                      color,
                    }}
                  >
                    {TYPE_ICONS[type]}
                  </div>
                  <div className="min-w-0">
                    <div className={`
                      text-[13px] font-medium truncate
                      ${isSelected ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}
                    `}>
                      {t.name}
                    </div>
                    <div className="text-[11px] text-[var(--text-tertiary)] truncate">
                      v{t.versions.length} &middot; {formatRelativeTime(t.updatedAt)}
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Right panel: editor */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {selected ? (
          <>
            {/* Top bar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]">
              <div>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {selected.name}
                </h2>
                <p className="text-[11px] text-[var(--text-tertiary)]">
                  {selected.description}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {/* Change description input */}
                {dirty && (
                  <input
                    type="text"
                    placeholder="Change description (optional)"
                    value={changeDesc}
                    onChange={e => setChangeDesc(e.target.value)}
                    className="
                      h-7 w-52 rounded-md border border-[var(--border-color)]
                      bg-[var(--bg-primary)] px-2 text-xs text-[var(--text-primary)]
                      placeholder:text-[var(--text-tertiary)]
                      focus:outline-none focus:ring-1 focus:ring-[var(--accent-blue)]
                    "
                    onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
                  />
                )}

                {saveSuccess && (
                  <span className="flex items-center gap-1 text-[11px] text-green-500">
                    <Check className="h-3 w-3" /> Saved
                  </span>
                )}

                <button
                  onClick={handleReset}
                  className="
                    flex items-center gap-1.5 rounded-md px-2.5 py-1.5
                    text-[11px] font-medium text-[var(--text-secondary)]
                    hover:bg-[var(--bg-tertiary)] transition-colors
                  "
                  title="Reset to hardcoded default"
                >
                  <RotateCcw className="h-3 w-3" />
                  Reset
                </button>

                <button
                  onClick={handleSave}
                  disabled={!dirty || saving}
                  className={`
                    flex items-center gap-1.5 rounded-md px-3 py-1.5
                    text-[11px] font-semibold transition-colors
                    ${dirty
                      ? 'bg-[var(--accent-blue)] text-white hover:bg-[var(--accent-blue)]/90'
                      : 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] cursor-not-allowed'
                    }
                  `}
                >
                  {saving ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                  Save
                </button>
              </div>
            </div>

            {/* Error banner */}
            {error && (
              <div className="flex items-center gap-2 px-4 py-2 bg-red-500/10 text-red-400 text-xs">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {error}
              </div>
            )}

            {/* Main content area */}
            <div className="flex flex-1 overflow-hidden">
              {/* Editor */}
              <div className="flex flex-1 flex-col overflow-hidden">
                <textarea
                  ref={textareaRef}
                  value={editBody}
                  onChange={e => {
                    setEditBody(e.target.value);
                    if (!dirty) setDirty(true);
                  }}
                  spellCheck={false}
                  className="
                    flex-1 resize-none p-4 font-mono text-[12px] leading-[1.6]
                    bg-[var(--bg-primary)] text-[var(--text-primary)]
                    focus:outline-none
                    selection:bg-[var(--accent-blue)]/30
                  "
                  style={{ tabSize: 2 }}
                />

                {/* Bottom stats bar */}
                <div className="flex items-center justify-between px-4 py-1.5 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-tertiary)]">
                  <span>{editBody.length.toLocaleString()} characters &middot; ~{Math.ceil(editBody.length / 4).toLocaleString()} tokens</span>
                  <span>
                    {dirty ? 'Unsaved changes' : 'Up to date'} &middot; Ctrl+S to save
                  </span>
                </div>
              </div>

              {/* Right sidebar: variables + history */}
              <div
                className="
                  flex flex-col border-l border-[var(--border-color)]
                  bg-[var(--bg-secondary)] overflow-y-auto
                "
                style={{ width: 260, minWidth: 260 }}
              >
                {/* Variables section */}
                <div className="border-b border-[var(--border-color)]">
                  <button
                    onClick={() => setVarsOpen(!varsOpen)}
                    className="
                      flex items-center gap-2 w-full px-3 py-2.5
                      text-[12px] font-semibold text-[var(--text-primary)]
                      hover:bg-[var(--bg-tertiary)] transition-colors
                    "
                  >
                    {varsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <Braces className="h-3.5 w-3.5" />
                    Variables
                    <span className="text-[10px] font-normal text-[var(--text-tertiary)] ml-auto">
                      {selected.variables.length}
                    </span>
                  </button>

                  {varsOpen && (
                    <div className="px-2 pb-2">
                      {selected.variables.map((v: PromptVariable) => (
                        <button
                          key={v.name}
                          onClick={() => insertVariable(v.name)}
                          className="
                            w-full text-left rounded-md px-2 py-1.5 mb-0.5
                            hover:bg-[var(--bg-tertiary)] transition-colors group
                          "
                          title={`Click to insert {{${v.name}}} at cursor`}
                        >
                          <div className="flex items-center gap-1.5">
                            <code className="text-[11px] font-mono text-[var(--accent-blue)]">
                              {`{{${v.name}}}`}
                            </code>
                          </div>
                          <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5 leading-tight">
                            {v.description}
                          </div>
                        </button>
                      ))}

                      <div className="flex items-start gap-1.5 px-2 py-1.5 mt-1 rounded-md bg-[var(--accent-blue)]/5">
                        <Info className="h-3 w-3 text-[var(--accent-blue)] shrink-0 mt-0.5" />
                        <span className="text-[10px] text-[var(--text-tertiary)] leading-tight">
                          Click a variable to insert it at the cursor position in the editor
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Version history section */}
                <div>
                  <button
                    onClick={() => setHistoryOpen(!historyOpen)}
                    className="
                      flex items-center gap-2 w-full px-3 py-2.5
                      text-[12px] font-semibold text-[var(--text-primary)]
                      hover:bg-[var(--bg-tertiary)] transition-colors
                    "
                  >
                    {historyOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <History className="h-3.5 w-3.5" />
                    Version History
                    <span className="text-[10px] font-normal text-[var(--text-tertiary)] ml-auto">
                      {selected.versions.length}
                    </span>
                  </button>

                  {historyOpen && (
                    <div className="px-2 pb-2 max-h-80 overflow-y-auto">
                      {[...selected.versions]
                        .sort((a, b) => b.version - a.version)
                        .map(v => {
                          const isCurrent = v.version === selected.versions.length;
                          return (
                            <div
                              key={v.version}
                              className={`
                                rounded-md px-2.5 py-2 mb-1
                                ${isCurrent
                                  ? 'bg-[var(--accent-blue)]/8 ring-1 ring-[var(--accent-blue)]/20'
                                  : 'hover:bg-[var(--bg-tertiary)]'
                                }
                              `}
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-[11px] font-medium text-[var(--text-primary)]">
                                  v{v.version}
                                  {isCurrent && (
                                    <span className="ml-1.5 text-[10px] text-[var(--accent-blue)] font-normal">
                                      current
                                    </span>
                                  )}
                                </span>
                                {!isCurrent && (
                                  <button
                                    onClick={() => handleRevert(v.version)}
                                    className="
                                      flex items-center gap-1 text-[10px] text-[var(--text-secondary)]
                                      hover:text-[var(--accent-blue)] transition-colors
                                    "
                                    title={`Revert to version ${v.version}`}
                                  >
                                    <Undo2 className="h-3 w-3" />
                                    Revert
                                  </button>
                                )}
                              </div>
                              <div className="text-[10px] text-[var(--text-tertiary)] mt-0.5">
                                {formatRelativeTime(v.editedAt)}
                              </div>
                              {v.changeDescription && (
                                <div className="text-[10px] text-[var(--text-secondary)] mt-0.5 italic">
                                  {v.changeDescription}
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-[var(--text-tertiary)] text-sm">
            Select a prompt template to edit
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const now = Date.now();
  const diff = now - d.getTime();

  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d ago`;

  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
