import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CLIMessage {
  type: string;
  subtype?: string;
  // Different message types have different shapes:
  // system:init -> { session_id: string }
  // assistant -> { message: { content: Array<{ type: 'text' | 'tool_use', text?: string, name?: string, input?: any }> } }
  // stream_event:content_block_delta -> { delta: { type: string, text?: string } }
  // stream_event:content_block_start -> { content_block: { type: string, name?: string } }
  // result -> { duration_ms: number, ... }
  [key: string]: unknown;
}

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  changes?: unknown;
  [key: string]: unknown;
}

export interface CLILaunchOptions {
  prompt: string;
  cwd: string;                    // Working directory (usually a worktree)
  sessionId?: string;             // For --resume
  systemPrompt?: string;          // Additional system prompt
  maxTurns?: number;              // --max-turns flag
  env?: Record<string, string>;   // Additional env vars
}

export interface CLIProcess extends EventEmitter {
  // Events:
  // 'message' -> (msg: CLIMessage) — parsed NDJSON message
  // 'text' -> (text: string) — extracted text content from assistant messages
  // 'tool_use' -> (name: string, input: any) — tool use started
  // 'result' -> (result: CLIMessage) — final result message
  // 'error' -> (err: Error) — process error
  // 'exit' -> (code: number | null, signal: string | null) — process exited
  // 'session_id' -> (id: string) — CLI session ID for future --resume

  pid: number;
  sessionId: string | null;

  /** Kill the process (SIGTERM, then SIGKILL after graceMs) */
  kill(graceMs?: number): Promise<void>;

  /** Check if process is still alive */
  isAlive(): boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class CLIProcessImpl extends EventEmitter implements CLIProcess {
  pid: number;
  sessionId: string | null = null;

  private child: ChildProcess;
  private alive = true;
  private stdoutBuffer = '';
  private emittedCodexToolItems = new Set<string>();
  private exitPromise: Promise<void>;
  private exitResolve!: () => void;

  constructor(child: ChildProcess) {
    super();
    this.child = child;
    this.pid = child.pid!;

    // Create a promise that resolves when the process exits — used by
    // killWithEscalation to avoid waiting the full grace period.
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });

    this.setupStdin();
    this.setupStdout();
    this.setupStderr();
    this.setupLifecycle();
  }

  // -- Public API -----------------------------------------------------------

  async kill(graceMs = 10000): Promise<void> {
    if (!this.alive) return;
    await killWithEscalation(this.pid, graceMs, this.exitPromise);
    this.alive = false;
  }

  isAlive(): boolean {
    return this.alive;
  }

  // -- Internals ------------------------------------------------------------

  /**
   * Listen for errors on stdin so a broken pipe doesn't crash the process.
   * stdin errors are expected when the CLI exits before we finish writing.
   */
  private setupStdin(): void {
    if (!this.child.stdin) return;

    this.child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE / ECONNRESET are expected if the child exits early — not a bug.
      if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return;
      console.error(`[cli-launcher pid=${this.pid}] stdin error: ${err.message}`);
    });
  }

  /**
   * Buffer incoming stdout data, split on newlines, and JSON.parse each
   * complete line as an NDJSON message.
   */
  private setupStdout(): void {
    if (!this.child.stdout) return;

    this.child.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split('\n');
      // The last element is either empty (line ended with \n) or a partial
      // line that we need to keep buffering.
      this.stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg: CLIMessage = JSON.parse(trimmed);
          if (config.cliBackend === 'codex') {
            this.handleCodexMessage(msg);
          } else {
            this.handleClaudeMessage(msg);
          }
        } catch {
          // Not valid JSON — ignore (could be raw CLI output during startup)
        }
      }
    });
  }

  /**
   * Log stderr but never let it crash the host process.
   */
  private setupStderr(): void {
    if (!this.child.stderr) return;

    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        // eslint-disable-next-line no-console
        console.error(`[cli-launcher pid=${this.pid}] stderr: ${text}`);
      }
    });
  }

  /**
   * Track process lifecycle: error + exit.
   */
  private setupLifecycle(): void {
    this.child.on('error', (err: Error) => {
      this.alive = false;
      this.exitResolve();
      this.emit('error', err);
    });

    this.child.on('exit', (code: number | null, signal: string | null) => {
      this.alive = false;
      this.exitResolve();

      // Flush any remaining buffered data
      if (this.stdoutBuffer.trim()) {
        try {
          const msg: CLIMessage = JSON.parse(this.stdoutBuffer.trim());
          if (config.cliBackend === 'codex') {
            this.handleCodexMessage(msg);
          } else {
            this.handleClaudeMessage(msg);
          }
        } catch {
          // Not JSON — discard
        }
        this.stdoutBuffer = '';
      }

      if (code !== null && code !== 0) {
        this.emit('error', new Error(`CLI exited with code ${code}`));
      }
      this.emit('exit', code, signal);
    });
  }

  /**
   * Central message dispatcher — emits typed events based on message shape.
   */
  private handleClaudeMessage(msg: CLIMessage): void {
    this.emit('message', msg);

    // system:init — capture session_id
    if (msg.type === 'system' && msg.subtype === 'init') {
      const sid = msg.session_id as string | undefined;
      if (sid) {
        this.sessionId = sid;
        this.emit('session_id', sid);
      }
      return;
    }

    // assistant message — extract text content and tool_use blocks
    if (msg.type === 'assistant') {
      const message = msg.message as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> } | undefined;
      if (message?.content && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            this.emit('text', block.text);
          } else if (block.type === 'tool_use' && block.name) {
            this.emit('tool_use', block.name, block.input);
          }
        }
      }
      return;
    }

    // stream_event:content_block_delta — incremental text
    if (msg.type === 'stream_event' && msg.subtype === 'content_block_delta') {
      const delta = msg.delta as { type?: string; text?: string } | undefined;
      if (delta?.type === 'text_delta' && delta.text) {
        this.emit('text', delta.text);
      }
      return;
    }

    // stream_event:content_block_start — tool use starting
    if (msg.type === 'stream_event' && msg.subtype === 'content_block_start') {
      const block = msg.content_block as { type?: string; name?: string } | undefined;
      if (block?.type === 'tool_use' && block.name) {
        this.emit('tool_use', block.name, undefined);
      }
      return;
    }

    // result — final result message
    if (msg.type === 'result') {
      this.emit('result', msg);
      return;
    }
  }

  /**
   * Codex JSONL event dispatcher — normalizes Codex exec events into the same
   * EventEmitter contract used by Claude.
   */
  private handleCodexMessage(msg: CLIMessage): void {
    this.emit('message', msg);

    if (msg.type === 'thread.started') {
      const sid = msg.thread_id as string | undefined;
      if (sid) {
        this.sessionId = sid;
        this.emit('session_id', sid);
      }
      return;
    }

    if (msg.type === 'item.started' || msg.type === 'item.completed') {
      const item = msg.item as CodexItem | undefined;
      if (!item) return;

      if (item.type === 'agent_message' && item.text) {
        this.emit('text', item.text);
        return;
      }

      if (this.isCodexToolItem(item)) {
        const shouldEmit =
          msg.type === 'item.started' ||
          (item.id ? !this.emittedCodexToolItems.has(item.id) : true);

        if (shouldEmit) {
          const toolName = item.type ?? 'tool';
          const toolInput = this.buildCodexToolPayload(item);
          this.emit('tool_use', toolName, toolInput);

          if (item.id) {
            this.emittedCodexToolItems.add(item.id);
          }
        }
      }
      return;
    }

    if (msg.type === 'turn.completed') {
      this.emit('result', msg);
    }
  }

  private isCodexToolItem(item: CodexItem): boolean {
    if (!item.type || item.type === 'agent_message') {
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

  private buildCodexToolPayload(item: CodexItem): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...item };

    if (item.command) {
      payload.command = item.command;
    }

    if (item.changes) {
      payload.changes = item.changes;
    }

    return payload;
  }
}

// ---------------------------------------------------------------------------
// Launcher
// ---------------------------------------------------------------------------

export function launchCLI(options: CLILaunchOptions): CLIProcess {
  const { binary, args } = buildCLICommand(options);

  const child = spawn(binary, args, {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: options.cwd,
    env: {
      ...process.env,
      ...options.env,
      DAVID_AGENT: '1',
    },
  });

  const cliProcess = new CLIProcessImpl(child);

  // Write the prompt as plain text to stdin and close it immediately.
  // There is no race condition here: Node.js will buffer the write internally
  // until the child process is ready to read.  Closing stdin signals to the
  // CLI that the full prompt has been delivered.
  if (child.stdin) {
    child.stdin.write(options.prompt, (err) => {
      if (err) {
        // If the write failed (e.g. process exited immediately), the error
        // handler on stdin will catch it.  We still need to end() to avoid
        // a resource leak.
        child.stdin!.end();
        return;
      }
      child.stdin!.end();
    });
  } else {
    // stdin should always exist because we configured stdio: ['pipe', ...],
    // but guard defensively.
    cliProcess.emit('error', new Error('CLI subprocess has no stdin'));
  }

  return cliProcess;
}

function buildCLICommand(options: CLILaunchOptions): { binary: string; args: string[] } {
  if (config.cliBackend === 'codex') {
    return buildCodexCommand(options);
  }

  return buildClaudeCommand(options);
}

function buildClaudeCommand(options: CLILaunchOptions): { binary: string; args: string[] } {
  const args: string[] = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  if (options.sessionId) {
    args.push('--resume', options.sessionId);
  }

  if (options.systemPrompt) {
    args.push('--system-prompt', options.systemPrompt);
  }

  if (options.maxTurns !== undefined) {
    args.push('--max-turns', String(options.maxTurns));
  }

  args.push('-p', '-');

  return {
    binary: config.claudeBinary,
    args,
  };
}

function buildCodexCommand(options: CLILaunchOptions): { binary: string; args: string[] } {
  const args: string[] = ['exec', '--json', '--full-auto'];

  if (options.systemPrompt) {
    args.push('-c', `developer_instructions=${JSON.stringify(options.systemPrompt)}`);
  }

  if (options.sessionId) {
    args.push('resume', options.sessionId);
  }

  // Codex reads the task prompt from stdin when passed `-` as the prompt.
  args.push('-');

  return {
    binary: config.codexBinary,
    args,
  };
}

// ---------------------------------------------------------------------------
// Process-group kill helpers
// ---------------------------------------------------------------------------

/**
 * Kill an entire process group.
 * Requires the child to have been spawned with `detached: true`.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill with escalation: SIGTERM -> wait graceMs -> SIGKILL.
 *
 * If an `exitPromise` is provided (from CLIProcessImpl), we race it against the
 * grace timer so that we don't needlessly wait if the process exits promptly.
 */
export async function killWithEscalation(
  pid: number,
  graceMs: number = 10000,
  exitPromise?: Promise<void>,
): Promise<void> {
  const sent = killProcessGroup(pid, 'SIGTERM');
  if (!sent) {
    // Process group doesn't exist (already gone) — nothing to do.
    return;
  }

  // Wait up to graceMs for the process to exit on its own.
  let timerId: NodeJS.Timeout;
  const timer = new Promise<'timeout'>((resolve) => {
    timerId = setTimeout(() => resolve('timeout'), graceMs);
  });

  const race = exitPromise
    ? Promise.race([exitPromise.then(() => 'exited' as const), timer])
    : timer;

  const result = await race;

  // Clean up the timer so it doesn't keep the event loop alive unnecessarily
  // when the process exited before the grace period expired.
  clearTimeout(timerId!);

  if (result === 'timeout') {
    // Escalate to SIGKILL — process did not exit within grace period.
    killProcessGroup(pid, 'SIGKILL');
  }
}
