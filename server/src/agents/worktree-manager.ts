import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../config.js';
import { ensureControlRepo } from '../repo/repo-manager.js';

const execAsync = promisify(exec);

export interface WorktreeInfo {
  path: string;        // Absolute path to worktree
  branch: string;      // Branch name (e.g., sre/bug-123)
  commitHash: string;  // HEAD commit
  createdAt: Date;
}

/**
 * Get the worktree directory path for a bug.
 */
export function getWorktreePath(bugId: string): string {
  return path.join(config.worktreesDir, `sre-${bugId}`);
}

/**
 * Get the detached snapshot worktree path for a task.
 */
export function getSnapshotWorktreePath(taskId: string): string {
  return path.join(config.worktreesDir, `snapshot-${taskId}`);
}

/**
 * Get the branch name for a bug.
 */
export function getBranchName(bugId: string): string {
  return `sre/${bugId}`;
}

/**
 * Run a git command against the managed control repo unless an explicit
 * worktree cwd is provided.
 */
async function git(args: string, cwd?: string): Promise<string> {
  const workingDir = cwd ?? (await ensureControlRepo(false)).controlRepoPath;
  const cmd = `git ${args}`;
  console.log(`[worktree-manager] Running: ${cmd} (cwd: ${workingDir})`);

  try {
    await fs.access(workingDir);
    const { stdout, stderr } = await execAsync(cmd, { cwd: workingDir });
    if (stderr) {
      console.log(`[worktree-manager] stderr: ${stderr.trim()}`);
    }
    return stdout.trim();
  } catch (error: any) {
    console.error(`[worktree-manager] Command failed: ${cmd}`);
    console.error(`[worktree-manager] stderr: ${error.stderr?.trim()}`);
    throw error;
  }
}

/**
 * Create a new worktree for a fix agent.
 *
 * Branch name: sre/{bugId}
 * Location: {config.worktreesDir}/sre-{bugId}
 * Base: origin/staging
 */
export async function createWorktree(bugId: string): Promise<WorktreeInfo> {
  const { controlRepoPath } = await ensureControlRepo(true);
  const worktreePath = getWorktreePath(bugId);
  const branch = getBranchName(bugId);

  // 1. Ensure worktrees directory exists
  await fs.mkdir(config.worktreesDir, { recursive: true });

  // 2. Check if worktree already exists
  const exists = await worktreeExists(bugId);
  if (exists) {
    throw new Error(`Worktree for bug ${bugId} already exists at ${worktreePath}`);
  }

  // 3. Fetch latest staging
  await git(`fetch origin ${config.baseBranch}`, controlRepoPath);

  // 4. Delete the local branch if it already exists (leftover from a previous run)
  try {
    await git(`branch -D ${branch}`, controlRepoPath);
    console.log(`[worktree-manager] Deleted stale local branch ${branch}`);
  } catch {
    // Branch doesn't exist — that's fine
  }

  // 5. Create worktree with a new branch off origin/staging
  await git(`worktree add -b ${branch} ${worktreePath} origin/${config.baseBranch}`, controlRepoPath);

  // 6. Read HEAD commit from the new worktree
  const commitHash = await git('rev-parse HEAD', worktreePath);

  return {
    path: worktreePath,
    branch,
    commitHash,
    createdAt: new Date(),
  };
}

/**
 * Create a detached snapshot worktree from the latest remote base branch.
 * Used for read-only tasks like mapping and analysis so they don't run in
 * the control repo itself.
 */
export async function createSnapshotWorktree(taskId: string): Promise<WorktreeInfo> {
  const { controlRepoPath } = await ensureControlRepo(true);
  const worktreePath = getSnapshotWorktreePath(taskId);

  await fs.mkdir(config.worktreesDir, { recursive: true });

  try {
    await fs.access(worktreePath);
    throw new Error(`Snapshot worktree already exists at ${worktreePath}`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  await git(`worktree add --detach ${worktreePath} origin/${config.baseBranch}`, controlRepoPath);

  const commitHash = await git('rev-parse HEAD', worktreePath);

  return {
    path: worktreePath,
    branch: '(detached)',
    commitHash,
    createdAt: new Date(),
  };
}

/**
 * Remove a worktree and its branch.
 */
export async function removeWorktree(bugId: string): Promise<void> {
  const worktreePath = getWorktreePath(bugId);
  const branch = getBranchName(bugId);
  await removeWorktreeByPath(worktreePath, branch);
}

/**
 * Remove a worktree by absolute path, optionally deleting its branch too.
 */
export async function removeWorktreeByPath(
  worktreePath: string,
  branch?: string,
): Promise<void> {
  const { controlRepoPath } = await ensureControlRepo(false);

  // 1. Remove the worktree (--force handles dirty working trees)
  try {
    await git(`worktree remove ${worktreePath} --force`, controlRepoPath);
    console.log(`[worktree-manager] Removed worktree at ${worktreePath}`);
  } catch (error: any) {
    // If the directory was already deleted manually, prune instead
    console.warn(`[worktree-manager] worktree remove failed, pruning: ${error.message}`);
    await git('worktree prune', controlRepoPath);
  }

  // 2. Delete the local branch (ignore errors if already deleted)
  if (branch && branch !== '(detached)') {
    try {
      await git(`branch -D ${branch}`, controlRepoPath);
      console.log(`[worktree-manager] Deleted branch ${branch}`);
    } catch {
      console.log(`[worktree-manager] Branch ${branch} already deleted or does not exist`);
    }
  }
}

/**
 * List all active worktrees managed by David.
 * Parses `git worktree list --porcelain` and filters to worktrees
 * inside config.worktreesDir.
 */
export async function listWorktrees(): Promise<WorktreeInfo[]> {
  const output = await git('worktree list --porcelain');
  if (!output) return [];

  const worktrees: WorktreeInfo[] = [];
  const blocks = output.split('\n\n');

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length === 0) continue;

    let worktreePath = '';
    let commitHash = '';
    let branch = '';

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktreePath = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        commitHash = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        // branch refs/heads/sre/bug-123 -> sre/bug-123
        branch = line.slice('branch refs/heads/'.length);
      }
    }

    // Only include worktrees that live inside our worktrees directory
    if (worktreePath && worktreePath.startsWith(config.worktreesDir)) {
      // Determine createdAt from the directory's birthtime (best effort)
      let createdAt = new Date();
      try {
        const stat = await fs.stat(worktreePath);
        createdAt = stat.birthtime;
      } catch {
        // Directory may have been deleted; use now as fallback
      }

      worktrees.push({
        path: worktreePath,
        branch,
        commitHash,
        createdAt,
      });
    }
  }

  return worktrees;
}

/**
 * Clean up orphaned worktrees — worktrees with no matching active agent.
 * Called on server startup to recover from unclean shutdowns.
 *
 * Returns the count of worktrees that were cleaned up.
 */
export async function cleanupOrphanedWorktrees(
  activeAgentBranches: Set<string>,
): Promise<number> {
  console.log('[worktree-manager] Starting orphaned worktree cleanup...');

  try {
    await ensureControlRepo(false);
  } catch {
    console.warn(
      '[worktree-manager] Skipping cleanup because the control repo is unavailable',
    );
    return 0;
  }

  const worktrees = await listWorktrees();
  let cleaned = 0;

  for (const wt of worktrees) {
    if (!activeAgentBranches.has(wt.branch)) {
      console.log(
        `[worktree-manager] Orphaned worktree: ${wt.branch} at ${wt.path} — removing`,
      );

      // Derive bugId from directory name: sre-{bugId}
      const dirName = path.basename(wt.path);
      const bugId = dirName.replace(/^sre-/, '');

      try {
        if (dirName.startsWith('sre-')) {
          await removeWorktree(bugId);
        } else {
          await removeWorktreeByPath(wt.path, wt.branch);
        }
        cleaned++;
      } catch (error: any) {
        console.error(
          `[worktree-manager] Failed to clean up worktree ${wt.path}: ${error.message}`,
        );
      }
    }
  }

  // Final prune to catch any dangling references
  try {
    const { controlRepoPath } = await ensureControlRepo(false);
    await git('worktree prune', controlRepoPath);
  } catch {
    // Non-critical
  }

  console.log(`[worktree-manager] Cleanup complete. Removed ${cleaned} orphaned worktree(s).`);
  return cleaned;
}

/**
 * Check if a worktree exists for the given bug.
 */
export async function worktreeExists(bugId: string): Promise<boolean> {
  const worktreePath = getWorktreePath(bugId);
  try {
    await fs.access(worktreePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Commit all changes in a worktree.
 * Stages everything with `git add -A` then commits.
 *
 * Returns the new commit hash.
 */
export async function commitChanges(
  worktreePath: string,
  message: string,
): Promise<string> {
  // Stage all changes
  await git('add -A', worktreePath);

  // Commit — the message is passed via -m with proper escaping
  const escapedMessage = message.replace(/'/g, "'\\''");
  await git(`commit -m '${escapedMessage}'`, worktreePath);

  // Return the new HEAD commit hash
  const commitHash = await git('rev-parse HEAD', worktreePath);
  return commitHash;
}

/**
 * Push a worktree's branch to origin.
 */
export async function pushBranch(bugId: string): Promise<void> {
  const worktreePath = getWorktreePath(bugId);
  const branch = getBranchName(bugId);

  await git(`push origin ${branch}`, worktreePath);
  console.log(`[worktree-manager] Pushed branch ${branch} to origin`);
}

/**
 * Check if there are uncommitted changes in a worktree.
 */
export async function hasChanges(worktreePath: string): Promise<boolean> {
  const output = await git('status --porcelain', worktreePath);
  return output.length > 0;
}
