import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface LLMConfig {
  provider: "anthropic" | "openai" | "openrouter";
  model: string;
  apiKey: string;
}

export interface PricingConfig {
  strategy: "fixed" | "complexity";
  baseRateEth: string;
  maxRateEth: string;
}

export interface PollingConfig {
  intervalMs: number;
  urgentIntervalMs: number;
}

export interface PersonalityConfig {
  tone: "professional" | "casual" | "friendly" | "technical";
  responseStyle: "concise" | "detailed" | "balanced";
  customInstructions?: string;
}

export interface RoutingConfig {
  enabled: boolean;
  cheapModel: string;
  standardModel: string;
  complexModel: string;
}

export interface PaperclipIntegrationConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  companyId: string;
}

export interface CashClawConfig {
  agentId: string;
  llm: LLMConfig;
  routing?: RoutingConfig;
  polling: PollingConfig;
  pricing: PricingConfig;
  specialties: string[];
  autoQuote: boolean;
  autoWork: boolean;
  maxConcurrentTasks: number;
  maxLoopTurns?: number;
  maxTokenBudget?: number;
  maxToolCalls?: number;
  maxCostPerTaskUsd?: number;
  maxTaskDurationMs?: number;
  declineKeywords: string[];
  personality?: PersonalityConfig;
  learningEnabled: boolean;
  studyIntervalMs: number;
  agentCashEnabled: boolean;
  qaReviewEnabled?: boolean; // default true; set false to skip QA gate
  paperclip?: PaperclipIntegrationConfig;
  directClients?: Array<{
    id: string;
    name: string;
    apiKey: string;
    monthlyBudgetUsd?: number;
  }>;
}

const CONFIG_DIR = process.env.CASHCLAW_CONFIG_DIR ?? path.join(os.homedir(), ".cashclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "cashclaw.json");

const DEFAULT_CONFIG: Omit<CashClawConfig, "agentId" | "llm"> = {
  polling: { intervalMs: 30000, urgentIntervalMs: 10000 },
  pricing: { strategy: "fixed", baseRateEth: "0.005", maxRateEth: "0.05" },
  specialties: [],
  autoQuote: true,
  autoWork: true,
  maxConcurrentTasks: 3,
  declineKeywords: [],
  learningEnabled: true,
  studyIntervalMs: 1_800_000, // 30 minutes
  agentCashEnabled: false,
};

/** Validate config fields. Returns array of error messages, empty if valid. */
export function validateConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (!config || typeof config !== "object") return ["Config must be an object"];
  const c = config as Record<string, unknown>;

  if (c.agentId !== undefined && typeof c.agentId !== "string") errors.push("agentId must be a string");

  if (c.llm && typeof c.llm === "object") {
    const llm = c.llm as Record<string, unknown>;
    if (llm.provider && !["anthropic", "openai", "openrouter"].includes(llm.provider as string)) {
      errors.push("llm.provider must be anthropic, openai, or openrouter");
    }
    if (llm.apiKey !== undefined && (typeof llm.apiKey !== "string")) {
      errors.push("llm.apiKey must be a string");
    }
  }

  if (c.maxConcurrentTasks !== undefined) {
    const v = Number(c.maxConcurrentTasks);
    if (!Number.isInteger(v) || v < 1 || v > 20) errors.push("maxConcurrentTasks must be 1-20");
  }

  if (c.polling && typeof c.polling === "object") {
    const p = c.polling as Record<string, unknown>;
    if (typeof p.intervalMs === "number" && (p.intervalMs < 5000 || p.intervalMs > 600000)) {
      errors.push("polling.intervalMs must be 5000-600000");
    }
  }

  if (c.studyIntervalMs !== undefined) {
    const v = Number(c.studyIntervalMs);
    if (v < 60_000 || v > 86_400_000) errors.push("studyIntervalMs must be 60000-86400000");
  }

  if (c.maxTokenBudget !== undefined) {
    const v = Number(c.maxTokenBudget);
    if (!Number.isInteger(v) || v < 1000) errors.push("maxTokenBudget must be >= 1000");
  }

  if (c.maxToolCalls !== undefined) {
    const v = Number(c.maxToolCalls);
    if (!Number.isInteger(v) || v < 1) errors.push("maxToolCalls must be >= 1");
  }

  return errors;
}

export function loadConfig(): CashClawConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as CashClawConfig;
    if (!parsed || typeof parsed !== "object") return null;
    const errors = validateConfig(parsed);
    if (errors.length > 0) {
      console.error(`Config validation warnings: ${errors.join("; ")}`);
    }
    return parsed;
  } catch {
    return null;
  }
}

export function requireConfig(): CashClawConfig {
  const config = loadConfig();
  if (!config) {
    throw new Error(
      "No config found. Run `cashclaw init` first.",
    );
  }
  return config;
}

export function saveConfig(config: CashClawConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  fs.chmodSync(CONFIG_PATH, 0o600);
}

/** Check if config has all required fields for running the agent */
export function isConfigured(): boolean {
  const config = loadConfig();
  if (!config) return false;
  return Boolean(config.agentId && config.llm?.apiKey && config.llm?.provider);
}

/** Save partial config fields, merging with existing config or defaults */
export function savePartialConfig(partial: Partial<CashClawConfig>): CashClawConfig {
  const existing = loadConfig();
  const config = {
    ...DEFAULT_CONFIG,
    agentId: "",
    llm: { provider: "anthropic" as const, model: "", apiKey: "" },
    ...existing,
    ...partial,
  };
  saveConfig(config);
  return config;
}

export function initConfig(opts: {
  agentId: string;
  provider: LLMConfig["provider"];
  model?: string;
  apiKey: string;
  specialties?: string[];
}): CashClawConfig {
  const modelDefaults: Record<LLMConfig["provider"], string> = {
    anthropic: "claude-sonnet-4-20250514",
    openai: "gpt-4o",
    openrouter: "anthropic/claude-sonnet-4-20250514",
  };

  const config: CashClawConfig = {
    ...DEFAULT_CONFIG,
    agentId: opts.agentId,
    llm: {
      provider: opts.provider,
      model: opts.model ?? modelDefaults[opts.provider],
      apiKey: opts.apiKey,
    },
    specialties: opts.specialties ?? [],
  };

  saveConfig(config);
  return config;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

/** Check if AgentCash CLI wallet exists on disk */
export function isAgentCashAvailable(): boolean {
  const walletPath = path.join(os.homedir(), ".agentcash", "wallet.json");
  return fs.existsSync(walletPath);
}
