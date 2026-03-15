import { describe, it, expect } from "vitest";
import { estimateCostUsd, getModelPricing } from "../src/llm/cost.js";
import { selectModel, type RoutingConfig, type RoutingInput } from "../src/llm/router.js";

// --- Cost estimator tests ---

describe("estimateCostUsd", () => {
  it("should calculate Sonnet cost correctly", () => {
    // 1000 input + 500 output on Sonnet = (1000*3 + 500*15) / 1M = 0.0105
    const cost = estimateCostUsd("claude-sonnet-4-20250514", 1000, 500);
    expect(cost).toBeCloseTo(0.0105, 4);
  });

  it("should calculate Haiku cost correctly", () => {
    // 1000 input + 500 output on Haiku = (1000*0.8 + 500*4) / 1M = 0.0028
    const cost = estimateCostUsd("claude-haiku-3-5-20241022", 1000, 500);
    expect(cost).toBeCloseTo(0.0028, 4);
  });

  it("should use default pricing for unknown model", () => {
    const cost = estimateCostUsd("unknown-model", 1000, 500);
    // Default = Sonnet pricing
    expect(cost).toBeCloseTo(0.0105, 4);
  });

  it("should calculate realistic task cost", () => {
    // Typical task: 15K input, 5K output on Sonnet
    const cost = estimateCostUsd("claude-sonnet-4-20250514", 15000, 5000);
    // (15000*3 + 5000*15) / 1M = 0.045 + 0.075 = 0.12
    expect(cost).toBeCloseTo(0.12, 2);
  });
});

describe("getModelPricing", () => {
  it("should return known pricing for Sonnet", () => {
    const p = getModelPricing("claude-sonnet-4-20250514");
    expect(p.input).toBe(3.00);
    expect(p.output).toBe(15.00);
  });

  it("should return default for unknown model", () => {
    const p = getModelPricing("totally-unknown");
    expect(p.input).toBe(3.00);
  });
});

// --- Model router tests ---

const routing: RoutingConfig = {
  enabled: true,
  cheapModel: "claude-haiku-3-5-20241022",
  standardModel: "claude-sonnet-4-20250514",
  complexModel: "claude-opus-4-20250514",
};

describe("selectModel", () => {
  it("should route study sessions to cheap model", () => {
    const model = selectModel(routing, "claude-sonnet-4-20250514", { context: "study" });
    expect(model).toBe("claude-haiku-3-5-20241022");
  });

  it("should route chat to cheap model", () => {
    const model = selectModel(routing, "claude-sonnet-4-20250514", { context: "chat" });
    expect(model).toBe("claude-haiku-3-5-20241022");
  });

  it("should route standard tasks to standard model", () => {
    const model = selectModel(routing, "claude-sonnet-4-20250514", {
      context: "task",
      taskDescription: "Write a blog post",
      taskStatus: "requested",
    });
    expect(model).toBe("claude-sonnet-4-20250514");
  });

  it("should route revisions to standard model (never cheap)", () => {
    const model = selectModel(routing, "claude-sonnet-4-20250514", {
      context: "task",
      taskStatus: "revision",
    });
    expect(model).toBe("claude-sonnet-4-20250514");
  });

  it("should route high-risk MiroFish tasks to standard model", () => {
    const model = selectModel(routing, "claude-sonnet-4-20250514", {
      context: "task",
      taskStatus: "accepted",
      miroRevisionRisk: "high",
    });
    expect(model).toBe("claude-sonnet-4-20250514");
  });

  it("should return base model when routing disabled", () => {
    const disabled = { ...routing, enabled: false };
    const model = selectModel(disabled, "my-custom-model", { context: "study" });
    expect(model).toBe("my-custom-model");
  });

  it("should return base model when routing config undefined", () => {
    const model = selectModel(undefined, "my-custom-model", { context: "study" });
    expect(model).toBe("my-custom-model");
  });
});
