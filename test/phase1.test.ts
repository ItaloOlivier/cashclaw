import { describe, it, expect, vi } from "vitest";
import { validateConfig } from "../src/config.js";
import { runAgentLoop } from "../src/loop/index.js";
import type { LLMProvider, LLMResponse } from "../src/llm/types.js";
import type { Task } from "../src/moltlaunch/types.js";
import type { CashClawConfig } from "../src/config.js";

// Mock the tools registry
vi.mock("../src/tools/registry.js", () => ({
  getToolDefinitions: () => [
    {
      name: "quote_task",
      description: "Submit a price quote",
      input_schema: { type: "object", properties: { task_id: { type: "string" }, price_eth: { type: "string" } }, required: ["task_id", "price_eth"] },
    },
  ],
  executeTool: vi.fn().mockImplementation((name: string, input: Record<string, unknown>) => {
    return Promise.resolve({ success: true, data: `Executed ${name}` });
  }),
}));

const baseConfig: CashClawConfig = {
  agentId: "test-agent",
  llm: { provider: "anthropic", model: "test", apiKey: "test-key" },
  polling: { intervalMs: 30000, urgentIntervalMs: 10000 },
  pricing: { strategy: "fixed", baseRateEth: "0.005", maxRateEth: "0.05" },
  specialties: ["typescript"],
  autoQuote: true,
  autoWork: true,
  maxConcurrentTasks: 3,
  declineKeywords: [],
  learningEnabled: false,
  studyIntervalMs: 1_800_000,
  agentCashEnabled: false,
};

const baseTask: Task = {
  id: "task-1",
  agentId: "test-agent",
  clientAddress: "0x1234",
  task: "Write a function",
  status: "requested",
};

function createMockLLM(responses: LLMResponse[]): LLMProvider {
  let callIndex = 0;
  return {
    chat: vi.fn().mockImplementation(() => {
      const response = responses[callIndex];
      if (!response) throw new Error(`No mock response for call ${callIndex}`);
      callIndex++;
      return Promise.resolve(response);
    }),
  };
}

// --- Config validation tests ---

describe("validateConfig", () => {
  it("should accept valid config", () => {
    const errors = validateConfig(baseConfig);
    expect(errors).toEqual([]);
  });

  it("should reject non-object config", () => {
    expect(validateConfig(null)).toEqual(["Config must be an object"]);
    expect(validateConfig("string")).toEqual(["Config must be an object"]);
  });

  it("should reject invalid LLM provider", () => {
    const errors = validateConfig({ ...baseConfig, llm: { provider: "invalid", model: "x", apiKey: "k" } });
    expect(errors).toContain("llm.provider must be anthropic, openai, or openrouter");
  });

  it("should reject maxConcurrentTasks out of range", () => {
    const errors = validateConfig({ ...baseConfig, maxConcurrentTasks: -5 });
    expect(errors).toContain("maxConcurrentTasks must be 1-20");
  });

  it("should reject maxConcurrentTasks > 20", () => {
    const errors = validateConfig({ ...baseConfig, maxConcurrentTasks: 25 });
    expect(errors).toContain("maxConcurrentTasks must be 1-20");
  });

  it("should reject studyIntervalMs out of range", () => {
    const errors = validateConfig({ ...baseConfig, studyIntervalMs: 100 });
    expect(errors).toContain("studyIntervalMs must be 60000-86400000");
  });

  it("should reject maxTokenBudget too small", () => {
    const errors = validateConfig({ ...baseConfig, maxTokenBudget: 500 });
    expect(errors).toContain("maxTokenBudget must be >= 1000");
  });

  it("should accept valid maxTokenBudget", () => {
    const errors = validateConfig({ ...baseConfig, maxTokenBudget: 50000 });
    expect(errors).toEqual([]);
  });
});

// --- Circuit breaker tests ---

describe("circuit breakers", () => {
  it("should abort when token budget exceeded", async () => {
    const config = { ...baseConfig, maxTokenBudget: 500 };
    const llm = createMockLLM([
      {
        content: [{ type: "text", text: "Big response" }],
        stopReason: "end_turn" as const,
        usage: { inputTokens: 300, outputTokens: 300 }, // 600 > 500
      },
    ]);

    const result = await runAgentLoop(llm, baseTask, config);
    expect(result.abortReason).toBe("token_budget");
  });

  it("should abort when tool call limit exceeded", async () => {
    const config = { ...baseConfig, maxToolCalls: 2 };
    const toolResponse: LLMResponse = {
      content: [
        { type: "tool_use", id: "tc-1", name: "quote_task", input: { task_id: "task-1", price_eth: "0.01" } },
        { type: "tool_use", id: "tc-2", name: "quote_task", input: { task_id: "task-1", price_eth: "0.02" } },
        { type: "tool_use", id: "tc-3", name: "quote_task", input: { task_id: "task-1", price_eth: "0.03" } },
      ],
      stopReason: "tool_use",
      usage: { inputTokens: 100, outputTokens: 20 },
    };

    const llm = createMockLLM([toolResponse]);
    const result = await runAgentLoop(llm, baseTask, config);
    expect(result.abortReason).toBe("tool_call_limit");
    expect(result.toolCalls.length).toBeLessThanOrEqual(2);
  });

  it("should abort on max_tokens truncation", async () => {
    const llm = createMockLLM([
      {
        content: [{ type: "text", text: "Truncated mid-sentence..." }],
        stopReason: "max_tokens",
        usage: { inputTokens: 100, outputTokens: 4096 },
      },
    ]);

    const result = await runAgentLoop(llm, baseTask, baseConfig);
    expect(result.abortReason).toBe("max_tokens_truncated");
    expect(result.reasoning).toContain("max_tokens");
  });

  it("should not abort when within all limits", async () => {
    const config = { ...baseConfig, maxTokenBudget: 100_000, maxToolCalls: 25 };
    const llm = createMockLLM([
      {
        content: [
          { type: "tool_use", id: "tc-1", name: "quote_task", input: { task_id: "task-1", price_eth: "0.01" } },
        ],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      {
        content: [{ type: "text", text: "Done." }],
        stopReason: "end_turn",
        usage: { inputTokens: 200, outputTokens: 10 },
      },
    ]);

    const result = await runAgentLoop(llm, baseTask, config);
    expect(result.abortReason).toBeUndefined();
    expect(result.turns).toBe(2);
  });
});
