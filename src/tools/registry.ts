import type { ToolDefinition } from "../llm/types.js";
import type { CashClawConfig } from "../config.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { runQAReview } from "../qa/reviewer.js";
import { recordQAResult } from "../qa/metrics.js";
import { structuredLog } from "../log.js";
import {
  readTask,
  quoteTask,
  declineTask,
  submitWork,
  sendMessage,
  listBounties,
  claimBounty,
} from "./marketplace.js";
import {
  checkWalletBalance,
  readFeedbackHistory,
  memorySearch,
  logActivity,
} from "./utility.js";
import { agentcashFetch, agentcashBalance } from "./agentcash.js";
import { predictOutcome, simulateApproach } from "./mirofish.js";
import { browsePage, browserInteract, browserScreenshot } from "./browser.js";
import { isMiroFishAvailable } from "../mirofish/client.js";
import { isBrowserAvailable } from "../config.js";
import { moltbookRead, moltbookPost } from "./moltbook.js";
import { isMoltbookAvailable } from "../moltbook/client.js";

const BASE_TOOLS: Tool[] = [
  readTask,
  quoteTask,
  declineTask,
  submitWork,
  sendMessage,
  listBounties,
  claimBounty,
  checkWalletBalance,
  readFeedbackHistory,
  memorySearch,
  logActivity,
];

const AGENTCASH_TOOLS: Tool[] = [
  agentcashFetch,
  agentcashBalance,
];

const MIROFISH_TOOLS: Tool[] = [
  predictOutcome,
  simulateApproach,
];

const BROWSER_TOOLS: Tool[] = [
  browsePage,
  browserInteract,
  browserScreenshot,
];

const MOLTBOOK_TOOLS: Tool[] = [
  moltbookRead,
  moltbookPost,
];

// Memoize by config reference to avoid rebuilding on every tool call
let cachedConfig: CashClawConfig | null = null;
let cachedToolMap: Map<string, Tool> | null = null;

function buildToolMap(config: CashClawConfig): Map<string, Tool> {
  if (cachedConfig === config && cachedToolMap) return cachedToolMap;
  let tools = [...BASE_TOOLS];
  if (config.agentCashEnabled) {
    tools = [...tools, ...AGENTCASH_TOOLS];
  }
  if (isMiroFishAvailable()) {
    tools = [...tools, ...MIROFISH_TOOLS];
  }
  if (config.browserEnabled && isBrowserAvailable()) {
    tools = [...tools, ...BROWSER_TOOLS];
  }
  if (config.moltbookEnabled && isMoltbookAvailable()) {
    tools = [...tools, ...MOLTBOOK_TOOLS];
  }
  cachedToolMap = new Map(tools.map((t) => [t.definition.name, t]));
  cachedConfig = config;
  return cachedToolMap;
}

export function getToolDefinitions(config: CashClawConfig): ToolDefinition[] {
  const toolMap = buildToolMap(config);
  return [...toolMap.values()].map((t) => t.definition);
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const toolMap = buildToolMap(ctx.config);
  const tool = toolMap.get(name);
  if (!tool) {
    return { success: false, data: `Unknown tool: ${name}` };
  }

  try {
    // QA gate: intercept submit_work to review deliverable before submission
    if (name === "submit_work" && ctx.config.qaReviewEnabled !== false) {
      const deliverable = input.result as string;
      const taskId = input.task_id as string;

      if (deliverable && taskId) {
        try {
          const review = await runQAReview(
            ctx.config,
            ctx.taskDescription ?? `Task ${taskId}`,
            deliverable,
          );

          recordQAResult({
            taskId,
            approved: review.approved,
            score: review.score,
            revisedAndApproved: false,
            timestamp: Date.now(),
          });

          structuredLog("info", "qa.review", {
            taskId,
            approved: review.approved,
            score: review.score,
          });

          if (!review.approved) {
            return {
              success: false,
              data: `QA Review REJECTED (score: ${review.score}/5). Revise before submitting:\n\n${review.feedback}\n\nAddress the feedback above and call submit_work again with the improved deliverable.`,
            };
          }
        } catch (err) {
          // QA failure is non-fatal — submit anyway (fail-open)
          const msg = err instanceof Error ? err.message : String(err);
          structuredLog("warn", "qa.error", { taskId, error: msg });
        }
      }
    }

    return await tool.execute(input, ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, data: `Tool error: ${msg}` };
  }
}
