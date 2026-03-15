/**
 * Paperclip control plane task source.
 */

import type { TaskSource } from "./interface.js";
import type { Task } from "../moltlaunch/types.js";
import type { PaperclipIntegrationConfig } from "../config.js";
import * as paperclipClient from "../paperclip/client.js";
import { issueToTask } from "../paperclip/mapper.js";

export function createPaperclipSource(config: PaperclipIntegrationConfig | undefined): TaskSource {
  return {
    name: "paperclip",

    isEnabled() {
      return Boolean(config?.apiUrl && config?.apiKey);
    },

    async poll(): Promise<Task[]> {
      if (!config) return [];
      try {
        const issues = await paperclipClient.getAssignedIssues(config);
        return issues.map((issue) => issueToTask(issue));
      } catch {
        return [];
      }
    },
  };
}
