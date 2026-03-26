// ============================================
// David — AI SRE Tool
// Managed Agent Lifecycle
// ============================================
//
// Wraps a single CLI-backed coding agent with lifecycle management:
// spawn, monitor, timeout, restart, and output capture.
// Adapted from plaibook-internal's ManagedProcess.
// ============================================

import { EventEmitter } from 'events';
import { config } from '../config.js';
import type { AgentType, AgentStatus, AgentRecord, AgentResult } from 'david-shared';
// Note: will import from ./cli-launcher.js at runtime — code against the interface
// import { launchCLI, killWithEscalation, type CLIProcess, type CLILaunchOptions } from './cli-launcher.js';

// ============================================
// Types
// ============================================

export interface ManagedAgentOptions {
  id: string;
  type: AgentType;
  prompt: string;
  cwd: string;
  taskId: string;
  nodeId?: string;
  parentAgentId?: string;
  worktreePath?: string;
  branch?: string;
  timeoutMs?: number;
  maxRestarts?: number;
  systemPrompt?: string;
  env?: Record<string, string>;
}

export interface ManagedAgentServices {
  launchCLI?: (options: {
    prompt: string;
    cwd: string;
    sessionId?: string;
    systemPrompt?: string;
    env?: Record<string, string>;
  }) => any | Promise<any>;
}

/** Maximum number of output lines kept in memory. */
const OUTPUT_LOG_MAX_LINES = 500;

/** Number of output lines persisted to the database record. */
const OUTPUT_LOG_DB_LINES = 100;

/** Number of trailing output lines scanned when parsing a structured result. */
const RESULT_PARSE_TAIL_LINES = 50;

// ============================================
// ManagedAgent
// ============================================

export class ManagedAgent extends EventEmitter {
  // ---- Events ----
  // 'status'    -> (status: AgentStatus)
  // 'output'    -> (line: string)
  // 'result'    -> (result: AgentResult)
  // 'error'     -> (error: Error)
  // 'restarted' -> (attempt: number)

  // ---- Public readonly fields ----
  readonly id: string;
  readonly type: AgentType;
  readonly taskId: string;
  readonly nodeId?: string;
  readonly parentAgentId?: string;
  readonly worktreePath?: string;
  readonly branch?: string;

  // ---- Private state ----
  private status: AgentStatus = 'queued';
  private process: /* CLIProcess */ any = null;
  private cliSessionId: string | null = null;
  private createdAt: Date = new Date();
  private startedAt: Date | null = null;
  private completedAt: Date | null = null;
  private restarts: number = 0;
  private maxRestarts: number;
  private timeoutMs: number;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private outputLog: string[] = [];
  private result: AgentResult | null = null;
  private prompt: string;
  private cwd: string;
  private systemPrompt?: string;
  private env?: Record<string, string>;
  /** True while a restart attempt is in progress (backoff + relaunch). */
  private restarting: boolean = false;
  private services: ManagedAgentServices;
  private static readonly TOOL_OUTPUT_MAX = 180;

  constructor(options: ManagedAgentOptions, services: ManagedAgentServices = {}) {
    super();

    this.id = options.id;
    this.type = options.type;
    this.prompt = options.prompt;
    this.cwd = options.cwd;
    this.taskId = options.taskId;
    this.nodeId = options.nodeId;
    this.parentAgentId = options.parentAgentId;
    this.worktreePath = options.worktreePath;
    this.branch = options.branch;
    this.timeoutMs = options.timeoutMs ?? config.agentTimeoutMs;
    this.maxRestarts = options.maxRestarts ?? config.agentMaxRestarts;
    this.systemPrompt = options.systemPrompt;
    this.env = options.env;
    this.services = services;
  }

  // ============================================
  // Public API
  // ============================================

  /** Start the agent. Called by the agent pool once a concurrency slot is available. */
  async start(): Promise<void> {
    this.setStatus('starting');

    try {
      await this.launchProcess();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.setStatus('failed');
      this.emit('error', error);
    }
  }

  /** Stop the agent immediately (kill the underlying process). */
  async stop(): Promise<void> {
    this.clearTimeout();

    if (this.process) {
      await this.killProcess();
    }

    // Only transition if we are not already in a terminal state.
    if (!this.isTerminal()) {
      this.setStatus('failed');
    }
  }

  /** Current lifecycle status. */
  getStatus(): AgentStatus {
    return this.status;
  }

  /** Copy of the in-memory output ring buffer. */
  getOutputLog(): string[] {
    return [...this.outputLog];
  }

  /** Snapshot suitable for persistence in MongoDB. */
  toRecord(): AgentRecord {
    return {
      _id: this.id,
      type: this.type,
      status: this.status,
      taskId: this.taskId,
      nodeId: this.nodeId,
      parentAgentId: this.parentAgentId,
      worktreePath: this.worktreePath,
      branch: this.branch,
      cliSessionId: this.cliSessionId ?? undefined,
      startedAt: this.startedAt ?? undefined,
      completedAt: this.completedAt ?? undefined,
      restarts: this.restarts,
      maxRestarts: this.maxRestarts,
      timeoutMs: this.timeoutMs,
      outputLog: this.outputLog.slice(-OUTPUT_LOG_DB_LINES),
      result: this.result ?? undefined,
      createdAt: this.createdAt,
    };
  }

  /** Whether the agent has reached a terminal state and will not change further. */
  isTerminal(): boolean {
    return this.status === 'completed' || this.status === 'failed' || this.status === 'timeout';
  }

  // ============================================
  // Process lifecycle (private)
  // ============================================

  /**
   * Launch (or re-launch) the CLI subprocess and wire up event handlers.
   * If we have a previous cliSessionId we pass --resume so the agent can
   * continue from where it left off.
   */
  private async launchProcess(): Promise<void> {
    const launchCLI = this.services.launchCLI ?? await this.loadLaunchCLI();

    this.process = await launchCLI({
      prompt: this.prompt,
      cwd: this.worktreePath ?? this.cwd,
      systemPrompt: this.systemPrompt,
      env: this.env,
      sessionId: this.cliSessionId ?? undefined,
    });

    // ---- Wire event handlers ----

    this.process.on('session_id', (sessionId: string) => {
      this.cliSessionId = sessionId;
    });

    this.process.on('text', (line: string) => {
      this.pushOutput(line);
    });

    this.process.on('tool_use', (name: string, input: unknown) => {
      this.pushOutput(this.formatToolUse(name, input));
    });

    this.process.on('result', (raw: unknown) => {
      const parsed = this.coerceAgentResult(raw);
      if (parsed) {
        this.result = parsed;
        this.completedAt = new Date();
        this.setStatus('completed');
        this.clearTimeout();
        this.emit('result', parsed);
      }
    });

    this.process.on('error', (err: Error) => {
      this.pushOutput(`[error] ${err.message}`);
      this.emit('error', err);
      // Do not transition status here — wait for the 'exit' event to decide
      // whether to restart or fail.
    });

    this.process.on('exit', (code: number | null) => {
      this.process = null;
      this.handleExit(code);
    });

    // Transition to running and arm the timeout.
    this.startedAt = this.startedAt ?? new Date();
    this.setStatus('running');
    this.startTimeout();
  }

  /** Handle the subprocess exiting. */
  private handleExit(code: number | null): void {
    // Already completed via a structured 'result' event — nothing to do.
    if (this.status === 'completed') return;

    // Already in a terminal state — nothing to do.
    if (this.isTerminal()) return;

    // handleTimeout is managing the restart — it killed the process
    // and will handle the restart itself, so ignore this exit event.
    if (this.restarting) return;

    if (code === 0) {
      // Clean exit but no structured result arrived via event.
      // Attempt to parse one from the captured output.
      const parsed = this.parseResult(this.outputLog);
      this.result = parsed;
      this.completedAt = new Date();
      this.clearTimeout();
      this.setStatus('completed');
      if (parsed) {
        this.emit('result', parsed);
      }
    } else {
      // Non-zero exit — try to restart.
      this.clearTimeout();
      this.attemptRestart().catch((err) => {
        console.error(`[managed-agent] Unhandled error during restart of ${this.id}:`, err);
        if (!this.isTerminal()) {
          this.completedAt = new Date();
          this.setStatus('failed');
        }
      });
    }
  }

  /** Attempt to restart the agent within the configured retry budget. */
  private async attemptRestart(): Promise<void> {
    this.restarting = true;
    const restarted = await this.restart();
    this.restarting = false;
    if (!restarted) {
      this.completedAt = new Date();
      this.setStatus('failed');
    }
  }

  // ============================================
  // Restart logic
  // ============================================

  /**
   * Restart the agent if the retry budget has not been exhausted.
   * Applies exponential backoff from config.agentRestartBackoffMs.
   * Returns true if a restart was initiated, false if the budget is spent.
   */
  private async restart(): Promise<boolean> {
    if (this.restarts >= this.maxRestarts) {
      return false;
    }

    this.restarts += 1;

    // Determine backoff delay (clamp index to array length).
    const backoffIndex = Math.min(
      this.restarts - 1,
      config.agentRestartBackoffMs.length - 1,
    );
    const backoffMs = config.agentRestartBackoffMs[backoffIndex];

    this.appendOutput(
      `[lifecycle] restarting (attempt ${this.restarts}/${this.maxRestarts}) after ${backoffMs}ms backoff`,
    );

    await this.delay(backoffMs);

    // Guard: the agent may have been stopped externally during the backoff.
    if (this.isTerminal()) return false;

    this.setStatus('starting');

    try {
      await this.launchProcess();
      this.emit('restarted', this.restarts);
      return true;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('error', error);
      return false;
    }
  }

  // ============================================
  // Timeout handling
  // ============================================

  /** Arm the timeout timer. */
  private startTimeout(): void {
    this.clearTimeout();
    this.timeoutTimer = setTimeout(() => {
      this.handleTimeout();
    }, this.timeoutMs);
  }

  /** Clear the timeout timer if one is pending. */
  private clearTimeout(): void {
    if (this.timeoutTimer) {
      globalThis.clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  /** Called when the agent has exceeded its time budget. */
  private async handleTimeout(): Promise<void> {
    this.appendOutput(
      `[lifecycle] agent timed out after ${this.timeoutMs}ms`,
    );

    // Mark that we are attempting a restart BEFORE killing the process.
    // The kill triggers the 'exit' event synchronously during the await,
    // and handleExit must see restarting=true so it does not also attempt
    // a restart (which would cause two concurrent CLI processes).
    this.restarting = true;

    if (this.process) {
      await this.killProcess();
    }

    // Attempt a restart even after a timeout — the agent might make
    // progress on the next try (e.g. resuming from its session).
    const restarted = await this.restart();
    this.restarting = false;

    if (!restarted) {
      this.completedAt = new Date();
      // Emit 'timeout' so consumers can distinguish the cause, then
      // immediately transition to 'failed' which is the true terminal state.
      this.setStatus('timeout');
    }
  }

  // ============================================
  // Process management helpers
  // ============================================

  /** Kill the subprocess, escalating from SIGTERM to SIGKILL if necessary. */
  private async killProcess(): Promise<void> {
    if (!this.process) return;

    try {
      // Use the CLIProcess.kill() method which passes the internal exitPromise
      // to killWithEscalation, enabling early return when the process exits
      // before the grace period expires.
      await this.process.kill();
    } catch {
      // Best-effort: if the process is already gone this is fine.
    } finally {
      this.process = null;
    }
  }

  // ============================================
  // Output ring buffer
  // ============================================

  /** Append a line to the in-memory output ring buffer. */
  private appendOutput(line: string): void {
    this.outputLog.push(line);
    if (this.outputLog.length > OUTPUT_LOG_MAX_LINES) {
      // Trim from the front to keep the most recent lines.
      this.outputLog.splice(0, this.outputLog.length - OUTPUT_LOG_MAX_LINES);
    }
  }

  /** Append output and notify pool/dashboard subscribers. */
  private pushOutput(line: string): void {
    this.appendOutput(line);
    this.emit('output', line);
  }

  // ============================================
  // Result parsing
  // ============================================

  /**
   * Scan the tail of the output log for a JSON block containing an
   * AgentResult.  The agent is expected to emit a fenced JSON block:
   *
   *   ```json
   *   { "bugsFound": 1, "bugsVerified": 1, ..., "summary": "..." }
   *   ```
   *
   * Returns null when no valid result is found.
   */
  private parseResult(output: string[]): AgentResult | null {
    if (output.length === 0) return null;

    // Only scan the last N lines to avoid expensive searches on long outputs.
    const tail = output.slice(-RESULT_PARSE_TAIL_LINES);
    const joined = tail.join('\n');

    // Strategy 1: look for a fenced JSON block (```json ... ```)
    const fencedMatch = joined.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    if (fencedMatch) {
      const parsed = this.tryParseAgentResult(fencedMatch[1]);
      if (parsed) return parsed;
    }

    // Strategy 2: look for the outermost { ... } that looks like a result.
    // Walk backwards through the tail to find the last JSON object.
    for (let i = tail.length - 1; i >= 0; i--) {
      const line = tail[i].trim();
      if (line.startsWith('{') && line.endsWith('}')) {
        const parsed = this.tryParseAgentResult(line);
        if (parsed) return parsed;
      }
    }

    // Strategy 3: accumulate lines between the last '{' and '}' seen.
    let braceStart = -1;
    let braceEnd = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      if (braceEnd === -1 && tail[i].trim().endsWith('}')) {
        braceEnd = i;
      }
      if (braceEnd !== -1 && tail[i].trim().startsWith('{')) {
        braceStart = i;
        break;
      }
    }

    if (braceStart !== -1 && braceEnd !== -1 && braceStart <= braceEnd) {
      const candidate = tail.slice(braceStart, braceEnd + 1).join('\n');
      const parsed = this.tryParseAgentResult(candidate);
      if (parsed) return parsed;
    }

    return null;
  }

  /**
   * Attempt to JSON-parse a string and validate it as an AgentResult.
   * Returns a well-typed AgentResult or null.
   */
  private tryParseAgentResult(raw: string): AgentResult | null {
    try {
      const obj = JSON.parse(raw);
      if (typeof obj !== 'object' || obj === null) return null;

      // The only required field is `summary`.
      if (typeof obj.summary !== 'string') return null;

      return {
        bugsFound: typeof obj.bugsFound === 'number' ? obj.bugsFound : undefined,
        bugsVerified: typeof obj.bugsVerified === 'number' ? obj.bugsVerified : undefined,
        fixesApplied: typeof obj.fixesApplied === 'number' ? obj.fixesApplied : undefined,
        prsCreated: typeof obj.prsCreated === 'number' ? obj.prsCreated : undefined,
        summary: obj.summary,
      };
    } catch {
      return null;
    }
  }

  /**
   * Coerce an unknown value (from the CLI 'result' event) into an
   * AgentResult, returning null on failure.
   */
  private coerceAgentResult(raw: unknown): AgentResult | null {
    if (typeof raw === 'string') {
      return this.tryParseAgentResult(raw);
    }
    if (typeof raw === 'object' && raw !== null) {
      return this.tryParseAgentResult(JSON.stringify(raw));
    }
    return null;
  }

  private formatToolUse(name: string, input: unknown): string {
    if (input && typeof input === 'object') {
      const record = input as Record<string, unknown>;
      const statusBits: string[] = [];

      if (typeof record.status === 'string' && record.status !== 'in_progress') {
        statusBits.push(record.status);
      }
      if (typeof record.exit_code === 'number' || typeof record.exit_code === 'string') {
        statusBits.push(`exit ${record.exit_code}`);
      }

      const statusSuffix = statusBits.length > 0 ? ` (${statusBits.join(', ')})` : '';

      if (typeof record.command === 'string' && record.command.trim()) {
        return `$ ${this.truncate(this.squashWhitespace(record.command), ManagedAgent.TOOL_OUTPUT_MAX)}${statusSuffix}`;
      }

      if (typeof record.path === 'string' && record.path.trim()) {
        return `Tool: ${name} ${this.truncate(record.path, ManagedAgent.TOOL_OUTPUT_MAX)}${statusSuffix}`;
      }

      if (Array.isArray(record.changes)) {
        return `Tool: ${name} ${record.changes.length} change(s)${statusSuffix}`;
      }

      if (typeof record.text === 'string' && record.text.trim()) {
        return `Tool: ${name} ${this.truncate(this.squashWhitespace(record.text), ManagedAgent.TOOL_OUTPUT_MAX)}${statusSuffix}`;
      }

      const compact = this.compactJSON(record);
      if (compact !== '{}') {
        return `Tool: ${name} ${this.truncate(compact, ManagedAgent.TOOL_OUTPUT_MAX)}${statusSuffix}`;
      }
    }

    return `Tool: ${name}`;
  }

  // ============================================
  // Status transitions
  // ============================================

  /**
   * Valid transitions between agent statuses.
   * Terminal states (completed, failed, timeout) have no outbound transitions.
   * During a restart, 'running' -> 'starting' is allowed (the agent crashed
   * and is relaunching).
   */
  private static readonly VALID_TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
    queued:    ['starting', 'failed'],
    starting:  ['running', 'failed', 'timeout'],
    running:   ['completed', 'failed', 'timeout', 'starting'],
    completed: [],
    failed:    [],
    timeout:   [],
  };

  /** Transition to a new status and emit a 'status' event. */
  private setStatus(next: AgentStatus): void {
    if (this.status === next) return;

    // During a restart the agent may transition from a non-terminal state
    // back to 'starting'.  Allow that explicitly.
    const allowed = this.restarting
      ? [...ManagedAgent.VALID_TRANSITIONS[this.status], 'starting' as AgentStatus]
      : ManagedAgent.VALID_TRANSITIONS[this.status];

    if (!allowed.includes(next)) {
      console.error(
        `[managed-agent] Invalid status transition for ${this.id}: ${this.status} -> ${next}`,
      );
      return;
    }

    this.status = next;
    this.emit('status', next);
  }

  // ============================================
  // Utilities
  // ============================================

  /** Promise-based delay. */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private compactJSON(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private squashWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private truncate(value: string, max: number): string {
    if (value.length <= max) {
      return value;
    }

    return `${value.slice(0, max - 1)}…`;
  }

  private async loadLaunchCLI(): Promise<NonNullable<ManagedAgentServices['launchCLI']>> {
    const { launchCLI } = await import('./cli-launcher.js');
    return launchCLI;
  }
}
