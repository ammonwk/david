# David — AI Site Reliability Engineer

## Overview

David is an autonomous AI SRE that continuously monitors logs and audits codebases to find, verify, reproduce, fix, and PR bugs — with a visual, interactive dashboard for control and observability.

**Target repo:** `~/Documents/plaibook/ai-outbound-agent`
**Stack:** MongoDB + Express + React + TypeScript (MERN)
**Runtime:** Local machine (eventually EC2), single process + spawned agents
**Base branch:** `staging`

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        David Dashboard (React)                       │
│  ┌───────────┐ ┌──────────────┐ ┌────────────┐ ┌────────────────┐  │
│  │ Overview   │ │ Log Scanner  │ │ Codebase   │ │ Agent Monitor  │  │
│  │ Dashboard  │ │ Config+Runs  │ │ Topology   │ │ + PR Tracker   │  │
│  └───────────┘ └──────────────┘ └────────────┘ └────────────────┘  │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ WebSocket + REST
┌─────────────────────────┴───────────────────────────────────────────┐
│                      David Server (Express)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ ┌────────────┐ │
│  │ Scan     │ │ Agent    │ │ Codebase │ │ PR     │ │ Learning   │ │
│  │ Engine   │ │ Pool     │ │ Mapper   │ │ Manager│ │ Engine     │ │
│  └──────────┘ └──────────┘ └──────────┘ └────────┘ └────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
         │              │              │           │
    CloudWatch    Claude Code     OpenRouter    GitHub API
     (boto3)     CLI Agents      (Gemini)      (Octokit)
```

---

## 1. Log Scanner

### 1.1 Prefetch Layer

A Python script (adapted from `log-monitor-prefetch.py`) queries CloudWatch Insights.

**Configurable parameters (from UI):**
| Parameter | Options | Default |
|---|---|---|
| Time span | 5m, 15m, 1h, 6h, 24h | 5m |
| Severity filter | all, warn+error, error only | all |
| Schedule | On-demand, or cron interval matching time span | Every 5m |

**Query template:**
```
fields @timestamp, @message, @logStream
| filter @message like /regex based on severity/
| sort @timestamp desc
| limit 10000
```

- `all` → no filter on level
- `warn+error` → `level` in `("warn", "error")`
- `error` → `level` = `"error"`

**Output:** Structured JSON written to MongoDB `scan_results` collection, not markdown files.

### 1.2 Analysis Agent

After prefetch, a single Claude Code CLI agent is spawned to analyze the logs:

1. Reads the fresh log data from MongoDB
2. Reads the persistent SRE state (known issues, baselines, resolved issues) from MongoDB
3. Reads the codebase topology (latest mapping) from MongoDB
4. Compares current logs against known issues — new? worse? same? resolved?
5. For each new or worsened issue:
   - Creates a `bug_report` document in MongoDB with: pattern, severity, evidence, suspected root cause, affected files
   - Queues a **Fix Agent** in the agent pool
6. Updates the SRE state with findings

### 1.3 Scheduled Runs

The server uses `node-cron` to schedule scans based on the configured interval. The UI shows the active schedule and next run time. Scheduling can be paused/resumed from the UI.

---

## 2. Codebase Mapper

### 2.1 Purpose

Builds a hierarchical topology of the codebase (L1 → L2 → L3 groups) so agents know what features exist and where they live. Re-runs every 24 hours or on demand.

### 2.2 Algorithm

**Phase 1: Filesystem Walk**
- Recursively walk the target repo, collecting all source files (`.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.json`, `.sql`, `.graphql`, etc.)
- Exclude: `node_modules`, `.git`, `dist`, `build`, `coverage`, `tmp`, `__tests__`, `tests`
- Output: full directory tree with file paths and line counts

**Phase 2: L1 Discovery (gemini-3.1-pro-preview via OpenRouter)**
- Send the full directory tree to the LLM
- Prompt: "You are analyzing a codebase's directory structure. Group these files into high-level feature domains (L1 groups). Each group should represent a distinct functional area of the system. Return a JSON array of groups, each with a `name`, `description`, and `includes` (array of path prefixes)."
- This is a single LLM call — the directory tree is lightweight

**Phase 3: L2 Discovery (gemini-3.1-flash-lite, parallel)**
- For each L1 group, send its file list to the LLM
- Prompt: "Break this feature domain into sub-features (L2 groups). Each should be a cohesive module or subsystem."
- All L1 groups processed in parallel via `Promise.all`

**Phase 4: L3 Discovery (gemini-3.1-flash-lite, parallel)**
- For each L2 group, send its file list + first ~50 lines of each file
- Prompt: "Break this sub-feature into specific functional units (L3 groups). Each should be small enough for a single engineer to audit thoroughly — ideally 5-20 files."
- All L2 groups processed in parallel

**Phase 5: Persist**
- Store the full topology tree in MongoDB `codebase_topology` collection
- Each node: `{ id, name, description, level, parentId, files[], totalLines, children[] }`
- Store metadata: `{ mappedAt, commitHash, fileCount, totalLines }`

### 2.3 Resume Support

Store per-node mapping results. If interrupted, resume from the last un-mapped level.

---

## 3. Codebase Audit

### 3.1 Trigger

- **Scheduled:** Every 24 hours (configurable)
- **On-demand:** Button in UI — can run full audit or select specific nodes from the topology graph

### 3.2 Agent Dispatch

For each L3 group in scope:

1. Create a `audit_task` document in MongoDB: `{ nodeId, nodeName, files[], status: 'queued' }`
2. Submit to the Agent Pool queue

The Agent Pool will start up to 30 concurrent top-level agents. The rest queue with FIFO ordering.

### 3.3 Per-L3 Audit Agent (top-level)

Each audit agent is a Claude Code CLI subprocess in its own git worktree (branched from `origin/staging`). It receives:

- The L3 group's file list and description
- The full codebase topology (so it knows what else exists)
- The current SRE state (known issues, baselines)
- Access to the full repo (read any file, not just its assigned ones)
- Access to MongoDB (read logs, prior bug reports)

**The agent's workflow:**

```
┌─────────────────────────────────────┐
│         Audit Sub-Agents            │
│  (one per file cluster in L3)       │
│  Read code deeply, flag concerns    │
└──────────────┬──────────────────────┘
               │ List of potential bugs
┌──────────────▼──────────────────────┐
│       Verify Sub-Agents             │
│  (one per flagged issue)            │
│  Read full context, check logs,     │
│  check MongoDB, write failing test  │
│  or reproduce safely if possible    │
└──────────────┬──────────────────────┘
               │ Confirmed bugs only
┌──────────────▼──────────────────────┐
│         Fix Sub-Agents              │
│  (one per confirmed bug)            │
│  Write fix, verify fix passes,      │
│  run existing tests                 │
└──────────────┬──────────────────────┘
               │ Fixed + verified
               ▼
         Create PR per fix
```

### 3.4 Verification Standards

Each verify sub-agent is instructed to:

1. **Read the full context** — not just the flagged file, but callers, callees, related modules
2. **Check logs** — query MongoDB for recent log patterns matching the suspected issue
3. **Check data** — if the bug involves data handling, query MongoDB to see if the data state reflects the issue
4. **Write a failing test** if the bug is testable — this is the gold standard
5. **Safe reproduction** — if testable without side effects, attempt to trigger the bug in a sandboxed way
6. **Add observability** — if the bug can't be confirmed but is suspicious, the agent MAY propose logging/metrics improvements that would make the issue surfaceable in future scans. This is an acceptable output.
7. **Err on the side of caution** — if the agent can't figure it out, it should make NO changes and document what it found for human review

### 3.5 Conservative Change Policy

Agents are explicitly instructed:
- **Prefer no change** over a speculative fix
- **Never** change behavior to mask an issue
- **Observability improvements** (better logging, metrics, error messages) are a valid and encouraged output when the root cause is unclear
- Each PR should fix exactly ONE issue — no drive-by cleanups

---

## 4. Agent Pool

### 4.1 Architecture

Adapted from plaibook-internal's `ManagedProcess` + `session-manager` patterns.

**Pool state:**
```typescript
interface AgentPool {
  active: Map<string, ManagedAgent>    // Currently running (max 30)
  queue: AgentTask[]                    // FIFO queue
  completed: string[]                   // IDs of finished agents (in MongoDB)
}
```

**ManagedAgent:**
```typescript
interface ManagedAgent {
  id: string
  type: 'log-analysis' | 'audit' | 'fix'
  status: 'starting' | 'running' | 'completed' | 'failed' | 'timeout'
  process: ChildProcess               // Claude Code CLI subprocess
  worktree?: string                   // Git worktree path (for fix agents)
  branch?: string                     // Git branch name
  startedAt: Date
  restarts: number                    // Max 3
  timeoutMs: 60 * 60 * 1000          // 1 hour
  parentId?: string                   // For sub-agents: the top-level agent ID
  taskId: string                      // Reference to audit_task or bug_report
  output: string[]                    // Captured stdout lines
}
```

### 4.2 Lifecycle

1. **Spawn:** `claude --print --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions`
2. **Communication:** NDJSON over stdin/stdout (same as plaibook-internal)
3. **Health:** Check process is alive + producing output. If silent for >10 minutes, consider hung.
4. **Timeout:** 1 hour hard limit. On timeout, SIGTERM → 10s grace → SIGKILL (process group kill via `kill(-pid)`)
5. **Restart:** On timeout or error, restart up to 3 times. Feed prior context via `--resume` if possible. Exponential backoff: 5s, 15s, 45s.
6. **Completion:** Agent writes structured output (bugs found, fixes made, PRs created) to stdout. Parsed and stored in MongoDB.
7. **Queue drain:** On agent completion, immediately start next queued agent if pool has capacity.

### 4.3 Worktree Management

For fix agents (agents that will modify code):
- `git worktree add -b sre/{bugId} worktrees/sre-{bugId} staging` - make sure they get the most recent staging though
- Agent's CWD is set to the worktree
- On completion: if PR created, worktree is kept until PR is merged/closed. Otherwise cleaned up.
- Orphan worktree cleanup on server startup

### 4.4 Real-Time Streaming

All agent stdout is:
1. Parsed as NDJSON
2. Stored in MongoDB (append to agent's output log)
3. Broadcast via WebSocket to any connected dashboard clients watching that agent

---

## 5. PR Manager

### 5.1 PR Creation Flow

When a fix agent completes successfully:

1. `git add -A` in the agent's worktree
2. `git commit -m "[SRE] {concise description of fix}"`
3. `git push origin sre/{bugId}`
4. Create PR via Octokit:
   - **Title:** `[SRE] {description}`
   - **Labels:** `autofix`
   - **Base:** `staging`
   - **Head:** `sre/{bugId}`
   - **Body:** AI-generated description including:
     - Bug summary (what's wrong)
     - Evidence (log patterns, failing tests, data inconsistencies)
     - Fix summary (what was changed and why)
     - Verification (how the fix was verified — test output, reproduction results)
     - Risk assessment (what could go wrong)
     - Link back to David dashboard for full audit trail

### 5.2 PR Description Generation

Use Claude (via the fix agent itself, or a dedicated call) to generate the PR body from:
- The git diff
- The bug report document
- The verification results
- The agent's reasoning trace

### 5.3 PR Tracking

Store in MongoDB `pull_requests` collection:
```typescript
{
  prNumber: number
  prUrl: string
  bugReportId: string
  agentId: string
  branch: string
  status: 'open' | 'merged' | 'closed'
  createdAt: Date
  resolvedAt?: Date
  resolution?: 'accepted' | 'rejected'  // merged = accepted, closed = rejected
  rejectionReason?: string               // Parsed from PR comments if available
  scanType: 'log' | 'audit'
  diff: string
  description: string
}
```

### 5.4 GitHub Webhook / Polling

Poll GitHub API every 5 minutes for status updates on open PRs (or set up a webhook endpoint). When a PR is merged or closed, update the record and feed the outcome into the Learning Engine.

---

## 6. Learning Engine

### 6.1 Purpose

Track which kinds of fixes get accepted vs rejected, and use that signal to improve future agent behavior.

### 6.2 Data Model

```typescript
interface LearningRecord {
  bugCategory: string        // e.g., "null-check", "race-condition", "error-handling"
  filePattern: string        // e.g., "features/integrations/**"
  wasAccepted: boolean
  confidence: number         // How confident the agent was
  verificationMethod: string // "failing-test", "log-correlation", "code-review-only"
  prNumber: number
  feedbackNotes?: string     // Extracted from PR review comments
}
```

### 6.3 Feedback Loop

When spawning new agents, include in their system prompt:
- Summary of recent accepted/rejected fixes in similar areas
- Patterns to avoid (from rejected PRs)
- Patterns that work (from accepted PRs)
- Overall acceptance rate and what verification methods correlate with acceptance

### 6.4 Dashboard View

- Accept/reject ratio over time (chart)
- Top accepted patterns vs top rejected patterns
- Per-feature-area acceptance rates
- Trend line: is David getting better over time?

---

## 7. Dashboard UI

### 7.1 Layout

Single-page app with a sidebar navigation:

```
┌──────┬──────────────────────────────────────────────┐
│      │                                              │
│  📊  │   Main Content Area                          │
│  O   │                                              │
│  v   │   (changes based on selected nav item)       │
│  e   │                                              │
│  r   │                                              │
│  v   │                                              │
│  i   │                                              │
│  e   │                                              │
│  w   │                                              │
│      │                                              │
│  🔍  │                                              │
│  L   │                                              │
│  o   │                                              │
│  g   │                                              │
│  s   │                                              │
│      │                                              │
│  🗺️  │                                              │
│  M   │                                              │
│  a   │                                              │
│  p   │                                              │
│      │                                              │
│  🤖  │                                              │
│  A   │                                              │
│  g   │                                              │
│  e   │                                              │
│  n   │                                              │
│  t   │                                              │
│  s   │                                              │
│      │                                              │
│  📝  │                                              │
│  P   │                                              │
│  R   │                                              │
│  s   │                                              │
│      │                                              │
└──────┴──────────────────────────────────────────────┘
```

### 7.2 Overview Dashboard

- **System status:** running/paused, next scheduled scan, agents active/queued/completed
- **Live counters:** bugs found today, PRs created today, PRs accepted this week
- **Activity feed:** real-time stream of events (scan started, bug found, agent spawned, PR created, PR merged)
- **Health sparklines:** agent success rate, scan frequency, queue depth over last 24h

### 7.3 Log Scanner Page

- **Config panel:**
  - Time span selector (5m / 15m / 1h / 6h / 24h)
  - Severity filter (all / warn+error / error)
  - Schedule toggle (on/off) with interval display
  - "Scan Now" button
- **Results panel:**
  - Timeline of past scans with status badges
  - Click a scan to see: raw log patterns, identified issues, agents spawned
  - Diff view: what changed since last scan

### 7.4 Codebase Topology Page

- **Interactive hierarchy graph** (force-directed or tree layout):
  - L1 nodes as large clusters
  - L2 nodes as medium clusters within L1
  - L3 nodes as leaf nodes within L2
  - Color coding: green = recently audited clean, yellow = has open issues, red = has unresolved bugs
  - Size scaled by line count
  - Click a node to see: files, description, last audit time, open issues
- **Actions:**
  - "Re-map Codebase" button (re-runs the full topology discovery)
  - "Audit Selected" button — select one or more nodes, then click to trigger an audit of just those nodes
  - "Audit All" button — full codebase audit
- **Node detail panel** (on click):
  - File list with line counts
  - Recent bugs in this area
  - PR history for this area
  - Last audit timestamp and findings

### 7.5 Agent Monitor Page

- **Pool status bar:** `Active: 12/30 | Queued: 8 | Completed: 45 | Failed: 2`
- **Agent cards** in a grid/list:
  - Agent ID, type (log-analysis / audit / fix), target (node or bug)
  - Status badge (starting / running / completed / failed / timeout)
  - Runtime duration (live counter)
  - Restart count
  - Progress indicator (if available from agent output)
  - "View Output" → opens a live-streaming terminal-style view of agent's stdout
  - "Stop" button for running agents
- **Queue view:** ordered list of pending tasks with estimated wait time

### 7.6 PR Tracker Page

- **Table of all PRs** created by David:
  - PR number (linked to GitHub), title, status (open/merged/closed), created date
  - Bug source (log scan or codebase audit)
  - Affected area (L1/L2/L3 node)
  - Verification method used
- **Filters:** by status, by scan type, by feature area, by date range
- **Learning metrics panel:**
  - Acceptance rate (overall and per-category)
  - Chart: acceptance rate over time
  - "What David is learning" — top patterns from accepted/rejected PRs

### 7.7 Real-Time Updates

All pages receive live updates via WebSocket:
- Agent status changes
- New scan results
- New bugs found
- PR status changes
- Queue movements

No polling. Pure push via Socket.IO.

---

## 8. Data Model (MongoDB Collections)

### `sre_state`
Persistent SRE knowledge base (replaces Winston's `plaibook-server-state.md`):
```typescript
{
  _id: 'singleton',
  knownIssues: [{
    id: string,
    pattern: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    firstSeen: Date,
    lastSeen: Date,
    status: 'active' | 'investigating' | 'fixing' | 'resolved',
  rootCause?: string,
    affectedFiles?: string[],
    relatedPrIds?: string[]
  }],
  baselines: {
    cpuMax: number,
    memoryMax: number,
    errorRatePerHour: number,
    lastUpdated: Date
  },
  resolvedIssues: [/* same shape, archived */]
}
```

### `scan_results`
```typescript
{
  _id: ObjectId,
  type: 'log' | 'audit',
  startedAt: Date,
  completedAt: Date,
  config: { timeSpan: string, severity: string },
  logPatterns: [{ message: string, count: number, level: string, firstOccurrence: Date, lastOccurrence: Date }],
  ecsMetrics?: { cpuMax: number, memoryMax: number, spikes: [] },
  ecsEvents?: [],
  newIssues: string[],        // IDs of newly created bug reports
  updatedIssues: string[],    // IDs of existing issues that changed
  resolvedIssues: string[],   // IDs of issues now resolved
  summary: string             // AI-generated summary
}
```

### `bug_reports`
```typescript
{
  _id: ObjectId,
  source: 'log-scan' | 'codebase-audit',
  scanId: ObjectId,
  nodeId?: string,            // Codebase topology node if from audit
  pattern: string,
  severity: 'low' | 'medium' | 'high' | 'critical',
  evidence: string,
  suspectedRootCause: string,
  affectedFiles: string[],
  status: 'reported' | 'verifying' | 'verified' | 'fixing' | 'fixed' | 'pr-created' | 'wont-fix',
  verificationResult?: {
    method: 'failing-test' | 'log-correlation' | 'data-check' | 'reproduction' | 'code-review',
    details: string,
    confirmed: boolean
  },
  fixAgentId?: string,
  prId?: ObjectId,
  createdAt: Date,
  updatedAt: Date
}
```

### `codebase_topology`
```typescript
{
  _id: ObjectId,
  mappedAt: Date,
  commitHash: string,
  repoPath: string,
  fileCount: number,
  totalLines: number,
  nodes: [{
    id: string,
    name: string,
    description: string,
    level: 1 | 2 | 3,
    parentId: string | null,
    files: string[],
    totalLines: number,
    children: string[]
  }]
}
```

### `agents`
```typescript
{
  _id: ObjectId,
  type: 'log-analysis' | 'audit' | 'verify' | 'fix',
  status: 'queued' | 'starting' | 'running' | 'completed' | 'failed' | 'timeout',
  taskId: ObjectId,           // bug_report or scan_result reference
  nodeId?: string,
  parentAgentId?: ObjectId,
  worktreePath?: string,
  branch?: string,
  cliSessionId?: string,
  startedAt?: Date,
  completedAt?: Date,
  restarts: number,
  outputLog: string[],        // Last N lines of output
  result?: {
    bugsFound?: number,
    bugsVerified?: number,
    fixesApplied?: number,
    prsCreated?: number,
    summary: string
  },
  createdAt: Date
}
```

### `pull_requests`
```typescript
{
  _id: ObjectId,
  prNumber: number,
  prUrl: string,
  title: string,
  bugReportId: ObjectId,
  agentId: ObjectId,
  branch: string,
  status: 'open' | 'merged' | 'closed',
  resolution?: 'accepted' | 'rejected',
  scanType: 'log' | 'audit',
  nodeId?: string,
  diff: string,
  description: string,
  verificationMethod: string,
  rejectionFeedback?: string,
  createdAt: Date,
  resolvedAt?: Date
}
```

### `learning_records`
```typescript
{
  _id: ObjectId,
  bugCategory: string,
  filePattern: string,
  wasAccepted: boolean,
  confidence: number,
  verificationMethod: string,
  prId: ObjectId,
  feedbackNotes?: string,
  createdAt: Date
}
```

---

## 9. Project Structure - subject to change as needed

```
david/
├── package.json                    # Monorepo root (npm workspaces)
├── tsconfig.json
├── SPEC.md
├── CLAUDE.md
│
├── server/                         # Express backend
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── index.ts               # Entry point: Express + Socket.IO + cron setup
│   │   ├── config.ts              # Env vars, MongoDB URI, repo path, etc.
│   │   │
│   │   ├── api/                   # REST API routes
│   │   │   ├── scans.ts           # GET/POST scan config, trigger scans
│   │   │   ├── agents.ts          # GET agents, POST stop agent
│   │   │   ├── topology.ts        # GET topology, POST re-map, POST audit
│   │   │   ├── prs.ts             # GET PRs, learning metrics
│   │   │   └── state.ts           # GET/PUT SRE state
│   │   │
│   │   ├── engine/                # Core business logic
│   │   │   ├── log-scanner.ts     # Prefetch + analysis orchestration
│   │   │   ├── prefetch.ts        # CloudWatch query (calls Python or native AWS SDK)
│   │   │   ├── codebase-mapper.ts # L1/L2/L3 topology discovery
│   │   │   ├── audit-engine.ts    # Codebase audit orchestration
│   │   │   └── scheduler.ts       # node-cron job management
│   │   │
│   │   ├── agents/                # Agent lifecycle management
│   │   │   ├── agent-pool.ts      # Pool with 30-agent cap + queue
│   │   │   ├── managed-agent.ts   # Single agent lifecycle (spawn, monitor, restart)
│   │   │   ├── cli-launcher.ts    # Claude Code CLI spawn + NDJSON comms
│   │   │   ├── worktree-manager.ts# Git worktree create/cleanup
│   │   │   └── prompts.ts         # System prompts for each agent type
│   │   │
│   │   ├── pr/                    # PR creation and tracking
│   │   │   ├── pr-manager.ts      # Create PRs via Octokit
│   │   │   ├── pr-tracker.ts      # Poll GitHub for PR status updates
│   │   │   └── learning-engine.ts # Accept/reject pattern tracking
│   │   │
│   │   ├── llm/                   # LLM client utilities
│   │   │   └── openrouter.ts      # OpenRouter API client (Gemini calls)
│   │   │
│   │   ├── ws/                    # WebSocket layer
│   │   │   └── socket-manager.ts  # Socket.IO rooms, event broadcasting
│   │   │
│   │   └── db/                    # MongoDB models and connection
│   │       ├── connection.ts
│   │       └── models.ts          # Mongoose schemas for all collections
│   │
│   └── scripts/
│       └── prefetch.py            # CloudWatch prefetch (if keeping Python)
│
├── dashboard/                     # React frontend
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx
│       ├── App.tsx                # Router + layout
│       ├── components/
│       │   ├── Layout.tsx         # Sidebar + main content shell
│       │   ├── Sidebar.tsx
│       │   ├── ActivityFeed.tsx   # Real-time event stream
│       │   ├── AgentCard.tsx      # Single agent status card
│       │   ├── AgentOutput.tsx    # Terminal-style agent output viewer
│       │   ├── TopologyGraph.tsx  # Interactive codebase hierarchy
│       │   ├── ScanConfig.tsx     # Log scan configuration form
│       │   ├── PRTable.tsx        # PR list with filters
│       │   ├── LearningCharts.tsx # Accept/reject trends
│       │   └── StatusBar.tsx      # Pool status bar
│       │
│       ├── pages/
│       │   ├── Overview.tsx
│       │   ├── LogScanner.tsx
│       │   ├── CodebaseMap.tsx
│       │   ├── AgentMonitor.tsx
│       │   └── PRTracker.tsx
│       │
│       ├── hooks/
│       │   ├── useSocket.ts       # Socket.IO connection + event handlers
│       │   ├── useAgents.ts       # Agent state management
│       │   └── useTopology.ts     # Topology graph data
│       │
│       └── lib/
│           ├── api.ts             # REST API client
│           └── types.ts           # Shared TypeScript types
│
├── shared/                        # Shared types between server and dashboard
│   ├── package.json
│   └── src/
│       └── types.ts
│
└── worktrees/                     # Git worktrees for fix agents (gitignored)
```

---

## 10. Agent Prompts

### 10.1 Log Analysis Agent

```
You are an AI SRE analyzing server logs for the ai-outbound-agent application.

You have access to:
- Fresh log data from the last {timeSpan}
- The persistent SRE state (known issues, baselines, history)
- The full codebase at {repoPath}
- MongoDB at {mongoUri}

Your job:
1. Read the log data and SRE state
2. For each log pattern, determine: is this a known issue, a new issue, or noise?
3. For new issues, investigate the codebase to understand the root cause
4. Create bug reports for genuine issues with: pattern, severity, evidence, suspected root cause, affected files
5. Update the SRE state: mark resolved issues, update severities, add new issues
6. Output a structured JSON summary of your findings

Be conservative. Only report genuine bugs, not expected behavior or transient noise.
Known issues that are unchanged do not need new bug reports.

Recent learning from past PRs:
{learningContext}

Gold standard:
You are allowed to make 0 or 1 PRs in this review. If through your thorough reviews you find and understand a bug or set of bugs that doesn't have a PR out for them yet, carefully make the fixes, verify your work by having a subagent audit your work, then if the work still seems relevant and worth committing touch it up and make a PR for it.
```

### 10.2 Audit Agent (per L3 group)

```
You are an AI SRE auditing a specific feature area of the ai-outbound-agent codebase.

Your assigned feature area: {nodeName}
Description: {nodeDescription}
Files: {fileList}

You have access to the full repo — your assigned files are your focus, but read any related files as needed.
You also have access to MongoDB ({mongoUri}) for checking data state and recent logs.

Your workflow:
1. AUDIT: Read every file in your assigned area deeply. You can use a suabgent or two to get a feel for the layout and to scout out related features, but read the key files yourself. Look for dangerous bugs and issues, such as:
   - Logic errors, off-by-one errors, race conditions
   - Unhandled edge cases, missing null checks
   - Error handling gaps (swallowed errors, missing catch blocks)
   - Data consistency issues
   - Security concerns (injection, auth bypass, data exposure)
   - Resource leaks (unclosed connections, missing cleanup)
   - Concurrency issues (shared mutable state, missing locks)
   - Etc - whatever needs to be fixed at a Medium or higher severity

2. VERIFY: Once you're done listing out all the bugs you've found, for each potential bug launch a sub-agent to verify it:
   - Read the full context (callers, callees, related modules)
   - Check recent logs for evidence of the bug manifesting
   - Check MongoDB for data state reflecting the issue
   - Write a failing test if possible (gold standard)
   - Attempt safe reproduction if feasible
   - If you can't verify, but the issue is suspicious, propose observability improvements
   - If this seems to have been a false alarm, report that it was a false alarm (most common case, this is ok)
   - If it is a real bug, explain that and how to fix it

3. FIX: For each verified bug, launch a sub-agent to fix it:
   - Write the minimal fix
   - Ensure existing tests still pass
   - Write new tests for the fix if appropriate
   - Create one commit per fix

CRITICAL: Prefer NO CHANGE over a speculative fix. Never mask issues. Observability improvements are a valid output.

Output: structured JSON with bugs found, verified, fixed, and any observability proposals.

Recent learning from past PRs in this area:
{learningContext}
```

---

## 11. Implementation Order

### Phase 1: Foundation
1. Project scaffolding (monorepo, server, dashboard, shared types)
2. MongoDB connection + all Mongoose models
3. Express server with REST API stubs
4. React dashboard shell with sidebar navigation + routing
5. Socket.IO setup (server + client)
6. Config system (env vars, target repo path, MongoDB URI)

### Phase 2: Codebase Mapper
7. Filesystem walker
8. OpenRouter LLM client
9. L1/L2/L3 discovery pipeline
10. Topology storage in MongoDB
11. Interactive topology graph component in dashboard
12. "Re-map" and "Audit Selected" buttons

### Phase 3: Agent Infrastructure
13. CLI launcher (Claude Code subprocess + NDJSON)
14. ManagedAgent lifecycle (health, timeout, restart)
15. Agent Pool (30-cap, queue, drain)
16. Worktree manager (create, cleanup, orphan detection)
17. Agent monitor page in dashboard (cards, output viewer, status)
18. WebSocket broadcasting of agent events

### Phase 4: Log Scanner
19. CloudWatch prefetch (AWS SDK for JS, not Python — keep it all TypeScript)
20. Log analysis agent orchestration
21. Scan scheduling (node-cron, configurable)
22. Log scanner page in dashboard (config, trigger, results)
23. SRE state management

### Phase 5: Codebase Audit
24. Audit engine (dispatch L3 agents from topology)
25. Audit/verify/fix sub-agent orchestration
26. Integration with agent pool
27. Selective audit from topology graph

### Phase 6: PR Pipeline
28. PR creation via Octokit
29. PR tracking (GitHub polling)
30. PR tracker page in dashboard
31. Learning engine (accept/reject tracking)
32. Learning context injection into agent prompts
33. Learning metrics dashboard

### Phase 7: Overview Dashboard
34. Activity feed (aggregated WebSocket events)
35. Status counters and sparklines
36. Overview page assembly

### Phase 8: Polish
37. Error handling and edge cases
38. Graceful shutdown (clean up agents, worktrees)
39. Server startup recovery (detect orphaned worktrees, resume tracking open PRs)
40. Performance tuning (MongoDB indexes, WebSocket throttling)
