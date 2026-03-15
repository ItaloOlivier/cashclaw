/**
 * Pluggable task source interface.
 * Each source polls for tasks from a different platform/client.
 */

import type { Task } from "../moltlaunch/types.js";

export interface TaskSource {
  /** Human-readable name for logging */
  name: string;

  /** Whether this source is currently enabled */
  isEnabled(): boolean;

  /** Poll for actionable tasks. Returns empty array on error (non-fatal). */
  poll(): Promise<Task[]>;
}
