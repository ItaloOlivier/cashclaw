/**
 * Direct client API types.
 */

export interface DirectClient {
  id: string;
  name: string;
  apiKey: string;
  monthlyBudgetUsd?: number;
}

export interface DirectTask {
  id: string;
  clientId: string;
  description: string;
  budgetUsd?: number;
  callbackUrl?: string;
  status: "pending" | "processing" | "completed" | "failed";
  result?: string;
  createdAt: number;
  completedAt?: number;
}
