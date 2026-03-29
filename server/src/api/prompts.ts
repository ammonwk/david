import { Router } from 'express';
import { PromptTemplateModel } from '../db/models.js';
import { getDefaultTemplateBody } from '../agents/prompt-templates.js';
import type { PromptType, UpdatePromptTemplateRequest } from 'david-shared';

const VALID_TYPES: PromptType[] = ['log-analysis', 'audit', 'verify', 'fix', 'pr-description'];

const router = Router();

// GET /api/prompts — list all prompt templates
router.get('/', async (_req, res) => {
  try {
    const templates = await PromptTemplateModel.find().lean();
    res.json(templates);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prompts/:id — get a single prompt template
router.get('/:id', async (req, res) => {
  try {
    const id = req.params.id as PromptType;
    if (!VALID_TYPES.includes(id)) {
      return res.status(400).json({ error: `Invalid prompt type: ${id}` });
    }

    const template = await PromptTemplateModel.findById(id).lean();
    if (!template) return res.status(404).json({ error: 'Template not found' });

    res.json(template);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/prompts/:id — update a prompt template body (creates a new version)
router.put('/:id', async (req, res) => {
  try {
    const id = req.params.id as PromptType;
    if (!VALID_TYPES.includes(id)) {
      return res.status(400).json({ error: `Invalid prompt type: ${id}` });
    }

    const { body, changeDescription } = req.body as UpdatePromptTemplateRequest;
    if (!body || typeof body !== 'string') {
      return res.status(400).json({ error: 'body is required and must be a string' });
    }

    const existing = await PromptTemplateModel.findById(id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    // Determine next version number
    const maxVersion = existing.versions.reduce((max, v) => Math.max(max, v.version), 0);
    const nextVersion = maxVersion + 1;

    const now = new Date();

    // Push current body as a new version and update the active body
    existing.versions.push({
      version: nextVersion,
      body,
      editedAt: now,
      changeDescription: changeDescription || undefined,
    });

    existing.body = body;
    existing.updatedAt = now;

    await existing.save();

    res.json(existing.toObject());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prompts/:id/revert — revert to a specific version
router.post('/:id/revert', async (req, res) => {
  try {
    const id = req.params.id as PromptType;
    if (!VALID_TYPES.includes(id)) {
      return res.status(400).json({ error: `Invalid prompt type: ${id}` });
    }

    const { version } = req.body as { version: number };
    if (typeof version !== 'number') {
      return res.status(400).json({ error: 'version is required and must be a number' });
    }

    const existing = await PromptTemplateModel.findById(id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const targetVersion = existing.versions.find(v => v.version === version);
    if (!targetVersion) {
      return res.status(404).json({ error: `Version ${version} not found` });
    }

    const maxVersion = existing.versions.reduce((max, v) => Math.max(max, v.version), 0);
    const now = new Date();

    // Create a new version entry for the revert
    existing.versions.push({
      version: maxVersion + 1,
      body: targetVersion.body,
      editedAt: now,
      changeDescription: `Reverted to version ${version}`,
    });

    existing.body = targetVersion.body;
    existing.updatedAt = now;

    await existing.save();

    res.json(existing.toObject());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/prompts/:id/reset — reset to hardcoded default
router.post('/:id/reset', async (req, res) => {
  try {
    const id = req.params.id as PromptType;
    if (!VALID_TYPES.includes(id)) {
      return res.status(400).json({ error: `Invalid prompt type: ${id}` });
    }

    const existing = await PromptTemplateModel.findById(id);
    if (!existing) return res.status(404).json({ error: 'Template not found' });

    const defaultBody = getDefaultTemplateBody(id);
    const maxVersion = existing.versions.reduce((max, v) => Math.max(max, v.version), 0);
    const now = new Date();

    existing.versions.push({
      version: maxVersion + 1,
      body: defaultBody,
      editedAt: now,
      changeDescription: 'Reset to default',
    });

    existing.body = defaultBody;
    existing.updatedAt = now;

    await existing.save();

    res.json(existing.toObject());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
