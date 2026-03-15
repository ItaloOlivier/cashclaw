import { describe, it, expect } from "vitest";
import {
  scoreTaskForAgent,
  routeTask,
  classifyTask,
  type AgentProfile,
} from "../src/fleet/router.js";

const contentAgent: AgentProfile = {
  id: "agent-content",
  name: "CashClaw Content",
  specialties: ["copywriting", "blog-posts", "social-media", "seo-content"],
  role: "content",
};

const codeAgent: AgentProfile = {
  id: "agent-code",
  name: "CashClaw Code",
  specialties: ["code-review", "typescript", "react", "api-development", "bug-fixing"],
  role: "code",
};

const qaAgent: AgentProfile = {
  id: "agent-qa",
  name: "CashClaw QA",
  specialties: ["quality-review"],
  role: "qa",
};

const agents = [contentAgent, codeAgent, qaAgent];

describe("scoreTaskForAgent", () => {
  it("should score content task higher for content agent", () => {
    const { score } = scoreTaskForAgent("Write copywriting for seo-content campaign", contentAgent);
    expect(score).toBeGreaterThan(0);
  });

  it("should score code task higher for code agent", () => {
    const { score } = scoreTaskForAgent("Fix the bug in the TypeScript API endpoint", codeAgent);
    expect(score).toBeGreaterThan(0);
  });

  it("should return zero for no match", () => {
    const { score } = scoreTaskForAgent("Cook me a pizza", contentAgent);
    expect(score).toBe(0);
  });

  it("should return matched specialties", () => {
    const { matched } = scoreTaskForAgent("Review the react component code", codeAgent);
    expect(matched).toContain("react");
  });
});

describe("routeTask", () => {
  it("should route blog post to content agent", () => {
    const results = routeTask("Write a blog post about copywriting best practices", agents);
    expect(results[0].agentId).toBe("agent-content");
  });

  it("should route TypeScript bug to code agent", () => {
    const results = routeTask("Fix the TypeScript bug in the React API", agents);
    expect(results[0].agentId).toBe("agent-code");
  });

  it("should exclude QA agent from task routing", () => {
    const results = routeTask("Write something", agents);
    const qaResult = results.find((r) => r.agentId === "agent-qa");
    expect(qaResult).toBeUndefined();
  });

  it("should return all non-QA agents sorted by score", () => {
    const results = routeTask("Random task", agents);
    expect(results).toHaveLength(2); // content + code, not qa
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });
});

describe("classifyTask", () => {
  it("should classify code tasks", () => {
    expect(classifyTask("Fix the bug in the API endpoint")).toBe("code");
    expect(classifyTask("Write a Python script for data processing")).toBe("code");
    expect(classifyTask("Debug the TypeScript function")).toBe("code");
  });

  it("should classify content tasks", () => {
    expect(classifyTask("Write a blog post about marketing")).toBe("content");
    expect(classifyTask("Create social media copy for the campaign")).toBe("content");
    expect(classifyTask("Write an email newsletter")).toBe("content");
  });

  it("should classify ambiguous tasks as general", () => {
    expect(classifyTask("Help me with something")).toBe("general");
  });
});
