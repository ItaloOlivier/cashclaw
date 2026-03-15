/**
 * Fleet Router — routes tasks to the best-fit agent by specialty matching.
 *
 * Used when multiple CashClaw instances run under Paperclip orchestration.
 * Each instance declares specialties in its config; the router scores
 * task descriptions against specialty keywords.
 *
 * Routing happens at the Paperclip level (assigning issues to agents),
 * but this module provides the scoring logic for local triage decisions.
 */

export interface AgentProfile {
  id: string;
  name: string;
  specialties: string[];
  role?: string; // "content" | "code" | "qa"
}

export interface RouteResult {
  agentId: string;
  agentName: string;
  score: number;
  matchedSpecialties: string[];
}

/** Score a task against an agent's specialties */
export function scoreTaskForAgent(
  taskDescription: string,
  agent: AgentProfile,
): { score: number; matched: string[] } {
  const lower = taskDescription.toLowerCase();
  const matched: string[] = [];

  for (const specialty of agent.specialties) {
    // Check for whole-word or partial match in task description
    const specLower = specialty.toLowerCase();
    if (lower.includes(specLower)) {
      matched.push(specialty);
    }
  }

  return { score: matched.length, matched };
}

/**
 * Route a task to the best-fit agent from a fleet.
 * Returns scored results for all agents, sorted best-first.
 *
 * Excludes agents with role "qa" from task routing (they only review).
 */
export function routeTask(
  taskDescription: string,
  agents: AgentProfile[],
): RouteResult[] {
  const candidates = agents.filter((a) => a.role !== "qa");

  const scored = candidates.map((agent) => {
    const { score, matched } = scoreTaskForAgent(taskDescription, agent);
    return {
      agentId: agent.id,
      agentName: agent.name,
      score,
      matchedSpecialties: matched,
    };
  });

  // Sort by score descending; ties broken by agent order (first configured wins)
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Simple keyword-based classification for content vs code tasks.
 * Used as fallback when no specialty match is found.
 */
export function classifyTask(taskDescription: string): "content" | "code" | "general" {
  const lower = taskDescription.toLowerCase();

  const codeKeywords = [
    "code", "function", "bug", "api", "endpoint", "typescript", "javascript",
    "python", "react", "database", "sql", "fix", "debug", "test", "script",
    "repository", "git", "deploy", "backend", "frontend", "refactor",
  ];

  const contentKeywords = [
    "write", "blog", "article", "copy", "content", "seo", "social media",
    "email", "newsletter", "landing page", "description", "summary",
    "documentation", "readme", "post", "marketing",
  ];

  const codeScore = codeKeywords.filter((k) => lower.includes(k)).length;
  const contentScore = contentKeywords.filter((k) => lower.includes(k)).length;

  if (codeScore > contentScore) return "code";
  if (contentScore > codeScore) return "content";
  return "general";
}
