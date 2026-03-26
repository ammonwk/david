import dotenv from 'dotenv';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function loadEnv(): void {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

// Load .env from project root
loadEnv();

function parseCLIBackend(value: string | undefined): 'claude' | 'codex' {
  return value === 'claude' ? 'claude' : 'codex';
}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
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

export function createConfig(env: NodeJS.ProcessEnv) {
  return {
    // Server
    port: parseInt(env.PORT || '3001', 10),
    nodeEnv: env.NODE_ENV || 'development',

    // MongoDB
    mongodbUri: env.MONGODB_URI || 'mongodb://localhost:27017/david',

    // Target repository
    targetRepoUrl: requireEnv('TARGET_REPO_URL', env),
    baseBranch: env.BASE_BRANCH || 'staging',

    // AWS
    awsRegion: env.AWS_REGION || 'us-east-1',
    cloudwatchLogGroup: env.CLOUDWATCH_LOG_GROUP || '/ecs/sms-agent',
    ecsClusterName: env.ECS_CLUSTER_NAME || 'sms-agent',
    ecsServiceName: env.ECS_SERVICE_NAME || 'sms-agent',

    // GitHub
    githubToken: env.GITHUB_TOKEN || '',
    githubOwner: env.GITHUB_OWNER || 'AiAutomatrix',
    githubRepo: env.GITHUB_REPO || 'ai-outbound-agent',

    // OpenRouter
    openrouterApiKey: env.OPENROUTER_API_KEY || '',
    geminiProModel: 'google/gemini-3.1-pro-preview',
    geminiFlashModel: 'google/gemini-3.1-flash-lite-preview',

    // Agent pool
    maxConcurrentAgents: parseInt(env.MAX_CONCURRENT_AGENTS || '5', 10),
    agentTimeoutMs: parseInt(env.AGENT_TIMEOUT_MS || '3600000', 10),
    agentMaxRestarts: parseInt(env.AGENT_MAX_RESTARTS || '3', 10),
    agentRestartBackoffMs: [5000, 15000, 45000],

    // Paths
    worktreesDir: resolvePathValue(
      env.WORKTREES_DIR,
      path.resolve(__dirname, '../../worktrees'),
    ),
    repoControlDir: resolvePathValue(
      env.REPO_CONTROL_DIR,
      path.resolve(__dirname, '../../.david/repo-control'),
    ),
    projectRoot: path.resolve(__dirname, '../..'),

    // CLI backend
    cliBackend: parseCLIBackend(env.CLI_BACKEND),

    // Claude CLI
    claudeBinary: env.CLAUDE_BINARY || 'claude',

    // Codex CLI
    codexBinary: env.CODEX_BINARY || 'codex',

    // Scan defaults
    defaultScanTimeSpan: '5m' as const,
    defaultSeverityFilter: 'all' as const,
    defaultScanCron: '*/5 * * * *',
    defaultAuditCron: '0 3 * * *',
  } as const;
}

export const config = createConfig(process.env);

export type Config = typeof config;
