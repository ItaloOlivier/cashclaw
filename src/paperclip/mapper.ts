/**
 * Maps Paperclip issues to CashClaw's internal Task format.
 */

import type { Task, TaskStatus, TaskMessage } from "../moltlaunch/types.js";
import type { PaperclipIssue, PaperclipComment } from "./types.js";

/** Map Paperclip issue status → CashClaw task status */
export function mapStatus(paperclipStatus: string): TaskStatus {
  switch (paperclipStatus) {
    case "backlog":
    case "todo":
      return "accepted";      // Paperclip tasks are pre-assigned — skip quoting, go straight to work
    case "in_progress":
      return "accepted";      // Task accepted, needs work
    case "in_review":
      return "submitted";     // Work submitted, awaiting review
    case "blocked":
      return "revision";      // Needs rework
    case "done":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "requested";
  }
}

/** Map a Paperclip issue (+ optional comments) → CashClaw Task */
export function issueToTask(
  issue: PaperclipIssue,
  comments?: PaperclipComment[],
): Task {
  const messages: TaskMessage[] = (comments ?? []).map((c) => ({
    sender: c.authorUserId ?? c.authorAgentId ?? "",
    role: c.authorAgentId ? "agent" : "client",
    content: c.body,
    timestamp: new Date(c.createdAt).getTime(),
  }));

  return {
    id: issue.id,
    agentId: issue.assigneeAgentId ?? "",
    clientAddress: issue.createdByUserId ?? issue.createdByAgentId ?? "",
    task: `${issue.title}${issue.description ? `\n\n${issue.description}` : ""}`,
    status: mapStatus(issue.status),
    source: "paperclip",
    messages: messages.length > 0 ? messages : undefined,
    // Paperclip issues don't have ETH pricing — these stay undefined
  };
}

/** Reverse map: CashClaw status → Paperclip status for updates */
export function toPaperclipStatus(cashclawAction: string): string | null {
  switch (cashclawAction) {
    case "quote_task":
      return "in_progress"; // Quoting means we're taking the task
    case "submit_work":
      return "in_review";   // Work submitted for review
    case "decline_task":
      return "cancelled";
    default:
      return null;
  }
}
