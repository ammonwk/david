import fs from 'fs/promises';
import path from 'path';
import { cleanupTestEnv, createTestEnv, type TestEnvContext } from './helpers/test-env.js';
import { pathExists, runGit, seedRemoteRepo } from './helpers/git.js';

describe('worktree manager integration', () => {
  let testEnv: TestEnvContext;

  afterEach(async () => {
    vi.resetModules();
    if (testEnv) {
      await cleanupTestEnv(testEnv);
    }
  });

  it('creates and removes detached snapshot worktrees against a real remote repo', async () => {
    testEnv = await createTestEnv();
    const { bareRepoPath } = await seedRemoteRepo(testEnv.rootDir);

    process.env.TARGET_REPO_URL = bareRepoPath;

    const {
      createSnapshotWorktree,
      listWorktrees,
      removeWorktreeByPath,
    } = await import('../src/agents/worktree-manager.js');

    const worktree = await createSnapshotWorktree('scan-123');
    const listed = await listWorktrees();

    expect(await pathExists(path.join(worktree.path, 'README.md'))).toBe(true);
    expect(listed.some((entry) => entry.path === worktree.path)).toBe(true);

    await removeWorktreeByPath(worktree.path, worktree.branch);

    expect(await pathExists(worktree.path)).toBe(false);
  });

  it('creates a named fix worktree from the configured base branch', async () => {
    testEnv = await createTestEnv();
    const { bareRepoPath } = await seedRemoteRepo(testEnv.rootDir);

    process.env.TARGET_REPO_URL = bareRepoPath;

    const {
      createWorktree,
      removeWorktree,
    } = await import('../src/agents/worktree-manager.js');

    const worktree = await createWorktree('bug-42');
    const currentBranch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], worktree.path);

    await fs.writeFile(path.join(worktree.path, 'fix.txt'), 'patched\n');

    expect(worktree.branch).toBe('sre/bug-42');
    expect(currentBranch).toBe('sre/bug-42');

    await removeWorktree('bug-42');

    expect(await pathExists(worktree.path)).toBe(false);
  });
});
