import { describe, it, expect } from "vitest";
import { createMoltlaunchSource } from "../src/sources/moltlaunch.js";
import { createPaperclipSource } from "../src/sources/paperclip.js";
import { createDirectSource } from "../src/sources/direct.js";
import * as store from "../src/direct/store.js";

describe("TaskSource: moltlaunch", () => {
  it("should be enabled with an agentId", () => {
    const source = createMoltlaunchSource("agent-1");
    expect(source.isEnabled()).toBe(true);
    expect(source.name).toBe("moltlaunch");
  });

  it("should be disabled without agentId", () => {
    const source = createMoltlaunchSource("");
    expect(source.isEnabled()).toBe(false);
  });
});

describe("TaskSource: paperclip", () => {
  it("should be enabled with full config", () => {
    const source = createPaperclipSource({
      apiUrl: "http://localhost:3100",
      apiKey: "pcp_test",
      agentId: "agent-1",
      companyId: "company-1",
    });
    expect(source.isEnabled()).toBe(true);
    expect(source.name).toBe("paperclip");
  });

  it("should be disabled without config", () => {
    const source = createPaperclipSource(undefined);
    expect(source.isEnabled()).toBe(false);
  });

  it("should return empty on poll when disabled", async () => {
    const source = createPaperclipSource(undefined);
    const tasks = await source.poll();
    expect(tasks).toEqual([]);
  });
});

describe("TaskSource: direct", () => {
  it("should be enabled with clients configured", () => {
    const source = createDirectSource([
      { id: "client-1", name: "Test", apiKey: "key-1" },
    ]);
    expect(source.isEnabled()).toBe(true);
    expect(source.name).toBe("direct");
  });

  it("should be disabled without clients", () => {
    const source = createDirectSource(undefined);
    expect(source.isEnabled()).toBe(false);
  });

  it("should be disabled with empty clients array", () => {
    const source = createDirectSource([]);
    expect(source.isEnabled()).toBe(false);
  });
});

describe("DirectTask store", () => {
  it("should create and retrieve a task", () => {
    const task = store.createTask("client-1", "Write a blog post", 25);
    expect(task.id).toMatch(/^direct-/);
    expect(task.status).toBe("pending");
    expect(task.clientId).toBe("client-1");

    const retrieved = store.getTask(task.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.description).toBe("Write a blog post");
  });

  it("should list pending tasks", () => {
    const task = store.createTask("client-2", "Another task");
    const pending = store.getPendingTasks();
    expect(pending.some((t) => t.id === task.id)).toBe(true);
  });

  it("should mark task processing", () => {
    const task = store.createTask("client-3", "Process me");
    store.markProcessing(task.id);
    const retrieved = store.getTask(task.id);
    expect(retrieved!.status).toBe("processing");
  });
});
