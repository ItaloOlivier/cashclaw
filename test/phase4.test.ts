import { describe, it, expect } from "vitest";
import { QA_SYSTEM_PROMPT, buildQAUserPrompt } from "../src/qa/prompts.js";

describe("QA prompts", () => {
  it("should contain evaluation criteria", () => {
    expect(QA_SYSTEM_PROMPT).toContain("Completeness");
    expect(QA_SYSTEM_PROMPT).toContain("Quality");
    expect(QA_SYSTEM_PROMPT).toContain("Formatting");
    expect(QA_SYSTEM_PROMPT).toContain("Accuracy");
  });

  it("should specify JSON response format", () => {
    expect(QA_SYSTEM_PROMPT).toContain('"approved"');
    expect(QA_SYSTEM_PROMPT).toContain('"score"');
    expect(QA_SYSTEM_PROMPT).toContain('"feedback"');
    expect(QA_SYSTEM_PROMPT).toContain('"checklist"');
  });

  it("should fail-open when in doubt", () => {
    expect(QA_SYSTEM_PROMPT).toContain("When in doubt, APPROVE");
  });

  it("should build user prompt with task and deliverable", () => {
    const prompt = buildQAUserPrompt("Build a landing page", "Here is the HTML...");
    expect(prompt).toContain("Build a landing page");
    expect(prompt).toContain("Here is the HTML...");
    expect(prompt).toContain("Task Requirements");
    expect(prompt).toContain("Deliverable to Review");
  });

  it("should include MiroFish checklist when provided", () => {
    const prompt = buildQAUserPrompt(
      "Write code",
      "const x = 1;",
      "- Revision risk: HIGH\n- Check error handling",
    );
    expect(prompt).toContain("MiroFish Risk Assessment");
    expect(prompt).toContain("Revision risk: HIGH");
    expect(prompt).toContain("predicted revision risks");
  });

  it("should not include MiroFish section when not provided", () => {
    const prompt = buildQAUserPrompt("Write code", "const x = 1;");
    expect(prompt).not.toContain("MiroFish");
  });
});

describe("QA reviewer parse", () => {
  it("should handle valid JSON response", async () => {
    // Test the parse logic from reviewer.ts inline
    const text = '{"approved": true, "score": 4.5, "feedback": "Looks good", "checklist": [{"item": "Completeness", "passed": true, "score": 5}]}';
    const result = JSON.parse(text);
    expect(result.approved).toBe(true);
    expect(result.score).toBe(4.5);
    expect(result.checklist).toHaveLength(1);
  });

  it("should handle JSON wrapped in code blocks", () => {
    const text = '```json\n{"approved": false, "score": 2, "feedback": "Missing tests", "checklist": []}\n```';
    const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const result = JSON.parse(jsonStr);
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe("Missing tests");
  });
});
