import { describe, it, expect } from "vitest";
import { mapStatus, issueToTask, toPaperclipStatus } from "../src/paperclip/mapper.js";
import type { PaperclipIssue, PaperclipComment } from "../src/paperclip/types.js";

describe("mapStatus", () => {
  it("should map 'todo' to 'accepted' (Paperclip tasks skip quoting)", () => {
    expect(mapStatus("todo")).toBe("accepted");
  });

  it("should map 'backlog' to 'accepted' (Paperclip tasks skip quoting)", () => {
    expect(mapStatus("backlog")).toBe("accepted");
  });

  it("should map 'in_progress' to 'accepted'", () => {
    expect(mapStatus("in_progress")).toBe("accepted");
  });

  it("should map 'in_review' to 'submitted'", () => {
    expect(mapStatus("in_review")).toBe("submitted");
  });

  it("should map 'blocked' to 'revision'", () => {
    expect(mapStatus("blocked")).toBe("revision");
  });

  it("should map 'done' to 'completed'", () => {
    expect(mapStatus("done")).toBe("completed");
  });

  it("should map 'cancelled' to 'cancelled'", () => {
    expect(mapStatus("cancelled")).toBe("cancelled");
  });

  it("should default unknown status to 'requested'", () => {
    expect(mapStatus("unknown_thing")).toBe("requested");
  });
});

describe("issueToTask", () => {
  const baseIssue: PaperclipIssue = {
    id: "issue-123",
    companyId: "company-1",
    title: "Build landing page",
    description: "Create a responsive landing page with hero section",
    status: "todo",
    priority: "medium",
    assigneeAgentId: "agent-1",
    createdByUserId: "user-1",
    createdAt: "2026-03-15T10:00:00Z",
    updatedAt: "2026-03-15T10:00:00Z",
  };

  it("should map basic issue to task", () => {
    const task = issueToTask(baseIssue);
    expect(task.id).toBe("issue-123");
    expect(task.agentId).toBe("agent-1");
    expect(task.clientAddress).toBe("user-1");
    expect(task.task).toContain("Build landing page");
    expect(task.task).toContain("responsive landing page");
    expect(task.status).toBe("accepted");
  });

  it("should handle issue without description", () => {
    const issue = { ...baseIssue, description: null };
    const task = issueToTask(issue);
    expect(task.task).toBe("Build landing page");
  });

  it("should map comments to messages", () => {
    const comments: PaperclipComment[] = [
      {
        id: "c1",
        issueId: "issue-123",
        authorUserId: "user-1",
        body: "Please use dark theme",
        createdAt: "2026-03-15T11:00:00Z",
      },
      {
        id: "c2",
        issueId: "issue-123",
        authorAgentId: "agent-1",
        body: "Got it, will use dark palette",
        createdAt: "2026-03-15T11:05:00Z",
      },
    ];

    const task = issueToTask(baseIssue, comments);
    expect(task.messages).toHaveLength(2);
    expect(task.messages![0].role).toBe("client");
    expect(task.messages![0].content).toBe("Please use dark theme");
    expect(task.messages![1].role).toBe("agent");
  });

  it("should handle no comments", () => {
    const task = issueToTask(baseIssue);
    expect(task.messages).toBeUndefined();
  });

  it("should handle missing assignee", () => {
    const issue = { ...baseIssue, assigneeAgentId: null };
    const task = issueToTask(issue);
    expect(task.agentId).toBe("");
  });
});

describe("toPaperclipStatus", () => {
  it("should map quote_task to in_progress", () => {
    expect(toPaperclipStatus("quote_task")).toBe("in_progress");
  });

  it("should map submit_work to in_review", () => {
    expect(toPaperclipStatus("submit_work")).toBe("in_review");
  });

  it("should map decline_task to cancelled", () => {
    expect(toPaperclipStatus("decline_task")).toBe("cancelled");
  });

  it("should return null for unknown action", () => {
    expect(toPaperclipStatus("send_message")).toBeNull();
  });
});
