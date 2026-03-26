import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function parseCLIBackend(value: string | undefined): 'claude' | 'codex' {
  return value === 'codex' ? 'codex' : 'claude';
}

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // MongoDB
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/david',

  // Target repository
  targetRepoPath: process.env.TARGET_REPO_PATH || path.resolve(process.env.HOME || '~', 'Documents/plaibook/ai-outbound-agent'),
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
