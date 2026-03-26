# David — AI Site Reliability Engineer

## Project Overview
David is an autonomous AI SRE that monitors CloudWatch logs, maps codebase topology via LLM, and dispatches fleets of Claude Code agents to find, verify, fix, and PR bugs — with a visual, interactive dashboard for control and observability.

## Tech Stack
- **Backend:** Express + TypeScript + MongoDB (Mongoose) + Socket.IO
- **Frontend:** React + TypeScript + Vite + Tailwind CSS + D3.js (treemap, Gantt) + Recharts (area charts) + Framer Motion (transitions)
- **Agent Runtime:** Claude Code CLI subprocesses (NDJSON over stdin/stdout)
- **LLM for Mapping:** OpenRouter (google/gemini-3.1-pro-preview for L1, google/gemini-3.1-flash-lite-preview for L2/L3)
- **Cloud:** AWS SDK (CloudWatch Logs, CloudWatch Metrics, ECS)
- **Git:** GitHub (Octokit), git worktrees for agent isolation

## Monorepo Structure
- `server/` — Express backend (API routes, engines, agent management, PR pipeline)
- `dashboard/` — React frontend (Vite, Tailwind, Socket.IO client)
- `shared/` — TypeScript type definitions shared between server and dashboard
- `worktrees/` — Git worktrees for fix agents (gitignored)

## Dashboard Pages
- **Command Center** — Default landing page. Three-column operational summary: agent pool gauge, live event timeline, health vitals (mini area charts).
- **Log Scanner** — Heatmap timeline of error/warning density, scan history list, config drawer for scan parameters and scheduling.
- **Codebase Map** — Zoomable treemap (L1 → L2 → L3), activity overlay, node detail drawer. NOT circle packing.
- **Agent Monitor** — Tree view + Gantt timeline toggle. Shows agent hierarchy and concurrency. Agent detail panel with live terminal output.
- **PR Pipeline** — Kanban board (Reported → Verifying → Fixing → PR Open → Merged → Closed). Cards auto-move as status changes, NOT draggable. Learning metrics strip at bottom.

## Component Organization
Components are organized by feature in subdirectories under `dashboard/src/components/`:
- `shell/` — GlobalShell, TopBar, Sidebar, EventTicker, CommandPalette, ToastManager
- `command-center/` — AgentPoolGauge, EventTimeline, HealthVitals
- `log-scanner/` — HeatmapTimeline, ScanHistory, ScanConfigDrawer
- `topology/` — Treemap, ActivityOverlay, NodeDetailDrawer
- `agents/` — AgentTree, AgentGantt, AgentDetail, TerminalViewer, PoolBar
- `pr-pipeline/` — KanbanBoard, PipelineCard, PipelineDetail, LearningStrip

## Hooks
- `useSocket` — Singleton Socket.IO connection, event subscriptions
- `useReconnectionState` — Exported from useSocket, tracks WebSocket reconnection status
- `useAgents` — Agent pool state and lifecycle events
- `useTopology` — Codebase topology data and zoom state
- `useScanConfig` — Log scanner configuration and scheduling
- `useTheme` — Light/dark theme toggle (system preference detected on first load)
- `useCommandPalette` — Command palette state and actions (Cmd+K / Ctrl+K)
- `usePipeline` — PR pipeline kanban data and status transitions

## Conventions
- All code is TypeScript with strict mode
- ES modules everywhere ("type": "module" in package.json)
- Import shared types from 'david-shared' (the shared workspace package)
- Server runs on port 3001, dashboard on 5173 (proxied via Vite)
- MongoDB collections: sre_state, scan_results, bug_reports, codebase_topology, agents, pull_requests, learning_records
- WebSocket events use the WSEventType enum from shared types
- Agent subprocess communication uses NDJSON over stdin/stdout pipes
- Git branches for fixes: sre/{bugId} off staging
- PRs: [SRE] prefix in title, "autofix" GitHub label, base branch = staging
- One git worktree per bug fix, cleaned up after PR merge/close

## Key Patterns
- Agent pool: max 30 concurrent top-level agents, FIFO queue for overflow
- Agents timeout at 1 hour, restart up to 3 times with exponential backoff (5s/15s/45s)
- Process group kill: spawn with detached:true, kill(-pid) for cleanup
- Agent permissions: CLI launched with `--permission-mode bypassPermissions`
- PR dedup: agents check for existing open PRs on the same files/bug before starting a fix, and again before creating a PR
- PR babysitting: after opening a PR, fix agents loop — watch CI via `gh run watch`, fix failures, read and address PR review comments — until CI is green and no comments remain unaddressed
- Conservative change policy: agents prefer NO CHANGE over speculative fixes
- Observability improvements (better logging/metrics) are a valid agent output
- Learning engine tracks PR accept/reject to improve future agent behavior
- Agent port isolation: each agent gets a unique `PORT` env var from a pool (range 4000–4999), reclaimed on agent completion/failure
- Zoomable treemap for codebase topology (not circle packing) — click to zoom L1 → L2 → L3, breadcrumb navigation
- Kanban board for PR pipeline (not table) — columns represent bug-to-merge lifecycle stages
- Tree view + Gantt timeline for agent monitor — tree shows parent/child hierarchy, Gantt shows temporal concurrency
- Command palette (Cmd+K / Ctrl+K) for quick search across agents, bugs, PRs, topology nodes, and actions
- Light/dark theme with system preference detection
- Toast notifications for high-signal events (top-right, auto-dismiss 5s, max 3 stacked)
- Bottom event ticker showing most recent system event

## File Organization
- `server/src/api/` — Express route handlers (thin, delegate to engines)
- `server/src/engine/` — Business logic orchestrators (log-scanner, codebase-mapper, audit-engine, scheduler)
- `server/src/agents/` — Agent lifecycle (pool, managed-agent, cli-launcher, worktree-manager, prompts)
- `server/src/pr/` — PR creation, tracking, learning (pr-manager, pr-tracker, learning-engine)
- `server/src/llm/` — OpenRouter LLM client
- `server/src/ws/` — Socket.IO event broadcasting
- `server/src/db/` — MongoDB connection and Mongoose models
- `dashboard/src/pages/` — Top-level page components (CommandCenter, LogScanner, CodebaseMap, AgentMonitor, PRPipeline)
- `dashboard/src/components/` — UI components organized by feature (see Component Organization above)
- `dashboard/src/hooks/` — React hooks (see Hooks above)
- `dashboard/src/lib/` — API client and utilities

## Commands
- `npm run dev` — Start both server and dashboard in dev mode (via concurrently)
- `npm run dev:server` — Start just the server (tsx watch)
- `npm run dev:dashboard` — Start just the dashboard (vite)
- `npm run build` — Build all workspaces
