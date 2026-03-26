// ============================================
// David — AI SRE Tool
// Learning Engine — Tracks accept/reject patterns
// to improve future agent behavior.
// ============================================

import type {
  LearningRecord,
  LearningMetrics,
  PullRequestRecord,
  BugReport,
} from 'david-shared';

// Lazy-load models to handle the case where DB might not be wired up yet
let LearningRecordModel: any;
let PullRequestModel: any;
try {
  const models = await import('../db/models.js');
  LearningRecordModel = models.LearningRecordModel;
  PullRequestModel = models.PullRequestModel;
} catch {
  console.warn('[LearningEngine] Could not import DB models — DB operations will be no-ops until models are available.');
}

/** Bug categories used for heuristic classification. */
const BUG_CATEGORIES = [
  'null-check',
  'error-handling',
  'race-condition',
  'type-error',
  'missing-validation',
  'resource-leak',
  'logic-error',
  'observability',
  'other',
] as const;

type BugCategory = (typeof BUG_CATEGORIES)[number];

/** Keyword map for heuristic bug categorization. */
const CATEGORY_KEYWORDS: Record<BugCategory, string[]> = {
  'null-check': ['null', 'undefined', 'nil', 'optional chaining', 'cannot read propert', 'is not defined', 'nullpointer'],
  'error-handling': ['try', 'catch', 'error handling', 'unhandled', 'uncaught', 'throw', 'exception', 'reject'],
  'race-condition': ['race', 'concurrent', 'mutex', 'lock', 'deadlock', 'async', 'await', 'timing', 'parallel'],
  'type-error': ['type', 'typeerror', 'cast', 'coercion', 'interface', 'mismatch', 'incompatible'],
  'missing-validation': ['validat', 'sanitiz', 'check', 'assert', 'constraint', 'boundary', 'input', 'schema'],
  'resource-leak': ['leak', 'close', 'dispose', 'cleanup', 'memory', 'connection', 'socket', 'stream', 'file descriptor'],
  'logic-error': ['logic', 'off-by-one', 'infinite loop', 'incorrect', 'wrong', 'inverted', 'negat', 'condition'],
  'observability': ['log', 'metric', 'trace', 'monitor', 'alert', 'observ', 'instrument', 'debug'],
  'other': [],
};

export class LearningEngine {
  /**
   * Record the outcome of a PR (called when PR is merged or closed).
   *
   * 1. Categorize the bug based on pattern text and affected files
   * 2. Extract file pattern from affected files
   * 3. Create a LearningRecord in MongoDB
   * 4. If rejected, extract useful feedback from review comments
   */
  async recordOutcome(params: {
    pr: PullRequestRecord;
    bugReport: BugReport;
    resolution: 'accepted' | 'rejected';
    feedbackComments: string[];
  }): Promise<void> {
    const { pr, bugReport, resolution, feedbackComments } = params;

    const bugCategory = this.categorizeBug(bugReport);
    const filePattern = this.extractFilePattern(bugReport.affectedFiles);
    const wasAccepted = resolution === 'accepted';

    // Build feedback notes from review comments (especially useful for rejections)
    let feedbackNotes: string | undefined;
    if (feedbackComments.length > 0) {
      if (wasAccepted) {
        // For accepted PRs, just note that feedback was positive
        feedbackNotes = `Accepted with ${feedbackComments.length} comment(s).`;
      } else {
        // For rejected PRs, capture the actual feedback for learning
        const trimmedComments = feedbackComments
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
          .slice(0, 10); // Cap at 10 comments to avoid huge records
        feedbackNotes = trimmedComments.join('\n---\n');
      }
    }

    // Determine confidence based on verification method
    const confidence = this.computeConfidence(bugReport);

    const record: Omit<LearningRecord, '_id'> = {
      bugCategory,
      filePattern,
      wasAccepted,
      confidence,
      verificationMethod: bugReport.verificationResult?.method ?? pr.verificationMethod,
      prId: pr._id ?? String(pr.prNumber),
      feedbackNotes,
      createdAt: new Date(),
    };

    // Persist to MongoDB
    if (LearningRecordModel) {
      try {
        await LearningRecordModel.create(record);
        console.log(
          `[LearningEngine] Recorded outcome: category=${bugCategory} accepted=${wasAccepted} filePattern=${filePattern}`,
        );
      } catch (err) {
        console.error('[LearningEngine] Failed to create learning record:', err);
      }
    } else {
      // TODO: Persist when models are available
      console.warn('[LearningEngine] DB models not available — learning record not persisted:', record);
    }
  }

  /**
   * Get learning context for a specific feature area.
   * Used to inject into agent prompts so they can learn from past outcomes.
   *
   * @param nodeId       Optional topology node ID to scope the context
   * @param filePatterns Optional file glob patterns to match against
   * @returns Context object with acceptance rate, recent patterns, and area-specific notes
   */
  async getLearningContext(params: {
    nodeId?: string;
    filePatterns?: string[];
  }): Promise<{
    acceptanceRate: number;
    recentAccepted: string[];
    recentRejected: string[];
    areaSpecificNotes: string;
  }> {
    const defaultResult = {
      acceptanceRate: 0,
      recentAccepted: [],
      recentRejected: [],
      areaSpecificNotes: 'No learning data available yet.',
    };

    if (!LearningRecordModel || !PullRequestModel) return defaultResult;

    try {
      const { nodeId, filePatterns } = params;

      // Build query filter based on file patterns or nodeId
      const filter: Record<string, any> = {};

      if (filePatterns && filePatterns.length > 0) {
        // Match records whose filePattern overlaps with any of the given patterns
        // Use regex to find records where the stored pattern shares a common prefix
        const regexPatterns = filePatterns.map((fp) => {
          // Extract the directory part before any glob wildcard
          const dirPart = fp.replace(/\/?\*\*.*$/, '').replace(/\/?\*$/, '');
          return dirPart ? new RegExp(dirPart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : null;
        }).filter(Boolean);

        if (regexPatterns.length > 0) {
          filter.filePattern = { $in: regexPatterns };
        }
      }

      // If nodeId is provided, also look up PRs for that node and find matching learning records
      if (nodeId) {
        const prsForNode = await PullRequestModel.find({ nodeId }).select('_id').lean();
        const prIds = prsForNode.map((p: any) => String(p._id));
        if (prIds.length > 0) {
          if (filter.filePattern) {
            // Combine with OR: match file pattern OR match node PRs
            filter.$or = [{ filePattern: filter.filePattern }, { prId: { $in: prIds } }];
            delete filter.filePattern;
          } else {
            filter.prId = { $in: prIds };
          }
        }
      }

      // Query matching learning records, sorted by recency
      const records: LearningRecord[] = await LearningRecordModel
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      if (records.length === 0) return defaultResult;

      // Calculate acceptance rate
      const acceptedCount = records.filter((r) => r.wasAccepted).length;
      const acceptanceRate = records.length > 0 ? acceptedCount / records.length : 0;

      // Get recent accepted and rejected patterns (up to 20 each)
      const recentAccepted = records
        .filter((r) => r.wasAccepted)
        .slice(0, 20)
        .map((r) => `[${r.bugCategory}] ${r.filePattern}`);

      const recentRejected = records
        .filter((r) => !r.wasAccepted)
        .slice(0, 20)
        .map((r) => {
          const note = r.feedbackNotes ? ` — ${r.feedbackNotes.slice(0, 120)}` : '';
          return `[${r.bugCategory}] ${r.filePattern}${note}`;
        });

      // Generate area-specific notes: common rejection reasons
      const rejectedRecords = records.filter((r) => !r.wasAccepted && r.feedbackNotes);
      let areaSpecificNotes = '';

      if (rejectedRecords.length > 0) {
        // Count rejection categories
        const categoryCounts: Record<string, number> = {};
        for (const r of rejectedRecords) {
          categoryCounts[r.bugCategory] = (categoryCounts[r.bugCategory] || 0) + 1;
        }

        const topRejectionCategories = Object.entries(categoryCounts)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 3)
          .map(([cat, count]) => `${cat} (${count}x)`);

        areaSpecificNotes = `Acceptance rate: ${(acceptanceRate * 100).toFixed(0)}%. `;
        areaSpecificNotes += `Most common rejection categories: ${topRejectionCategories.join(', ')}. `;

        // Include the most recent rejection feedback as a concrete example
        const latestRejection = rejectedRecords[0];
        if (latestRejection?.feedbackNotes) {
          areaSpecificNotes += `Latest rejection feedback: "${latestRejection.feedbackNotes.slice(0, 200)}"`;
        }
      } else {
        areaSpecificNotes = `Acceptance rate: ${(acceptanceRate * 100).toFixed(0)}% across ${records.length} PR(s). No rejection feedback recorded.`;
      }

      return { acceptanceRate, recentAccepted, recentRejected, areaSpecificNotes };
    } catch (err) {
      console.error('[LearningEngine] Failed to get learning context:', err);
      return defaultResult;
    }
  }

  /**
   * Get overall learning metrics for the dashboard.
   *
   * Aggregates from the learning_records collection:
   *   1. Total PRs, accepted count, rejected count, acceptance rate
   *   2. By-category breakdown
   *   3. By-verification-method breakdown
   *   4. Recent trend (last 30 days, grouped by day)
   *   5. Top accepted and rejected patterns
   */
  async getMetrics(): Promise<LearningMetrics> {
    const emptyMetrics: LearningMetrics = {
      totalPRs: 0,
      acceptedCount: 0,
      rejectedCount: 0,
      acceptanceRate: 0,
      byCategory: [],
      byVerificationMethod: [],
      recentTrend: [],
      topPatterns: { accepted: [], rejected: [] },
    };

    if (!LearningRecordModel) return emptyMetrics;

    try {
      // --- 1. Overall counts ---
      const allRecords: LearningRecord[] = await LearningRecordModel.find().lean();

      if (allRecords.length === 0) return emptyMetrics;

      const totalPRs = allRecords.length;
      const acceptedCount = allRecords.filter((r) => r.wasAccepted).length;
      const rejectedCount = totalPRs - acceptedCount;
      const acceptanceRate = totalPRs > 0 ? acceptedCount / totalPRs : 0;

      // --- 2. By category ---
      const categoryMap = new Map<string, { total: number; accepted: number }>();
      for (const r of allRecords) {
        const entry = categoryMap.get(r.bugCategory) ?? { total: 0, accepted: 0 };
        entry.total++;
        if (r.wasAccepted) entry.accepted++;
        categoryMap.set(r.bugCategory, entry);
      }

      const byCategory = Array.from(categoryMap.entries())
        .map(([category, stats]) => ({
          category,
          total: stats.total,
          accepted: stats.accepted,
          rate: stats.total > 0 ? stats.accepted / stats.total : 0,
        }))
        .sort((a, b) => b.total - a.total);

      // --- 3. By verification method ---
      const methodMap = new Map<string, { total: number; accepted: number }>();
      for (const r of allRecords) {
        const entry = methodMap.get(r.verificationMethod) ?? { total: 0, accepted: 0 };
        entry.total++;
        if (r.wasAccepted) entry.accepted++;
        methodMap.set(r.verificationMethod, entry);
      }

      const byVerificationMethod = Array.from(methodMap.entries())
        .map(([method, stats]) => ({
          method,
          total: stats.total,
          accepted: stats.accepted,
          rate: stats.total > 0 ? stats.accepted / stats.total : 0,
        }))
        .sort((a, b) => b.total - a.total);

      // --- 4. Recent trend (last 30 days, grouped by day) ---
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const recentRecords = allRecords.filter((r) => new Date(r.createdAt) >= thirtyDaysAgo);

      const dayMap = new Map<string, { accepted: number; rejected: number }>();
      for (const r of recentRecords) {
        const dateKey = new Date(r.createdAt).toISOString().slice(0, 10); // YYYY-MM-DD
        const entry = dayMap.get(dateKey) ?? { accepted: 0, rejected: 0 };
        if (r.wasAccepted) {
          entry.accepted++;
        } else {
          entry.rejected++;
        }
        dayMap.set(dateKey, entry);
      }

      const recentTrend = Array.from(dayMap.entries())
        .map(([date, counts]) => ({ date, ...counts }))
        .sort((a, b) => a.date.localeCompare(b.date));

      // --- 5. Top patterns ---
      // Count occurrences of (category + filePattern) for accepted and rejected
      const acceptedPatternCounts = new Map<string, number>();
      const rejectedPatternCounts = new Map<string, number>();

      for (const r of allRecords) {
        const patternKey = `[${r.bugCategory}] ${r.filePattern}`;
        if (r.wasAccepted) {
          acceptedPatternCounts.set(patternKey, (acceptedPatternCounts.get(patternKey) ?? 0) + 1);
        } else {
          rejectedPatternCounts.set(patternKey, (rejectedPatternCounts.get(patternKey) ?? 0) + 1);
        }
      }

      const topAccepted = Array.from(acceptedPatternCounts.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([pattern]) => pattern);

      const topRejected = Array.from(rejectedPatternCounts.entries())
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([pattern]) => pattern);

      return {
        totalPRs,
        acceptedCount,
        rejectedCount,
        acceptanceRate,
        byCategory,
        byVerificationMethod,
        recentTrend,
        topPatterns: { accepted: topAccepted, rejected: topRejected },
      };
    } catch (err) {
      console.error('[LearningEngine] Failed to compute metrics:', err);
      return emptyMetrics;
    }
  }

  /**
   * Categorize a bug report into a category string using heuristics.
   *
   * Examines the bug's pattern text, suspected root cause, evidence,
   * affected file paths, and verification method to pick the best category.
   */
  private categorizeBug(bugReport: BugReport): string {
    // Combine all text signals for keyword matching
    const signals = [
      bugReport.pattern,
      bugReport.suspectedRootCause,
      bugReport.evidence,
      ...(bugReport.affectedFiles || []),
    ]
      .join(' ')
      .toLowerCase();

    // Score each category by counting keyword matches
    let bestCategory: BugCategory = 'other';
    let bestScore = 0;

    for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS) as [BugCategory, string[]][]) {
      let score = 0;
      for (const keyword of keywords) {
        if (signals.includes(keyword)) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestCategory = category;
      }
    }

    // Special case: if the verification method is a good signal, use it to break ties
    if (bestScore === 0) {
      const method = bugReport.verificationResult?.method;
      if (method === 'log-correlation') return 'observability';
      if (method === 'code-review') return 'logic-error';
    }

    return bestCategory;
  }

  /**
   * Extract a glob-style file pattern from affected files.
   *
   * Finds the longest common directory prefix shared by all files
   * and returns it as a glob pattern (e.g., "features/auth/**").
   * If there's only one file, returns its directory pattern.
   */
  private extractFilePattern(files: string[]): string {
    if (!files || files.length === 0) return '**';

    // Normalize: strip leading slashes and 'src/' prefix for cleaner patterns
    const normalized = files.map((f) => f.replace(/^\/+/, '').replace(/^src\//, ''));

    if (normalized.length === 1) {
      // Single file: return its directory as a pattern
      const parts = normalized[0].split('/');
      if (parts.length <= 1) return '**';
      return parts.slice(0, -1).join('/') + '/**';
    }

    // Multiple files: find the longest common prefix by directory segments
    const splitPaths = normalized.map((f) => f.split('/'));
    const minLength = Math.min(...splitPaths.map((p) => p.length));

    const commonParts: string[] = [];
    for (let i = 0; i < minLength; i++) {
      const segment = splitPaths[0][i];
      if (splitPaths.every((p) => p[i] === segment)) {
        commonParts.push(segment);
      } else {
        break;
      }
    }

    if (commonParts.length === 0) return '**';

    // Don't include the filename part in the pattern
    // If the common prefix IS a full file path (all segments match), use its directory
    const pattern = commonParts.join('/');

    // Check if the pattern is a file (has an extension in the last segment)
    const lastSegment = commonParts[commonParts.length - 1];
    if (lastSegment.includes('.')) {
      // Common prefix is a file path — use its parent directory
      return commonParts.slice(0, -1).join('/') + '/**' || '**';
    }

    return pattern + '/**';
  }

  /**
   * Compute a confidence score (0-1) for the learning record based on
   * the verification method and whether verification actually confirmed the bug.
   */
  private computeConfidence(bugReport: BugReport): number {
    if (!bugReport.verificationResult) return 0.3;

    const { method, confirmed } = bugReport.verificationResult;

    if (!confirmed) return 0.2;

    // Higher confidence for stronger verification methods
    switch (method) {
      case 'failing-test':
        return 0.95;
      case 'reproduction':
        return 0.9;
      case 'data-check':
        return 0.8;
      case 'log-correlation':
        return 0.7;
      case 'code-review':
        return 0.6;
      default:
        return 0.5;
    }
  }
}

export const learningEngine = new LearningEngine();
