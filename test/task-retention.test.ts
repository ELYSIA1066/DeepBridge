import { TaskState, type AgentCard, type Task } from "@a2a-js/sdk";
import { TaskNotFoundError } from "@a2a-js/sdk/errors";
import {
  DefaultRequestHandler,
  ServerCallContext,
  type AgentExecutor,
} from "@a2a-js/sdk/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskProgressStore } from "../app/progress.js";
import { planTaskRetention, RetainedTaskStore } from "../app/task-store.js";

const stores: RetainedTaskStore[] = [];

function createStore(
  progress: TaskProgressStore,
  options: ConstructorParameters<typeof RetainedTaskStore>[1] = {},
): RetainedTaskStore {
  const store = new RetainedTaskStore(progress, {
    cleanupIntervalMs: 60_000,
    ...options,
  });
  stores.push(store);
  return store;
}

function makeTask(
  id: string,
  state: TaskState,
  terminalTime: number,
  contextId = "context-1",
): Task {
  return {
    id,
    contextId,
    status: { state, timestamp: new Date(terminalTime).toISOString(), message: undefined },
    artifacts: [{
      artifactId: `artifact-${id}`,
      name: "result",
      description: "",
      parts: [],
      metadata: undefined,
      extensions: [],
    }],
    history: [],
    metadata: undefined,
  };
}

function addProgress(progress: TaskProgressStore, taskId: string): void {
  progress.start(taskId);
  progress.add(taskId, { kind: "assistant", text: `progress-${taskId}` });
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RetainedTaskStore", () => {
  it("R1-1 removes an expired terminal task and its progress together", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 100, maxRetainedTasks: 10, now: () => now });
    const context = new ServerCallContext();
    const task = makeTask("expired", TaskState.TASK_STATE_COMPLETED, now);
    addProgress(progress, task.id);
    await store.save(task, context);

    now = 1100;
    expect(store.cleanupRetainedTasks(now)).toMatchObject({ ttlRemoved: 1, maxRemoved: 0 });
    await expect(store.load(task.id, context)).resolves.toBeUndefined();
    expect(progress.get(task.id)).toBeUndefined();
  });

  it("treats completed, rejected, failed, and canceled as terminal", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 10, maxRetainedTasks: 10, now: () => now });
    const context = new ServerCallContext();
    const terminalStates = [
      TaskState.TASK_STATE_COMPLETED,
      TaskState.TASK_STATE_REJECTED,
      TaskState.TASK_STATE_FAILED,
      TaskState.TASK_STATE_CANCELED,
    ];

    for (const [index, state] of terminalStates.entries()) {
      const task = makeTask(`terminal-${index}`, state, now);
      addProgress(progress, task.id);
      await store.save(task, context);
    }
    now += 10;
    store.cleanupRetainedTasks(now);

    for (let index = 0; index < terminalStates.length; index += 1) {
      await expect(store.load(`terminal-${index}`, context)).resolves.toBeUndefined();
      expect(progress.get(`terminal-${index}`)).toBeUndefined();
    }
  });

  it("R1-2 keeps terminal tasks and progress before their TTL", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 100, maxRetainedTasks: 10, now: () => now });
    const context = new ServerCallContext();
    const task = makeTask("fresh", TaskState.TASK_STATE_COMPLETED, now);
    addProgress(progress, task.id);
    await store.save(task, context);

    now = 1099;
    expect(store.cleanupRetainedTasks(now).totalRemoved).toBe(0);
    await expect(store.load(task.id, context)).resolves.toMatchObject({ id: task.id });
    expect(progress.get(task.id)?.events).toHaveLength(1);
  });

  it("does not extend terminalAt when the same terminal task is saved again", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 100, maxRetainedTasks: 10, now: () => now });
    const context = new ServerCallContext();
    const task = makeTask("same-terminal", TaskState.TASK_STATE_COMPLETED, now);
    await store.save(task, context);

    now = 1090;
    await store.save(makeTask(task.id, TaskState.TASK_STATE_COMPLETED, now), context);
    now = 1100;

    expect(store.cleanupRetainedTasks(now).ttlRemoved).toBe(1);
    await expect(store.load(task.id, context)).resolves.toBeUndefined();
  });

  it("R1-3 never removes an old non-terminal task or its progress", async () => {
    let now = 0;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 10, maxRetainedTasks: 1, now: () => now });
    const context = new ServerCallContext();
    const tasks = [
      makeTask("old-running", TaskState.TASK_STATE_WORKING, now),
      makeTask("old-submitted", TaskState.TASK_STATE_SUBMITTED, now),
    ];
    for (const task of tasks) {
      addProgress(progress, task.id);
      await store.save(task, context);
    }

    now = 1000;
    expect(store.cleanupRetainedTasks(now).totalRemoved).toBe(0);
    for (const task of tasks) {
      await expect(store.load(task.id, context)).resolves.toMatchObject({ id: task.id });
      expect(progress.get(task.id)?.events).toHaveLength(1);
    }
  });

  it("R1-4 retains the newest terminal tasks and removes progress for max-limit evictions", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 10_000, maxRetainedTasks: 3, now: () => now });
    const context = new ServerCallContext();

    for (let index = 1; index <= 5; index += 1) {
      now += 1;
      const task = makeTask(`T${index}`, TaskState.TASK_STATE_COMPLETED, now);
      addProgress(progress, task.id);
      await store.save(task, context);
    }

    for (const id of ["T1", "T2"]) {
      await expect(store.load(id, context)).resolves.toBeUndefined();
      expect(progress.get(id)).toBeUndefined();
    }
    for (const id of ["T3", "T4", "T5"]) {
      await expect(store.load(id, context)).resolves.toMatchObject({ id });
      expect(progress.get(id)?.events).toHaveLength(1);
    }
  });

  it("R1-5 excludes running tasks from the terminal-task quota", async () => {
    let now = 10_000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 100, maxRetainedTasks: 3, now: () => now });
    const context = new ServerCallContext();

    for (let index = 1; index <= 3; index += 1) {
      const task = makeTask(`terminal-${index}`, TaskState.TASK_STATE_COMPLETED, now - index);
      addProgress(progress, task.id);
      await store.save(task, context);
    }
    for (let index = 1; index <= 5; index += 1) {
      const task = makeTask(`running-${index}`, TaskState.TASK_STATE_WORKING, 0);
      addProgress(progress, task.id);
      await store.save(task, context);
    }

    now = 10_050;
    expect(store.cleanupRetainedTasks(now).totalRemoved).toBe(0);
    const listed = await store.list(listParams(), context);
    expect(listed.totalSize).toBe(8);
    expect(listed.tasks.filter((task) => task.status?.state === TaskState.TASK_STATE_WORKING)).toHaveLength(5);
  });

  it("R1-6 expires old tasks before evicting the oldest remaining tasks over max", () => {
    const plan = planTaskRetention([
      { key: "T1", terminalAt: 0, sequence: 1 },
      { key: "T2", terminalAt: 1, sequence: 2 },
      { key: "T3", terminalAt: 20, sequence: 3 },
      { key: "T4", terminalAt: 21, sequence: 4 },
      { key: "T5", terminalAt: 22, sequence: 5 },
    ], 29, 10, 2);

    expect(plan.expiredKeys).toEqual(["T1", "T2"]);
    expect(plan.maxLimitKeys).toEqual(["T3"]);
  });

  it("R1-7 makes repeated cleanup idempotent", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 1, maxRetainedTasks: 10, now: () => now });
    const context = new ServerCallContext();
    const task = makeTask("once", TaskState.TASK_STATE_COMPLETED, now);
    addProgress(progress, task.id);
    await store.save(task, context);

    now += 1;
    expect(store.cleanupRetainedTasks(now).totalRemoved).toBe(1);
    expect(store.cleanupRetainedTasks(now).totalRemoved).toBe(0);
    expect(progress.get(task.id)).toBeUndefined();
  });

  it("R1-8 deletes a task even when it has no progress entry", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 1, maxRetainedTasks: 10, now: () => now });
    const context = new ServerCallContext();
    await store.save(makeTask("without-progress", TaskState.TASK_STATE_FAILED, now), context);

    now += 1;
    expect(store.cleanupRetainedTasks(now).ttlRemoved).toBe(1);
    await expect(store.load("without-progress", context)).resolves.toBeUndefined();
  });

  it("R1-9 makes progress deletion idempotent", () => {
    const progress = new TaskProgressStore();
    expect(() => {
      progress.delete("missing");
      progress.delete("missing");
    }).not.toThrow();
    expect(progress.get("missing")).toBeUndefined();
  });

  it("R1-10 leaves context session lifecycle outside task retention", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 1, maxRetainedTasks: 10, now: () => now });
    const contextSessions = new Map([["context-1", { sessionId: "session-1" }]]);
    const closeSession = vi.fn();
    const context = new ServerCallContext();
    await store.save(makeTask("old-task", TaskState.TASK_STATE_COMPLETED, now, "context-1"), context);

    now += 1;
    store.cleanupRetainedTasks(now);

    expect(contextSessions.get("context-1")).toEqual({ sessionId: "session-1" });
    expect(closeSession).not.toHaveBeenCalled();
  });

  it("R1-11 and R1-12 make removed tasks absent from GetTask and ListTasks", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 1, maxRetainedTasks: 10, now: () => now });
    const context = new ServerCallContext();
    await store.save(makeTask("removed", TaskState.TASK_STATE_REJECTED, now), context);
    const handler = new DefaultRequestHandler(
      { name: "retention test" } as AgentCard,
      store,
      { execute: async () => undefined, cancelTask: async () => undefined } as AgentExecutor,
    );

    now += 1;
    store.cleanupRetainedTasks(now);

    await expect(handler.getTask({ tenant: "", id: "removed", historyLength: 1 }, context))
      .rejects.toBeInstanceOf(TaskNotFoundError);
    const list = await handler.listTasks(listParams(), context);
    expect(list.tasks).toEqual([]);
    expect(list.totalSize).toBe(0);
  });

  it("preserves A2A task sorting, filtering, pagination, and artifact omission", async () => {
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, { retentionMs: 10_000, maxRetainedTasks: 10, now: () => now });
    const context = new ServerCallContext();
    for (const task of [
      makeTask("older", TaskState.TASK_STATE_COMPLETED, 100),
      makeTask("newest", TaskState.TASK_STATE_COMPLETED, 300, "context-special"),
      makeTask("middle", TaskState.TASK_STATE_FAILED, 200),
    ]) {
      now += 1;
      await store.save(task, context);
    }

    const firstPage = await store.list({ ...listParams(), pageSize: 2 }, context);
    expect(firstPage.tasks.map((task) => task.id)).toEqual(["newest", "middle"]);
    expect(firstPage.tasks.every((task) => task.artifacts.length === 0)).toBe(true);
    expect(firstPage.totalSize).toBe(3);
    expect(firstPage.nextPageToken).not.toBe("");
    const secondPage = await store.list({
      ...listParams(),
      pageSize: 2,
      pageToken: firstPage.nextPageToken,
      includeArtifacts: true,
    }, context);
    expect(secondPage.tasks.map((task) => task.id)).toEqual(["older"]);
    expect(secondPage.tasks[0]?.artifacts).toHaveLength(1);

    const contextFiltered = await store.list({
      ...listParams(),
      contextId: "context-special",
    }, context);
    expect(contextFiltered.tasks.map((task) => task.id)).toEqual(["newest"]);
    const stateFiltered = await store.list({
      ...listParams(),
      status: TaskState.TASK_STATE_FAILED,
    }, context);
    expect(stateFiltered.tasks.map((task) => task.id)).toEqual(["middle"]);
  });

  it("runs periodic TTL cleanup and clears its timer on close", async () => {
    vi.useFakeTimers();
    let now = 1000;
    const progress = new TaskProgressStore();
    const store = createStore(progress, {
      retentionMs: 10,
      maxRetainedTasks: 10,
      cleanupIntervalMs: 5,
      now: () => now,
    });
    const context = new ServerCallContext();
    const task = makeTask("timer-task", TaskState.TASK_STATE_COMPLETED, now);
    await store.save(task, context);

    now += 10;
    await vi.advanceTimersByTimeAsync(5);
    await expect(store.load(task.id, context)).resolves.toBeUndefined();
    expect(progress.get(task.id)).toBeUndefined();

    store.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function listParams() {
  return {
    tenant: "",
    contextId: "",
    status: TaskState.TASK_STATE_UNSPECIFIED,
    pageSize: 100,
    pageToken: "",
    historyLength: 1,
    statusTimestampAfter: undefined,
    includeArtifacts: false,
  };
}
