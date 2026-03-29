// ============================================
// David — AI SRE Tool
// PR Manager: Creates and manages GitHub PRs for bug fixes
// ============================================

import { Octokit } from '@octokit/rest';
import { execSync } from 'child_process';
import { config } from '../config.js';
import type { PullRequestRecord, BugReport } from 'david-shared';

// Initialize Octokit with GitHub token
const octokit = new Octokit({ auth: config.githubToken });

export interface CreatePRParams {
  bugId: string;
  bugReport: BugReport;
  worktreePath: string;
  branch: string;               // e.g., sre/bug-abc123
  title: string;                // [SRE] prefix already included
  description: string;          // Markdown body
  diff: string;                 // Git diff for the PR record
  verificationMethod: string;
}

export interface PRCreateResult {
  prNumber: number;
  prUrl: string;
  branch: string;
}

/** Maximum diff size (8 KB) for LLM consumption. */
const MAX_DIFF_SIZE = 8 * 1024;

// ============================================
// Git helpers
// ============================================

/**
 * Commit all pending changes in a worktree.
 * Returns the commit hash, or null if there was nothing to commit.
 */
export async function commitPendingChanges(
  worktreePath: string,
  message: string,
): Promise<string | null> {
  const status = execSync('git status --porcelain', {
    cwd: worktreePath,
    encoding: 'utf-8',
  }).trim();

  if (!status) {
    return null;
  }

  execSync('git add -A', { cwd: worktreePath, encoding: 'utf-8' });
  execSync(`git commit -m ${JSON.stringify(message)}`, {
    cwd: worktreePath,
    encoding: 'utf-8',
  });

  const hash = execSync('git rev-parse HEAD', {
    cwd: worktreePath,
    encoding: 'utf-8',
  }).trim();

  return hash;
}

/**
 * Push a branch to origin from the given worktree.
 * Handles "already up to date" gracefully.
 */
export async function pushBranch(
  worktreePath: string,
  branch: string,
): Promise<void> {
  try {
    execSync(`git push origin ${branch}`, {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    // "Everything up-to-date" exits 0 normally, but guard against edge cases
    const msg: string = err.stderr ?? err.stdout ?? '';
    if (!msg.includes('up-to-date') && !msg.includes('up to date')) {
      throw err;
    }
  }
}

// ============================================
// PR lifecycle
// ============================================

/**
 * Create a GitHub pull request for a bug fix.
 *
 * 1. Commits any pending changes in the worktree.
 * 2. Pushes the branch to origin.
 * 3. Opens a PR via the GitHub API.
 * 4. Attaches the "autofix" label (creating it if necessary).
 */
export async function createPR(params: CreatePRParams): Promise<PRCreateResult> {
  const { worktreePath, branch, title, description } = params;

  // 1. Commit pending changes
  await commitPendingChanges(worktreePath, `[SRE] ${title}`);

  // 2. Push branch to origin
  await pushBranch(worktreePath, branch);

  // 3. Create the pull request
  const { data: pr } = await octokit.pulls.create({
    owner: config.githubOwner,
    repo: config.githubRepo,
    title: params.title,
    body: description,
    head: branch,
    base: config.baseBranch,
  });

  const prNumber = pr.number;

  // 4. Ensure the autofix label exists, then attach it
  await ensureAutofixLabel();
  await octokit.issues.addLabels({
    owner: config.githubOwner,
    repo: config.githubRepo,
    issue_number: prNumber,
    labels: ['autofix'],
  });

  return {
    prNumber,
    prUrl: pr.html_url,
    branch,
  };
}

// ============================================
// Label management
// ============================================

/**
 * Ensure the "autofix" label exists on the target repo.
 * Silently ignores 422 (already exists) errors.
 */
export async function ensureAutofixLabel(): Promise<void> {
  try {
    await octokit.issues.createLabel({
      owner: config.githubOwner,
      repo: config.githubRepo,
      name: 'autofix',
      color: '7B61FF',
      description: 'Automated fix by David AI SRE',
    });
  } catch (err: any) {
    // 422 = already exists — that's fine
    if (err.status !== 422) throw err;
  }
}

// ============================================
// PR status & feedback
// ============================================

/**
 * Retrieve the current status of a pull request.
 */
export async function getPRStatus(prNumber: number): Promise<{
  status: 'open' | 'merged' | 'closed';
  mergedAt?: string;
  closedAt?: string;
}> {
  const { data } = await octokit.pulls.get({
    owner: config.githubOwner,
    repo: config.githubRepo,
    pull_number: prNumber,
  });

  if (data.merged) return { status: 'merged', mergedAt: data.merged_at! };
  if (data.state === 'closed') return { status: 'closed', closedAt: data.closed_at! };
  return { status: 'open' };
}

/**
 * Fetch all comments on a PR (both review comments and issue comments).
 * Useful for the learning engine to extract reviewer feedback.
 */
export async function getPRComments(prNumber: number): Promise<string[]> {
  const [reviewComments, issueComments] = await Promise.all([
    octokit.pulls.listReviewComments({
      owner: config.githubOwner,
      repo: config.githubRepo,
      pull_number: prNumber,
      per_page: 100,
    }),
    octokit.issues.listComments({
      owner: config.githubOwner,
      repo: config.githubRepo,
      issue_number: prNumber,
      per_page: 100,
    }),
  ]);

  const comments = [
    ...reviewComments.data.map((c) => c.body),
    ...issueComments.data.map((c) => c.body ?? ''),
  ].filter(Boolean);

  return comments;
}

// ============================================
// Diff helpers
// ============================================

/**
 * Get the diff between the current branch and the base branch.
 * Truncates to 8 KB so it can be safely fed into an LLM context.
 */
export async function getPRDiff(worktreePath: string): Promise<string> {
  const diff = execSync(
    `git diff origin/${config.baseBranch}...HEAD`,
    { cwd: worktreePath, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 },
  );

  if (diff.length > MAX_DIFF_SIZE) {
    return diff.slice(0, MAX_DIFF_SIZE) + '\n\n... [truncated to 8 KB] ...';
  }
  return diff;
}

// ============================================
// Listing
// ============================================

/**
 * Find an existing open PR for a given branch.
 * Returns the PR info if found, null otherwise.
 * Useful for detecting PRs that agents created directly via `gh pr create`.
 */
export async function findPRByBranch(branch: string): Promise<PRCreateResult | null> {
  try {
    const { data } = await octokit.pulls.list({
      owner: config.githubOwner,
      repo: config.githubRepo,
      state: 'open',
      head: `${config.githubOwner}:${branch}`,
      per_page: 1,
    });

    if (data.length === 0) return null;

    return {
      prNumber: data[0].number,
      prUrl: data[0].html_url,
      branch: data[0].head.ref,
    };
  } catch {
    return null;
  }
}

/**
 * Create a PR or find the existing one if the agent already created it.
 * This handles the case where the fix agent runs `gh pr create` directly
 * before the engine's post-completion handler runs.
 */
export async function createOrFindPR(params: CreatePRParams): Promise<PRCreateResult> {
  // First check if the agent already created a PR for this branch
  const existing = await findPRByBranch(params.branch);
  if (existing) {
    return existing;
  }

  // No existing PR — create one
  return createPR(params);
}

/**
 * List all open PRs created by David (identified by the "autofix" label).
 */
export async function listOpenPRs(): Promise<
  Array<{
    prNumber: number;
    prUrl: string;
    title: string;
    branch: string;
    createdAt: string;
  }>
> {
  const { data } = await octokit.pulls.list({
    owner: config.githubOwner,
    repo: config.githubRepo,
    state: 'open',
    per_page: 100,
  });

  return data
    .filter((pr) => pr.labels.some((l) => l.name === 'autofix'))
    .map((pr) => ({
      prNumber: pr.number,
      prUrl: pr.html_url,
      title: pr.title,
      branch: pr.head.ref,
      createdAt: pr.created_at,
    }));
}
