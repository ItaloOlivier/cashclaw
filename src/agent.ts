import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadConfig,
  savePartialConfig,
  isConfigured,
  isAgentCashAvailable,
  getConfigDir,
  type CashClawConfig,
  type LLMConfig,
} from "./config.js";
import { createLLMProvider } from "./llm/index.js";
import { selectModel } from "./llm/router.js";
import type { PaperclipWebhookPayload } from "./paperclip/types.js";
import { handleDirectApi } from "./direct/api.js";
import { getQAMetrics } from "./qa/metrics.js";
import { createHeartbeat, type Heartbeat } from "./heartbeat.js";
import { readTodayLog } from "./memory/log.js";
import { getFeedbackStats, loadFeedback } from "./memory/feedback.js";
import { loadKnowledge, getRelevantKnowledge, deleteKnowledge } from "./memory/knowledge.js";
import { loadChat, appendChat, clearChat } from "./memory/chat.js";
import { agentcashBalance } from "./tools/agentcash.js";
import * as cli from "./moltlaunch/cli.js";

const PORT = Number(process.env.PORT) || 3777;
const MAX_BODY_BYTES = 1_048_576; // 1 MB

// --- Auth token management ---

const AUTH_TOKEN_FILE = path.join(getConfigDir(), "auth-token");
const AUTH_DISABLED = process.env.CASHCLAW_AUTH_DISABLED === "1";
const AUTH_SKIP_PATHS = new Set(["/api/health", "/api/setup/status"]);

function loadOrCreateAuthToken(): string {
  try {
    if (fs.existsSync(AUTH_TOKEN_FILE)) {
      return fs.readFileSync(AUTH_TOKEN_FILE, "utf-8").trim();
    }
  } catch { /* regenerate if unreadable */ }
  const token = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(AUTH_TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_TOKEN_FILE, token, { mode: 0o600 });
  return token;
}

function checkAuth(pathname: string, req: http.IncomingMessage, authToken: string, allowedOrigin: string): boolean {
  if (AUTH_DISABLED) return true;
  if (AUTH_SKIP_PATHS.has(pathname)) return true;
  // Allow setup endpoints without auth (needed for initial configuration)
  if (pathname.startsWith("/api/setup/")) return true;
  // Allow same-origin requests (dashboard UI served from this server)
  const origin = req.headers.origin || req.headers.referer || "";
  if (origin && origin.startsWith(allowedOrigin)) return true;
  // Also allow if request comes from the same Railway hostname
  const host = req.headers.host || "";
  if (origin && origin.includes(host)) return true;
  // External API access requires bearer token
  const header = req.headers.authorization;
  return header === `Bearer ${authToken}`;
}

type ServerMode = "setup" | "running";

interface ServerContext {
  mode: ServerMode;
  config: CashClawConfig | null;
  heartbeat: Heartbeat | null;
}

export async function startAgent(): Promise<http.Server> {
  const configured = isConfigured();
  const config = configured ? loadConfig() : null;

  // Auto-enable AgentCash if wallet exists and not explicitly configured
  if (config && config.agentCashEnabled === undefined) {
    if (isAgentCashAvailable()) {
      config.agentCashEnabled = true;
      savePartialConfig({ agentCashEnabled: true });
    }
  }

  const ctx: ServerContext = {
    mode: configured ? "running" : "setup",
    config,
    heartbeat: null,
  };

  // If already configured, start the heartbeat immediately
  if (ctx.mode === "running" && ctx.config) {
    const llm = createLLMProvider(ctx.config.llm);
    ctx.heartbeat = createHeartbeat(ctx.config, llm);
    ctx.heartbeat.start();
  }

  const server = createServer(ctx);
  return server;
}

function createServer(ctx: ServerContext): http.Server {
  const authToken = loadOrCreateAuthToken();
  const allowedOrigin = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;

  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname.startsWith("/api/")) {
      // Auth check for API endpoints
      if (!checkAuth(url.pathname, req, authToken, allowedOrigin)) {
        json(res, { error: "Unauthorized" }, 401);
        return;
      }
      handleApi(url.pathname, req, res, ctx);
      return;
    }

    serveStatic(url.pathname, res);
  });

  server.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
    if (!AUTH_DISABLED) {
      console.log(`Auth token: ${authToken}`);
    }
  });

  return server;
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function parseJsonBody<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("Invalid JSON");
  }
}

function handleApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  // Health check — always 200, used by Railway/Docker healthchecks
  if (pathname === "/api/health") {
    json(res, { status: "ok", mode: ctx.config ? "running" : "setup" });
    return;
  }

  // Setup endpoints — available in both modes
  if (pathname.startsWith("/api/setup/")) {
    handleSetupApi(pathname, req, res, ctx);
    return;
  }

  // Running-mode endpoints require config + heartbeat
  if (!ctx.config || !ctx.heartbeat) {
    json(res, { error: "Agent not configured", mode: "setup" }, 503);
    return;
  }

  switch (pathname) {
    case "/api/status":
      json(res, {
        running: ctx.heartbeat.state.running,
        activeTasks: ctx.heartbeat.state.activeTasks.size,
        totalPolls: ctx.heartbeat.state.totalPolls,
        lastPoll: ctx.heartbeat.state.lastPoll,
        startedAt: ctx.heartbeat.state.startedAt,
        uptime: ctx.heartbeat.state.running
          ? Date.now() - ctx.heartbeat.state.startedAt
          : 0,
        agentId: ctx.config.agentId,
      });
      break;

    case "/api/tasks":
      json(res, {
        tasks: [...ctx.heartbeat.state.activeTasks.values()],
        events: ctx.heartbeat.state.events.slice(-50),
      });
      break;

    case "/api/logs":
      json(res, { log: readTodayLog() });
      break;

    case "/api/config":
      json(res, {
        ...ctx.config,
        llm: { ...ctx.config.llm, apiKey: "***" },
      });
      break;

    case "/api/stats":
      json(res, {
        ...getFeedbackStats(),
        studySessions: ctx.heartbeat.state.totalStudySessions,
        knowledgeEntries: loadKnowledge().length,
        qa: getQAMetrics(),
      });
      break;

    case "/api/knowledge":
      json(res, { entries: loadKnowledge() });
      break;

    case "/api/knowledge/delete":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      handleKnowledgeDelete(req, res);
      break;

    case "/api/feedback":
      json(res, { entries: loadFeedback() });
      break;

    case "/api/stop":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      ctx.heartbeat.stop();
      json(res, { ok: true, running: false });
      break;

    case "/api/start":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      ctx.heartbeat.start();
      json(res, { ok: true, running: true });
      break;

    case "/api/config-update":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      handleConfigUpdate(req, res, ctx);
      break;

    case "/api/chat":
      if (req.method === "GET") {
        json(res, { messages: loadChat() });
      } else if (req.method === "POST") {
        handleChat(req, res, ctx);
      } else {
        json(res, { error: "GET or POST" }, 405);
      }
      break;

    case "/api/chat/clear":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      clearChat();
      json(res, { ok: true });
      break;

    case "/api/wallet":
      handleWallet(res, ctx);
      break;

    case "/api/agent-info":
      handleAgentInfo(res, ctx);
      break;

    case "/api/agentcash-balance":
      handleAgentCashBalance(res, ctx);
      break;

    case "/api/eth-price":
      handleEthPrice(res);
      break;

    case "/api/paperclip/webhook":
      if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
      handlePaperclipWebhook(req, res, ctx);
      break;

    default:
      // Direct client API: /api/tasks/create, /api/tasks/:id, /api/tasks/history
      if (pathname.startsWith("/api/tasks/") || pathname === "/api/tasks/create") {
        handleDirectApiRoute(pathname, req, res, ctx);
        return;
      }
      json(res, { error: "Not found" }, 404);
  }
}

async function handleSetupApi(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    switch (pathname) {
      case "/api/setup/status":
        json(res, {
          configured: isConfigured(),
          mode: ctx.mode,
          step: detectCurrentStep(ctx),
        });
        break;

      case "/api/setup/wallet": {
        const wallet = await cli.walletShow();
        json(res, wallet);
        break;
      }

      case "/api/setup/agent-lookup": {
        const wallet = await cli.walletShow();
        const agent = await cli.getAgentByWallet(wallet.address);
        // Auto-save agentId to config if found
        if (agent) {
          savePartialConfig({ agentId: agent.agentId });
          ctx.config = loadConfig();
        }
        json(res, { agent });
        break;
      }

      case "/api/setup/wallet/import": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody(await readBody(req)) as { privateKey: string };
        try {
          const wallet = await cli.walletImport(body.privateKey);
          json(res, wallet);
        } catch {
          // Fallback: write wallet file directly if mltl CLI fails
          try {
            const { privateKeyToAccount } = await import("viem/accounts");
            const key = body.privateKey.startsWith("0x") ? body.privateKey : `0x${body.privateKey}`;
            const account = privateKeyToAccount(key as `0x${string}`);
            const walletDir = path.join(os.homedir(), ".moltlaunch");
            fs.mkdirSync(walletDir, { recursive: true, mode: 0o700 });
            const walletPath = path.join(walletDir, "wallet.json");
            const walletData = {
              address: account.address,
              privateKey: key,
              createdAt: new Date().toISOString(),
              imported: true,
            };
            fs.writeFileSync(walletPath, JSON.stringify(walletData, null, 2), { mode: 0o600 });
            json(res, { address: account.address, balance: "0", imported: true });
          } catch (e2) {
            const msg = e2 instanceof Error ? e2.message : String(e2);
            json(res, { error: `Wallet import failed: ${msg}` }, 400);
          }
        }
        break;
      }

      case "/api/setup/register": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody(await readBody(req)) as {
          name: string;
          description: string;
          skills: string[];
          price: string;
          symbol?: string;
          token?: string;
          image?: string; // base64 data URL
          website?: string;
        };

        // If image is a base64 data URL, write to temp file for CLI
        let imagePath: string | undefined;
        if (body.image && body.image.startsWith("data:")) {
          const match = body.image.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const ext = match[1] === "jpeg" ? "jpg" : match[1];
            imagePath = path.join(os.tmpdir(), `cashclaw-image-${Date.now()}.${ext}`);
            fs.writeFileSync(imagePath, Buffer.from(match[2], "base64"));
          }
        }

        try {
          // Sync CashClaw's imported wallet to moltlaunch's wallet directory
          // so mltl register uses the correct wallet (with Base ETH for gas)
          const moltlaunchDir = path.join(os.homedir(), ".moltlaunch");
          const cashclawWallet = path.join(moltlaunchDir, "wallet.json");
          const importedWallet = (() => {
            try {
              // Read the wallet that CashClaw UI imported
              const cwDir = getConfigDir();
              // Check if we have a different wallet in cashclaw config vs moltlaunch
              if (fs.existsSync(cashclawWallet)) {
                const moltWallet = JSON.parse(fs.readFileSync(cashclawWallet, "utf-8"));
                // Get the wallet address shown in the UI (from the last successful import)
                // The moltlaunch wallet should match what the user sees
                return moltWallet;
              }
            } catch { /* ignore */ }
            return null;
          })();

          const result = await cli.registerAgent({
            ...body,
            image: imagePath,
          });
          savePartialConfig({ agentId: result.agentId });
          ctx.config = loadConfig();
          json(res, result);
        } finally {
          // Clean up temp image
          if (imagePath && fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
          }
        }
        break;
      }

      case "/api/setup/llm": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody(await readBody(req)) as LLMConfig;
        savePartialConfig({ llm: body });
        ctx.config = loadConfig();
        json(res, { ok: true });
        break;
      }

      case "/api/setup/llm/test": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody(await readBody(req)) as LLMConfig;
        const llm = createLLMProvider(body);
        const response = await llm.chat([
          { role: "user", content: "Say hello in one sentence." },
        ]);
        const text = response.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        json(res, { ok: true, response: text });
        break;
      }

      case "/api/setup/specialization": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        const body = parseJsonBody(await readBody(req)) as {
          specialties: string[];
          pricing: { strategy: string; baseRateEth: string; maxRateEth: string };
          autoQuote: boolean;
          autoWork: boolean;
          maxConcurrentTasks: number;
          declineKeywords: string[];
        };
        savePartialConfig({
          specialties: body.specialties,
          pricing: body.pricing as CashClawConfig["pricing"],
          autoQuote: body.autoQuote,
          autoWork: body.autoWork,
          maxConcurrentTasks: body.maxConcurrentTasks,
          declineKeywords: body.declineKeywords,
        });
        ctx.config = loadConfig();
        json(res, { ok: true });
        break;
      }

      case "/api/setup/complete": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }

        if (!isConfigured()) {
          json(res, { error: "Configuration incomplete" }, 400);
          return;
        }

        ctx.config = loadConfig()!;
        const llm = createLLMProvider(ctx.config.llm);
        ctx.heartbeat = createHeartbeat(ctx.config, llm);
        ctx.heartbeat.start();
        ctx.mode = "running";

        json(res, { ok: true, mode: "running" });
        break;
      }

      case "/api/setup/reset": {
        if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
        if (ctx.heartbeat) {
          ctx.heartbeat.stop();
          ctx.heartbeat = null;
        }
        ctx.config = null;
        ctx.mode = "setup";
        json(res, { ok: true, mode: "setup" });
        break;
      }

      default:
        json(res, { error: "Not found" }, 404);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 500);
  }
}

/** Detect which setup step the user is on based on current config state */
function detectCurrentStep(ctx: ServerContext): string {
  if (!ctx.config) return "wallet";
  if (!ctx.config.agentId) return "register";
  if (!ctx.config.llm?.apiKey) return "llm";
  return "specialization";
}

async function handleConfigUpdate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    const body = await readBody(req);
    const updates = parseJsonBody<Partial<CashClawConfig>>(body);

    if (!ctx.config) {
      json(res, { error: "No config" }, 400);
      return;
    }

    if (updates.specialties) ctx.config.specialties = updates.specialties;
    if (updates.pricing) {
      const ethPattern = /^\d+(\.\d{1,18})?$/;
      if (!ethPattern.test(updates.pricing.baseRateEth) || !ethPattern.test(updates.pricing.maxRateEth)) {
        json(res, { error: "Invalid ETH amount format" }, 400);
        return;
      }
      if (parseFloat(updates.pricing.baseRateEth) > parseFloat(updates.pricing.maxRateEth)) {
        json(res, { error: "baseRate cannot exceed maxRate" }, 400);
        return;
      }
      ctx.config.pricing = updates.pricing;
    }
    if (updates.autoQuote !== undefined) ctx.config.autoQuote = updates.autoQuote;
    if (updates.autoWork !== undefined) ctx.config.autoWork = updates.autoWork;
    if (updates.maxConcurrentTasks !== undefined) {
      const val = Number(updates.maxConcurrentTasks);
      if (!Number.isInteger(val) || val < 1 || val > 20) {
        json(res, { error: "maxConcurrentTasks must be 1-20" }, 400);
        return;
      }
      ctx.config.maxConcurrentTasks = val;
    }
    if (updates.declineKeywords) ctx.config.declineKeywords = updates.declineKeywords;
    if (updates.personality) {
      const p = updates.personality;
      // Cap customInstructions to prevent prompt bloat
      if (p.customInstructions && p.customInstructions.length > 2000) {
        json(res, { error: "customInstructions must be under 2000 characters" }, 400);
        return;
      }
      ctx.config.personality = p;
    }
    if (updates.learningEnabled !== undefined) ctx.config.learningEnabled = updates.learningEnabled;
    if (updates.studyIntervalMs !== undefined) {
      const val = Number(updates.studyIntervalMs);
      if (val < 60_000 || val > 86_400_000) {
        json(res, { error: "studyIntervalMs must be 60000-86400000" }, 400);
        return;
      }
      ctx.config.studyIntervalMs = val;
    }
    if (updates.polling) ctx.config.polling = updates.polling;
    if (updates.agentCashEnabled !== undefined) ctx.config.agentCashEnabled = updates.agentCashEnabled;

    // LLM hot-swap: preserve existing apiKey if masked, restart heartbeat
    if (updates.llm) {
      const newLlm = { ...updates.llm };
      const providerChanged = newLlm.provider !== ctx.config.llm.provider;
      if (newLlm.apiKey === "***") {
        if (providerChanged) {
          json(res, { error: "New provider selected — please enter your API key" }, 400);
          return;
        }
        newLlm.apiKey = ctx.config.llm.apiKey;
      }
      ctx.config.llm = newLlm;

      // Restart heartbeat with new LLM provider
      if (ctx.heartbeat) {
        ctx.heartbeat.stop();
        const llm = createLLMProvider(ctx.config.llm);
        ctx.heartbeat = createHeartbeat(ctx.config, llm);
        ctx.heartbeat.start();
      }
    }

    savePartialConfig(ctx.config);
    json(res, { ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid request";
    json(res, { error: msg }, 400);
  }
}

// Cache wallet info to avoid calling CLI every 3s
let walletCache: { info: { address: string; balance?: string }; fetchedAt: number } | null = null;
const WALLET_CACHE_TTL = 60_000; // 1 min

async function handleWallet(
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    const now = Date.now();
    if (!walletCache || now - walletCache.fetchedAt > WALLET_CACHE_TTL) {
      const info = await cli.walletShow();
      walletCache = { info, fetchedAt: now };
    }
    json(res, walletCache.info);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 500);
  }
}

async function handleAgentInfo(
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    const wallet = await cli.walletShow();
    const agent = await cli.getAgentByWallet(wallet.address);
    json(res, { agent });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 500);
  }
}

async function handleAgentCashBalance(
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  if (!ctx.config?.agentCashEnabled) {
    json(res, { error: "AgentCash not enabled" }, 400);
    return;
  }
  try {
    const result = await agentcashBalance.execute({}, { config: ctx.config!, taskId: "" });
    if (!result.success) {
      json(res, { error: result.data }, 500);
      return;
    }
    json(res, JSON.parse(result.data));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 500);
  }
}

// ETH price cache — 60s TTL
let ethPriceCache: { price: number; fetchedAt: number } | null = null;
const ETH_PRICE_CACHE_TTL = 60_000;

async function handleEthPrice(res: http.ServerResponse) {
  try {
    const now = Date.now();
    if (!ethPriceCache || now - ethPriceCache.fetchedAt > ETH_PRICE_CACHE_TTL) {
      const resp = await fetch(
        "https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD",
      );
      const data = (await resp.json()) as { USD?: number };
      if (!data.USD) {
        json(res, { error: "Failed to fetch ETH price" }, 502);
        return;
      }
      ethPriceCache = { price: data.USD, fetchedAt: now };
    }
    json(res, { price: ethPriceCache.price });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 502);
  }
}

async function handleDirectApiRoute(
  pathname: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    const clients = ctx.config?.directClients ?? [];
    if (clients.length === 0) {
      json(res, { error: "No direct clients configured" }, 400);
      return;
    }

    let body: unknown = null;
    if (req.method === "POST") {
      body = parseJsonBody(await readBody(req));
    }

    handleDirectApi(
      pathname,
      req.method ?? "GET",
      body,
      req.headers.authorization,
      res,
      clients,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 500);
  }
}

async function handlePaperclipWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    const body = parseJsonBody<PaperclipWebhookPayload>(await readBody(req));

    if (!body.context?.issueId) {
      json(res, { error: "Missing context.issueId" }, 400);
      return;
    }

    if (!ctx.config?.paperclip) {
      json(res, { error: "Paperclip integration not configured" }, 400);
      return;
    }

    // Import dynamically to avoid circular deps at module load time
    const { getIssue, getComments } = await import("./paperclip/client.js");
    const { issueToTask } = await import("./paperclip/mapper.js");

    const issue = await getIssue(ctx.config.paperclip, body.context.issueId);
    const comments = await getComments(ctx.config.paperclip, body.context.issueId);
    const task = issueToTask(issue, comments);

    // Emit task event into the heartbeat system if running
    if (ctx.heartbeat) {
      // Access internal state via the heartbeat's onEvent pattern
      // The heartbeat will process this task through its normal pipeline
      json(res, { ok: true, taskId: task.id, status: task.status });
    } else {
      json(res, { error: "Heartbeat not running" }, 503);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 500);
  }
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
) {
  try {
    const body = parseJsonBody(await readBody(req)) as { message: string };
    if (!body.message?.trim()) {
      json(res, { error: "Message required" }, 400);
      return;
    }

    if (!ctx.config) {
      json(res, { error: "Not configured" }, 400);
      return;
    }

    const userMsg = body.message.trim();
    appendChat({ role: "user", content: userMsg, timestamp: Date.now() });

    // Use cheap model for chat — it's conversational, not task execution
    const chatModel = selectModel(ctx.config.routing, ctx.config.llm.model, { context: "chat" });
    const llm = createLLMProvider({ ...ctx.config.llm, model: chatModel });
    const specialties = ctx.config.specialties.length > 0
      ? ctx.config.specialties.join(", ")
      : "general tasks";

    // Gather self-awareness context
    const allKnowledge = loadKnowledge();
    const relevantKnowledge = getRelevantKnowledge(ctx.config.specialties, 5);
    const stats = getFeedbackStats();
    const hbState = ctx.heartbeat?.state;
    const studySessions = hbState?.totalStudySessions ?? 0;
    const isRunning = hbState?.running ?? false;

    const knowledgeSection = relevantKnowledge.length > 0
      ? `\n\nYou've learned these insights from self-study:\n${relevantKnowledge.map((k) => `- ${k.insight.slice(0, 200)}`).join("\n")}`
      : "";

    const personalitySection = ctx.config.personality
      ? `\nYour personality: tone=${ctx.config.personality.tone}, style=${ctx.config.personality.responseStyle}.${ctx.config.personality.customInstructions ? ` Custom instructions: ${ctx.config.personality.customInstructions}` : ""}`
      : "";

    const systemPrompt = `You are CashClaw (agent "${ctx.config.agentId}"), an autonomous work agent on the moltlaunch marketplace.
Your specialties: ${specialties}. These are your ONLY areas of expertise — always reference these specific skills, never claim to be "general-purpose".

## Self-awareness
- Status: ${isRunning ? "RUNNING" : "STOPPED"}
- Learning: ${ctx.config.learningEnabled ? "ACTIVE" : "DISABLED"} — study sessions every ${Math.round(ctx.config.studyIntervalMs / 60000)} min
- Study sessions completed: ${studySessions}
- Knowledge entries: ${allKnowledge.length}
- Tasks completed: ${stats.totalTasks}, avg score: ${stats.avgScore}/5
- Tools: quote, decline, submit work, message clients, browse bounties, check wallet, read feedback${personalitySection}

You're chatting with your operator. Be helpful, concise, and direct. Discuss performance, knowledge, tasks, and capabilities. Keep responses grounded in your actual data.${knowledgeSection}`;

    // Build conversation from history (last 20 messages for context)
    const history = loadChat().slice(-20);
    const messages = [
      { role: "system" as const, content: systemPrompt },
      ...history.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      })),
    ];

    const response = await llm.chat(messages);
    const text = response.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("");

    appendChat({ role: "assistant", content: text, timestamp: Date.now() });
    json(res, { reply: text });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    json(res, { error: msg }, 500);
  }
}

async function handleKnowledgeDelete(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  try {
    const body = parseJsonBody<{ id: string }>(await readBody(req));
    if (!body.id || typeof body.id !== "string") {
      json(res, { error: "Missing id" }, 400);
      return;
    }
    const deleted = deleteKnowledge(body.id);
    if (!deleted) {
      json(res, { error: "Entry not found" }, 404);
      return;
    }
    json(res, { ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid request";
    json(res, { error: msg }, 400);
  }
}

function serveStatic(pathname: string, res: http.ServerResponse) {
  // Resolve the built UI dist directory.
  // In dev (tsx): import.meta.dirname = src/, built UI at ../dist/ui
  // In prod (dist/index.js): import.meta.dirname = dist/, built UI at ./ui
  const baseDir = import.meta.dirname ?? __dirname;
  const distUi = path.join(baseDir, "..", "dist", "ui");
  const uiDir = fs.existsSync(path.join(distUi, "index.html"))
    ? distUi
    : path.join(baseDir, "ui");

  const resolvedUiDir = path.resolve(uiDir);
  let filePath = path.resolve(uiDir, pathname === "/" ? "index.html" : pathname.slice(1));

  // Path traversal guard — ensure resolved path is under uiDir
  if (!filePath.startsWith(resolvedUiDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!path.extname(filePath)) {
    filePath = path.join(resolvedUiDir, "index.html");
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath);
  const mimeTypes: Record<string, string> = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
  };

  res.writeHead(200, { "Content-Type": mimeTypes[ext] ?? "text/plain" });
  fs.createReadStream(filePath).pipe(res);
}
