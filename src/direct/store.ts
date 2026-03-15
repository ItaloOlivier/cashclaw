/**
 * In-memory + file-backed task store for direct clients.
 * Persists completed tasks to disk for history. Active tasks live in memory.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { DirectTask } from "./types.js";

const CONFIG_DIR = process.env.CASHCLAW_CONFIG_DIR ?? path.join(os.homedir(), ".cashclaw");
const STORE_PATH = path.join(CONFIG_DIR, "direct-tasks.json");
const MAX_STORED = 200;

const activeTasks = new Map<string, DirectTask>();

function loadStored(): DirectTask[] {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as DirectTask[];
  } catch {
    return [];
  }
}

function saveStored(tasks: DirectTask[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const trimmed = tasks.slice(-MAX_STORED);
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

export function createTask(clientId: string, description: string, budgetUsd?: number, callbackUrl?: string): DirectTask {
  const task: DirectTask = {
    id: `direct-${crypto.randomBytes(8).toString("hex")}`,
    clientId,
    description,
    budgetUsd,
    callbackUrl,
    status: "pending",
    createdAt: Date.now(),
  };
  activeTasks.set(task.id, task);
  return task;
}

export function getTask(taskId: string): DirectTask | undefined {
  return activeTasks.get(taskId) ?? loadStored().find((t) => t.id === taskId);
}

export function getPendingTasks(): DirectTask[] {
  return [...activeTasks.values()].filter((t) => t.status === "pending");
}

export function completeTask(taskId: string, result: string): DirectTask | undefined {
  const task = activeTasks.get(taskId);
  if (!task) return undefined;
  task.status = "completed";
  task.result = result;
  task.completedAt = Date.now();
  activeTasks.delete(taskId);

  // Persist to disk
  const stored = loadStored();
  stored.push(task);
  saveStored(stored);

  return task;
}

export function failTask(taskId: string, reason: string): DirectTask | undefined {
  const task = activeTasks.get(taskId);
  if (!task) return undefined;
  task.status = "failed";
  task.result = reason;
  task.completedAt = Date.now();
  activeTasks.delete(taskId);

  const stored = loadStored();
  stored.push(task);
  saveStored(stored);

  return task;
}

export function markProcessing(taskId: string): void {
  const task = activeTasks.get(taskId);
  if (task) task.status = "processing";
}

export function getHistory(): DirectTask[] {
  return loadStored();
}
