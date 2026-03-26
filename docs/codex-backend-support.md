# Adding Codex CLI Backend Support

David's agent runtime currently shells out to the Claude Code CLI. This doc describes how to make the CLI backend configurable so operators can switch between Claude and Codex (OpenAI) without touching application code.

## Goal

A single env var (`CLI_BACKEND=claude|codex`) selects which CLI binary and protocol to use. Everything above `cli-launcher.ts` — ManagedAgent, the agent pool, the dashboard — remains unchanged. They already talk to a normalized EventEmitter interface (`text`, `tool_use`, `result`, `session_id`, `exit`) and must never know which backend is running.

---

## 1. Config

**File:** `server/src/config.ts`

Add:
- `cliBackend`: `'claude' | 'codex'` from `CLI_BACKEND` env var, default `'claude'`
- `codexBinary`: from `CODEX_BINARY` env var, default `'codex'`

The existing `claudeBinary` stays as-is.

Update `.env.example` with the new vars and a comment explaining when you'd switch.

---

## 2. CLI Launcher — Arg Construction

**File:** `server/src/agents/cli-launcher.ts`

The `launchCLI` function currently hardcodes Claude-specific args. Split the arg construction into two paths based on `config.cliBackend`.

### Claude args (existing behavior, no changes)
```
claude --print --output-format stream-json --verbose --dangerously-skip-permissions -p -
```

### Codex args
```
codex exec --json --full-auto -
```

Key mappings:
| Concern | Claude | Codex |
|---------|--------|-------|
| Binary | `config.claudeBinary` | `config.codexBinary` |
| One-shot mode | `--print` | `exec` subcommand |
| Streaming JSON | `--output-format stream-json` | `--json` |
| Bypass permissions | `--dangerously-skip-permissions` | `--full-auto` (or `--yolo` for full filesystem access) |
| Prompt via stdin | `-p -` | `-` (positional arg to `exec`) |
| Resume session | `--resume <id>` | `exec resume <id>` |
| System prompt | `--system-prompt <text>` | TBD — may need `--config` or profile |
| Max turns | `--max-turns N` | No direct equivalent — omit or use config |
| Verbose | `--verbose` | Not needed, `--json` covers it |

The `spawn()` call itself stays the same — `detached: true`, `stdio: ['pipe', 'pipe', 'pipe']`, `cwd`, merged env. Just swap the binary and args.

Prompt delivery is identical: write to stdin, then `end()`.

---

## 3. CLI Launcher — NDJSON Message Parsing

This is the core of the work. The `handleMessage` method in `CLIProcessImpl` must normalize two different NDJSON protocols into the same event interface.

### Claude NDJSON events (current)
```jsonl
{"type":"system","subtype":"init","session_id":"..."}
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"stream_event","subtype":"content_block_delta","delta":{"type":"text_delta","text":"..."}}
{"type":"stream_event","subtype":"content_block_start","content_block":{"type":"tool_use","name":"..."}}
{"type":"result","duration_ms":1234}
```

### Codex NDJSON events (observed + inferred)
```jsonl
{"type":"thread.started","thread_id":"019d2b3c-..."}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Hello."}}
{"type":"turn.completed","usage":{"input_tokens":10706,"output_tokens":6}}
```

### Event mapping

| Normalized event | Claude source | Codex source |
|-----------------|---------------|--------------|
| `session_id` | `system` + `subtype:init` → `msg.session_id` | `thread.started` → `msg.thread_id` |
| `text` | `assistant` → content blocks with `type:text`, or `stream_event:content_block_delta` with `text_delta` | `item.completed` where `item.type === 'agent_message'` → `item.text` |
| `tool_use` | `assistant` → content blocks with `type:tool_use`, or `stream_event:content_block_start` with `tool_use` | Likely `item.completed` where `item.type` is something like `tool_call` or `function_call` — **verify by running a Codex task that triggers tool use** |
| `result` | `type:result` | `turn.completed` — treat as the result event, carry `usage` through |

### Implementation approach

Add a `handleCodexMessage(msg)` method alongside the existing `handleMessage(msg)`. In `setupStdout`, dispatch to the correct handler based on `config.cliBackend`. Both handlers emit the same events (`session_id`, `text`, `tool_use`, `result`, `message`).

Do **not** try to merge the two parsers into one polymorphic thing. They're small, the protocols are different enough, and two clear functions are easier to maintain than one clever abstraction.

---

## 4. Result Parsing

**File:** `server/src/agents/managed-agent.ts`

The `parseResult` method scans agent output for a fenced JSON block containing an `AgentResult`. This is prompt-driven (the agent prompt tells it to emit a specific JSON shape), not protocol-driven. It should work identically for both backends since both Claude and Codex agents receive the same system prompt instructing them to output a result block.

No changes needed here, but verify that Codex's `--json` mode doesn't swallow or escape the fenced JSON block in the agent's text output. If it does, extract the result from the `item.completed` text content instead.

---

## 5. Agent Prompts

**File:** `server/src/agents/prompts.ts`

Review the system prompts for any Claude-specific references (e.g., "you are Claude", tool names that are Claude-specific). Make them backend-neutral or conditionally templated. Codex uses the same general tool paradigm (read, write, bash, etc.) so the prompts should mostly transfer, but double-check tool name references.

---

## 6. Verification Checklist

Before considering this done:

- [ ] Run `codex exec --json "hello"` and confirm NDJSON parsing produces a `session_id` event and a `text` event
- [ ] Run a Codex task that uses tools (e.g., file read/write) and capture the NDJSON to confirm `tool_use` event shape
- [ ] Run a Codex task with the actual agent prompt and confirm the `AgentResult` JSON block appears in `item.text` and is parseable by `parseResult`
- [ ] Confirm `codex exec resume <thread_id>` works for restart scenarios
- [ ] Confirm process group kill (`kill(-pid)`) works the same way with Codex subprocesses
- [ ] Test the full flow: pool queues agent → agent starts → output streams to dashboard via Socket.IO → agent completes → result persisted

---

## 7. What NOT to do

- **Don't abstract a `CLIBackend` interface/class hierarchy.** There are exactly two backends. An `if/else` or two parallel functions is the right level of abstraction. If a third backend ever matters, refactor then.
- **Don't change ManagedAgent, the agent pool, Socket.IO, or the dashboard.** The whole point is that the `CLIProcess` EventEmitter is the abstraction boundary.
- **Don't try to support running both backends simultaneously.** This is a global config switch, not a per-agent choice. (If that changes later, the config can move to `ManagedAgentOptions`, but don't build for that now.)
