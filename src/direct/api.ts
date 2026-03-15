/**
 * Direct client REST API endpoints.
 *
 * POST /api/tasks/create   — Submit a new task
 * GET  /api/tasks/:id      — Check task status
 * GET  /api/tasks/history   — View completed tasks
 */

import type http from "node:http";
import type { DirectClient } from "./types.js";
import * as store from "./store.js";

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/** Validate direct client API key */
function authenticateClient(
  apiKey: string,
  clients: DirectClient[],
): DirectClient | null {
  return clients.find((c) => c.apiKey === apiKey) ?? null;
}

export function handleDirectApi(
  pathname: string,
  method: string,
  body: unknown,
  authHeader: string | undefined,
  res: http.ServerResponse,
  clients: DirectClient[],
): void {
  // Authenticate
  const apiKey = authHeader?.replace("Bearer ", "") ?? "";
  const client = authenticateClient(apiKey, clients);

  if (!client) {
    json(res, { error: "Invalid API key" }, 401);
    return;
  }

  if (pathname === "/api/tasks/create" && method === "POST") {
    const data = body as { description?: string; budgetUsd?: number; callbackUrl?: string } | null;

    if (!data?.description?.trim()) {
      json(res, { error: "description is required" }, 400);
      return;
    }

    const task = store.createTask(
      client.id,
      data.description.trim(),
      data.budgetUsd,
      data.callbackUrl,
    );

    json(res, { taskId: task.id, status: task.status }, 201);
    return;
  }

  if (pathname === "/api/tasks/history" && method === "GET") {
    const history = store.getHistory().filter((t) => t.clientId === client.id);
    json(res, { tasks: history });
    return;
  }

  // GET /api/tasks/:id
  const taskMatch = pathname.match(/^\/api\/tasks\/(direct-[a-f0-9]+)$/);
  if (taskMatch && method === "GET") {
    const task = store.getTask(taskMatch[1]);
    if (!task || task.clientId !== client.id) {
      json(res, { error: "Task not found" }, 404);
      return;
    }
    json(res, task);
    return;
  }

  json(res, { error: "Not found" }, 404);
}
