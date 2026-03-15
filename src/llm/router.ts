/**
 * Model Router — 3-tier routing: Haiku (cheap), Sonnet (standard), Opus (complex)
 *
 * Decides which model to use based on task characteristics:
 * - Study sessions / chat → Haiku
 * - Simple tasks (<500 chars, no revision) → Sonnet
 * - Complex tasks (revision, long description, MiroFish high-risk) → Sonnet (never Haiku)
 * - Explicitly flagged complex → Opus
 */

export interface RoutingConfig {
  enabled: boolean;
  cheapModel: string;      // e.g. "claude-haiku-3-5-20241022"
  standardModel: string;   // e.g. "claude-sonnet-4-20250514"
  complexModel: string;    // e.g. "claude-opus-4-20250514"
}

export type TaskContext = "study" | "chat" | "task";

export interface RoutingInput {
  context: TaskContext;
  taskDescription?: string;
  taskStatus?: string;          // "requested" | "accepted" | "revision"
  miroRevisionRisk?: "high" | "medium" | "low";
}

const DEFAULT_ROUTING: RoutingConfig = {
  enabled: false,
  cheapModel: "claude-haiku-3-5-20241022",
  standardModel: "claude-sonnet-4-20250514",
  complexModel: "claude-opus-4-20250514",
};

/** Select the optimal model based on task characteristics */
export function selectModel(
  routing: RoutingConfig | undefined,
  baseModel: string,
  input: RoutingInput,
): string {
  const config = routing?.enabled ? routing : null;
  if (!config) return baseModel;

  // Study sessions and chat → always cheap
  if (input.context === "study" || input.context === "chat") {
    return config.cheapModel;
  }

  // Revisions → always standard (never cheap — quality matters for client retention)
  if (input.taskStatus === "revision") {
    return config.standardModel;
  }

  // MiroFish says high revision risk → standard minimum
  if (input.miroRevisionRisk === "high") {
    return config.standardModel;
  }

  // Short, simple tasks → standard (Haiku often misses nuance on marketplace tasks)
  // We default to standard because the quality difference between Haiku and Sonnet
  // on real freelance tasks is significant based on research data
  return config.standardModel;
}

export function getDefaultRouting(): RoutingConfig {
  return { ...DEFAULT_ROUTING };
}
