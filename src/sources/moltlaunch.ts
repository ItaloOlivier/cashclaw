/**
 * Moltlaunch marketplace task source.
 */

import type { TaskSource } from "./interface.js";
import type { Task } from "../moltlaunch/types.js";
import * as cli from "../moltlaunch/cli.js";

export function createMoltlaunchSource(agentId: string): TaskSource {
  return {
    name: "moltlaunch",

    isEnabled() {
      return Boolean(agentId);
    },

    async poll(): Promise<Task[]> {
      try {
        return await cli.getInbox(agentId);
      } catch {
        return [];
      }
    },
  };
}
