/**
 * MiroFish API Client
 *
 * Connects CashClaw to a MiroFish swarm intelligence instance for
 * task feasibility prediction, pricing optimization, and competitive simulation.
 *
 * All calls have a 10s timeout and fail gracefully — CashClaw operates
 * normally if MiroFish is unavailable.
 */

const MIROFISH_TIMEOUT_MS = 10_000;

export interface MiroPrediction {
  recommendedPriceEth: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  riskFactors: string[];
  acceptanceProbability: number; // 0–1
}

export interface MiroStrategy {
  approach: string;
  qualityThreshold: string;
  revisionRisk: "high" | "medium" | "low";
  keyConsiderations: string[];
}

export interface MiroFeedbackResult {
  divergence: number; // 0–1, how far actual was from predicted
  insight: string;
  adjustments: string[];
}

function getBaseUrl(): string | null {
  return process.env.MIROFISH_API_URL || null;
}

function getApiKey(): string | null {
  return process.env.MIROFISH_API_KEY || null;
}

export function isMiroFishAvailable(): boolean {
  return getBaseUrl() !== null;
}

async function miroFetch<T>(path: string, body: unknown): Promise<T | null> {
  const baseUrl = getBaseUrl();
  if (!baseUrl) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MIROFISH_TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiKey = getApiKey();
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Pre-Quote: Predict optimal pricing and acceptance probability for a task.
 *
 * Uses MiroFish's conceptual framework:
 * 1. Seed: task description + market context
 * 2. Agents: our agent, competitor archetypes, client
 * 3. Simulate: pricing scenarios
 * 4. Output: recommended bid + confidence
 */
export async function predictTaskFeasibility(
  taskDescription: string,
  category: string | undefined,
  budgetWei: string | undefined,
  specialties: string[],
  baseRateEth: string,
  maxRateEth: string,
): Promise<MiroPrediction | null> {
  return miroFetch<MiroPrediction>("/api/predict/task-feasibility", {
    seed: {
      taskDescription,
      category,
      budgetWei,
    },
    agentContext: {
      specialties,
      baseRateEth,
      maxRateEth,
    },
    simulationConfig: {
      scenarios: ["optimistic", "baseline", "pessimistic"],
      agentCount: 4, // us + 3 competitor archetypes
    },
  });
}

/**
 * Pre-Work: Get strategic recommendations before executing a task.
 *
 * Simulates delivery approaches and identifies revision risk factors.
 */
export async function getWorkStrategy(
  taskDescription: string,
  clientMessages: Array<{ role: string; content: string }>,
  specialties: string[],
): Promise<MiroStrategy | null> {
  return miroFetch<MiroStrategy>("/api/predict/work-strategy", {
    seed: {
      taskDescription,
      clientMessages,
    },
    agentContext: {
      specialties,
    },
    simulationConfig: {
      focus: "delivery_quality",
    },
  });
}

/**
 * Post-Completion: Feed actual outcome back to improve future predictions.
 *
 * Compares MiroFish's prediction against real results to calibrate the model.
 */
export async function reportOutcome(
  taskDescription: string,
  quotedPriceEth: string,
  actualScore: number,
  clientComment: string,
  wasRevised: boolean,
): Promise<MiroFeedbackResult | null> {
  return miroFetch<MiroFeedbackResult>("/api/predict/report-outcome", {
    outcome: {
      taskDescription,
      quotedPriceEth,
      actualScore,
      clientComment,
      wasRevised,
    },
  });
}
