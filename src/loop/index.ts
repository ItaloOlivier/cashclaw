import type { LLMProvider, LLMMessage, LLMResponse, ToolUseBlock, ToolResultBlock } from "../llm/types.js";
import type { CashClawConfig } from "../config.js";
import type { Task } from "../moltlaunch/types.js";
import type { ToolContext } from "../tools/types.js";
import { getToolDefinitions, executeTool } from "../tools/registry.js";
import { buildSystemPrompt } from "./prompt.js";
import { buildTaskContext } from "./context.js";

const DEFAULT_MAX_TURNS = 10;
const DEFAULT_MAX_TOKEN_BUDGET = 100_000;
const DEFAULT_MAX_TOOL_CALLS = 25;
const DEFAULT_MAX_DURATION_MS = 300_000; // 5 minutes

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: string;
  success: boolean;
}

export interface LoopResult {
  toolCalls: ToolCallRecord[];
  reasoning: string;
  turns: number;
  usage: { inputTokens: number; outputTokens: number };
  abortReason?: "token_budget" | "tool_call_limit" | "duration_limit" | "max_tokens_truncated";
}

export async function runAgentLoop(
  llm: LLMProvider,
  task: Task,
  config: CashClawConfig,
  miroContext?: string,
): Promise<LoopResult> {
  const maxTurns = config.maxLoopTurns ?? DEFAULT_MAX_TURNS;
  const maxTokenBudget = config.maxTokenBudget ?? DEFAULT_MAX_TOKEN_BUDGET;
  const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxDurationMs = config.maxTaskDurationMs ?? DEFAULT_MAX_DURATION_MS;
  const startTime = Date.now();

  const tools = getToolDefinitions(config);
  const toolCtx: ToolContext = { config, taskId: task.id };

  // Build system prompt, appending MiroFish strategic intelligence if available
  let systemPrompt = buildSystemPrompt(config, task.task);
  if (miroContext) {
    systemPrompt += miroContext;
  }

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildTaskContext(task) },
  ];

  const allToolCalls: ToolCallRecord[] = [];
  const reasoningParts: string[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  function makeResult(extra?: { abortReason?: LoopResult["abortReason"]; turnCount?: number }): LoopResult {
    return {
      toolCalls: allToolCalls,
      reasoning: reasoningParts.join("\n") + (extra?.abortReason ? `\n[aborted: ${extra.abortReason}]` : ""),
      turns: extra?.turnCount ?? maxTurns,
      usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      abortReason: extra?.abortReason,
    };
  }

  for (let turn = 0; turn < maxTurns; turn++) {
    // Circuit breaker: duration
    if (Date.now() - startTime > maxDurationMs) {
      return makeResult({ abortReason: "duration_limit", turnCount: turn });
    }

    const response: LLMResponse = await llm.chat(messages, tools);
    totalInputTokens += response.usage.inputTokens;
    totalOutputTokens += response.usage.outputTokens;

    // Circuit breaker: token budget
    if (totalInputTokens + totalOutputTokens > maxTokenBudget) {
      return makeResult({ abortReason: "token_budget", turnCount: turn + 1 });
    }

    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) {
        reasoningParts.push(block.text);
      }
    }

    messages.push({ role: "assistant" as const, content: response.content });

    // Handle max_tokens truncation — don't process tool calls from truncated responses
    if (response.stopReason === "max_tokens") {
      reasoningParts.push("[output truncated — max_tokens reached]");
      return makeResult({ abortReason: "max_tokens_truncated", turnCount: turn + 1 });
    }

    if (response.stopReason !== "tool_use") {
      return {
        toolCalls: allToolCalls,
        reasoning: reasoningParts.join("\n"),
        turns: turn + 1,
        usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is ToolUseBlock => b.type === "tool_use",
    );

    const toolResults: ToolResultBlock[] = [];

    for (const block of toolUseBlocks) {
      // Circuit breaker: tool call limit
      if (allToolCalls.length >= maxToolCalls) {
        return makeResult({ abortReason: "tool_call_limit", turnCount: turn + 1 });
      }

      const result = await executeTool(block.name, block.input, toolCtx);

      allToolCalls.push({
        name: block.name,
        input: block.input,
        result: result.data,
        success: result.success,
      });

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: result.data,
        is_error: !result.success,
      });
    }

    messages.push({ role: "user" as const, content: toolResults });
  }

  reasoningParts.push("[max turns reached]");
  return makeResult({ turnCount: maxTurns });
}
