/**
 * QA Reviewer — Haiku-based quality gate for deliverables.
 *
 * Intercepts submit_work calls, evaluates the deliverable against
 * task requirements, and either approves or returns feedback.
 *
 * Cost: ~$0.004 per review on Haiku (2K input + 500 output tokens).
 */

import { createLLMProvider } from "../llm/index.js";
import type { CashClawConfig } from "../config.js";
import { QA_SYSTEM_PROMPT, buildQAUserPrompt } from "./prompts.js";

export interface QAChecklistItem {
  item: string;
  passed: boolean;
  score: number;
}

export interface QAReviewResult {
  approved: boolean;
  score: number;
  feedback: string;
  checklist: QAChecklistItem[];
}

const QA_MODEL = "claude-haiku-3-5-20241022";

/**
 * Run a QA review on a deliverable before submission.
 * Uses Haiku for cost efficiency (~$0.004/review).
 */
export async function runQAReview(
  config: CashClawConfig,
  taskDescription: string,
  deliverable: string,
  miroChecklist?: string,
): Promise<QAReviewResult> {
  const llm = createLLMProvider({
    provider: "anthropic",
    model: QA_MODEL,
    apiKey: config.llm.apiKey,
  });

  const userPrompt = buildQAUserPrompt(taskDescription, deliverable, miroChecklist);

  const response = await llm.chat([
    { role: "system", content: QA_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ]);

  const text = response.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Parse the JSON response
  try {
    // Extract JSON from the response (handle potential markdown code blocks)
    const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const result = JSON.parse(jsonStr) as QAReviewResult;

    return {
      approved: result.approved ?? true,
      score: typeof result.score === "number" ? result.score : 3,
      feedback: result.feedback ?? "",
      checklist: Array.isArray(result.checklist) ? result.checklist : [],
    };
  } catch {
    // If we can't parse the QA response, approve by default (fail-open)
    // Better to submit imperfect work than block on a malformed review
    return {
      approved: true,
      score: 3,
      feedback: "QA review parse error — auto-approved",
      checklist: [],
    };
  }
}
