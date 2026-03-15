/**
 * Paperclip API types — minimal subset needed by CashClaw.
 * These mirror the Paperclip REST API response shapes.
 */

export interface PaperclipConfig {
  apiUrl: string;       // e.g. "http://localhost:3100"
  apiKey: string;       // pcp_... agent API key
  agentId: string;      // Paperclip agent UUID
  companyId: string;    // Paperclip company UUID
}

export interface PaperclipIssue {
  id: string;
  companyId: string;
  projectId?: string | null;
  title: string;
  description?: string | null;
  status: string; // backlog | todo | in_progress | in_review | blocked | done | cancelled
  priority: string;
  assigneeAgentId?: string | null;
  parentId?: string | null;
  issueNumber?: number;
  identifier?: string;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaperclipComment {
  id: string;
  issueId: string;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  body: string;
  createdAt: string;
}

export interface PaperclipWebhookPayload {
  runId: string;
  agentId: string;
  companyId: string;
  context: {
    taskId?: string;
    issueId?: string;
    wakeReason?: string;
    wakeCommentId?: string;
  };
}

export interface CreateCostEvent {
  agentId: string;
  issueId?: string | null;
  projectId?: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: string; // ISO 8601
}
