# Implementation Plan Prompt: Paperclip + CashClaw Autonomous Revenue System

> Feed this prompt to Claude Opus 4.6 (1M context) or equivalent frontier model.
> Attach the full contents of both repositories as context before this prompt.

---

## ROLE

You are a staff-level systems architect with deep production experience in:
- Multi-agent AI orchestration (you have shipped fleet systems processing 10K+ tasks/day)
- Node.js/TypeScript backend systems at scale
- PostgreSQL schema design and migration safety
- LLM API integration (Anthropic, OpenAI) including cost optimization, prompt caching, and model routing
- On-chain payment systems (EVM, Base L2, ERC-20/ETH escrow)
- Real-world freelance marketplace economics

You are also a pragmatist. You do not over-engineer. You have read the research and know:
- Best autonomous agent completed 2.5% of real Upwork tasks (Remote Labor Index, CAIS/Scale AI, 2026)
- SWE-bench Verified is contaminated; SWE-bench Pro shows 46% on real multi-file tasks
- METR data: AI succeeds ~50% on 1-hour tasks, <10% on 4+ hour tasks
- MAST study: multi-agent failure rates 41-86% across frameworks, benefits plateau at 4 agents
- Compound reliability: 85% per-step accuracy across 10 steps = 20% end-to-end success
- Moltlaunch: ~298 completed orders total across platform (launched Feb 9, 2026)
- Companies making real money sell agent-powered services, not fully autonomous agents
- Prompt caching reduces input costs 90%; model routing reduces total costs 40-50%
- The 60/10 rule: 60% of costs come from 10% of tasks

You will produce a plan that works within these constraints, not one that ignores them.

---

## CONTEXT

### System A: Paperclip (Control Plane)

**What it is:** A control plane for AI-agent companies. Manages agents, org structure, task assignment, budgets, governance, and audit trails.

**Repository:** `/Users/user/paperclip`
- pnpm monorepo: `server/` (Express 5 REST API), `ui/` (React 19 + Vite), `cli/`, `packages/db/` (Drizzle ORM + PostgreSQL), `packages/shared/`, `packages/adapters/`, `skills/`
- Node 20+, TypeScript 5.7, PostgreSQL 17 (embedded PGlite or external)
- 413+ merged PRs, active open-source project

**Key architecture:**
- Company-scoped everything (multi-company per instance)
- Agent adapters: `claude_local`, `codex_local`, `cursor`, `openclaw_gateway`, `process`, `http`
- Heartbeat system: agents wake on schedule/event, check out tasks atomically, execute via adapter, report back
- Issue execution lock: one active execution per issue at a time, deferred wakeups promoted on release
- Session persistence: per-task sessions survive across heartbeats
- Skills injection: markdown-based skill files symlinked into agent runtime
- Budget enforcement: monthly caps per agent with hard-stop auto-pause at 100%
- Activity logging: every mutation auditable with actor, run ID, timestamp

**Core tables:** `companies`, `agents`, `issues` (with `parent_id`, `execution_run_id`, `execution_locked_at`, `assignee_agent_id`, `checkout_run_id`, status enum: backlog/todo/in_progress/in_review/blocked/done/cancelled), `heartbeat_runs` (with `context_snapshot` JSONB), `agent_wakeup_requests` (with deferred execution and coalescing), `agent_task_sessions`, `agent_runtime_state`, `issue_comments`, `cost_events`, `activity_log`, `approvals`, `goals`, `projects`

**Adapter interface:**
```typescript
interface AdapterExecutionContext {
  runId: string;
  agent: AdapterAgent;
  runtime: AdapterRuntime; // sessionId, sessionParams, taskKey
  config: Record<string, unknown>; // agent's adapterConfig
  context: Record<string, unknown>; // wake context (taskId, issueId, wakeReason, etc.)
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  authToken?: string; // short-lived JWT
}
```

**What Paperclip does NOT do:** Execute work. It is a control plane only. Agents run externally and phone home via REST API.

---

### System B: CashClaw (Execution Agent)

**What it is:** An autonomous work agent that watches for tasks on the Moltlaunch marketplace, quotes them, executes work via multi-turn LLM tool-use, submits deliverables, and self-improves via study sessions.

**Repository:** `/Users/user/cashclaw`
- Single Node.js process, 2,694 lines TypeScript, 45 source files
- Dependencies: `ws` (WebSocket), `viem` (ETH), `minisearch` (BM25 search)
- LLM providers: Anthropic, OpenAI, OpenRouter (raw fetch, zero SDKs)
- State: JSON files in `~/.cashclaw/` (config, knowledge, feedback, chat, daily logs)
- UI: React 19 + Vite dashboard at :3777 (monitor, tasks, chat, settings)
- 3 commits total, v0.1.0

**Core components:**

1. **Heartbeat** (`src/heartbeat.ts`, 406 lines): WebSocket to `wss://api.moltlaunch.com/ws/{agentId}` + REST polling fallback every 30s. Study scheduler every 30min. Concurrent task limit (default 3). Dedup via `processedVersions` Map.

2. **Agent Loop** (`src/loop/index.ts`, 107 lines): Multi-turn LLM conversation with tools. Max 10 turns. Builds system prompt with identity, pricing rules, personality, injected knowledge. Returns tool calls, reasoning, turn count, token usage.

3. **LLM Factory** (`src/llm/index.ts`, 243 lines): Raw fetch to Anthropic/OpenAI/OpenRouter APIs. Translates between Anthropic and OpenAI tool formats. Hardcoded `max_tokens: 4096`.

4. **Tools** (13 total): 7 marketplace (read_task, quote_task, decline_task, submit_work, send_message, list_bounties, claim_bounty), 4 utility (check_wallet_balance, read_feedback_history, memory_search, log_activity), 2 AgentCash (agentcash_fetch, agentcash_balance), 2 MiroFish (predict_outcome, simulate_approach).

5. **Memory** (`src/memory/`): Knowledge (50 entries max, FIFO), Feedback (100 entries max), Search (BM25+ with 30-day half-life temporal decay), Chat history (100 messages), Daily markdown logs.

6. **Marketplace abstraction** (`src/moltlaunch/cli.ts`, 186 lines, 10 functions): Wraps the `mltl` CLI. Designed to be swapped for any task source.

7. **MiroFish integration** (`src/mirofish/`): Optional swarm intelligence. Pre-quote, pre-work, post-complete hooks.

**Moltlaunch marketplace:** On-chain freelance marketplace on Base (Coinbase L2). ETH payment via trustless escrow. ERC-8004 agent identity. Task flow: client posts → agent quotes → client accepts → escrow locks → agent delivers → 24hr review → funds release.

---

### Verified Bugs and Gaps in CashClaw

These are confirmed issues found via code audit (file:line references verified):

**Critical (P0):**
- Zero LLM retry logic (`llm/index.ts`): single 429/500 kills task
- No per-task cost tracking or budget enforcement (`loop/index.ts`): runaway spend possible
- No API authentication (`agent.ts:65`): any process can stop/wipe agent
- Race condition: accepted tasks dropped during processing (`heartbeat.ts:185-191`)
- Memory leak: `completedTasks` Set grows unbounded (`heartbeat.ts:68`)
- `submitWork` passed as CLI argument, no size limit (`cli.ts:164`)
- No price validation on quotes (`marketplace.ts:43-48`)
- CORS hardcoded to localhost (`agent.ts:65`): breaks Railway deployment
- Config has zero validation (`config.ts:61-71`)

**High (P1):**
- 50 knowledge entries cycles in ~8 hours, no dedup
- No quote acceptance/rejection tracking (can't learn pricing)
- No LLM provider fallback (single point of failure)
- No `max_tokens` stop reason handling (truncated outputs accepted silently)
- `npx agentcash` per API call (~2s overhead each)
- No task requeue after loop error
- No structured logging
- No test coverage (vitest configured, 0 test files with actual tests)

**Medium (P2):**
- No streaming support in LLM
- Tools executed sequentially, not in parallel
- No timeout on individual tool execution
- No rate limiting on `send_message` (spam possible)
- Dashboard polls every 3s even in background tabs
- No earnings/revenue tracking in UI
- No completed task history view
- SSRF potential via agentcash redirect following

---

## TASK

Produce a **phased implementation plan** to transform CashClaw + Paperclip into a revenue-generating autonomous agent system.

The plan must:

### 1. RESPECT THESE CONSTRAINTS

- **Reliability ceiling:** Do not plan for tasks >1 hour human-equivalent. METR data shows <10% AI success beyond 4 hours. Target the sweet spot: 15min-1hr, well-specified, digital delivery.
- **Agent count ceiling:** Maximum 4 specialized agents. MAST study shows coordination overhead dominates beyond 4.
- **Marketplace reality:** Moltlaunch has ~60 orders/month platform-wide. Revenue must come from multiple sources.
- **Compound error:** Every multi-step workflow must account for 85%^N reliability decay. Minimize steps.
- **Cost discipline:** LLM API costs must be <15% of task revenue at steady state. Model routing and prompt caching are mandatory, not optional.
- **Quality gate mandatory:** Every deliverable must be reviewed before submission. The 2.5% completion rate on real freelance tasks is primarily a quality problem.
- **Zero data loss:** All Paperclip schema changes via migrations. No destructive operations. No `--accept-data-loss`.
- **Additive only:** No breaking changes to existing Paperclip or CashClaw APIs/schemas. All new columns must have defaults.

### 2. COVER THESE WORKSTREAMS

**Workstream A: CashClaw Hardening**
Fix the verified P0 and P1 bugs. Make CashClaw production-ready as a standalone agent before integrating with Paperclip. Include:
- Exact file changes with before/after descriptions
- New dependencies (if any) with justification
- Test plan for each fix (what to test, expected behavior)

**Workstream B: Paperclip Integration**
Connect CashClaw to Paperclip as a governed agent. Include:
- New Paperclip adapter: `cashclaw` adapter type in `packages/adapters/`
- New CashClaw task source: `src/paperclip/cli.ts` replacing `src/moltlaunch/cli.ts` as an alternative backend
- Paperclip skill for CashClaw: what CashClaw needs to know about the Paperclip API
- Schema changes (if any) with exact migration SQL
- How the heartbeat flow works end-to-end: Paperclip issue created → CashClaw picks up → executes → reports back

**Workstream C: Cost Optimization**
Implement the three proven cost levers:
- Model routing: Haiku for classification + simple tasks, Sonnet for standard, Opus for complex
- Prompt caching: `cache_control` on system prompt blocks (Anthropic API)
- Circuit breakers: per-task token budget, max tool calls, max cost, max duration

**Workstream D: Quality System**
Build the quality gate:
- QA agent (Haiku-based reviewer) that checks every deliverable before submission
- Evaluator-optimizer loop: reviewer can approve or send back with feedback
- Quality metrics: track approval rate, revision rate, client satisfaction correlation

**Workstream E: Revenue Diversification**
Add task sources beyond Moltlaunch:
- Direct client portal (white-label API for retainer clients)
- At least one additional marketplace adapter (Fiverr, Upwork, or Virtuals Protocol ACP)
- Paperclip as task source for board-created issues

**Workstream F: Fleet Operations**
Scale from 1 to 3-4 specialized agents:
- Agent specialization strategy (which specialties, which models, why)
- Paperclip orchestration: triage routing, per-agent budgets, cross-agent knowledge sharing
- Observability: what to monitor, alert on, and dashboard

### 3. STRUCTURE THE PLAN AS PHASES

Each phase must be:
- **Independently deployable** — each phase ships value, no phase depends on a future phase to be useful
- **Testable** — explicit test criteria for each phase, not "verify it works"
- **Time-bounded** — estimate in days of focused work, not calendar time
- **Costed** — what are the infrastructure/API costs to operate at the end of this phase?

### 4. FOR EACH PHASE, PROVIDE

```
## Phase N: [Name]

### Goal
One sentence: what capability does this phase deliver?

### Prerequisites
What must be true before this phase starts?

### Changes

#### [Component]: [File path]
- What changes and why
- Before/after behavior
- Migration SQL (if schema change)

### New Files
- Path, purpose, key interfaces

### Test Plan
- Unit tests: what functions, what assertions
- Integration tests: what flows, what assertions
- Manual verification: what to check

### Rollback Plan
How to undo this phase if it causes problems

### Operating Costs
Monthly infrastructure + API costs at expected volume

### Success Criteria
Measurable conditions that prove this phase works.
Not "it runs" — quantifiable metrics.

### Revenue Impact
How this phase changes the revenue picture (or prevents loss)
```

### 5. INCLUDE A RISK REGISTER

For each significant risk:
- Description
- Probability (low/medium/high)
- Impact (low/medium/high)
- Mitigation strategy
- Detection method (how do you know if this risk materializes?)

### 6. ANTI-PATTERNS TO AVOID

Do NOT propose any of the following:
- More than 4 agents (coordination overhead dominates)
- Custom LLM training or fine-tuning (wrong cost tier for this project)
- Building a custom agent framework (CashClaw exists, extend it)
- Blockchain/smart contract development (use existing Moltlaunch/AgentCash infra)
- Separate messaging system between agents (use Paperclip's task + comment system)
- Real-time WebSocket between Paperclip and CashClaw (polling + webhook is sufficient)
- Any change that requires Moltlaunch platform changes (we don't control it)
- Automatic retry of failed marketplace submissions (reputation risk)
- Accepting tasks that require file uploads, real-time interaction, or physical-world actions
- Building a custom dashboard when Paperclip's UI already exists
- Any "phase 0" or "foundation" phase that ships no user-facing value

### 7. OUTPUT FORMAT

Produce the full plan as a single markdown document with:
1. Executive summary (10 lines max)
2. Architecture diagram (ASCII art)
3. Phase-by-phase plan (following the template above)
4. Risk register
5. Monthly revenue + cost projections by phase
6. Decision log: key architectural decisions with alternatives considered and why they were rejected
7. Open questions: things that need human input before implementation starts

---

## VERIFICATION CHECKLIST

Before finalizing your plan, verify against each item:

- [ ] Every file path referenced actually exists in the repository structure provided
- [ ] Every schema change uses `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` with a default value
- [ ] No phase depends on a later phase to deliver value
- [ ] Total agent count never exceeds 4
- [ ] LLM costs modeled with real pricing ($3/$15 per 1M tokens for Sonnet, $0.80/$4 for Haiku)
- [ ] Every phase has a rollback plan that doesn't require data migration
- [ ] Quality gate exists before any deliverable reaches a client
- [ ] Moltlaunch is not the sole revenue source in any phase after Phase 2
- [ ] Compound reliability decay is accounted for in success rate estimates
- [ ] No breaking changes to existing Paperclip or CashClaw APIs
- [ ] The plan could be executed by a single senior engineer (no team coordination required)
- [ ] Every "test plan" entry specifies what to assert, not just what to run
