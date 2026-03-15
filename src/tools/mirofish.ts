/**
 * MiroFish Tools
 *
 * Two tools the LLM can call mid-task to query MiroFish predictions:
 * - predict_outcome: predict likely outcome of a pricing/delivery decision
 * - simulate_approach: test a work strategy before committing
 */

import type { Tool, ToolResult, ToolContext } from "./types.js";
import {
  isMiroFishAvailable,
  predictTaskFeasibility,
  getWorkStrategy,
} from "../mirofish/client.js";

export const predictOutcome: Tool = {
  definition: {
    name: "predict_outcome",
    description:
      "Query MiroFish swarm intelligence to predict the likely outcome of a pricing or delivery decision. " +
      "Use this before quoting to get data-backed pricing recommendations, or to assess task feasibility. " +
      "Only available when MiroFish is connected.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_description: {
          type: "string",
          description: "The task description to analyze",
        },
        category: {
          type: "string",
          description: "Task category (optional)",
        },
      },
      required: ["task_description"],
    },
  },

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!isMiroFishAvailable()) {
      return {
        success: false,
        data: "MiroFish is not connected. Set MIROFISH_API_URL to enable predictions.",
      };
    }

    const taskDesc = input.task_description as string;
    const category = input.category as string | undefined;

    const prediction = await predictTaskFeasibility(
      taskDesc,
      category,
      undefined,
      ctx.config.specialties,
      ctx.config.pricing.baseRateEth,
      ctx.config.pricing.maxRateEth,
    );

    if (!prediction) {
      return {
        success: false,
        data: "MiroFish prediction unavailable — service may be down or timed out.",
      };
    }

    return {
      success: true,
      data: JSON.stringify({
        recommendedPrice: `${prediction.recommendedPriceEth} ETH`,
        confidence: prediction.confidence,
        acceptanceProbability: `${Math.round(prediction.acceptanceProbability * 100)}%`,
        reasoning: prediction.reasoning,
        riskFactors: prediction.riskFactors,
      }, null, 2),
    };
  },
};

export const simulateApproach: Tool = {
  definition: {
    name: "simulate_approach",
    description:
      "Use MiroFish to simulate a work strategy before committing. " +
      "Returns quality thresholds, revision risk assessment, and key considerations. " +
      "Call this when you want to plan your approach for a complex task.",
    input_schema: {
      type: "object" as const,
      properties: {
        task_description: {
          type: "string",
          description: "The task to simulate",
        },
        client_messages: {
          type: "string",
          description: "Summary of client requirements and messages",
        },
      },
      required: ["task_description"],
    },
  },

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!isMiroFishAvailable()) {
      return {
        success: false,
        data: "MiroFish is not connected. Set MIROFISH_API_URL to enable simulations.",
      };
    }

    const taskDesc = input.task_description as string;
    const clientSummary = (input.client_messages as string) ?? "";

    const strategy = await getWorkStrategy(
      taskDesc,
      clientSummary ? [{ role: "client", content: clientSummary }] : [],
      ctx.config.specialties,
    );

    if (!strategy) {
      return {
        success: false,
        data: "MiroFish strategy unavailable — service may be down or timed out.",
      };
    }

    return {
      success: true,
      data: JSON.stringify({
        approach: strategy.approach,
        qualityThreshold: strategy.qualityThreshold,
        revisionRisk: strategy.revisionRisk,
        keyConsiderations: strategy.keyConsiderations,
      }, null, 2),
    };
  },
};
