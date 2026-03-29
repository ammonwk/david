// ============================================
// David — AI SRE Tool
// Prompt Template System
//
// Loads editable prompt templates from MongoDB,
// falls back to defaults generated from the
// hardcoded builder functions.  Templates use
// {{variableName}} placeholders for interpolation.
// ============================================

import { PromptTemplateModel } from '../db/models.js';
import {
  buildLogAnalysisPrompt,
  buildAuditAgentPrompt,
  buildVerifyAgentPrompt,
  buildFixAgentPrompt,
  buildPRDescriptionPrompt,
  formatLearningContext,
} from './prompts.js';
import type { LearningContext } from './prompts.js';
import type { PromptType, PromptVariable, PromptTemplate } from 'david-shared';

// ============================================
// Variable definitions per template type
// ============================================

const VARIABLES: Record<PromptType, PromptVariable[]> = {
  'log-analysis': [
    { name: 'timeSpan', description: 'Scan time window (e.g. "1h", "24h")' },
    { name: 'repoPath', description: 'Absolute path to the repository on disk' },
    { name: 'mongoUri', description: 'MongoDB connection URI for data queries' },
    { name: 'sreState', description: 'JSON-formatted current SRE state (known issues, baselines)' },
    { name: 'topologySummary', description: 'Human-readable summary of the codebase topology' },
    { name: 'logData', description: 'Formatted log patterns and raw events from CloudWatch' },
    { name: 'learningSection', description: 'Formatted learning context from past PR outcomes' },
  ],
  audit: [
    { name: 'nodeName', description: 'Name of the topology node being audited' },
    { name: 'nodeDescription', description: 'Description of the topology node' },
    { name: 'nodeId', description: 'Unique ID of the topology node' },
    { name: 'fileList', description: 'Bullet-point list of files in the audit scope' },
    { name: 'repoPath', description: 'Absolute path to the repository on disk' },
    { name: 'mongoUri', description: 'MongoDB connection URI for data queries' },
    { name: 'topologySummary', description: 'Human-readable summary of the codebase topology' },
    { name: 'sreState', description: 'JSON-formatted current SRE state' },
    { name: 'learningSection', description: 'Formatted learning context from past PR outcomes' },
  ],
  verify: [
    { name: 'bugDescription', description: 'Description of the suspected bug' },
    { name: 'fileList', description: 'Bullet-point list of affected files' },
    { name: 'evidence', description: 'Evidence provided by the audit agent' },
    { name: 'repoPath', description: 'Absolute path to the repository on disk' },
    { name: 'mongoUri', description: 'MongoDB connection URI for data queries' },
  ],
  fix: [
    { name: 'bugDescription', description: 'Description of the verified bug and root cause' },
    { name: 'verificationDetails', description: 'Details from the verification step' },
    { name: 'fileList', description: 'Bullet-point list of affected files' },
    { name: 'repoPath', description: 'Absolute path to the repository on disk' },
    { name: 'learningSection', description: 'Formatted learning context from past PR outcomes' },
  ],
  'pr-description': [
    { name: 'bugReport', description: 'Full bug report text' },
    { name: 'verificationDetails', description: 'Verification outcome details' },
    { name: 'commitLog', description: 'Git commit log for the fix branch' },
    { name: 'diff', description: 'Git diff of the fix' },
    { name: 'conversationSection', description: 'Optional agent conversation summary section (include header or leave empty)' },
  ],
};

const TEMPLATE_META: Record<PromptType, { name: string; description: string }> = {
  'log-analysis': {
    name: 'Log Analysis Agent',
    description: 'Analyzes CloudWatch logs, triages patterns, identifies bugs, and optionally applies a fix.',
  },
  audit: {
    name: 'Codebase Audit Agent',
    description: 'Deep-reads a topology node\'s files to find bugs, then verifies and fixes them via sub-agents.',
  },
  verify: {
    name: 'Verification Sub-Agent',
    description: 'Verifies whether a suspected bug is real through tests, log correlation, and data checks.',
  },
  fix: {
    name: 'Fix Sub-Agent',
    description: 'Writes a minimal correct fix for a verified bug, runs tests, opens a PR, and babysits CI.',
  },
  'pr-description': {
    name: 'PR Description Generator',
    description: 'Generates a structured pull request title and body from bug report, verification, and diff data.',
  },
};

// ============================================
// Default template generation
// ============================================

/** Sentinel learning context that produces a recognizable output for replacement. */
const EMPTY_LEARNING: LearningContext = {
  acceptanceRate: 0,
  recentAccepted: [],
  recentRejected: [],
  areaSpecificNotes: '',
};

const FILE_SENTINEL = '{{__FILE_SENTINEL__}}';

/**
 * Generate the default template body for a given prompt type by calling
 * the existing builder with marker values, then replacing computed sections
 * with {{variable}} placeholders.
 */
export function getDefaultTemplateBody(type: PromptType): string {
  const m = (name: string) => `{{${name}}}`;
  const emptyLearningOutput = formatLearningContext(EMPTY_LEARNING);

  switch (type) {
    case 'log-analysis': {
      const raw = buildLogAnalysisPrompt({
        scanConfig: { timeSpan: m('timeSpan') as any, severity: 'all' },
        logData: m('logData'),
        sreState: m('sreState'),
        topologySummary: m('topologySummary'),
        repoPath: m('repoPath'),
        mongoUri: m('mongoUri'),
        learning: EMPTY_LEARNING,
      });
      return raw.replace(emptyLearningOutput, m('learningSection'));
    }

    case 'audit': {
      const raw = buildAuditAgentPrompt({
        node: {
          id: m('nodeId'),
          name: m('nodeName'),
          description: m('nodeDescription'),
          level: 3,
          parentId: null,
          files: [FILE_SENTINEL],
          totalLines: 0,
          children: [],
        },
        topologySummary: m('topologySummary'),
        sreState: m('sreState'),
        repoPath: m('repoPath'),
        mongoUri: m('mongoUri'),
        learning: EMPTY_LEARNING,
      });
      return raw
        .replace(`  - ${FILE_SENTINEL}`, m('fileList'))
        .replace(emptyLearningOutput, m('learningSection'));
    }

    case 'verify': {
      const raw = buildVerifyAgentPrompt({
        bugDescription: m('bugDescription'),
        affectedFiles: [FILE_SENTINEL],
        evidence: m('evidence'),
        repoPath: m('repoPath'),
        mongoUri: m('mongoUri'),
      });
      return raw.replace(`  - ${FILE_SENTINEL}`, m('fileList'));
    }

    case 'fix': {
      const raw = buildFixAgentPrompt({
        bugDescription: m('bugDescription'),
        verificationDetails: m('verificationDetails'),
        affectedFiles: [FILE_SENTINEL],
        repoPath: m('repoPath'),
        learning: EMPTY_LEARNING,
      });
      return raw
        .replace(`  - ${FILE_SENTINEL}`, m('fileList'))
        .replace(emptyLearningOutput, m('learningSection'));
    }

    case 'pr-description': {
      // Generate without conversation summary, then insert the placeholder
      const raw = buildPRDescriptionPrompt({
        diff: m('diff'),
        bugReport: m('bugReport'),
        verificationDetails: m('verificationDetails'),
        commitLog: m('commitLog'),
      });
      // Insert {{conversationSection}} before the Instructions heading
      return raw.replace(
        '\n## Instructions',
        `\n${m('conversationSection')}\n## Instructions`,
      );
    }

    default:
      throw new Error(`Unknown prompt type: ${type}`);
  }
}

// ============================================
// Template interpolation
// ============================================

/**
 * Replace all {{variableName}} placeholders in a template with their values.
 * Unknown placeholders are left as-is.
 */
export function interpolateTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in variables ? variables[key] : match;
  });
}

// ============================================
// DB loading
// ============================================

/**
 * Load a prompt template from MongoDB, falling back to the hardcoded default.
 * Returns the template body (not yet interpolated).
 */
export async function loadTemplateBody(type: PromptType): Promise<string> {
  try {
    const doc = await PromptTemplateModel.findById(type).lean();
    if (doc?.body) return doc.body;
  } catch (err) {
    console.warn(`[prompt-templates] Failed to load template '${type}' from DB, using default:`, err);
  }
  return getDefaultTemplateBody(type);
}

/**
 * Render a prompt: load template from DB (or default), then interpolate variables.
 */
export async function renderPrompt(
  type: PromptType,
  variables: Record<string, string>,
): Promise<string> {
  const template = await loadTemplateBody(type);
  return interpolateTemplate(template, variables);
}

// ============================================
// Seeding
// ============================================

const ALL_PROMPT_TYPES: PromptType[] = ['log-analysis', 'audit', 'verify', 'fix', 'pr-description'];

/**
 * Seed default prompt templates into MongoDB if they don't already exist.
 * Called once during server startup.
 */
export async function seedDefaultPrompts(): Promise<void> {
  for (const type of ALL_PROMPT_TYPES) {
    const existing = await PromptTemplateModel.findById(type);
    if (existing) continue;

    const body = getDefaultTemplateBody(type);
    const meta = TEMPLATE_META[type];
    const vars = VARIABLES[type];
    const now = new Date();

    await PromptTemplateModel.create({
      _id: type,
      name: meta.name,
      description: meta.description,
      body,
      variables: vars,
      versions: [
        {
          version: 1,
          body,
          editedAt: now,
          changeDescription: 'Initial default template',
        },
      ],
      updatedAt: now,
      createdAt: now,
    });

    console.log(`[prompt-templates] Seeded default template: ${type}`);
  }
}

/**
 * Re-export for use in engines.
 */
export { formatLearningContext } from './prompts.js';
export type { LearningContext } from './prompts.js';
