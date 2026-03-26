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
│  │ Command    │ │ Log Scanner  │ │ Zoomable   │ │ Agent Monitor  │  │
│  │ Center     │ │ + Heatmap    │ │ Treemap    │ │ + PR Pipeline  │  │
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
│  run existing tests, open PR,       │
│  then babysit CI + address reviews  │
│  in a loop until fully green & clean│
└──────────────┬──────────────────────┘
               │ PR green + reviewed
               ▼
         Done — PR ready for merge
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

The fix agent itself handles the full PR lifecycle:

1. `git add -A` in the agent's worktree
2. `git commit -m "[SRE] {concise description of fix}"`
3. `git push origin sre/{bugId}`
4. Create PR via `gh pr create`:
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

### 5.1.1 CI Babysitting and Review Loop

Once the PR is open, the fix agent enters a loop:

1. **Watch CI** — run `gh run watch` to monitor the CI pipeline until completion. If any check fails, read the failure logs, fix the issue, commit, and push. Repeat until all checks are green.
2. **Read PR comments** — use `gh api` to read all comments and review comments on the PR. For each piece of actionable feedback, make the requested change, commit, and push.
3. **Loop** — return to step 1. Repeat this cycle until CI is fully green AND there are no unaddressed comments.

The agent only reports completion and stops once both conditions are satisfied. This ensures PRs are not abandoned in a failing or unreviewed state.

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

### 7.1 Design System

**Theme — Light and Dark:**
- Light and dark modes, toggled via the top bar. System preference detected on first load.
- Dark: near-black backgrounds (`#0a0a0f`), soft white text, colored accents with subtle glow
- Light: warm off-white backgrounds, dark text, matte colored accents
- Accent palette: blue (info/agents), amber (warnings), red (errors/critical), green (success/merged), violet (audit activity)

**Typography:**
- UI text: Inter (or system sans-serif fallback)
- Code and agent output: JetBrains Mono (or system monospace)
- Counters and numeric displays: `font-variant-numeric: tabular-nums` for alignment

**Motion:**
- All transitions are purposeful and subtle — easing durations 150–300ms
- Live-updating numbers use spring interpolation (count up/down smoothly)
- No decorative animation. Every moving element communicates a state change.

**Density:**
- Information-dense by default. Tooltips and drawers provide depth on demand.
- No hero sections, no excessive whitespace. Every pixel earns its place.

### 7.2 Global Shell

```
┌─────────────────────────────────────────────────────────────────────┐
│ ● David    3 agents active │ 2 queued │ last scan 4m ago │ 12 PRs  │◑│
├──────┬──────────────────────────────────────────────────────────────┤
│      │                                                              │
│  ◉   │                                                              │
│      │                                                              │
│  ◎   │              Main Content Area                               │
│      │                                                              │
│  ◫   │              (per-page views described below)                │
│      │                                                              │
│  ⚙   │                                                              │
│      │                                                              │
│  ↗   │                                                              │
│      │                                                              │
├──────┴──────────────────────────────────────────────────────────────┤
│  ▸ Agent sre-4a2f completed: 1 bug verified, PR #287 created       │
└─────────────────────────────────────────────────────────────────────┘
```

**Top bar (always visible):**
- Left: David wordmark + system health indicator (green dot = healthy, amber = degraded, red = error)
- Center: live counters — active agents, queued agents, time since last scan, open PRs. Numbers animate smoothly on change.
- Right: theme toggle (sun/moon), settings

**Sidebar (always visible, icon-only at rest, expands on hover to show labels):**
- Pages: Command Center, Log Scanner, Codebase Map, Agent Monitor, PR Pipeline
- Active page indicated by accent-colored bar on left edge
- Compact — takes minimal horizontal space

**Bottom event bar (always visible):**
- Single-line ticker showing the most recent system event with a subtle entrance animation
- Click to expand into a full activity feed overlay

**Command palette (`Cmd+K` / `Ctrl+K`):**
- Search across agents, bugs, PRs, topology nodes, and actions
- Shows recent items and quick actions (trigger scan, pause scheduler, re-map codebase)

**Toast notifications:**
- Slide in from top-right for high-signal events: bug found, PR created, PR merged, agent failure
- Click to navigate to the relevant detail view
- Auto-dismiss after 5s, stack up to 3

**Keyboard shortcuts:**
- `Cmd+K` — command palette
- `1–5` — navigate to pages
- `n` / `p` — next/previous item in lists
- `Enter` — expand or open selected item
- `Esc` — close drawer, modal, or palette

### 7.3 Command Center (Overview)

The default landing page. A single-screen operational summary of everything David is doing.

**Layout: three columns, full viewport height.**

**Left column — Agent Pool Gauge:**
- Vertical bar visualization showing pool capacity (0–30)
- Filled segments = active agents, colored by type (blue = analysis, violet = audit, green = fix)
- Dimmed segments = queued agents
- Each segment is hoverable (tooltip: agent ID, type, runtime) and clickable (navigates to agent detail)
- Below the gauge: compact list of the 5 most recent agent completions with status badges

**Center column — Live Event Timeline:**
- Vertical, auto-scrolling timeline of system events
- Each event: timestamp, type icon, one-line description, severity color on left edge
- Event types: scan started/completed, bug reported, agent spawned/completed/failed, PR created, PR merged/closed
- Related events grouped by causal chain (scan → bug → agent → PR) with subtle indentation
- Clicking any event navigates to its detail view in the relevant page
- New events animate in from the top with a brief highlight

**Right column — Health Vitals:**
- Stacked mini area charts (~80px tall each):
  - Error rate over last 24h (with baseline threshold line)
  - Agent throughput (completed/hour) over last 24h
  - Queue depth over last 24h
  - PR acceptance rate (rolling 7-day window)
- Hover any chart for exact values, click to expand to full detail
- Below the charts: compact number grid — bugs found today, PRs created today, PRs merged this week, acceptance rate

### 7.4 Log Scanner

**Top: Heatmap Timeline**
- Horizontal heatmap grid (similar to GitHub contributions, but horizontal) showing error/warning density per time bucket
- X-axis: last 7 days bucketed by hour. Y-axis: severity levels.
- Cell color intensity = log volume. Hover for exact counts.
- Click a cell to filter the scan list below to that time range

**Middle: Scan History**
- Vertical list of past scans, newest first
- Each row: timestamp, duration, config summary (timespan + severity), result badges (e.g., "3 new bugs, 1 resolved")
- Expandable: click to reveal findings — list of identified issues with severity, pattern match, status
- Click a finding to see evidence (log excerpts, pattern details) in a slide-out drawer

**Config: slide-out drawer (gear icon in page header):**
- Time span: segmented control (5m / 15m / 1h / 6h / 24h)
- Severity filter: segmented control (all / warn+error / error)
- Schedule: toggle on/off, interval display, next-run countdown timer
- "Scan Now" button — prominent, primary accent color

**Live scan indicator:**
- When a scan is running, an animated progress bar appears in the page header
- Below the heatmap: live status line — "Scanning... 4,231 log entries processed" with a counting animation

### 7.5 Codebase Topology

**Primary view: Zoomable Treemap**
- Full-width treemap visualization (similar to WinDirStat / Disk Inventory X)
- Each rectangle = a topology node. Size proportional to line count.
- Color = health status:
  - Muted green: recently audited, no open issues
  - Amber: has open bug reports
  - Red: has unresolved critical or high-severity bugs
  - Gray: never audited
- Three zoom levels corresponding to L1 → L2 → L3:
  - Default view: L1 groups as large labeled rectangles (name + file count)
  - Click an L1 to smooth-zoom into its L2 children (the clicked rectangle expands to fill the view)
  - Click an L2 to zoom into L3. At L3 level, individual files appear as small cells within the rectangle.
  - Breadcrumb trail at top for navigation: `All > Backend Services > Auth Module` — click any level to zoom back out

**Activity overlay (toggleable via button in page header):**
- Nodes being audited: animated dashed border ("scanning" effect)
- Nodes with an active fix agent: small wrench icon badge
- Nodes with a recently created PR: small PR icon badge

**Actions (page header):**
- "Re-map Codebase" — triggers full topology rediscovery
- "Audit Selected" — enters selection mode: click nodes to select (highlighted border), then confirm to dispatch audit agents for those nodes
- "Audit All" — full codebase audit, with confirmation dialog

**Detail drawer (slides in from right on node click):**
- Node name, description, level
- File list with line counts
- Audit history: timeline of past audits with findings count
- Open bugs in this area (linked to their cards in PR Pipeline)
- Related PRs with status badges

### 7.6 Agent Monitor

**View toggle in page header: Tree | Timeline**

**Tree View (default):**
- Hierarchical process tree showing agent parent→child relationships
- Top-level agents (log-analysis, audit) are root nodes
- Their sub-agents (verify, fix) are children, indented and connected by lines
- Each node shows: agent type icon, target name, status badge, runtime counter (live-ticking for active agents)
- Running agents: subtle pulse animation on status indicator
- Completed: checkmark icon, muted styling
- Failed/timeout: red indicator
- Clicking a node opens the agent detail panel

**Timeline View:**
- Gantt-style horizontal bar chart
- X-axis: wall clock time. Each agent is a horizontal bar.
- Bar color = agent type, opacity encodes status (solid = running, faded = completed, hatched = failed)
- Bars grouped by parent — sub-agents appear as nested rows below their parent
- Visually shows concurrency: how many agents overlapped in time
- Hover a bar for agent details tooltip

**Agent Detail Panel (slides open on agent click):**
- **Left pane — Live Output:** terminal-style viewer, monospaced font, auto-scrolling, ANSI color support. Streams agent stdout in real-time. Searchable via `Cmd+F`.
- **Right pane — Context:** files being read/modified (compact file tree with activity indicators), bug report being worked on, link to created PR if any
- "Stop Agent" button for running agents

**Pool Capacity Gauge (always visible in page header):**
- Compact horizontal bar: `████████████░░░░░░░░░░░░░░░░░░ 12/30 active`
- Segments colored by agent type
- Queued count as a badge: `+8 queued`

### 7.7 PR Pipeline

**Primary view: Kanban Board**

Columns representing the bug-to-merge lifecycle:
- **Reported** — bugs found, not yet being worked on
- **Verifying** — verify agents running
- **Fixing** — fix agents running
- **PR Open** — PR created on GitHub, awaiting human review
- **Merged** — accepted and merged (last 7 days, then archived)
- **Closed** — rejected or closed (last 7 days, then archived)

Cards are not draggable (David controls the pipeline) but move between columns automatically with smooth animation as status changes.

**Card contents:**
- Bug title (truncated to one line)
- Severity badge (color-coded chip)
- Source badge: "log scan" or "audit"
- Affected area (L1 > L2 label)
- Age (e.g., "2h ago")
- Mini diff stat: `+12 −3` in green/red
- For PR Open cards: clickable GitHub link icon

**Detail panel (opens on card click):**
- Full bug report: pattern, evidence, suspected root cause
- Agent trace: which agents worked on this, their output summaries
- Diff viewer: syntax-highlighted, collapsible file sections
- PR details: GitHub link, review status, comments summary
- For closed PRs: rejection reason if available

**Bottom strip — Learning Metrics (always visible at bottom of this page):**
- Left: acceptance rate as a large number with trend arrow (↑/↓ vs last week)
- Center: small area chart — acceptance rate over the last 30 days
- Right: top 3 accepted patterns and top 3 rejected patterns as compact labeled chips

### 7.8 Real-Time Infrastructure

All pages receive live updates via WebSocket (Socket.IO). No polling.

**Event types pushed to clients:**
- Agent lifecycle: spawned, output line, status change, completed, failed
- Scan lifecycle: started, progress update, completed
- Bug reports: created, status changed
- PRs: created, merged, closed
- Topology: mapping started, progress, completed
- System: scheduler state change, pool capacity change

**Cross-view context linking:**
- Clicking a bug reference anywhere navigates to that bug's card in the PR Pipeline
- Clicking an agent reference navigates to that agent's node in the Agent Monitor
- Clicking a topology node reference navigates to the Codebase Map, zoomed to that node
- All navigation is deep-linkable via URL parameters

**Reconnection:**
- On WebSocket disconnect, show a subtle top banner: "Reconnecting..." with automatic exponential retry
- On reconnect, fetch a full state snapshot to sync any missed events

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
│       ├── App.tsx                # Router + global shell
│       │
│       ├── components/
│       │   ├── shell/
│       │   │   ├── GlobalShell.tsx    # Top bar + sidebar + bottom ticker + content slot
│       │   │   ├── TopBar.tsx         # Live counters, health indicator, theme toggle
│       │   │   ├── Sidebar.tsx        # Icon nav, expand-on-hover labels
│       │   │   ├── EventTicker.tsx    # Bottom single-line event bar
│       │   │   ├── CommandPalette.tsx # Cmd+K search overlay
│       │   │   └── ToastManager.tsx   # Notification toasts
│       │   │
│       │   ├── command-center/
│       │   │   ├── AgentPoolGauge.tsx # Vertical bar/ring pool visualization
│       │   │   ├── EventTimeline.tsx  # Live scrolling causal event stream
│       │   │   └── HealthVitals.tsx   # Stacked mini area charts + number grid
│       │   │
│       │   ├── log-scanner/
│       │   │   ├── HeatmapTimeline.tsx# Horizontal error-density heatmap
│       │   │   ├── ScanHistory.tsx    # Expandable scan result list
│       │   │   └── ScanConfigDrawer.tsx# Slide-out config panel
│       │   │
│       │   ├── topology/
│       │   │   ├── Treemap.tsx        # Zoomable D3 treemap with animated transitions
│       │   │   ├── ActivityOverlay.tsx # Agent activity badges on treemap nodes
│       │   │   └── NodeDetailDrawer.tsx# Slide-out node info, bugs, PRs, audit history
│       │   │
│       │   ├── agents/
│       │   │   ├── AgentTree.tsx      # Hierarchical process tree visualization
│       │   │   ├── AgentGantt.tsx     # Gantt-style timeline bar chart
│       │   │   ├── AgentDetail.tsx    # Split pane: live output + context
│       │   │   ├── TerminalViewer.tsx # Monospace auto-scrolling output stream
│       │   │   └── PoolBar.tsx        # Compact horizontal capacity gauge
│       │   │
│       │   └── pr-pipeline/
│       │       ├── KanbanBoard.tsx    # Column layout with animated card movement
│       │       ├── PipelineCard.tsx   # Bug/PR card with severity, diff stat, badges
│       │       ├── PipelineDetail.tsx # Full bug report, diff viewer, agent trace
│       │       └── LearningStrip.tsx  # Acceptance rate, trend chart, pattern chips
│       │
│       ├── pages/
│       │   ├── CommandCenter.tsx
│       │   ├── LogScanner.tsx
│       │   ├── CodebaseMap.tsx
│       │   ├── AgentMonitor.tsx
│       │   └── PRPipeline.tsx
│       │
│       ├── hooks/
│       │   ├── useSocket.ts       # Socket.IO connection, reconnection, event handlers
│       │   ├── useAgents.ts       # Agent tree state management
│       │   ├── useTopology.ts     # Treemap data + zoom state
│       │   ├── useScanConfig.ts   # Scan config state + schedule
│       │   └── useTheme.ts        # Light/dark mode toggle + system preference
│       │
│       └── lib/
│           ├── api.ts             # REST API client
│           ├── types.ts           # Shared TypeScript types
│           └── theme.ts           # CSS custom properties for light/dark themes
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

If you do open a PR, babysit it: loop on `gh run watch` to keep CI green (fixing any failures), then read all PR comments and address any feedback. Repeat until CI is fully green and no comments remain unaddressed. Only then may you move on.
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
   - Write the fix (small change or broader refactor — agent's judgment)
   - Ensure existing tests still pass
   - Write new tests for the fix if appropriate
   - Create one commit per fix, push, and open a PR targeting staging
   - Babysit the PR: loop on `gh run watch` to keep CI green (fixing failures) and `gh api` to read and address all PR review comments. Only stop once CI is fully green and no comments remain unaddressed.

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
4. Design system: theme provider (light/dark), CSS custom properties, base typography
5. Global shell: top bar with live counters, icon sidebar, bottom event ticker, routing
6. Socket.IO setup (server + client) + reconnection logic
7. Config system (env vars, target repo path, MongoDB URI)
8. Command palette (Cmd+K) + toast notification system

### Phase 2: Codebase Mapper
9. Filesystem walker
10. OpenRouter LLM client
11. L1/L2/L3 discovery pipeline
12. Topology storage in MongoDB
13. Zoomable treemap component (D3) with animated zoom transitions
14. Activity overlay + node detail drawer
15. "Re-map", "Audit Selected", and "Audit All" actions

### Phase 3: Agent Infrastructure
16. CLI launcher (Claude Code subprocess + NDJSON)
17. ManagedAgent lifecycle (health, timeout, restart)
18. Agent Pool (30-cap, queue, drain)
19. Worktree manager (create, cleanup, orphan detection)
20. Agent monitor: process tree view + Gantt timeline view
21. Agent detail panel: terminal viewer (ANSI support, auto-scroll) + context pane
22. Pool capacity gauge
23. WebSocket broadcasting of agent events

### Phase 4: Log Scanner
24. CloudWatch prefetch (AWS SDK for JS, not Python — keep it all TypeScript)
25. Log analysis agent orchestration
26. Scan scheduling (node-cron, configurable)
27. Log scanner page: heatmap timeline + expandable scan history + config drawer
28. Live scan progress indicator
29. SRE state management

### Phase 5: Codebase Audit
30. Audit engine (dispatch L3 agents from topology)
31. Audit/verify/fix sub-agent orchestration
32. Integration with agent pool
33. Selective audit from topology treemap

### Phase 6: PR Pipeline
34. PR creation via Octokit
35. PR tracking (GitHub polling)
36. Kanban board: columns, animated card transitions, card design
37. Pipeline detail panel: bug report, diff viewer, agent trace
38. Learning engine (accept/reject tracking)
39. Learning context injection into agent prompts
40. Learning metrics strip (acceptance trend, pattern chips)

### Phase 7: Command Center
41. Agent pool gauge visualization
42. Live causal event timeline
43. Health vitals (stacked area charts + number grid)
44. Cross-view context linking (click any reference to navigate)

### Phase 8: Polish
45. Error handling and edge cases
46. Graceful shutdown (clean up agents, worktrees)
47. Server startup recovery (detect orphaned worktrees, resume tracking open PRs)
48. Performance tuning (MongoDB indexes, WebSocket throttling)
49. Keyboard shortcut system + accessibility pass
50. Animation polish: spring interpolation on counters, smooth page transitions
