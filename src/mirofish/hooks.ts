/**
 * MiroFish Integration Hooks
 *
 * Three hooks that connect CashClaw's task lifecycle to MiroFish predictions:
 * 1. preQuoteHook — before quoting a task
 * 2. preWorkHook — before executing work
 * 3. postCompleteHook — after receiving feedback
 *
 * All hooks are non-blocking and fail gracefully.
 */

import type { Task } from "../moltlaunch/types.js";
import type { CashClawConfig } from "../config.js";
import {
  isMiroFishAvailable,
  predictTaskFeasibility,
  getWorkStrategy,
  reportOutcome,
  type MiroPrediction,
  type MiroStrategy,
} from "./client.js";
import { appendLog } from "../memory/log.js";
import { formatEther } from "viem";

export interface PreQuoteResult {
  prediction: MiroPrediction;
  promptInjection: string;
}

export interface PreWorkResult {
  strategy: MiroStrategy;
  promptInjection: string;
}

/**
 * Called before the agent loop runs on a "requested" task.
 * Returns pricing intelligence to inject into the system prompt.
 */
export async function preQuoteHook(
  task: Task,
  config: CashClawConfig,
): Promise<PreQuoteResult | null> {
  if (!isMiroFishAvailable()) return null;

  try {
    const prediction = await predictTaskFeasibility(
      task.task,
      task.category,
      task.budgetWei,
      config.specialties,
      config.pricing.baseRateEth,
      config.pricing.maxRateEth,
    );

    if (!prediction) return null;

    appendLog(
      `MiroFish prediction for ${task.id}: ${prediction.recommendedPriceEth} ETH ` +
      `(${prediction.confidence} confidence, ${Math.round(prediction.acceptanceProbability * 100)}% acceptance)`,
    );

    const promptInjection = formatPreQuotePrompt(prediction, task);
    return { prediction, promptInjection };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLog(`MiroFish preQuoteHook error: ${msg}`);
    return null;
  }
}

/**
 * Called before the agent loop runs on an "accepted" or "revision" task.
 * Returns strategy recommendations to inject into the system prompt.
 */
export async function preWorkHook(
  task: Task,
  config: CashClawConfig,
): Promise<PreWorkResult | null> {
  if (!isMiroFishAvailable()) return null;

  try {
    const clientMessages = (task.messages ?? []).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const strategy = await getWorkStrategy(
      task.task,
      clientMessages,
      config.specialties,
    );

    if (!strategy) return null;

    appendLog(
      `MiroFish strategy for ${task.id}: revision risk=${strategy.revisionRisk}, ` +
      `${strategy.keyConsiderations.length} considerations`,
    );

    const promptInjection = formatPreWorkPrompt(strategy);
    return { strategy, promptInjection };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLog(`MiroFish preWorkHook error: ${msg}`);
    return null;
  }
}

/**
 * Called after a task is completed and rated.
 * Feeds outcome data back to MiroFish to improve future predictions.
 */
export async function postCompleteHook(
  task: Task,
): Promise<void> {
  if (!isMiroFishAvailable()) return;
  if (task.ratedScore === undefined) return;

  try {
    const quotedPriceEth = task.quotedPriceWei
      ? formatEther(BigInt(task.quotedPriceWei))
      : "0";

    const result = await reportOutcome(
      task.task,
      quotedPriceEth,
      task.ratedScore,
      task.ratedComment ?? "",
      (task.revisionCount ?? 0) > 0,
    );

    if (result) {
      appendLog(
        `MiroFish feedback for ${task.id}: divergence=${result.divergence.toFixed(2)}, ` +
        `insight: ${result.insight.slice(0, 100)}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendLog(`MiroFish postCompleteHook error: ${msg}`);
  }
}

// --- Prompt formatting ---

function formatPreQuotePrompt(prediction: MiroPrediction, task: Task): string {
  const budget = task.budgetWei
    ? `Client budget: ${formatEther(BigInt(task.budgetWei))} ETH\n`
    : "";

  return `\n\n## Strategic Intelligence (MiroFish Prediction)

${budget}**Recommended price:** ${prediction.recommendedPriceEth} ETH (${prediction.confidence} confidence)
**Acceptance probability:** ${Math.round(prediction.acceptanceProbability * 100)}%
**Reasoning:** ${prediction.reasoning}

**Risk factors:**
${prediction.riskFactors.map((r) => `- ${r}`).join("\n")}

Use this intelligence to inform your pricing decision. You may deviate if you have strong reasons.`;
}

function formatPreWorkPrompt(strategy: MiroStrategy): string {
  return `\n\n## Strategic Intelligence (MiroFish Strategy)

**Recommended approach:** ${strategy.approach}
**Quality threshold:** ${strategy.qualityThreshold}
**Revision risk:** ${strategy.revisionRisk}

**Key considerations:**
${strategy.keyConsiderations.map((c) => `- ${c}`).join("\n")}

Use this strategy to guide your work. Focus on areas flagged as revision risks.`;
}
