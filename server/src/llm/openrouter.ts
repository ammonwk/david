import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface CompletionResult {
  content: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  model: string;
  costEstimate: number;
}

interface CostTracker {
  totalCalls: number;
  totalTokens: number;
  totalCost: number;
  byModel: Record<string, { calls: number; tokens: number; cost: number }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** Rough per-token pricing (USD) sourced from OpenRouter model pages. */
const MODEL_PRICING: Record<string, { prompt: number; completion: number }> = {
  'google/gemini-3.1-pro-preview':        { prompt: 1.25 / 1_000_000, completion: 10.0 / 1_000_000 },
  'google/gemini-3.1-flash-lite-preview':  { prompt: 0.0 / 1_000_000,  completion: 0.0 / 1_000_000 },
};

/** Default fallback pricing when a model is not in the table above. */
const DEFAULT_PRICING = { prompt: 1.0 / 1_000_000, completion: 3.0 / 1_000_000 };

const RETRYABLE_STATUS_CODES = new Set([429, 502, 503, 529]);

// ---------------------------------------------------------------------------
// Singleton cost tracker
// ---------------------------------------------------------------------------

const costTracker: CostTracker = {
  totalCalls: 0,
  totalTokens: 0,
  totalCost: 0,
  byModel: {},
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  return promptTokens * pricing.prompt + completionTokens * pricing.completion;
}

function updateCostTracker(model: string, tokens: number, cost: number): void {
  costTracker.totalCalls += 1;
  costTracker.totalTokens += tokens;
  costTracker.totalCost += cost;

  if (!costTracker.byModel[model]) {
    costTracker.byModel[model] = { calls: 0, tokens: 0, cost: 0 };
  }
  costTracker.byModel[model].calls += 1;
  costTracker.byModel[model].tokens += tokens;
  costTracker.byModel[model].cost += cost;
}

// ---------------------------------------------------------------------------
// Core completion
// ---------------------------------------------------------------------------

export async function complete(
  messages: ChatMessage[],
  model: string,
  options?: {
    temperature?: number;
    maxTokens?: number;
    responseFormat?: { type: 'json_object' };
  },
): Promise<CompletionResult> {
  const apiKey = config.openrouterApiKey;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const body: Record<string, unknown> = {
    model,
    messages,
  };
  if (options?.temperature !== undefined) body.temperature = options.temperature;
  if (options?.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options?.responseFormat) body.response_format = options.responseFormat;

  const startMs = Date.now();

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://david-sre.local',
      'X-Title': 'David AI SRE',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '<unreadable>');
    const err = new Error(
      `OpenRouter API error ${response.status}: ${errorBody}`,
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const data = await response.json() as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };

  const content = data.choices?.[0]?.message?.content ?? '';
  const promptTokens = data.usage?.prompt_tokens ?? 0;
  const completionTokens = data.usage?.completion_tokens ?? 0;
  const totalTokens = data.usage?.total_tokens ?? (promptTokens + completionTokens);
  const returnedModel = data.model ?? model;

  const latencyMs = Date.now() - startMs;
  const costEstimate = estimateCost(model, promptTokens, completionTokens);

  updateCostTracker(returnedModel, totalTokens, costEstimate);

  console.log(
    `[OpenRouter] model=${returnedModel} tokens=${totalTokens} ` +
    `(prompt=${promptTokens} completion=${completionTokens}) ` +
    `cost=$${costEstimate.toFixed(6)} latency=${latencyMs}ms`,
  );

  return { content, usage: { promptTokens, completionTokens, totalTokens }, model: returnedModel, costEstimate };
}

// ---------------------------------------------------------------------------
// Completion with retry
// ---------------------------------------------------------------------------

export async function completeWithRetry(
  messages: ChatMessage[],
  model: string,
  options?: {
    temperature?: number;
    maxTokens?: number;
    responseFormat?: { type: 'json_object' };
    maxRetries?: number;
  },
): Promise<CompletionResult> {
  const maxRetries = options?.maxRetries ?? 3;
  const { maxRetries: _stripped, ...completionOptions } = options ?? {};

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await complete(messages, model, completionOptions);
    } catch (err: unknown) {
      lastError = err;

      const status = (err as { status?: number }).status;
      const isRetryable =
        (status !== undefined && RETRYABLE_STATUS_CODES.has(status)) ||
        (err instanceof TypeError); // network errors surface as TypeError in fetch

      if (!isRetryable || attempt === maxRetries) {
        throw err;
      }

      const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
      console.log(
        `[OpenRouter] Retry ${attempt}/${maxRetries} for ${model} ` +
        `after ${status ?? 'network'} error — waiting ${backoffMs}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  // Should be unreachable, but satisfies the type checker
  throw lastError;
}

// ---------------------------------------------------------------------------
// Model-specific helpers
// ---------------------------------------------------------------------------

/** Complete with Gemini Pro — used for L1 topology discovery. */
export async function completeWithGeminiPro(
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<CompletionResult> {
  return completeWithRetry(messages, config.geminiProModel, options);
}

/** Complete with Gemini Flash Lite — used for L2/L3 topology discovery. */
export async function completeWithGeminiFlash(
  messages: ChatMessage[],
  options?: { temperature?: number; maxTokens?: number },
): Promise<CompletionResult> {
  return completeWithRetry(messages, config.geminiFlashModel, options);
}

// ---------------------------------------------------------------------------
// Cost tracking accessors
// ---------------------------------------------------------------------------

export function getCostStats(): CostTracker {
  return { ...costTracker, byModel: { ...costTracker.byModel } };
}

export function resetCostStats(): void {
  costTracker.totalCalls = 0;
  costTracker.totalTokens = 0;
  costTracker.totalCost = 0;
  costTracker.byModel = {};
}

// Re-export types for consumers
export type { ChatMessage, CompletionResult, CostTracker };
