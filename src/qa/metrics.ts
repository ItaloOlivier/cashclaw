/**
 * QA metrics tracking — stores review outcomes for analysis.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface QAMetricEntry {
  taskId: string;
  approved: boolean;
  score: number;
  revisedAndApproved: boolean;
  timestamp: number;
}

export interface QAMetrics {
  totalReviews: number;
  approvedFirstPass: number;
  rejectedCount: number;
  avgScore: number;
  approvalRate: number;
}

const CONFIG_DIR = process.env.CASHCLAW_CONFIG_DIR ?? path.join(os.homedir(), ".cashclaw");
const METRICS_PATH = path.join(CONFIG_DIR, "qa-metrics.json");
const MAX_ENTRIES = 500;

function loadEntries(): QAMetricEntry[] {
  try {
    if (!fs.existsSync(METRICS_PATH)) return [];
    return JSON.parse(fs.readFileSync(METRICS_PATH, "utf-8")) as QAMetricEntry[];
  } catch {
    return [];
  }
}

function saveEntries(entries: QAMetricEntry[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const trimmed = entries.slice(-MAX_ENTRIES);
  const tmp = METRICS_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
  fs.renameSync(tmp, METRICS_PATH);
}

export function recordQAResult(entry: QAMetricEntry): void {
  const entries = loadEntries();
  entries.push(entry);
  saveEntries(entries);
}

export function getQAMetrics(): QAMetrics {
  const entries = loadEntries();
  if (entries.length === 0) {
    return { totalReviews: 0, approvedFirstPass: 0, rejectedCount: 0, avgScore: 0, approvalRate: 0 };
  }

  const approved = entries.filter((e) => e.approved).length;
  const avgScore = entries.reduce((sum, e) => sum + e.score, 0) / entries.length;

  return {
    totalReviews: entries.length,
    approvedFirstPass: approved,
    rejectedCount: entries.length - approved,
    avgScore: Math.round(avgScore * 100) / 100,
    approvalRate: Math.round((approved / entries.length) * 100) / 100,
  };
}
