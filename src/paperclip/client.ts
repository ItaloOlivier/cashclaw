/**
 * Paperclip REST API client for CashClaw.
 *
 * Provides: issue fetching, status updates, comments, and cost reporting.
 * All calls use the agent's API key for authentication.
 */

import type {
  PaperclipConfig,
  PaperclipIssue,
  PaperclipComment,
  CreateCostEvent,
} from "./types.js";

const TIMEOUT_MS = 15_000;

async function paperclipFetch<T>(
  config: PaperclipConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiKey}`,
    };

    const res = await fetch(`${config.apiUrl}/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Paperclip API ${res.status}: ${errText}`);
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

/** Get issues assigned to this agent with actionable statuses */
export async function getAssignedIssues(
  config: PaperclipConfig,
): Promise<PaperclipIssue[]> {
  const statuses = "todo,in_progress,blocked";
  const result = await paperclipFetch<{ issues: PaperclipIssue[] }>(
    config,
    "GET",
    `/companies/${config.companyId}/issues?assigneeAgentId=${config.agentId}&status=${statuses}`,
  );
  return result.issues ?? [];
}

/** Get a single issue by ID */
export async function getIssue(
  config: PaperclipConfig,
  issueId: string,
): Promise<PaperclipIssue> {
  return paperclipFetch<PaperclipIssue>(config, "GET", `/issues/${issueId}`);
}

/** Get comments on an issue */
export async function getComments(
  config: PaperclipConfig,
  issueId: string,
): Promise<PaperclipComment[]> {
  const result = await paperclipFetch<{ comments: PaperclipComment[] }>(
    config,
    "GET",
    `/issues/${issueId}/comments`,
  );
  return result.comments ?? [];
}

/** Update issue status and/or add a comment */
export async function updateIssue(
  config: PaperclipConfig,
  issueId: string,
  updates: { status?: string; comment?: string },
  runId?: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (runId) headers["X-Paperclip-Run-Id"] = runId;

  await paperclipFetch<unknown>(config, "PATCH", `/issues/${issueId}`, updates);
}

/** Post a comment on an issue */
export async function addComment(
  config: PaperclipConfig,
  issueId: string,
  body: string,
): Promise<void> {
  await paperclipFetch<unknown>(config, "POST", `/issues/${issueId}/comments`, {
    body,
    authorAgentId: config.agentId,
  });
}

/** Report token usage / cost to Paperclip */
export async function reportCost(
  config: PaperclipConfig,
  event: CreateCostEvent,
): Promise<void> {
  try {
    await paperclipFetch<unknown>(
      config,
      "POST",
      `/companies/${config.companyId}/cost-events`,
      event,
    );
  } catch {
    // Non-fatal — cost reporting failure should not block task execution
  }
}
