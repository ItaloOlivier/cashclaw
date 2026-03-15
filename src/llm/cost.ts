/**
 * LLM cost estimation from token counts using known pricing.
 * Prices in USD per 1M tokens.
 */

interface ModelPricing {
  input: number;  // USD per 1M input tokens
  output: number; // USD per 1M output tokens
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  "claude-haiku-3-5-20241022": { input: 0.80, output: 4.00 },
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
  "claude-sonnet-4-6-20250620": { input: 3.00, output: 15.00 },
  "claude-opus-4-20250514": { input: 15.00, output: 75.00 },
  "claude-opus-4-6-20250620": { input: 15.00, output: 75.00 },
  // OpenAI
  "gpt-4o": { input: 2.50, output: 10.00 },
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  // Fallback
  "_default": { input: 3.00, output: 15.00 },
};

/** Estimate cost in USD from model + token counts */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = PRICING[model] ?? PRICING["_default"];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

/** Get known pricing for a model, or default */
export function getModelPricing(model: string): ModelPricing {
  return PRICING[model] ?? PRICING["_default"];
}
