// ============================================
// David — AI SRE Tool
// PR Tracker — Polls GitHub for PR status updates
// and feeds results into the learning engine.
// ============================================

import type { PullRequestRecord, BugReport, PRStatus } from 'david-shared';
import { Octokit } from '@octokit/rest';
import { config } from '../config.js';
import { learningEngine } from './learning-engine.js';
import { PullRequestModel, BugReportModel } from '../db/models.js';

const octokit = new Octokit({ auth: config.githubToken });

export class PRTracker {
  private pollInterval: NodeJS.Timeout | null = null;
  private pollIntervalMs: number = 5 * 60 * 1000; // 5 minutes

  /**
   * Start polling for PR status updates.
   *
   * @param getOpenPRs  Function that returns all open PRs from the database
   * @param updatePR    Function that updates a PR record in the database
   * @param onStatusChange  Callback invoked when a PR transitions to merged or closed
   *                        (intended for WebSocket broadcast)
   */
  startPolling(
    getOpenPRs: () => Promise<PullRequestRecord[]>,
    updatePR: (id: string, updates: Partial<PullRequestRecord>) => Promise<void>,
    onStatusChange: (pr: PullRequestRecord, newStatus: string) => void,
  ): void {
    if (this.pollInterval) {
      console.warn('[PRTracker] Polling already active — stopping previous interval.');
      this.stopPolling();
    }

    console.log(`[PRTracker] Starting PR polling every ${this.pollIntervalMs / 1000}s`);

    // Run once immediately, then on interval
    this.pollOnce(getOpenPRs, updatePR, onStatusChange).catch((err) =>
      console.error('[PRTracker] Initial poll failed:', err),
    );

    this.pollInterval = setInterval(() => {
      this.pollOnce(getOpenPRs, updatePR, onStatusChange).catch((err) =>
        console.error('[PRTracker] Poll cycle failed:', err),
      );
    }, this.pollIntervalMs);
  }

  /** Stop the polling interval. */
  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[PRTracker] Polling stopped.');
    }
  }

  /**
   * Check a single PR on-demand (e.g., triggered by a dashboard refresh button).
   * Fetches the current status from GitHub and updates the DB if it has changed.
   */
  async checkPR(prNumber: number): Promise<void> {
    try {
      const { data: ghPR } = await octokit.pulls.get({
        owner: config.githubOwner,
        repo: config.githubRepo,
        pull_number: prNumber,
      });

      const newStatus: PRStatus = ghPR.merged
        ? 'merged'
        : ghPR.state === 'closed'
          ? 'closed'
          : 'open';

      const existing = await PullRequestModel.findOne({ prNumber });
      if (existing && existing.status !== newStatus && newStatus !== 'open') {
          const resolution = newStatus === 'merged' ? 'accepted' as const : 'rejected' as const;

          // Fetch review comments for feedback
          const feedbackComments = await this.fetchReviewComments(prNumber);

          existing.status = newStatus;
          existing.resolvedAt = new Date();
          existing.resolution = resolution;

          if (resolution === 'rejected' && feedbackComments.length > 0) {
            existing.rejectionFeedback = feedbackComments.join('\n---\n');
          }

          await existing.save();
          console.log(`[PRTracker] PR #${prNumber} updated to ${newStatus}`);

          // Feed into learning engine
          try {
            const bugReport = await this.fetchBugReport(existing.bugReportId);
            if (bugReport) {
              await learningEngine.recordOutcome({
                pr: existing.toObject() as unknown as PullRequestRecord,
                bugReport,
                resolution,
                feedbackComments,
              });
            } else {
              console.warn(`[PRTracker] Bug report ${existing.bugReportId} not found — skipping learning record.`);
            }
          } catch (err) {
            console.error(`[PRTracker] Failed to record learning outcome for PR #${prNumber}:`, err);
          }
      }
    } catch (err) {
      console.error(`[PRTracker] Failed to check PR #${prNumber}:`, err);
    }
  }

  /**
   * Poll all open PRs once. Called by the interval set up in startPolling().
   * For each open PR:
   *   1. Check GitHub for current status
   *   2. If status changed (merged or closed):
   *      - Update DB record with new status, resolution, and resolvedAt
   *      - Fetch review comments for feedback (especially on rejection)
   *      - Call onStatusChange callback (for WebSocket broadcast)
   *      - Feed outcome into learning engine
   */
  private async pollOnce(
    getOpenPRs: () => Promise<PullRequestRecord[]>,
    updatePR: (id: string, updates: Partial<PullRequestRecord>) => Promise<void>,
    onStatusChange: (pr: PullRequestRecord, newStatus: string) => void,
  ): Promise<void> {
    let openPRs: PullRequestRecord[];
    try {
      openPRs = await getOpenPRs();
    } catch (err) {
      console.error('[PRTracker] Failed to fetch open PRs from DB:', err);
      return;
    }

    if (openPRs.length === 0) return;

    console.log(`[PRTracker] Polling ${openPRs.length} open PR(s)...`);

    for (const pr of openPRs) {
      try {
        const { data: ghPR } = await octokit.pulls.get({
          owner: config.githubOwner,
          repo: config.githubRepo,
          pull_number: pr.prNumber,
        });

        const newStatus: PRStatus = ghPR.merged
          ? 'merged'
          : ghPR.state === 'closed'
            ? 'closed'
            : 'open';

        // No change — skip
        if (newStatus === pr.status) continue;

        console.log(`[PRTracker] PR #${pr.prNumber} changed: ${pr.status} -> ${newStatus}`);

        // Determine resolution
        const resolution = newStatus === 'merged' ? 'accepted' as const : 'rejected' as const;

        // Fetch review comments for feedback (useful for both accepted and rejected)
        const feedbackComments = await this.fetchReviewComments(pr.prNumber);

        // Build update payload
        const updates: Partial<PullRequestRecord> = {
          status: newStatus,
          resolution,
          resolvedAt: new Date(),
        };

        // For rejected PRs, store the rejection feedback
        if (resolution === 'rejected' && feedbackComments.length > 0) {
          updates.rejectionFeedback = feedbackComments.join('\n---\n');
        }

        // Update in DB
        try {
          const prId = pr._id ?? '';
          await updatePR(prId, updates);
        } catch (err) {
          console.error(`[PRTracker] Failed to update PR #${pr.prNumber} in DB:`, err);
        }

        // Notify via callback (for WebSocket broadcast)
        const updatedPR: PullRequestRecord = { ...pr, ...updates };
        onStatusChange(updatedPR, newStatus);

        // Feed into learning engine
        try {
          const bugReport = await this.fetchBugReport(pr.bugReportId);
          if (bugReport) {
            await learningEngine.recordOutcome({
              pr: updatedPR,
              bugReport,
              resolution,
              feedbackComments,
            });
          } else {
            console.warn(`[PRTracker] Bug report ${pr.bugReportId} not found — skipping learning record.`);
          }
        } catch (err) {
          console.error(`[PRTracker] Failed to record learning outcome for PR #${pr.prNumber}:`, err);
        }
      } catch (err) {
        console.error(`[PRTracker] Failed to poll PR #${pr.prNumber}:`, err);
        // Continue polling other PRs even if one fails
      }
    }
  }

  /**
   * Fetch review comments from a GitHub PR.
   * Returns an array of comment body strings (from both review comments and issue comments).
   */
  private async fetchReviewComments(prNumber: number): Promise<string[]> {
    const comments: string[] = [];

    try {
      // Fetch PR review comments (inline code comments)
      const { data: reviewComments } = await octokit.pulls.listReviewComments({
        owner: config.githubOwner,
        repo: config.githubRepo,
        pull_number: prNumber,
        per_page: 100,
      });

      for (const comment of reviewComments) {
        if (comment.body) {
          comments.push(comment.body);
        }
      }

      // Fetch PR reviews (top-level review bodies)
      const { data: reviews } = await octokit.pulls.listReviews({
        owner: config.githubOwner,
        repo: config.githubRepo,
        pull_number: prNumber,
        per_page: 100,
      });

      for (const review of reviews) {
        if (review.body) {
          comments.push(review.body);
        }
      }

      // Fetch issue comments (general PR conversation)
      const { data: issueComments } = await octokit.issues.listComments({
        owner: config.githubOwner,
        repo: config.githubRepo,
        issue_number: prNumber,
        per_page: 100,
      });

      for (const comment of issueComments) {
        if (comment.body) {
          comments.push(comment.body);
        }
      }
    } catch (err) {
      console.error(`[PRTracker] Failed to fetch comments for PR #${prNumber}:`, err);
    }

    return comments;
  }

  /**
   * Fetch the bug report associated with a PR from the database.
   */
  private async fetchBugReport(bugReportId: string): Promise<BugReport | null> {
    try {
      const doc = await BugReportModel.findById(bugReportId).lean();
      return doc as BugReport | null;
    } catch (err) {
      console.error(`[PRTracker] Failed to fetch bug report ${bugReportId}:`, err);
      return null;
    }
  }
}

export const prTracker = new PRTracker();
