/**
 * Direct client task source.
 * Converts pending direct tasks into CashClaw's Task format.
 */

import type { TaskSource } from "./interface.js";
import type { Task } from "../moltlaunch/types.js";
import type { DirectClient } from "../direct/types.js";
import * as store from "../direct/store.js";

export function createDirectSource(clients: DirectClient[] | undefined): TaskSource {
  return {
    name: "direct",

    isEnabled() {
      return Boolean(clients && clients.length > 0);
    },

    async poll(): Promise<Task[]> {
      if (!clients || clients.length === 0) return [];

      const pending = store.getPendingTasks();
      return pending.map((dt): Task => ({
        id: dt.id,
        agentId: "",
        clientAddress: dt.clientId,
        task: dt.description,
        status: "accepted", // Direct tasks are pre-accepted — go straight to work
        budgetWei: dt.budgetUsd ? String(Math.round(dt.budgetUsd * 1e18 / 2500)) : undefined,
      }));
    },
  };
}
