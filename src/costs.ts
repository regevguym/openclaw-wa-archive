/**
 * LLM cost tracking — hooks into llm_output to capture token usage per session.
 * 
 * Strategy:
 * - llm_output fires after every LLM call with usage data
 * - We accumulate usage per session (keyed by sessionKey)
 * - When message_sending fires (outbound reply), we attach the accumulated
 *   usage to the most recent outbound message for that session
 * - This gives us per-message cost attribution
 */

import { getDb } from './db';

// Model pricing table (per 1M tokens, USD)
// Updated: 2026-04-05
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead?: number }> = {
  // Anthropic
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 },
  'claude-haiku-3-5': { input: 0.8, output: 4, cacheRead: 0.08 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-5.1-codex': { input: 2, output: 8 },
  // Google
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
};

interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  costUsd: number;
  provider: string;
  model: string;
  turnCount: number;
}

// Accumulated usage per session (cleared after attaching to outbound message)
const sessionUsageMap = new Map<string, SessionUsage>();

/**
 * Normalize model name for pricing lookup.
 * Strips provider prefix and version suffixes to match pricing table keys.
 */
function normalizeModelForPricing(model: string): string | null {
  // Strip provider prefix (e.g., "anthropic/claude-opus-4-6" -> "claude-opus-4-6")
  const bare = model.includes('/') ? model.split('/').pop()! : model;

  // Try exact match first
  if (MODEL_PRICING[bare]) return bare;

  // Strip trailing version numbers (e.g., "claude-opus-4-6" -> "claude-opus-4")
  const stripped = bare.replace(/-\d+$/, '');
  if (MODEL_PRICING[stripped]) return stripped;

  // Try progressively shorter matches
  const parts = bare.split('-');
  for (let i = parts.length - 1; i >= 2; i--) {
    const candidate = parts.slice(0, i).join('-');
    if (MODEL_PRICING[candidate]) return candidate;
  }

  return null;
}

/**
 * Calculate cost in USD for a given usage and model.
 */
function calculateCost(
  usage: { input?: number; output?: number; cacheRead?: number },
  model: string
): number {
  const pricingKey = normalizeModelForPricing(model);
  if (!pricingKey) return 0;

  const pricing = MODEL_PRICING[pricingKey];
  const inputCost = ((usage.input || 0) / 1_000_000) * pricing.input;
  const outputCost = ((usage.output || 0) / 1_000_000) * pricing.output;
  const cacheCost = pricing.cacheRead
    ? ((usage.cacheRead || 0) / 1_000_000) * pricing.cacheRead
    : 0;

  return inputCost + outputCost + cacheCost;
}

/**
 * Handle llm_output event — accumulate usage for the session.
 */
export function handleLlmOutput(
  event: {
    runId: string;
    sessionId: string;
    provider: string;
    model: string;
    assistantTexts: string[];
    usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  },
  ctx: { sessionKey?: string; sessionId?: string }
): void {
  const sessionKey = ctx.sessionKey;
  if (!sessionKey) return;

  const usage = event.usage;
  if (!usage) return;

  const costUsd = calculateCost(usage, event.model);
  const existing = sessionUsageMap.get(sessionKey);

  if (existing) {
    existing.input += usage.input || 0;
    existing.output += usage.output || 0;
    existing.cacheRead += usage.cacheRead || 0;
    existing.cacheWrite += usage.cacheWrite || 0;
    existing.total += usage.total || 0;
    existing.costUsd += costUsd;
    existing.provider = event.provider;
    existing.model = event.model;
    existing.turnCount++;
  } else {
    sessionUsageMap.set(sessionKey, {
      input: usage.input || 0,
      output: usage.output || 0,
      cacheRead: usage.cacheRead || 0,
      cacheWrite: usage.cacheWrite || 0,
      total: usage.total || 0,
      costUsd,
      provider: event.provider,
      model: event.model,
      turnCount: 1,
    });
  }
}

/**
 * Consume accumulated usage for a session (called when outbound message is stored).
 * Returns the accumulated usage and clears it.
 */
export function consumeSessionUsage(sessionKey: string): SessionUsage | null {
  const usage = sessionUsageMap.get(sessionKey);
  if (!usage) return null;
  sessionUsageMap.delete(sessionKey);
  return usage;
}

/**
 * Get current accumulated usage for a session (without consuming).
 */
export function peekSessionUsage(sessionKey: string): SessionUsage | null {
  return sessionUsageMap.get(sessionKey) || null;
}

/**
 * Attach accumulated usage to the most recent outbound message for a session.
 * Called after an outbound message is inserted into the DB.
 */
export function attachUsageToMessage(messageId: string, sessionKey: string): void {
  const usage = consumeSessionUsage(sessionKey);
  if (!usage) return;

  try {
    const sql = `
      UPDATE messages SET
        input_tokens = @input_tokens,
        output_tokens = @output_tokens,
        cache_read_tokens = @cache_read_tokens,
        cache_write_tokens = @cache_write_tokens,
        total_tokens = @total_tokens,
        cost_usd = @cost_usd
      WHERE id = @id
    `;
    getDb().prepare(sql).run({
      id: messageId,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cacheRead,
      cache_write_tokens: usage.cacheWrite,
      total_tokens: usage.total,
      cost_usd: usage.costUsd,
    });
  } catch (err) {
    console.error('[wa-archive] Error attaching usage to message:', err);
  }
}
