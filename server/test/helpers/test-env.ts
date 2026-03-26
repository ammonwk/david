import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';

export interface TestEnvContext {
  rootDir: string;
  repoControlDir: string;
  worktreesDir: string;
}

export async function createTestEnv(
  overrides: Record<string, string> = {},
): Promise<TestEnvContext> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'david-server-test-'));
  const repoControlDir = path.join(rootDir, 'repo-control');
  const worktreesDir = path.join(rootDir, 'worktrees');

  Object.assign(process.env, {
    NODE_ENV: 'test',
    TARGET_REPO_URL: 'https://example.com/test/repo.git',
    MONGODB_URI: 'mongodb://127.0.0.1:27017/david-test',
    REPO_CONTROL_DIR: repoControlDir,
    WORKTREES_DIR: worktreesDir,
    BASE_BRANCH: 'staging',
    CLI_BACKEND: 'codex',
    ...overrides,
  });

  return {
    rootDir,
    repoControlDir,
    worktreesDir,
  };
}

export async function cleanupTestEnv(context: TestEnvContext): Promise<void> {
  await fs.rm(context.rootDir, { recursive: true, force: true });
}

export async function clearDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    await mongoose.connection.db.dropDatabase();
  }
}
