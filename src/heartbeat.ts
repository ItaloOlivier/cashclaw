import WebSocket from "ws";
import type { CashClawConfig } from "./config.js";
import type { LLMProvider } from "./llm/types.js";
import type { Task } from "./moltlaunch/types.js";
import { createLLMProvider } from "./llm/index.js";
import { selectModel, type RoutingInput } from "./llm/router.js";
import { runAgentLoop, type LoopResult } from "./loop/index.js";
import * as paperclipClient from "./paperclip/client.js";
import { estimateCostUsd } from "./llm/cost.js";
import { runStudySession } from "./loop/study.js";
import { storeFeedback } from "./memory/feedback.js";
import { appendLog } from "./memory/log.js";
import { preQuoteHook, preWorkHook, postCompleteHook } from "./mirofish/hooks.js";
import { isMiroFishAvailable } from "./mirofish/client.js";
import type { TaskSource } from "./sources/interface.js";
import { createMoltlaunchSource } from "./sources/moltlaunch.js";
import { createPaperclipSource } from "./sources/paperclip.js";
import { createDirectSource } from "./sources/direct.js";

export interface HeartbeatState {
  running: boolean;
  activeTasks: Map<string, Task>;
  lastPoll: number;
  totalPolls: number;
  startedAt: number;
  events: ActivityEvent[];
  wsConnected: boolean;
  lastStudyTime: number;
  totalStudySessions: number;
}

export interface ActivityEvent {
  timestamp: number;
  type: "poll" | "loop_start" | "loop_complete" | "tool_call" | "feedback" | "error" | "ws" | "study";
  taskId?: string;
  message: string;
}

type EventListener = (event: ActivityEvent) => void;

const TERMINAL_STATUSES = new Set([
  "completed", "declined", "cancelled", "expired", "resolved", "disputed",
]);

const WS_URL = "wss://api.moltlaunch.com/ws";
const WS_INITIAL_RECONNECT_MS = 5_000;
const WS_MAX_RECONNECT_MS = 300_000; // 5 min cap
// When WS is connected, poll infrequently as a sync check
const WS_POLL_INTERVAL_MS = 120_000;
// Expire non-terminal tasks after 7 days to prevent memory leaks
const TASK_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Create a LLM provider with model routing applied */
function routedLLM(config: CashClawConfig, input: RoutingInput): LLMProvider {
  const model = selectModel(config.routing, config.llm.model, input);
  if (model === config.llm.model) {
    // No routing change — use the base provider
    return createLLMProvider(config.llm);
  }
  return createLLMProvider({ ...config.llm, model });
}

export function createHeartbeat(
  config: CashClawConfig,
  llm: LLMProvider,
) {
  // Build pluggable task sources
  const taskSources: TaskSource[] = [
    createMoltlaunchSource(config.agentId),
    createPaperclipSource(config.paperclip),
    createDirectSource(config.directClients),
  ].filter((s) => s.isEnabled());
  const state: HeartbeatState = {
    running: false,
    activeTasks: new Map(),
    lastPoll: 0,
    totalPolls: 0,
    startedAt: 0,
    events: [],
    wsConnected: false,
    lastStudyTime: 0,
    totalStudySessions: 0,
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let ws: WebSocket | null = null;
  let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let wsReconnectDelay = WS_INITIAL_RECONNECT_MS;
  let wsFailLogged = false;
  const processing = new Set<string>();
  const completedTasks = new Set<string>();
  const MAX_COMPLETED = 1000;
  // Queue updates that arrive while a task is being processed
  const pendingUpdates = new Map<string, Task>();
  // Track task+status combos to prevent duplicate processing from WS+poll overlap
  const processedVersions = new Map<string, string>();
  const listeners: EventListener[] = [];

  function emit(event: Omit<ActivityEvent, "timestamp">) {
    const full: ActivityEvent = { ...event, timestamp: Date.now() };
    state.events.push(full);
    if (state.events.length > 200) {
      state.events = state.events.slice(-200);
    }
    for (const fn of listeners) fn(full);
  }

  function onEvent(fn: EventListener) {
    listeners.push(fn);
  }

  // --- WebSocket ---

  function connectWs() {
    if (!state.running || !config.agentId) return;

    try {
      ws = new WebSocket(`${WS_URL}/${config.agentId}`);

      ws.on("open", () => {
        state.wsConnected = true;
        wsReconnectDelay = WS_INITIAL_RECONNECT_MS;
        wsFailLogged = false;
        emit({ type: "ws", message: "WebSocket connected" });
        appendLog("WebSocket connected");
      });

      ws.on("message", (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(data.toString()) as {
            event: string;
            task?: Task;
            timestamp?: number;
          };

          if (msg.event === "connected") return;

          emit({ type: "ws", taskId: msg.task?.id, message: `WS event: ${msg.event}` });

          if (msg.task) {
            handleTaskEvent(msg.task);
          }
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on("close", () => {
        state.wsConnected = false;
        // Only log the first disconnect, suppress repeated failures
        if (!wsFailLogged) {
          emit({ type: "ws", message: "WebSocket disconnected — retrying in background" });
          wsFailLogged = true;
        }
        scheduleWsReconnect();
      });

      ws.on("error", (err: Error) => {
        state.wsConnected = false;
        if (!wsFailLogged) {
          emit({ type: "error", message: `WebSocket error: ${err.message}` });
          wsFailLogged = true;
        }
        ws?.close();
        scheduleWsReconnect();
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!wsFailLogged) {
        emit({ type: "error", message: `WebSocket connect failed: ${msg}` });
        wsFailLogged = true;
      }
      scheduleWsReconnect();
    }
  }

  function scheduleWsReconnect() {
    if (!state.running) return;
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(() => connectWs(), wsReconnectDelay);
    // Exponential backoff: 5s → 10s → 20s → 40s → ... → 5min cap
    wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_MAX_RECONNECT_MS);
  }

  function disconnectWs() {
    if (wsReconnectTimer) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = null;
    }
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
    state.wsConnected = false;
  }

  // --- Task handling (shared by WS + poll) ---

  function handleTaskEvent(task: Task) {
    if (TERMINAL_STATUSES.has(task.status)) {
      if (task.status === "completed" && task.ratedScore !== undefined) {
        handleCompleted(task);
      }
      state.activeTasks.delete(task.id);
      processedVersions.delete(task.id);
      return;
    }

    // Dedup: skip if we already processed this exact task+status combo
    const version = `${task.id}:${task.status}`;
    if (processedVersions.get(task.id) === version && !processing.has(task.id)) {
      state.activeTasks.set(task.id, task);
      return;
    }

    if (processing.has(task.id)) {
      // Queue for re-processing after current loop finishes
      pendingUpdates.set(task.id, task);
      state.activeTasks.set(task.id, task);
      return;
    }

    if (task.status === "quoted" || task.status === "submitted") {
      state.activeTasks.set(task.id, task);
      processedVersions.set(task.id, version);
      return;
    }

    if (processing.size >= config.maxConcurrentTasks) return;

    state.activeTasks.set(task.id, task);
    processedVersions.set(task.id, version);
    processing.add(task.id);

    emit({ type: "loop_start", taskId: task.id, message: `Agent loop started (${task.status})` });
    appendLog(`Agent loop started for ${task.id} (${task.status})`);

    // MiroFish pre-hooks: inject strategic intelligence before the agent loop
    const miroPromises: Promise<string | null>[] = [];
    if (isMiroFishAvailable()) {
      if (task.status === "requested") {
        miroPromises.push(
          preQuoteHook(task, config).then((r) => r?.promptInjection ?? null),
        );
      } else if (task.status === "accepted" || task.status === "revision") {
        miroPromises.push(
          preWorkHook(task, config).then((r) => r?.promptInjection ?? null),
        );
      }
    }

    // Resolve MiroFish hooks (with 10s timeout built into client), then run loop
    Promise.all(miroPromises)
      .then((injections) => {
        const miroContext = injections.filter(Boolean).join("") || undefined;
        // Use routed model based on task characteristics
        const taskLLM = routedLLM(config, {
          context: "task",
          taskDescription: task.task,
          taskStatus: task.status,
        });
        return runAgentLoop(taskLLM, task, config, miroContext);
      })
      .then((result: LoopResult) => {
        const toolNames = result.toolCalls.map((tc) => tc.name).join(", ");
        emit({
          type: "loop_complete",
          taskId: task.id,
          message: `Loop done in ${result.turns} turn(s): [${toolNames}]`,
        });
        appendLog(`Loop done for ${task.id}: ${result.turns} turns, tools=[${toolNames}]`);

        for (const tc of result.toolCalls) {
          emit({
            type: "tool_call",
            taskId: task.id,
            message: `${tc.name}(${JSON.stringify(tc.input).slice(0, 100)}) → ${tc.success ? "ok" : "err"}`,
          });
        }

        // Report results and costs to Paperclip if this is a Paperclip-sourced task
        if (config.paperclip && task.source === "paperclip") {
          // Post loop result as a comment and update issue status
          const submitToolCall = result.toolCalls.find((tc) => tc.name === "submit_work");
          const summary = submitToolCall
            ? `Work submitted via submit_work (${result.turns} turns, ${toolNames})`
            : `Loop completed in ${result.turns} turn(s). Tools used: [${toolNames}].\n\n${result.reasoning.slice(0, 2000)}`;
          const newStatus = submitToolCall ? "in_review" : "in_progress";

          paperclipClient.updateIssue(config.paperclip, task.id, {
            status: newStatus,
            comment: summary,
          }).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            emit({ type: "error", taskId: task.id, message: `Paperclip update failed: ${msg}` });
          });

          // Report costs
          if (result.usage) {
            const costCents = Math.round(
              estimateCostUsd(config.llm.model, result.usage.inputTokens, result.usage.outputTokens) * 100,
            );
            paperclipClient.reportCost(config.paperclip, {
              agentId: config.paperclip.agentId,
              issueId: task.id,
              provider: config.llm.provider,
              model: config.llm.model,
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              costCents,
              occurredAt: new Date().toISOString(),
            }).catch(() => { /* non-fatal */ });
          }
        } else if (config.paperclip && result.usage) {
          // Non-Paperclip tasks: just report costs
          const costCents = Math.round(
            estimateCostUsd(config.llm.model, result.usage.inputTokens, result.usage.outputTokens) * 100,
          );
          paperclipClient.reportCost(config.paperclip, {
            agentId: config.paperclip.agentId,
            issueId: task.id,
            provider: config.llm.provider,
            model: config.llm.model,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            costCents,
            occurredAt: new Date().toISOString(),
          }).catch(() => { /* non-fatal */ });
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "error", taskId: task.id, message: `Loop error: ${msg}` });
        appendLog(`Loop error for ${task.id}: ${msg}`);
      })
      .finally(() => {
        processing.delete(task.id);
        // Re-process if an update arrived while we were processing
        const pending = pendingUpdates.get(task.id);
        if (pending) {
          pendingUpdates.delete(task.id);
          handleTaskEvent(pending);
        }
      });
  }

  // --- Polling (fallback / sync check) ---

  async function tick() {
    state.lastPoll = Date.now();
    state.totalPolls++;

    // Poll all enabled task sources
    for (const source of taskSources) {
      try {
        const tasks = await source.poll();
        if (tasks.length > 0) {
          emit({ type: "poll", message: `${source.name}: ${tasks.length} task(s)` });
          appendLog(`${source.name} — ${tasks.length} task(s)`);
        }
        for (const task of tasks) {
          handleTaskEvent(task);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ type: "error", message: `${source.name} poll error: ${msg}` });
        // Non-fatal — other sources still work
      }
    }

    scheduleNext();
  }

  function handleCompleted(task: Task) {
    if (task.ratedScore === undefined) return;
    if (completedTasks.has(task.id)) return;
    completedTasks.add(task.id);
    // Prevent unbounded growth — evict oldest entry
    if (completedTasks.size > MAX_COMPLETED) {
      const first = completedTasks.values().next().value;
      if (first) completedTasks.delete(first);
    }

    storeFeedback({
      taskId: task.id,
      taskDescription: task.task,
      score: task.ratedScore,
      comments: task.ratedComment ?? "",
      timestamp: Date.now(),
    });

    emit({
      type: "feedback",
      taskId: task.id,
      message: `Completed — rated ${task.ratedScore}/5`,
    });
    appendLog(`Task ${task.id} completed — score ${task.ratedScore}/5`);

    // MiroFish post-complete hook: feed outcome back for prediction calibration
    postCompleteHook(task).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      appendLog(`MiroFish postComplete error for ${task.id}: ${msg}`);
    });
  }

  function scheduleNext() {
    if (!state.running) return;

    // Expire stale non-terminal tasks to prevent memory leaks
    const now = Date.now();
    for (const [id, task] of state.activeTasks) {
      const taskTime = task.quotedAt ?? task.acceptedAt ?? task.submittedAt ?? state.startedAt;
      if (!processing.has(id) && now - taskTime > TASK_EXPIRY_MS) {
        state.activeTasks.delete(id);
        processedVersions.delete(id);
      }
    }

    // Check if we should study while idle
    void maybeStudy();

    // If WebSocket is connected, poll infrequently as a sync check
    if (state.wsConnected) {
      timer = setTimeout(() => void tick(), WS_POLL_INTERVAL_MS);
      return;
    }

    // Without WS, use normal polling intervals
    const hasUrgent = [...state.activeTasks.values()].some(
      (t) => t.status === "requested" || t.status === "revision" || t.status === "accepted",
    );

    const interval = hasUrgent
      ? config.polling.urgentIntervalMs
      : config.polling.intervalMs;

    timer = setTimeout(() => void tick(), interval);
  }

  let studying = false;

  async function maybeStudy() {
    if (!config.learningEnabled) return;
    if (studying) return;
    if (processing.size > 0) return;

    // Don't study if there are tasks needing action
    const hasUrgent = [...state.activeTasks.values()].some(
      (t) => t.status === "requested" || t.status === "revision" || t.status === "accepted",
    );
    if (hasUrgent) return;

    if (Date.now() - state.lastStudyTime < config.studyIntervalMs) return;

    studying = true;
    emit({ type: "study", message: "Starting study session..." });
    appendLog("Study session started");

    try {
      const studyLLM = routedLLM(config, { context: "study" });
      const result = await runStudySession(studyLLM, config);
      state.lastStudyTime = Date.now();
      state.totalStudySessions++;

      emit({
        type: "study",
        message: `Study complete: ${result.topic} (${result.tokensUsed} tokens)`,
      });
      appendLog(`Study session complete: ${result.topic} — ${result.insight.slice(0, 100)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: "error", message: `Study error: ${msg}` });
      appendLog(`Study error: ${msg}`);
      // Avoid retrying immediately on failure
      state.lastStudyTime = Date.now();
    } finally {
      studying = false;
    }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    state.startedAt = Date.now();
    // Don't study immediately on restart — wait one full interval
    if (state.lastStudyTime === 0) {
      state.lastStudyTime = Date.now();
    }
    appendLog("Heartbeat started");
    connectWs();
    void tick();
  }

  function stop() {
    state.running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    disconnectWs();
    appendLog("Heartbeat stopped");
  }

  return { state, start, stop, onEvent, handleTaskEvent };
}

export type Heartbeat = ReturnType<typeof createHeartbeat>;
