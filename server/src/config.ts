import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function parseCLIBackend(value: string | undefined): 'claude' | 'codex' {
  return value === 'claude' ? 'claude' : 'codex';
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function resolvePathValue(value: string | undefined, fallback?: string): string {
  const raw = value && value.trim().length > 0 ? value.trim() : fallback;
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // MongoDB
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/david',

  // Target repository
  targetRepoUrl: requireEnv('TARGET_REPO_URL'),
  baseBranch: process.env.BASE_BRANCH || 'staging',

  // AWS
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  cloudwatchLogGroup: process.env.CLOUDWATCH_LOG_GROUP || '/ecs/sms-agent',
  ecsClusterName: process.env.ECS_CLUSTER_NAME || 'sms-agent',
  ecsServiceName: process.env.ECS_SERVICE_NAME || 'sms-agent',

  // GitHub
  githubToken: process.env.GITHUB_TOKEN || '',
  githubOwner: process.env.GITHUB_OWNER || 'AiAutomatrix',
  githubRepo: process.env.GITHUB_REPO || 'ai-outbound-agent',

  // OpenRouter
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  geminiProModel: 'google/gemini-3.1-pro-preview',
  geminiFlashModel: 'google/gemini-3.1-flash-lite-preview',

  // Agent pool
  maxConcurrentAgents: parseInt(process.env.MAX_CONCURRENT_AGENTS || '30', 10),
  agentTimeoutMs: parseInt(process.env.AGENT_TIMEOUT_MS || '3600000', 10), // 1 hour
  agentMaxRestarts: parseInt(process.env.AGENT_MAX_RESTARTS || '3', 10),
  agentRestartBackoffMs: [5000, 15000, 45000], // exponential backoff

  // Paths
  worktreesDir: path.resolve(__dirname, '../../worktrees'),
  repoControlDir: resolvePathValue(
    process.env.REPO_CONTROL_DIR,
    path.resolve(__dirname, '../../.david/repo-control'),
  ),
  projectRoot: path.resolve(__dirname, '../..'),

  // CLI backend
  cliBackend: parseCLIBackend(process.env.CLI_BACKEND),

  // Claude CLI
  claudeBinary: process.env.CLAUDE_BINARY || 'claude',

  // Codex CLI
  codexBinary: process.env.CODEX_BINARY || 'codex',

  // Scan defaults
  defaultScanTimeSpan: '5m' as const,
  defaultSeverityFilter: 'all' as const,
  defaultScanCron: '*/5 * * * *', // every 5 minutes
  defaultAuditCron: '0 3 * * *',  // 3 AM daily
} as const;

export type Config = typeof config;
