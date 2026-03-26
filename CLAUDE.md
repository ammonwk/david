# David — AI Site Reliability Engineer

## Project Overview
David is an autonomous AI SRE that monitors CloudWatch logs, maps codebase topology via LLM, and dispatches fleets of Claude Code agents to find, verify, fix, and PR bugs.

## Tech Stack
- **Backend:** Express + TypeScript + MongoDB (Mongoose) + Socket.IO
- **Frontend:** React + TypeScript + Vite + Tailwind CSS + D3.js + Recharts
- **Agent Runtime:** Claude Code CLI subprocesses (NDJSON over stdin/stdout)
- **LLM for Mapping:** OpenRouter (google/gemini-3.1-pro-preview for L1, google/gemini-3.1-flash-lite-preview for L2/L3)
- **Cloud:** AWS SDK (CloudWatch Logs, CloudWatch Metrics, ECS)
- **Git:** GitHub (Octokit), git worktrees for agent isolation

## Monorepo Structure
- `server/` — Express backend (API routes, engines, agent management, PR pipeline)
- `dashboard/` — React frontend (Vite, Tailwind, Socket.IO client)
- `shared/` — TypeScript type definitions shared between server and dashboard
- `worktrees/` — Git worktrees for fix agents (gitignored)

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
- Conservative change policy: agents prefer NO CHANGE over speculative fixes
- Observability improvements (better logging/metrics) are a valid agent output
- Learning engine tracks PR accept/reject to improve future agent behavior

## File Organization
- `server/src/api/` — Express route handlers (thin, delegate to engines)
- `server/src/engine/` — Business logic orchestrators (log-scanner, codebase-mapper, audit-engine, scheduler)
- `server/src/agents/` — Agent lifecycle (pool, managed-agent, cli-launcher, worktree-manager, prompts)
- `server/src/pr/` — PR creation, tracking, learning (pr-manager, pr-tracker, learning-engine)
- `server/src/llm/` — OpenRouter LLM client
- `server/src/ws/` — Socket.IO event broadcasting
- `server/src/db/` — MongoDB connection and Mongoose models
- `dashboard/src/pages/` — Top-level page components (Overview, LogScanner, CodebaseMap, AgentMonitor, PRTracker)
- `dashboard/src/components/` — Reusable UI components
- `dashboard/src/hooks/` — React hooks (useSocket, useAgents, useTopology, useScanConfig)
- `dashboard/src/lib/` — API client and utilities

## Commands
- `npm run dev` — Start both server and dashboard in dev mode
- `npm run dev:server` — Start just the server (tsx watch)
- `npm run dev:dashboard` — Start just the dashboard (vite)
