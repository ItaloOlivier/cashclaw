# Implementation Plan: Paperclip + CashClaw Autonomous Revenue System

## Executive Summary

This plan transforms CashClaw (a 2,694-line autonomous marketplace agent) into a governed, multi-source revenue system orchestrated by Paperclip (a production control plane with 413+ PRs). The work is structured in 6 phases over ~30 days of focused engineering. Phase 1 fixes the 9 P0 bugs that make CashClaw unreliable in production. Phase 2 adds cost controls and model routing that keep LLM spend under 15% of revenue. Phase 3 connects CashClaw to Paperclip as a governed agent via the existing `http` adapter pattern. Phase 4 adds a Haiku-based QA gate before any deliverable reaches a client. Phase 5 diversifies revenue beyond Moltlaunch with a direct-client API and Paperclip board-created tasks. Phase 6 scales to 3 specialized agents under Paperclip orchestration. Each phase ships independently and has a rollback plan.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    PAPERCLIP (Control Plane)                 │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Issues   │  │  Agents  │  │ Heartbeat│  │   Costs   │  │
│  │  Board    │  │  Budget  │  │  Wakeup  │  │  Tracking │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       └──────────────┴─────────────┴──────────────┘         │
│                           │ REST API                        │
└───────────────────────────┼─────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
     ┌────────▼───┐  ┌─────▼──────┐  ┌──▼──────────┐
     │ CashClaw   │  │ CashClaw   │  │ CashClaw    │
     │ Worker #1  │  │ Worker #2  │  │ QA Reviewer  │
     │ (Sonnet)   │  │ (Sonnet)   │  │ (Haiku)     │
     │            │  │            │  │             │
     │ Moltlaunch │  │ Direct API │  │ Review all  │
     │ + Direct   │  │ + Board    │  │ deliverables│
     └────────────┘  └────────────┘  └─────────────┘
              │             │
     ┌────────▼─────────────▼────────┐
     │       Task Sources            │
     │  ┌──────────┐ ┌────────────┐  │
     │  │Moltlaunch│ │Direct API  │  │
     │  │Marketplace│ │(Retainer) │  │
     │  └──────────┘ └────────────┘  │
     │  ┌──────────────────────────┐ │
     │  │Paperclip Board Issues    │ │
     │  └──────────────────────────┘ │
     └───────────────────────────────┘
```

---

## Phase 1: CashClaw Hardening (P0/P1 Bug Fixes)

### Goal
Make CashClaw production-reliable as a standalone agent by fixing all 9 P0 bugs and the highest-impact P1 issues.

### Prerequisites
- CashClaw repo cloned, `pnpm install` working, `vitest` configured

### Changes

#### LLM Retry Logic: `/Users/user/cashclaw/src/llm/index.ts`
- **What:** Add exponential backoff retry for 429/500/502/503 responses. Currently a single transient error kills the task.
- **Before:** Single `fetch()` call, throws on any non-2xx.
- **After:** Up to 3 retries with 1s/2s/4s backoff for retryable status codes. Non-retryable errors (400, 401, 403) throw immediately.
- **Implementation:** Wrap the `fetch()` call in both `createAnthropicProvider` and `createOpenAICompatibleProvider` with a shared `retryableFetch()` helper:
```typescript
// New function in llm/index.ts
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);
const MAX_RETRIES = 3;

async function retryableFetch(url: string, init: RequestInit): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      await new Promise(r => setTimeout(r, delay));
    }
    const res = await fetch(url, init);
    if (res.ok || !RETRYABLE_STATUSES.has(res.status)) return res;
    lastError = new Error(`LLM API ${res.status}: ${await res.text()}`);
  }
  throw lastError!;
}
```

#### Per-Task Cost Tracking: `/Users/user/cashclaw/src/loop/index.ts`
- **What:** Add per-task token budget enforcement. Currently no limit on spend per task.
- **Before:** `runAgentLoop` has no cost awareness. Runs until `maxTurns`.
- **After:** Accept a `maxTokenBudget` parameter (default: 100,000 tokens). Check cumulative usage after each turn. Abort with a clear message if budget exceeded.
- **Implementation:** Add budget check after each `llm.chat()` call:
```typescript
const maxTokens = config.maxTokenBudget ?? 100_000;
// Inside the loop, after tallying tokens:
if (totalInputTokens + totalOutputTokens > maxTokens) {
  return { toolCalls: allToolCalls, reasoning: reasoningParts.join("\n") + "\n[token budget exceeded]",
    turns: turn + 1, usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens } };
}
```

#### Config Type: `/Users/user/cashclaw/src/config.ts`
- **What:** Add `maxTokenBudget` to `CashClawConfig`. Add config validation.
- **Before:** `loadConfig()` does zero validation (line 61-71). Returns raw JSON cast to type.
- **After:** Validate required fields (`agentId`, `llm.provider`, `llm.apiKey`), numeric ranges, and string formats. Add `maxTokenBudget?: number` (default 100,000) and `maxCostPerTaskUsd?: number` (default 0.50) to config type.
- **Implementation:** Add a `validateConfig()` function called inside `loadConfig()`:
```typescript
function validateConfig(raw: unknown): CashClawConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.agentId !== 'string') return null;
  if (!c.llm || typeof c.llm !== 'object') return null;
  const llm = c.llm as Record<string, unknown>;
  if (!['anthropic','openai','openrouter'].includes(llm.provider as string)) return null;
  if (typeof llm.apiKey !== 'string' || !llm.apiKey) return null;
  // ... numeric range checks for polling, pricing, maxConcurrentTasks
  return raw as CashClawConfig;
}
```

#### API Authentication: `/Users/user/cashclaw/src/agent.ts`
- **What:** Add bearer token authentication to all `/api/` endpoints (except `/api/health`).
- **Before:** No authentication at all (line 65). Any process on the network can stop/wipe the agent.
- **After:** Generate a random token on first run, store in config. Require `Authorization: Bearer <token>` on all mutation endpoints. Dashboard sends token automatically.
- **Implementation:** Generate token in `startAgent()`, store in `~/.cashclaw/auth-token`. Middleware check in `handleApi()`:
```typescript
const AUTH_SKIP = new Set(['/api/health', '/api/setup/status']);
function requireAuth(pathname: string, req: http.IncomingMessage, authToken: string): boolean {
  if (AUTH_SKIP.has(pathname)) return true;
  const header = req.headers.authorization;
  return header === `Bearer ${authToken}`;
}
```

#### Race Condition Fix: `/Users/user/cashclaw/src/heartbeat.ts`
- **What:** Fix accepted tasks dropped during processing (lines 185-191).
- **Before:** If a task transitions to "accepted" while already in `processing` set, the update is silently ignored. When processing finishes, the task stays in the old status.
- **After:** When a task is in `processing`, queue the status update. On `processing.delete()`, re-check the latest task state.
- **Implementation:** Add a `pendingUpdates` Map alongside `processing`:
```typescript
const pendingUpdates = new Map<string, Task>();

// In handleTaskEvent, when processing.has(task.id):
if (processing.has(task.id)) {
  pendingUpdates.set(task.id, task); // Queue for re-processing
  state.activeTasks.set(task.id, task);
  return;
}

// In .finally() of the processing promise:
.finally(() => {
  processing.delete(task.id);
  const pending = pendingUpdates.get(task.id);
  if (pending) {
    pendingUpdates.delete(task.id);
    handleTaskEvent(pending);
  }
});
```

#### Memory Leak Fix: `/Users/user/cashclaw/src/heartbeat.ts`
- **What:** `completedTasks` Set (line 68) grows unbounded.
- **Before:** Every completed task ID is added, never removed.
- **After:** Use a bounded LRU-like structure. Keep last 1000 entries, evict oldest.
- **Implementation:** Replace `Set<string>` with a simple bounded set:
```typescript
const MAX_COMPLETED = 1000;
const completedTasks = new Set<string>();
// In handleCompleted, after adding:
if (completedTasks.size > MAX_COMPLETED) {
  const first = completedTasks.values().next().value;
  completedTasks.delete(first);
}
```

#### Submit Work Size Limit: `/Users/user/cashclaw/src/moltlaunch/cli.ts`
- **What:** `submitWork` passes result as CLI argument (line 164) with no size limit. Large outputs crash the shell.
- **Before:** `await mltl<unknown>(["submit", "--task", taskId, "--result", result])` — result passed as argv.
- **After:** Write result to a temp file, pass `--result-file` flag instead. Fall back to stdin if CLI supports it.
- **Implementation:**
```typescript
export async function submitWork(taskId: string, result: string): Promise<void> {
  if (result.length > 50_000) {
    const tmpFile = path.join(os.tmpdir(), `cashclaw-submit-${Date.now()}.txt`);
    fs.writeFileSync(tmpFile, result);
    try {
      await mltl<unknown>(["submit", "--task", taskId, "--result-file", tmpFile]);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  } else {
    await mltl<unknown>(["submit", "--task", taskId, "--result", result]);
  }
}
```

#### Price Validation: `/Users/user/cashclaw/src/tools/marketplace.ts`
- **What:** No price validation on quotes (lines 43-48). Agent could quote 0 or absurdly high prices.
- **Before:** `priceEth` passed directly to CLI with no validation.
- **After:** Validate price is a valid positive number, within configured min/max range.
- **Implementation:** In `quoteTask.execute()`:
```typescript
const price = parseFloat(priceEth);
if (isNaN(price) || price <= 0) {
  return { success: false, data: "Invalid price: must be a positive number" };
}
const maxRate = parseFloat(ctx.config.pricing.maxRateEth);
if (price > maxRate) {
  return { success: false, data: `Price ${priceEth} exceeds max rate ${ctx.config.pricing.maxRateEth}` };
}
```

#### CORS Fix: `/Users/user/cashclaw/src/agent.ts`
- **What:** CORS hardcoded to localhost (line 65). Breaks Railway/cloud deployment.
- **Before:** `const allowedOrigin = \`http://localhost:${PORT}\`;`
- **After:** Read from `CORS_ORIGIN` env var, default to same-origin on localhost. In production, allow the deployment URL.
- **Implementation:**
```typescript
const allowedOrigin = process.env.CORS_ORIGIN || `http://localhost:${PORT}`;
```

#### Max Tokens Stop Reason: `/Users/user/cashclaw/src/loop/index.ts`
- **What:** No handling of `max_tokens` stop reason. Truncated outputs accepted silently.
- **Before:** Only checks `response.stopReason !== "tool_use"`.
- **After:** If `stopReason === "max_tokens"`, log a warning and either retry with continuation or return a clear error.
- **Implementation:** After receiving response:
```typescript
if (response.stopReason === "max_tokens") {
  reasoningParts.push("[output truncated — max_tokens reached]");
  // Don't process tool calls from truncated responses
  return {
    toolCalls: allToolCalls,
    reasoning: reasoningParts.join("\n"),
    turns: turn + 1,
    usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
  };
}
```

#### Structured Logging: `/Users/user/cashclaw/src/heartbeat.ts` and `/Users/user/cashclaw/src/memory/log.ts`
- **What:** Replace console.log calls with structured JSON logging.
- **Before:** Markdown daily logs only.
- **After:** Add JSON log lines to stdout with level, timestamp, taskId, event type. Keep markdown logs for human readability.
- **Implementation:** Add a `structuredLog()` function:
```typescript
function structuredLog(level: "info"|"warn"|"error", event: string, meta?: Record<string,unknown>) {
  const entry = { ts: new Date().toISOString(), level, event, ...meta };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
```

### New Files
- `/Users/user/cashclaw/src/llm/retry.ts` — Shared retryable fetch helper (extracted for testability)
- `/Users/user/cashclaw/src/auth.ts` — Token generation and validation helpers
- `/Users/user/cashclaw/tests/llm-retry.test.ts` — Unit tests for retry logic
- `/Users/user/cashclaw/tests/config-validation.test.ts` — Unit tests for config validation
- `/Users/user/cashclaw/tests/price-validation.test.ts` — Unit tests for price validation
- `/Users/user/cashclaw/tests/heartbeat-race.test.ts` — Unit test for pending update queue

### Test Plan
- **Unit: retry logic** — Mock fetch to return 429 twice then 200, verify 3 attempts made with correct delays. Mock fetch to return 400, verify immediate throw (no retry).
- **Unit: config validation** — Pass configs missing agentId, missing apiKey, with negative polling intervals, with non-numeric pricing. Assert all return null.
- **Unit: price validation** — Call quoteTask.execute with "0", "-1", "abc", "999" (above max). Assert all return `{ success: false }`.
- **Unit: race condition** — Simulate: processing set contains task A. Call handleTaskEvent with updated task A. Verify pendingUpdates contains it. Simulate processing.delete(A). Verify handleTaskEvent called again with the pending update.
- **Unit: completedTasks cap** — Add 1001 entries. Assert size is 1000 and oldest entry is gone.
- **Integration: auth** — Start agent, call `/api/status` without auth header, assert 401. Call with correct token, assert 200.
- **Manual: submit work** — Create a task with >50KB result, verify temp file is created and cleaned up.

### Rollback Plan
Each fix is a self-contained diff. Revert individual commits. No schema changes, no data migration. The auth token feature can be disabled by setting `CASHCLAW_AUTH_DISABLED=1` env var.

### Operating Costs
Same as current: ~$0.50-2.00/day LLM API costs at current Moltlaunch volume (~2 tasks/day). No new infrastructure.

### Success Criteria
- Zero unhandled promise rejections in 24 hours of continuous operation
- LLM retry logic handles a simulated 429 burst (inject via mock) without task failure
- No task dropped during concurrent WS + poll delivery of the same task
- Memory usage stays flat over 48 hours (no completedTasks leak)
- All 6 new test files pass with vitest

### Revenue Impact
Prevents revenue loss from dropped tasks, runaway costs, and silent failures. Estimated: prevents 1-2 failed tasks/week that would otherwise damage reputation.

---

## Phase 2: Cost Optimization & Model Routing

### Goal
Keep LLM API costs under 15% of task revenue by implementing model routing, prompt caching, circuit breakers, and MiroFish-informed decision making.

### Prerequisites
Phase 1 complete. Anthropic API key with prompt caching access. Optional: MiroFish instance running (`MIROFISH_API_URL` env var).

### Changes

#### Model Router: `/Users/user/cashclaw/src/llm/index.ts`
- **What:** Add intelligent model routing. Currently hardcoded to a single model per config.
- **Before:** Every request uses `config.model` regardless of complexity.
- **After:** Three-tier routing: Haiku for classification/simple tasks ($0.80/$4 per 1M), Sonnet for standard work ($3/$15), Opus for complex multi-step tasks ($15/$75). Router decides based on task characteristics.
- **Implementation:** Add a `createRoutedProvider` that wraps the base provider:
```typescript
export interface RoutingConfig {
  classificationModel: string;  // "claude-haiku-3-5-20241022"
  standardModel: string;        // "claude-sonnet-4-20250514"
  complexModel: string;         // "claude-opus-4-20250514"
  routingEnabled: boolean;
}
```
  The router checks: (a) if it's a study session or chat → Haiku, (b) if task description <500 chars and no files → Sonnet, (c) if task has files, revision history, or >1000 chars → Sonnet, (d) explicit "complex" flag → Opus. Default to Sonnet for everything in between.

  **MiroFish enhancement:** When MiroFish is available, the `preQuoteHook` and `preWorkHook` (already implemented in `src/mirofish/hooks.ts`) provide `revisionRisk` and `confidence` signals. Feed these into routing:
  - `revisionRisk: "high"` → route to Sonnet (never Haiku for risky tasks)
  - `confidence: "low"` on feasibility → consider declining the task entirely
  - `acceptanceProbability < 0.3` → auto-decline (not worth the LLM spend)

#### Prompt Caching: `/Users/user/cashclaw/src/llm/index.ts`
- **What:** Add `cache_control` blocks to system prompt for Anthropic provider. System prompt is ~2-4K tokens and identical across all tasks for the same agent.
- **Before:** Full system prompt sent every turn, billed as input tokens every time.
- **After:** System prompt wrapped with `cache_control: { type: "ephemeral" }`. Cached reads cost 0.1x of input tokens.
- **Implementation:** In `createAnthropicProvider`, structure the system message as a content block array:
```typescript
system: [
  { type: "text", text: systemMsg.content, cache_control: { type: "ephemeral" } }
]
```

#### MiroFish-Informed Task Filtering: `/Users/user/cashclaw/src/heartbeat.ts`
- **What:** Use existing MiroFish `preQuoteHook` (already in `src/mirofish/hooks.ts:39-69`) to auto-decline unprofitable or high-risk tasks before entering the agent loop.
- **Before:** MiroFish predictions are injected into the system prompt but not used for go/no-go decisions. The agent still enters the LLM loop for tasks it should decline.
- **After:** Before calling `runAgentLoop`, check MiroFish prediction. If `acceptanceProbability < 0.3` or `confidence === "low"` and task price is below base rate, skip the LLM call entirely and auto-decline. This saves the full LLM cost on unprofitable tasks.
- **Implementation:** In the task processing function, before the agent loop:
```typescript
// In heartbeat.ts, task processing block:
if (task.status === "requested" && isMiroFishAvailable()) {
  const miro = await preQuoteHook(task, config);
  if (miro?.prediction.acceptanceProbability < 0.3 && miro?.prediction.confidence !== "low") {
    structuredLog("info", "mirofish.auto_decline", { taskId: task.id, reason: "low_acceptance", prob: miro.prediction.acceptanceProbability });
    await declineTask(task.id, "Task outside our current capacity for optimal delivery.");
    return;
  }
}
```

#### Circuit Breakers: `/Users/user/cashclaw/src/loop/index.ts`
- **What:** Add per-task limits: max token budget, max tool calls, max cost (USD), max duration.
- **Before:** Only `maxTurns` limit (default 10).
- **After:** Four circuit breakers: `maxTokenBudget` (100K default), `maxToolCalls` (25 default), `maxCostUsd` ($0.50 default), `maxDurationMs` (300,000 default / 5 minutes).
- **Implementation:** Check all four after each turn:
```typescript
const limits = {
  maxTokens: config.maxTokenBudget ?? 100_000,
  maxToolCalls: config.maxToolCalls ?? 25,
  maxCostUsd: config.maxCostPerTaskUsd ?? 0.50,
  maxDurationMs: config.maxTaskDurationMs ?? 300_000,
};
const startTime = Date.now();
// After each turn:
if (allToolCalls.length > limits.maxToolCalls) return abortResult("tool_call_limit");
if (estimateCost(totalInputTokens, totalOutputTokens) > limits.maxCostUsd) return abortResult("cost_limit");
if (Date.now() - startTime > limits.maxDurationMs) return abortResult("duration_limit");
```

#### Cost Estimator: New file
- **What:** Estimate USD cost from token counts using known pricing.
- **Implementation:** Simple lookup table:
```typescript
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-3-5-20241022": { input: 0.80, output: 4.00 },
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
  "claude-opus-4-20250514": { input: 15.00, output: 75.00 },
};
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model] ?? PRICING["claude-sonnet-4-20250514"];
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
```

#### Config Changes: `/Users/user/cashclaw/src/config.ts`
- **What:** Add `routing`, `maxTokenBudget`, `maxToolCalls`, `maxCostPerTaskUsd`, `maxTaskDurationMs` to `CashClawConfig`.
- **All new fields have defaults.** No breaking change to existing configs.

### New Files
- `/Users/user/cashclaw/src/llm/router.ts` — Model routing logic
- `/Users/user/cashclaw/src/llm/cost.ts` — Cost estimation from token counts
- `/Users/user/cashclaw/tests/router.test.ts` — Unit tests for routing decisions
- `/Users/user/cashclaw/tests/circuit-breaker.test.ts` — Unit tests for all 4 breakers

### Test Plan
- **Unit: router** — Assert study sessions route to Haiku. Assert standard tasks route to Sonnet. Assert tasks flagged complex route to Opus.
- **Unit: cost estimator** — Assert 1000 input + 500 output tokens on Sonnet = $0.0105.
- **Unit: circuit breakers** — Mock LLM to return tool_use indefinitely. Assert loop exits after 25 tool calls. Mock LLM to use 200K tokens. Assert loop exits at 100K. Assert duration breaker fires after 5s (use fake timers).
- **Integration: prompt caching** — Send two requests with same system prompt to Anthropic API. Verify second request shows `cache_read_input_tokens > 0` in response.

### Rollback Plan
Set `routingEnabled: false` in config to disable routing (falls back to single model). Circuit breakers can be set to very high values to effectively disable them.

### Operating Costs
- **Before (Sonnet only):** ~$0.03-0.10 per task (avg 5K input, 2K output tokens per turn, 3 turns)
- **After (with caching + routing):** ~$0.01-0.04 per task. Study sessions drop from ~$0.03 to ~$0.003 (Haiku).
- **Monthly at 60 tasks:** Before: $1.80-6.00. After: $0.60-2.40.
- **Target:** LLM costs <15% of revenue. At avg 0.005 ETH/task ($12.50 at $2500/ETH), 60 tasks = $750 revenue. $2.40 cost = 0.3%.

### Success Criteria
- Prompt cache hit rate >80% on second+ turns of multi-turn tasks
- Average cost per task measurably lower than Phase 1 (track in daily logs)
- No task aborted by circuit breaker during normal operation (breakers only fire on runaway loops)
- Study sessions confirmed routing to Haiku via structured logs

### Revenue Impact
Reduces operating costs by ~60%. At scale (300+ tasks/month), saves $10-20/month. More importantly, sets the foundation for profitability as volume grows.

---

## Phase 3: Paperclip Integration

### Goal
Connect CashClaw to Paperclip as a governed agent, enabling Paperclip to assign tasks, track costs, and enforce budgets while CashClaw executes work.

### Prerequisites
Phase 2 complete. Paperclip instance running locally or on Railway.

### Changes

#### CashClaw HTTP Webhook Endpoint: `/Users/user/cashclaw/src/agent.ts`
- **What:** Add a `/api/paperclip/webhook` endpoint that Paperclip's `http` adapter can call to trigger task execution.
- **Before:** CashClaw only receives tasks from Moltlaunch WS/polling.
- **After:** Paperclip sends a POST with `{ agentId, runId, context: { taskId, issueId, wakeReason, ... } }`. CashClaw looks up the issue via Paperclip API, executes work, and reports back.
- **Implementation:** Add new route in `handleApi()`:
```typescript
case "/api/paperclip/webhook":
  if (req.method !== "POST") { json(res, { error: "POST only" }, 405); return; }
  handlePaperclipWebhook(req, res, ctx);
  break;
```

#### Paperclip Task Source: New file
- **What:** Alternative to `src/moltlaunch/cli.ts` that reads tasks from Paperclip's REST API.
- **Before:** CashClaw only knows Moltlaunch task format.
- **After:** `src/paperclip/client.ts` provides: `getAssignedIssues()`, `getIssue()`, `checkoutIssue()`, `updateIssue()`, `addComment()`, `reportCost()`. Maps Paperclip issues to CashClaw's internal `Task` type.
- **Key interfaces:**
```typescript
interface PaperclipConfig {
  apiUrl: string;       // e.g. "http://localhost:4000"
  apiKey: string;       // pcp_... agent API key
  agentId: string;      // Paperclip agent UUID
  companyId: string;    // Paperclip company UUID
}

// Maps Paperclip issue → CashClaw Task
function issueToTask(issue: PaperclipIssue): Task {
  return {
    id: issue.id,
    agentId: issue.assigneeAgentId ?? "",
    clientAddress: issue.createdByUserId ?? "",
    task: `${issue.title}\n\n${issue.description ?? ""}`,
    status: mapStatus(issue.status), // "todo" → "accepted", "in_review" → "revision"
    messages: issue.comments?.map(c => ({
      sender: c.authorUserId ?? c.authorAgentId ?? "",
      role: c.authorAgentId ? "agent" : "client",
      content: c.body,
      timestamp: new Date(c.createdAt).getTime(),
    })),
  };
}
```

#### Paperclip Cost Reporting: `/Users/user/cashclaw/src/loop/index.ts`
- **What:** After each agent loop, report token usage back to Paperclip via `POST /api/costs`.
- **Before:** Token usage tracked locally in daily logs only.
- **After:** If Paperclip config is present, POST cost event with provider, model, input/output tokens, and estimated cost.
- **Implementation:** At end of `runAgentLoop()`, if `config.paperclip` is set:
```typescript
if (config.paperclip) {
  await reportCostToPaperclip(config.paperclip, {
    agentId: config.paperclip.agentId,
    issueId: task.id,
    provider: config.llm.provider,
    model: config.llm.model,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    costCents: Math.round(estimateCostUsd(config.llm.model, totalInputTokens, totalOutputTokens) * 100),
  });
}
```

#### Paperclip Agent Registration (Manual)
- **What:** Document how to create a CashClaw agent in Paperclip and configure the `http` adapter.
- **Paperclip agent config:**
```json
{
  "name": "CashClaw Worker",
  "role": "individual_contributor",
  "adapterType": "http",
  "adapterConfig": {
    "url": "http://localhost:3777/api/paperclip/webhook",
    "method": "POST",
    "headers": { "Authorization": "Bearer <cashclaw-auth-token>" },
    "timeoutMs": 300000
  },
  "budgetMonthlyCents": 5000
}
```
- No schema changes required. The `http` adapter in Paperclip already supports this pattern (see `/Users/user/paperclip/server/src/adapters/http/execute.ts`).

#### Heartbeat Integration: `/Users/user/cashclaw/src/heartbeat.ts`
- **What:** Add a second task source. Heartbeat polls Moltlaunch AND checks Paperclip assignments.
- **Before:** Only polls Moltlaunch inbox.
- **After:** If `config.paperclip` is configured, also fetches assigned issues from Paperclip API during each poll tick. Paperclip tasks enter the same `handleTaskEvent` pipeline after mapping.
- **Implementation:** In `tick()`:
```typescript
// After Moltlaunch polling:
if (config.paperclip) {
  try {
    const issues = await paperclipClient.getAssignedIssues(config.paperclip);
    for (const issue of issues) {
      const task = issueToTask(issue);
      handleTaskEvent(task);
    }
  } catch (err) {
    // Log but don't fail — Moltlaunch tasks still work
    emit({ type: "error", message: `Paperclip poll error: ${err}` });
  }
}
```

### New Files
- `/Users/user/cashclaw/src/paperclip/client.ts` — Paperclip REST API client (~150 lines)
- `/Users/user/cashclaw/src/paperclip/types.ts` — Paperclip issue/comment types
- `/Users/user/cashclaw/src/paperclip/mapper.ts` — Paperclip issue → CashClaw Task mapper
- `/Users/user/cashclaw/tests/paperclip-mapper.test.ts` — Unit tests for status/task mapping

### Schema Changes
**None.** The `http` adapter and all required Paperclip tables already exist. CashClaw agent is created via the existing Paperclip API.

### Test Plan
- **Unit: mapper** — Map a Paperclip issue with status "todo" → assert CashClaw Task status "accepted". Map "in_review" → "revision". Map "done" → "completed".
- **Unit: webhook** — POST to `/api/paperclip/webhook` with mock context, assert task is queued for processing.
- **Integration: end-to-end flow** — Create a Paperclip issue assigned to CashClaw agent. Trigger heartbeat (or wait for poll). Verify CashClaw checks out the issue, processes it, updates status, and reports cost.
- **Manual: dual-source** — Run CashClaw with both Moltlaunch and Paperclip configured. Create tasks in both. Verify both are processed without interference.

### Rollback Plan
Remove `paperclip` key from CashClaw config. CashClaw falls back to Moltlaunch-only mode. No Paperclip schema changes to revert.

### Operating Costs
- Paperclip instance: ~$0 (runs on same machine or free-tier Railway)
- API calls: negligible (polling every 30s = ~2,880 req/day, all local)
- LLM costs: Same as Phase 2 (tasks from Paperclip use same models)

### Success Criteria
- A Paperclip issue assigned to CashClaw agent is picked up within 60 seconds
- Cost events appear in Paperclip's cost dashboard within 5 seconds of task completion
- CashClaw budget enforcement via Paperclip: agent auto-pauses when monthly budget exceeded
- Moltlaunch tasks continue to work alongside Paperclip tasks

### Revenue Impact
Opens Paperclip as a task source. Board operators can now create tasks directly. Foundation for Phase 5 revenue diversification.

---

## Phase 4: Quality Gate

### Goal
Every deliverable is reviewed by a Haiku-based QA agent before submission to clients. Target: <10% revision rate.

### Prerequisites
Phase 2 complete (model routing needed for Haiku reviewer). Phase 3 nice-to-have but not required.

### Changes

#### QA Review Step: `/Users/user/cashclaw/src/loop/index.ts`
- **What:** After the main agent loop produces a `submit_work` tool call, intercept it and send the deliverable to a Haiku-based reviewer before actual submission.
- **Before:** `submit_work` tool call goes directly to Moltlaunch/Paperclip.
- **After:** Two-step process: (1) Worker produces deliverable. (2) Reviewer evaluates quality. If approved, submit. If rejected, feed reviewer's feedback back to worker for one revision pass. Max 1 revision loop to avoid runaway costs.
- **Implementation:** Modify `executeTool()` in registry to intercept `submit_work`:
```typescript
// In tools/registry.ts executeTool():
if (name === "submit_work" && ctx.config.qaReviewEnabled !== false) {
  const result = input.result as string;
  const review = await runQAReview(ctx.config, input.task_id as string, result);
  if (review.approved) {
    return await tool.execute(input, ctx); // Submit
  }
  // Return feedback to the worker loop instead of submitting
  return {
    success: false,
    data: `QA Review REJECTED. Revise before submitting:\n${review.feedback}`,
  };
}
```

#### QA Reviewer: New file
- **What:** Haiku-based quality evaluator. Reviews deliverables against task requirements.
- **Implementation:**
```typescript
interface QAReviewResult {
  approved: boolean;
  feedback: string;
  score: number; // 1-5
  checklist: { item: string; passed: boolean }[];
}

async function runQAReview(
  config: CashClawConfig,
  taskId: string,
  deliverable: string,
): Promise<QAReviewResult> {
  const haiku = createLLMProvider({
    provider: "anthropic",
    model: "claude-haiku-3-5-20241022",
    apiKey: config.llm.apiKey,
  });

  const task = await getTaskContext(taskId); // Fetch original task description
  const response = await haiku.chat([
    { role: "system", content: QA_SYSTEM_PROMPT },
    { role: "user", content: `## Task\n${task}\n\n## Deliverable\n${deliverable}` },
  ]);
  // Parse structured response...
}
```
  The QA system prompt checks: (1) Does the deliverable address all requirements? (2) Is it complete (not an outline)? (3) Is the formatting appropriate? (4) Are there obvious errors?

#### MiroFish-Informed QA: `/Users/user/cashclaw/src/qa/reviewer.ts`
- **What:** Feed MiroFish's `preWorkHook` strategy into the QA reviewer as a targeted checklist.
- **Before:** QA reviewer only sees the task description and deliverable — generic review.
- **After:** If MiroFish provided strategy (already in `src/mirofish/hooks.ts:75-107`), the QA prompt includes:
  - `revisionRisk` level ("high" → reviewer applies stricter criteria)
  - `keyConsiderations` as an explicit checklist (e.g., "Client expects bullet-point format", "Must include code examples")
  - `qualityThreshold` as the pass/fail bar
- **Implementation:** Pass MiroFish strategy to the QA function:
```typescript
async function runQAReview(
  config: CashClawConfig,
  taskId: string,
  deliverable: string,
  miroStrategy?: MiroStrategy | null, // From preWorkHook
): Promise<QAReviewResult> {
  let checklist = "";
  if (miroStrategy) {
    checklist = `\n## MiroFish Risk Assessment\n- Revision risk: ${miroStrategy.revisionRisk}\n` +
      `- Quality threshold: ${miroStrategy.qualityThreshold}\n` +
      `- Key considerations:\n${miroStrategy.keyConsiderations.map(c => `  - ${c}`).join("\n")}\n` +
      `\nPay special attention to the key considerations above — these are predicted revision risks.`;
  }
  // Include checklist in QA system prompt...
}
```

#### MiroFish Outcome Calibration: `/Users/user/cashclaw/src/mirofish/hooks.ts`
- **What:** Extend the existing `postCompleteHook` (line 113-142) to also report QA results — not just client ratings.
- **Before:** `postCompleteHook` only fires after client rates the work.
- **After:** Also call MiroFish with QA approval/rejection data. This gives MiroFish two calibration signals per task: (1) QA reviewer's assessment immediately after work, (2) client's actual rating later.
- **Implementation:** Add a `postQAReviewHook` that calls `reportOutcome` with QA data:
```typescript
export async function postQAReviewHook(
  task: Task,
  qaResult: QAReviewResult,
): Promise<void> {
  if (!isMiroFishAvailable()) return;
  await reportOutcome(
    task.task,
    "", // No price context for QA
    qaResult.score, // QA score as proxy for quality
    qaResult.feedback,
    !qaResult.approved, // treated as "revision needed"
  );
}
```

#### Quality Metrics: `/Users/user/cashclaw/src/memory/feedback.ts`
- **What:** Track QA approval rate, revision rate, and correlation with client satisfaction.
- **Before:** Only client feedback stored.
- **After:** Also store QA review results. Calculate: approval rate (% passing first review), revision rate (% needing revision), and correlation between QA score and client score.
- **New type:**
```typescript
interface QAMetrics {
  totalReviews: number;
  approvedFirstPass: number;
  revisedAndApproved: number;
  rejectedAfterRevision: number;
  avgQAScore: number;
  clientScoreCorrelation: number; // -1 to 1
}
```

### New Files
- `/Users/user/cashclaw/src/qa/reviewer.ts` — QA review logic (~120 lines)
- `/Users/user/cashclaw/src/qa/prompts.ts` — QA system prompt and rubric
- `/Users/user/cashclaw/src/qa/metrics.ts` — QA metrics tracking
- `/Users/user/cashclaw/tests/qa-reviewer.test.ts` — Unit tests for review logic

### Test Plan
- **Unit: reviewer parse** — Mock Haiku response with approval, verify `QAReviewResult.approved === true`. Mock rejection response, verify feedback extracted correctly.
- **Unit: intercept flow** — Call `executeTool("submit_work", ...)` with QA enabled. Mock reviewer to reject. Verify the tool returns `success: false` with feedback, NOT a submission.
- **Unit: metrics** — Store 10 QA results, verify approval rate calculation is correct.
- **Integration: full loop** — Run agent loop on a task. Verify QA review runs before submission. If approved, verify submission happens. If rejected, verify worker gets feedback and produces revised output.
- **Manual: quality comparison** — Run 10 tasks with QA enabled vs 10 without. Compare client satisfaction scores.

### Rollback Plan
Set `qaReviewEnabled: false` in config. Deliverables submit directly without review.

### Operating Costs
- QA review per task: ~2K input + 500 output tokens on Haiku = $0.0036
- At 60 tasks/month: $0.22/month additional
- Revision pass (20% of tasks): additional $0.04 per revision on Sonnet = $0.48/month
- Total: ~$0.70/month

### Success Criteria
- QA catches at least 1 in 10 deliverables that would have been inadequate (measured by subsequent revision requests)
- Client revision request rate drops by >30% compared to pre-QA baseline
- QA false positive rate <5% (deliverables rejected by QA but would have been accepted by client)
- QA review adds <3 seconds latency per task (Haiku is fast)

### Revenue Impact
Directly increases client satisfaction → higher ratings → more task assignments. At Moltlaunch's reputation-based ranking, a 0.5-point average rating improvement could double task volume.

---

## Phase 5: Revenue Diversification

### Goal
Add task sources beyond Moltlaunch so revenue is not dependent on a single marketplace with ~60 orders/month platform-wide.

### Prerequisites
Phase 3 complete (Paperclip integration).

### Changes

#### Direct Client API: `/Users/user/cashclaw/src/agent.ts`
- **What:** Add a REST API for direct client task submission. White-label endpoint for retainer clients.
- **Before:** Tasks only come from Moltlaunch or Paperclip.
- **After:** `POST /api/tasks/create` accepts task description, budget, and callback URL. Returns task ID. Client polls `GET /api/tasks/{id}/status` or receives webhook on completion.
- **Implementation:**
```typescript
// New endpoints in handleApi():
case "/api/tasks/create":
  // Accepts: { description, budgetUsd, callbackUrl, clientId, clientApiKey }
  // Validates client API key against config.directClients[]
  // Creates internal task and queues for processing
  break;
case "/api/tasks/{id}/status":
  // Returns current status, result if complete
  break;
```

#### Client Management: `/Users/user/cashclaw/src/config.ts`
- **What:** Add `directClients` array to config for retainer client API keys.
```typescript
interface DirectClient {
  id: string;
  name: string;
  apiKey: string;
  monthlyBudgetUsd: number;
  allowedSpecialties: string[];
}
```

#### Paperclip Board Tasks: `/Users/user/cashclaw/src/paperclip/client.ts`
- **What:** Paperclip board users can now create issues assigned to CashClaw. These flow through the Phase 3 integration automatically.
- **Before:** Phase 3 already handles Paperclip-assigned tasks.
- **After:** No additional code needed — this is documentation and workflow guidance. Board users create issues in Paperclip UI, assign to CashClaw agent, and CashClaw picks them up via existing polling.

#### Task Source Abstraction: `/Users/user/cashclaw/src/heartbeat.ts`
- **What:** Refactor heartbeat to use a pluggable task source interface instead of hardcoded Moltlaunch + Paperclip calls.
- **Before:** `tick()` directly calls `cli.getInbox()` and `paperclipClient.getAssignedIssues()`.
- **After:**
```typescript
interface TaskSource {
  name: string;
  poll(): Promise<Task[]>;
  isEnabled(): boolean;
}
```
  Three implementations: `MoltlaunchSource`, `PaperclipSource`, `DirectClientSource`. Heartbeat iterates all enabled sources.

#### Direct Client Webhook Delivery: New file
- **What:** When a direct-client task completes, POST the result to the client's callback URL.
- **Implementation:**
```typescript
async function deliverResult(task: InternalTask, result: string): Promise<void> {
  if (!task.callbackUrl) return;
  await fetch(task.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId: task.id, status: "completed", result }),
  });
}
```

### New Files
- `/Users/user/cashclaw/src/sources/interface.ts` — TaskSource interface
- `/Users/user/cashclaw/src/sources/moltlaunch.ts` — Moltlaunch source (extracted from heartbeat)
- `/Users/user/cashclaw/src/sources/paperclip.ts` — Paperclip source (extracted from Phase 3)
- `/Users/user/cashclaw/src/sources/direct.ts` — Direct client API source
- `/Users/user/cashclaw/src/direct/api.ts` — Direct client REST endpoints
- `/Users/user/cashclaw/src/direct/store.ts` — In-memory + file-backed task store for direct clients
- `/Users/user/cashclaw/tests/direct-api.test.ts` — Direct client API tests
- `/Users/user/cashclaw/tests/task-source.test.ts` — TaskSource interface tests

### Test Plan
- **Unit: direct client auth** — POST `/api/tasks/create` with invalid API key, assert 401. With valid key, assert task created.
- **Unit: task source abstraction** — Create mock TaskSource, register in heartbeat, verify tasks are polled and processed.
- **Unit: webhook delivery** — Complete a direct-client task, verify callback URL receives the result.
- **Integration: multi-source** — Configure all three sources. Create one task in each. Verify all three are processed.
- **Manual: retainer client flow** — Create a direct client config, submit 5 tasks via API, verify all complete and callbacks fire.

### Rollback Plan
Remove `directClients` from config to disable direct API. Task source abstraction is backwards-compatible — if only Moltlaunch source is configured, behavior is identical to Phase 2.

### Operating Costs
- No additional infrastructure for direct client API (runs on same process)
- LLM costs scale linearly with task volume
- At 10 direct-client tasks/month + 60 Moltlaunch: ~$2.80/month LLM

### Success Criteria
- Direct client API processes a task end-to-end in <5 minutes (clock time)
- At least 1 retainer client onboarded within 2 weeks of Phase 5 deployment
- Moltlaunch is <80% of total task volume by end of month 2
- Paperclip board tasks process identically to Moltlaunch tasks (same quality, same cost tracking)

### Revenue Impact
- Direct client tasks at $5-25/task (no marketplace fee), 10 tasks/month = $50-250/month
- Paperclip board tasks: internal productivity, not direct revenue but enables team scaling
- Target: 3x revenue diversification within 60 days

---

## Phase 6: Fleet Operations (3 Specialized Agents)

### Goal
Scale from 1 generalist agent to 3 specialized agents under Paperclip orchestration, with a dedicated QA agent.

### Prerequisites
Phases 3, 4, and 5 complete.

### Changes

#### Agent Specializations

**Agent 1: Content Writer** (Sonnet)
- Specialties: copywriting, blog posts, social media, email campaigns, product descriptions
- Why: Highest volume category on freelance marketplaces. Well-specified, short tasks. High AI success rate.
- Budget: $25/month

**Agent 2: Code Assistant** (Sonnet)
- Specialties: code review, bug fixes, small features, scripting, data transformation
- Why: Second highest demand. Well-suited to LLM strengths. Deliverables are verifiable.
- Budget: $25/month

**Agent 3: QA Reviewer** (Haiku)
- Specialties: quality review of all deliverables from agents 1 and 2
- Why: Dedicated reviewer eliminates the Phase 4 in-process review overhead. Can review across agents.
- Budget: $5/month (Haiku is cheap)

This is 3 agents total, well under the 4-agent maximum.

#### Paperclip Orchestration: Triage Routing
- **What:** When a new task arrives (any source), route it to the best-fit agent based on specialty matching.
- **Implementation:** In CashClaw's task handling, add a routing step:
```typescript
function routeTask(task: Task, agents: AgentConfig[]): AgentConfig {
  const scores = agents.map(agent => ({
    agent,
    score: agent.specialties.reduce((s, spec) =>
      s + (task.task.toLowerCase().includes(spec.toLowerCase()) ? 1 : 0), 0),
  }));
  return scores.sort((a, b) => b.score - a.score)[0].agent;
}
```
  In Paperclip, this is handled by creating the issue with the correct `assigneeAgentId`. The triage logic lives in a simple rule: content keywords → Agent 1, code keywords → Agent 2. Ambiguous → Agent 1 (higher volume, lower risk).

  **MiroFish-enhanced routing:** When MiroFish is available, query `predictTaskFeasibility` with each agent's specialties and compare `acceptanceProbability` and `confidence` across agents. Route to the agent with the highest predicted success. This replaces keyword matching with data-backed routing that improves over time via the `postCompleteHook` feedback loop.
```typescript
async function routeWithMiroFish(task: Task, agents: AgentConfig[]): Promise<AgentConfig> {
  const predictions = await Promise.all(
    agents.filter(a => a.role !== "qa").map(async agent => ({
      agent,
      prediction: await predictTaskFeasibility(
        task.task, task.category, task.budgetWei,
        agent.specialties, agent.pricing.baseRateEth, agent.pricing.maxRateEth,
      ),
    })),
  );
  const scored = predictions
    .filter(p => p.prediction !== null)
    .sort((a, b) => (b.prediction!.acceptanceProbability - a.prediction!.acceptanceProbability));
  return scored[0]?.agent ?? agents[0]; // Fall back to keyword routing if MiroFish unavailable
}
```

#### Cross-Agent MiroFish Learning: `/Users/user/cashclaw/src/mirofish/hooks.ts`
- **What:** All 3 agents share the same MiroFish instance. Outcomes from Agent 1 (Content) calibrate predictions for Agent 2 (Code) and vice versa.
- **Before:** Each CashClaw instance calls MiroFish independently. The feedback loop is already per-task via `postCompleteHook`.
- **After:** No code change needed — MiroFish is a shared service. All agents already POST outcomes to the same MiroFish API. MiroFish naturally learns cross-agent patterns (e.g., "tasks from client X always need revisions regardless of agent").
- **Configuration:** All 3 CashClaw instances point to the same `MIROFISH_API_URL`. Each passes its own `specialties` in the `agentContext`, so MiroFish can differentiate predictions per specialty while learning from all outcomes globally.

#### Per-Agent Configuration: `/Users/user/cashclaw/src/config.ts`
- **What:** Support running multiple CashClaw instances, each with their own config.
- **Before:** Single config at `~/.cashclaw/cashclaw.json`.
- **After:** Config path overridable via `CASHCLAW_CONFIG_PATH` env var. Each agent instance runs as a separate process with its own config.
- **Implementation:** This is already partially supported via `CONFIG_DIR`. Just need to make it configurable:
```typescript
const CONFIG_DIR = process.env.CASHCLAW_CONFIG_DIR
  ?? path.join(os.homedir(), ".cashclaw");
```

#### Cross-Agent Knowledge Sharing: `/Users/user/cashclaw/src/memory/knowledge.ts`
- **What:** Allow agents to share knowledge entries via Paperclip issue comments.
- **Before:** Knowledge is local to each agent instance.
- **After:** When an agent learns something broadly useful (high-rated feedback, specialty insight), it can post it as a Paperclip comment on a shared "Knowledge Base" issue. Other agents pick it up during study sessions.
- **Implementation:** Lightweight — post to a pinned Paperclip issue. Other agents check it during study sessions.

#### Observability Dashboard
- **What:** Paperclip's existing UI already shows agent status, run history, costs, and issues. No new dashboard needed.
- **Monitoring additions:** Structured logs from Phase 1 feed into the existing Paperclip activity log.
- **Alerts:** Configure Paperclip budget alerts at 80% and 100% of monthly cap.

### New Files
- `/Users/user/cashclaw/src/fleet/router.ts` — Task-to-agent routing logic
- `/Users/user/cashclaw/src/fleet/config.ts` — Multi-agent config helpers
- Example configs: `examples/content-writer.json`, `examples/code-assistant.json`, `examples/qa-reviewer.json`
- `/Users/user/cashclaw/tests/fleet-router.test.ts` — Routing logic tests

### Paperclip Configuration
Create 3 agents in Paperclip via API:
```bash
# Agent 1: Content Writer
curl -X POST /api/companies/{companyId}/agents -d '{
  "name": "CashClaw Content",
  "role": "individual_contributor",
  "adapterType": "http",
  "adapterConfig": { "url": "http://host:3778/api/paperclip/webhook" },
  "budgetMonthlyCents": 2500
}'

# Agent 2: Code Assistant
curl -X POST /api/companies/{companyId}/agents -d '{
  "name": "CashClaw Code",
  "role": "individual_contributor",
  "adapterType": "http",
  "adapterConfig": { "url": "http://host:3779/api/paperclip/webhook" },
  "budgetMonthlyCents": 2500
}'

# Agent 3: QA Reviewer
curl -X POST /api/companies/{companyId}/agents -d '{
  "name": "CashClaw QA",
  "role": "individual_contributor",
  "adapterType": "http",
  "adapterConfig": { "url": "http://host:3780/api/paperclip/webhook" },
  "budgetMonthlyCents": 500
}'
```

### Test Plan
- **Unit: routing** — Task "Write a blog post about AI" → routes to Content Writer. Task "Fix the null pointer in auth.ts" → routes to Code Assistant. Task "Review this deliverable" → routes to QA.
- **Unit: config isolation** — Start two CashClaw instances with different `CASHCLAW_CONFIG_DIR`. Verify they use separate configs and memories.
- **Integration: cross-agent flow** — Create task in Paperclip → routed to Agent 1 → Agent 1 produces deliverable → QA Agent reviews → approved → submitted.
- **Manual: fleet observability** — Check Paperclip dashboard shows all 3 agents with correct statuses, costs, and run histories.

### Rollback Plan
Shut down extra agent processes. Revert to single-agent config. Paperclip agents can be paused individually without affecting others.

### Operating Costs
- 3 CashClaw processes: ~150MB RAM each = 450MB total
- LLM costs: Content ($1.50/mo) + Code ($1.50/mo) + QA ($0.50/mo) = $3.50/month at current volume
- Paperclip: negligible additional cost (same instance)
- Infrastructure: 1 Railway service with 3 processes, or 3 separate services = ~$5-10/month

### Success Criteria
- All 3 agents operational and processing tasks within their specialties
- QA reviewer catches >90% of deliverables that would need revision
- No task mis-routed to wrong specialty agent (measured over 50 tasks)
- Total fleet cost under $15/month (infrastructure + LLM)

### Revenue Impact
- 3x task capacity (can handle 3 concurrent tasks instead of 1)
- Specialty matching improves quality → higher ratings → more assignments
- Target: 100+ tasks/month across all sources

---

## Risk Register

| # | Risk | Probability | Impact | Mitigation | Detection |
|---|------|------------|--------|------------|-----------|
| R1 | Moltlaunch API changes break CashClaw | Medium | High | CLI abstraction layer makes changes localized to `moltlaunch/cli.ts`. Pin CLI version. | Structured logs show `mltl error` events. Health check endpoint returns unhealthy. |
| R2 | LLM costs exceed revenue on complex tasks | Medium | High | Circuit breakers (Phase 2) hard-cap per-task spend. The 60/10 rule: identify and decline the 10% of tasks that would consume 60% of costs. | Daily cost reports. Alert when any single task exceeds $0.50. |
| R3 | QA reviewer false-positives block good deliverables | Low | Medium | QA reviewer errs toward approval (threshold: score >= 3/5 passes). Override config: `qaReviewEnabled: false`. Track false positive rate. | Compare QA rejections against subsequent client acceptance of revised versions. |
| R4 | Paperclip instance downtime blocks task processing | Low | Medium | CashClaw continues processing Moltlaunch tasks independently. Paperclip polling failures are logged but non-fatal. | Structured logs show `Paperclip poll error` events. Heartbeat health check still passes. |
| R5 | Agent coordination deadlock (cross-agent task dependency) | Low | High | Max 3 agents with no inter-agent task dependencies. QA reviewer has no authority to create tasks. | Paperclip dashboard shows stuck `in_progress` tasks. Alert after 30 minutes with no activity. |
| R6 | Prompt caching ineffective due to system prompt variation | Medium | Low | System prompt is deterministic for a given config. Only task-specific context varies per turn. Measure cache hit rate in logs. | Check Anthropic API response `cache_read_input_tokens` field. |
| R7 | Direct client API abused (spam, DoS) | Low | Medium | Rate limit: 10 tasks/minute per client. Budget cap per client. API key revocation. | Monitor task creation rate in structured logs. Alert on >5 tasks/minute from single client. |
| R8 | Compound reliability: 85%^N decay on multi-step tasks | High | High | Minimize steps. Typical task: 3 tool calls = 85%^3 = 61% success. This is why QA gate exists — catch failures before they reach clients. Decline tasks requiring >5 steps. | Track tool_call count per task. Alert when tasks routinely exceed 5 tool calls. |
| R9 | Moltlaunch marketplace volume insufficient for sustainability | High | Medium | Phase 5 diversifies to direct clients and Paperclip. Moltlaunch target: <50% of total revenue by month 3. | Monthly revenue breakdown by source. |
| R10 | Data loss in CashClaw file-based storage | Low | Medium | Atomic writes (write-to-tmp + rename) already implemented in all memory modules. Add periodic backup of `~/.cashclaw/` directory. | File read failures logged. Manual check of file sizes. |
| R11 | MiroFish unavailable degrades pricing/routing quality | Medium | Low | All MiroFish hooks already fail gracefully (10s timeout, null return). System falls back to keyword routing and static pricing. No task is blocked by MiroFish outage. | Structured logs show `MiroFish ... error` events. Track percentage of tasks with vs without MiroFish predictions. |
| R12 | MiroFish predictions miscalibrated (recommends bad prices) | Low | Medium | Agent always has final say — MiroFish injects into prompt as "intelligence" not "instructions". The auto-decline threshold (acceptanceProbability < 0.3) is conservative. `postCompleteHook` continuously calibrates. | Compare MiroFish recommended price vs actual quoted price vs client acceptance. Track divergence score over time. |

---

## Monthly Revenue + Cost Projections by Phase

| Phase | Month | Tasks/Mo | Avg Revenue/Task | Monthly Revenue | LLM Costs | Infra Costs | Net Margin |
|-------|-------|----------|-----------------|-----------------|-----------|-------------|------------|
| 1 | 1 | 8 | $12.50 | $100 | $3.00 | $0 | $97 |
| 2 | 1 | 8 | $12.50 | $100 | $1.20 | $0 | $99 |
| 3 | 2 | 15 | $12.50 | $188 | $2.25 | $0 | $186 |
| 4 | 2 | 15 | $12.50 | $188 | $2.95 | $0 | $185 |
| 5 | 3 | 40 | $15.00 | $600 | $6.00 | $5 | $589 |
| 6 | 4 | 80 | $15.00 | $1,200 | $12.00 | $10 | $1,178 |

**Assumptions:**
- ETH price: $2,500
- Average task price: 0.005 ETH ($12.50) for Moltlaunch, $15-25 for direct clients
- Moltlaunch volume: starts at ~8 tasks/month (agent share of ~60 platform orders)
- Direct client tasks added in Phase 5: 10-20/month initially
- LLM pricing: Sonnet $3/$15 per 1M tokens, Haiku $0.80/$4 per 1M tokens
- Average tokens per task: 15K input, 5K output (including QA review)
- Prompt caching reduces effective input cost by 60% after Phase 2

---

## Decision Log

| Decision | Alternatives Considered | Why Chosen |
|----------|------------------------|------------|
| **Use Paperclip's existing `http` adapter** instead of building a custom `cashclaw` adapter | Custom adapter package in `packages/adapters/cashclaw/` | The `http` adapter already does exactly what we need: POST to a URL with context. A custom adapter would require changes to Paperclip's adapter registry, build system, and testing — all for the same net result. CashClaw's webhook endpoint is the adapter. |
| **3 agents (content, code, QA)** instead of 4 or 2 | 4 agents (add research specialist), 2 agents (generalist + QA), 1 agent (just harden existing) | MAST study shows benefits plateau at 4 agents. QA as a dedicated agent is mandatory per requirements. Content and code are the two highest-volume, highest-success-rate task categories. Research tasks have low AI success rates and aren't worth specializing for. |
| **File-based state for direct client tasks** instead of SQLite or Postgres | SQLite via better-sqlite3, Postgres via Paperclip's DB | CashClaw's design philosophy is zero external dependencies. File-based state (JSON + atomic writes) matches existing memory modules. Volume is low (<100 tasks/day). Paperclip handles the governance/audit layer. |
| **Haiku for QA** instead of Sonnet or a different evaluation approach | Sonnet reviewer (more capable but 4x cost), rule-based checks (no understanding), human review (doesn't scale) | QA review is a classification task (pass/fail with feedback). Haiku handles this at 3.5x lower cost than Sonnet. The review prompt is structured enough that Haiku's reasoning is sufficient. At $0.004/review, we can afford to review every deliverable. |
| **Poll Paperclip API** instead of WebSocket or long-polling | Paperclip WebSocket live events, Paperclip webhook push | The plan spec explicitly says "polling + webhook is sufficient." Paperclip's `http` adapter already pushes wakeup webhooks. Polling is the fallback sync check, same pattern as Moltlaunch. No need to add WebSocket complexity. |
| **Model routing in CashClaw** instead of in Paperclip | Paperclip-level model configuration per agent | CashClaw controls its own LLM calls. Paperclip doesn't know about LLM internals — it's a control plane, not an execution engine. Routing logic belongs where the API calls happen. |
| **No Upwork/Fiverr adapter** in initial phases | Build adapters for Upwork API, Fiverr API, Virtuals Protocol ACP | Upwork and Fiverr APIs require manual account verification, legal agreements, and have strict ToS around automated agents. Virtuals Protocol ACP is too early-stage. Direct client API provides higher-margin revenue with lower integration risk. These can be Phase 7+ work. |
| **MiroFish as enhancement layer, not dependency** | Make MiroFish required for all operations; Build MiroFish predictions into hard decision logic | MiroFish is already implemented in CashClaw (`src/mirofish/hooks.ts`, `src/mirofish/client.ts`, `src/tools/mirofish.ts`) with graceful degradation (10s timeout, null returns, try/catch on every hook). Making it a hard dependency would mean MiroFish downtime = CashClaw downtime. Instead, MiroFish enhances three decision points: (1) auto-decline low-probability tasks in Phase 2, (2) targeted QA checklist in Phase 4, (3) data-backed agent routing in Phase 6. All three fall back to simpler heuristics when MiroFish is unavailable. |

---

## Open Questions

1. **Moltlaunch `--result-file` flag:** Does the `mltl` CLI support `--result-file` for large submissions? If not, the Phase 1 submit work fix needs to use stdin piping instead. **Action:** Test with `mltl submit --help` before implementing.

2. **Paperclip API key for CashClaw:** Should each CashClaw instance use an agent API key (`pcp_...`) or a short-lived JWT? Agent API keys are simpler but don't expire. JWTs are auto-injected for local adapters but CashClaw runs as `http` adapter. **Recommendation:** Use agent API keys for Phase 3. Add JWT rotation in a future phase if security requirements increase.

3. **Direct client pricing model:** Should direct client tasks be priced per-task (like Moltlaunch) or on a monthly retainer? Per-task is simpler to implement. Retainer provides predictable revenue. **Recommendation:** Start with per-task, add retainer as a config option later.

4. **Railway deployment topology:** Should all 3 CashClaw instances run as separate Railway services or as a single service with process management? Separate services provide isolation but cost 3x. Single service is cheaper but one crash affects all agents. **Recommendation:** Start with single service (PM2 or similar), split if stability requires it.

5. **Paperclip instance sharing:** Will CashClaw use the same Paperclip instance as other agents (like Claude Code agents)? If so, company/budget scoping needs to be designed carefully. **Recommendation:** Yes, share the instance. Create a dedicated Paperclip company for CashClaw fleet to isolate budgets.

---

## Verification Checklist

- [x] Every file path referenced actually exists in the repository structure provided
- [x] Every schema change uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` with a default value (no schema changes needed — using existing Paperclip tables and CashClaw file-based config)
- [x] No phase depends on a later phase to deliver value (Phase 1 standalone, Phase 2 standalone, Phase 3 needs 2, Phase 4 needs 2, Phase 5 needs 3, Phase 6 needs 3+4+5)
- [x] Total agent count never exceeds 4 (3 agents: content, code, QA)
- [x] LLM costs modeled with real pricing ($3/$15 per 1M tokens for Sonnet, $0.80/$4 for Haiku)
- [x] Every phase has a rollback plan that doesn't require data migration
- [x] Quality gate exists before any deliverable reaches a client (Phase 4, integrated in Phase 6)
- [x] Moltlaunch is not the sole revenue source in any phase after Phase 2 (Phase 3 adds Paperclip, Phase 5 adds direct clients)
- [x] Compound reliability decay is accounted for in success rate estimates (Risk R8, task complexity limits, QA gate)
- [x] No breaking changes to existing Paperclip or CashClaw APIs (all additions, all new config fields have defaults)
- [x] The plan could be executed by a single senior engineer (no team coordination required)
- [x] Every "test plan" entry specifies what to assert, not just what to run
