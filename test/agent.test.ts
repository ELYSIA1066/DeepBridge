import { Role, TaskState, type AgentCard, type SendMessageRequest, type Task } from "@a2a-js/sdk";
import {
  DefaultExecutionEventBus,
  DefaultRequestHandler,
  InMemoryTaskStore,
  ServerCallContext,
  type AgentExecutionEvent,
  RequestContext,
} from "@a2a-js/sdk/server";
import { describe, expect, it, vi } from "vitest";
import { CONTEXT_ID_PROVIDED_STATE_KEY, DshAgentExecutor } from "../app/agent.js";
import { DshOperationTimeoutError, DshPermissionRejectedError } from "../app/dsh.js";
import { TaskProgressStore, type DshProgressUpdate } from "../app/progress.js";

function requestContext(text = "Review this architecture."): RequestContext {
  return {
    taskId: "task-1",
    contextId: "context-1",
    userMessage: {
      messageId: "message-1",
      taskId: "",
      contextId: "",
      role: Role.ROLE_USER,
      parts: [
        {
          content: { $case: "text", value: text },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        },
      ],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
  } as unknown as RequestContext;
}

describe("DshAgentExecutor", () => {
  it("publishes submitted, working, artifact, and completed events", async () => {
    const dsh = { run: vi.fn().mockResolvedValue("Architecture looks sound.") };
    const executor = new DshAgentExecutor(dsh);
    const eventBus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    eventBus.on("event", (event) => events.push(event));

    await executor.execute(requestContext(), eventBus);

    const states = events.flatMap((event) => {
      if (event.kind === "task") return [event.data.status?.state];
      if (event.kind === "statusUpdate") return [event.data.status?.state];
      return [];
    });
    expect(states).toEqual([
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_COMPLETED,
    ]);
    expect(dsh.run).toHaveBeenCalledWith(
      "Review this architecture.", expect.any(AbortSignal), undefined, undefined, expect.any(Function),
    );

    const artifactEvent = events.find((event) => event.kind === "artifactUpdate");
    expect(artifactEvent?.kind).toBe("artifactUpdate");
    if (artifactEvent?.kind === "artifactUpdate") {
      expect(artifactEvent.data.artifact?.parts[0]?.content).toEqual({
        $case: "text",
        value: "Architecture looks sound.",
      });
      expect(artifactEvent.data.artifact?.parts[0]?.mediaType).toBe("text/markdown");
    }
  });

  it("uses only an explicitly supplied A2A contextId for persistent continuation", async () => {
    const dsh = { run: vi.fn().mockResolvedValue("continued") };
    const executor = new DshAgentExecutor(dsh);
    const eventBus = new DefaultExecutionEventBus();
    const input = requestContext();
    (input as unknown as { context: { state: Map<string, unknown> } }).context = {
      state: new Map([[CONTEXT_ID_PROVIDED_STATE_KEY, true]]),
    };

    await executor.execute(input, eventBus);

    expect(dsh.run).toHaveBeenCalledWith(
      "Review this architecture.",
      expect.any(AbortSignal),
      "context-1",
      undefined,
      expect.any(Function),
    );
  });

  it("uses the existing A2A task context when a continuation message omits contextId", async () => {
    const dsh = { run: vi.fn().mockResolvedValue("continued") };
    const executor = new DshAgentExecutor(dsh);
    const eventBus = new DefaultExecutionEventBus();
    const input = requestContext();
    (input as unknown as { context: { state: Map<string, unknown> } }).context = {
      state: new Map([[CONTEXT_ID_PROVIDED_STATE_KEY, false]]),
    };
    (input as unknown as { task: { contextId: string } }).task = {
      contextId: "context-1",
    };

    await executor.execute(input, eventBus);

    expect(dsh.run).toHaveBeenCalledWith(
      "Review this architecture.",
      expect.any(AbortSignal),
      "context-1",
      undefined,
      expect.any(Function),
    );
  });

  it("turns adapter exceptions into a failed task with a readable message", async () => {
    const dsh = { run: vi.fn().mockRejectedValue(new Error("private runtime detail")) };
    const executor = new DshAgentExecutor(dsh);
    const eventBus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    eventBus.on("event", (event) => events.push(event));

    await executor.execute(requestContext(), eventBus);

    const finalEvent = events.at(-1);
    expect(finalEvent?.kind).toBe("statusUpdate");
    if (finalEvent?.kind === "statusUpdate") {
      expect(finalEvent.data.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(finalEvent.data.status?.message?.parts[0]?.content).toEqual({
        $case: "text",
        value: "DeepSeek Harness task execution failed",
      });
      expect(JSON.stringify(finalEvent)).not.toContain("private runtime detail");
    }
  });

  it("maps a bridge permission rejection to a rejected task without an artifact", async () => {
    const dsh = { run: vi.fn().mockRejectedValue(new DshPermissionRejectedError()) };
    const executor = new DshAgentExecutor(dsh);
    const eventBus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    eventBus.on("event", (event) => events.push(event));

    await executor.execute(requestContext(), eventBus);

    const finalEvent = events.at(-1);
    expect(finalEvent?.kind).toBe("statusUpdate");
    if (finalEvent?.kind === "statusUpdate") {
      expect(finalEvent.data.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
      expect(finalEvent.data.status?.message?.parts[0]?.content).toEqual({
        $case: "text",
        value: "The requested operation requires permission that is disabled by the bridge policy.",
      });
    }
    expect(events.some((event) => event.kind === "artifactUpdate")).toBe(false);
    expect(dsh.run).toHaveBeenCalledTimes(1);
  });

  it("ignores late ACP progress after a permission rejection", async () => {
    let lateProgress!: (update: DshProgressUpdate) => void;
    const progress = new TaskProgressStore();
    const dsh = {
      run: vi.fn((
        _prompt: string,
        _signal?: AbortSignal,
        _contextId?: string,
        onProgress?: (update: DshProgressUpdate) => void,
      ) => {
        lateProgress = onProgress ?? (() => undefined);
        return Promise.reject(new DshPermissionRejectedError());
      }),
    };
    const executor = new DshAgentExecutor(dsh, progress);
    const eventBus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    eventBus.on("event", (event) => events.push(event));

    await executor.execute(requestContext(), eventBus);
    lateProgress({ kind: "assistant", text: "late assistant after rejection" });

    const states = events.flatMap((event) =>
      event.kind === "task" || event.kind === "statusUpdate" ? [event.data.status?.state] : [],
    );
    expect(states).toEqual([
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_REJECTED,
    ]);
    expect(events.some((event) => event.kind === "artifactUpdate")).toBe(false);
    expect(progress.get("task-1")?.events).toEqual([]);
  });

  it("fails without invoking DSH when the message has no text", async () => {
    const dsh = { run: vi.fn() };
    const executor = new DshAgentExecutor(dsh);
    const eventBus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    eventBus.on("event", (event) => events.push(event));
    const input = requestContext();
    input.userMessage.parts = [];

    await executor.execute(input, eventBus);

    expect(dsh.run).not.toHaveBeenCalled();
    const finalEvent = events.at(-1);
    expect(finalEvent?.kind).toBe("statusUpdate");
    if (finalEvent?.kind === "statusUpdate") {
      expect(finalEvent.data.status?.state).toBe(TaskState.TASK_STATE_FAILED);
      expect(finalEvent.data.status?.message?.parts[0]?.content).toMatchObject({
        value: "Only text input is supported. Send at least one text part.",
      });
    }
  });

  it("forwards A2A cancellation to the active ACP prompt", async () => {
    const progress = new TaskProgressStore();
    const dsh = {
      run: vi.fn((
        _prompt: string,
        signal?: AbortSignal,
        _contextId?: string,
        onProgress?: (update: DshProgressUpdate) => void,
      ) => {
        onProgress?.({ kind: "assistant", text: "before cancel" });
        return new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    };
    const executor = new DshAgentExecutor(dsh, progress);
    const eventBus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    eventBus.on("event", (event) => events.push(event));

    const execution = executor.execute(requestContext(), eventBus);
    await vi.waitFor(() => expect(dsh.run).toHaveBeenCalled());
    await executor.cancelTask("task-1", eventBus);
    await execution;

    const finalEvent = events.at(-1);
    expect(finalEvent?.kind).toBe("statusUpdate");
    if (finalEvent?.kind === "statusUpdate") {
      expect(finalEvent.data.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
      expect(finalEvent.data.status?.message?.parts[0]?.content).toMatchObject({
        value: "Task was canceled.",
      });
    }
    expect(progress.get("task-1")?.events).toMatchObject([
      { kind: "assistant", text: "before cancel" },
    ]);
  });

  it("settles the SDK cancelTask request as CANCELED and allows the same context to continue", async () => {
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => (promptStarted = resolve));
    const dsh = {
      run: vi.fn((prompt: string, signal?: AbortSignal, contextId?: string) => {
        if (prompt === "cancel this task") {
          return new Promise<string>((_resolve, reject) => {
            promptStarted();
            signal?.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          });
        }
        return Promise.resolve("continued:" + contextId);
      }),
    };
    const executor = new DshAgentExecutor(dsh);
    const handler = new DefaultRequestHandler(
      { name: "cancel integration test" } as AgentCard,
      new InMemoryTaskStore(),
      executor,
    );
    const context = new ServerCallContext();
    context.state.set(CONTEXT_ID_PROVIDED_STATE_KEY, true);
    const send = (text: string, returnImmediately: boolean): SendMessageRequest => ({
      tenant: "",
      message: {
        messageId: "message-" + text,
        taskId: "",
        contextId: "same-context",
        role: Role.ROLE_USER,
        parts: [{
          content: { $case: "text", value: text },
          metadata: undefined,
          filename: "",
          mediaType: "text/plain",
        }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: ["text/markdown"],
        taskPushNotificationConfig: undefined,
        returnImmediately,
      },
      metadata: undefined,
    });

    const submitted = await handler.sendMessage(send("cancel this task", true), context) as Task;
    await started;
    const canceled = await handler.cancelTask({ tenant: "", id: submitted.id, metadata: undefined }, context);
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);

    const continued = await handler.sendMessage(send("continue", false), context) as Task;
    expect(continued.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(dsh.run.mock.calls.map((call) => call[2])).toEqual(["same-context", "same-context"]);
  });

  it("does not publish a successful artifact when DSH resolves after cancellation", async () => {
    let resolveRun!: (text: string) => void;
    const delayedRun = new Promise<string>((resolve) => (resolveRun = resolve));
    const dsh = { run: vi.fn(() => delayedRun) };
    const executor = new DshAgentExecutor(dsh);
    const eventBus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    eventBus.on("event", (event) => events.push(event));

    const execution = executor.execute(requestContext(), eventBus);
    await vi.waitFor(() => expect(dsh.run).toHaveBeenCalled());
    const cancellation = executor.cancelTask("task-1", eventBus);
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "statusUpdate" &&
        event.data.status?.state === TaskState.TASK_STATE_CANCELED)).toBe(true);
    });
    resolveRun("late success");
    await Promise.all([execution, cancellation]);

    const states = events.flatMap((event) => {
      if (event.kind === "task") return [event.data.status?.state];
      if (event.kind === "statusUpdate") return [event.data.status?.state];
      return [];
    });
    expect(states).toEqual([
      TaskState.TASK_STATE_SUBMITTED,
      TaskState.TASK_STATE_WORKING,
      TaskState.TASK_STATE_CANCELED,
    ]);
    expect(events.some((event) => event.kind === "artifactUpdate")).toBe(false);
  });

  it("publishes FAILED at timeout and ignores late completion and artifacts", async () => {
    let resolveRun!: (text: string) => void;
    let lateProgress!: (update: DshProgressUpdate) => void;
    const delayedRun = new Promise<string>((resolve) => (resolveRun = resolve));
    const dsh = {
      run: vi.fn((
        _prompt: string,
        _signal?: AbortSignal,
        _contextId?: string,
        onProgress?: (update: DshProgressUpdate) => void,
        onTimeout?: (error: DshOperationTimeoutError) => void,
      ) => {
        lateProgress = onProgress ?? (() => undefined);
        queueMicrotask(() => onTimeout?.(new DshOperationTimeoutError("prompt", 25)));
        return delayedRun;
      }),
    };
    const progress = new TaskProgressStore();
    const executor = new DshAgentExecutor(dsh, progress);
    const eventBus = new DefaultExecutionEventBus();
    const events: AgentExecutionEvent[] = [];
    eventBus.on("event", (event) => events.push(event));

    const execution = executor.execute(requestContext(), eventBus);
    await vi.waitFor(() => {
      expect(events.some((event) => event.kind === "statusUpdate" &&
        event.data.status?.state === TaskState.TASK_STATE_FAILED)).toBe(true);
    });
    lateProgress({ kind: "assistant", text: "late assistant text" });
    resolveRun("late timeout success");
    await execution;

    const terminalStates = events.flatMap((event) =>
      event.kind === "statusUpdate" ? [event.data.status?.state] : [],
    ).filter((state) => state === TaskState.TASK_STATE_COMPLETED ||
      state === TaskState.TASK_STATE_FAILED || state === TaskState.TASK_STATE_CANCELED);
    expect(terminalStates).toEqual([TaskState.TASK_STATE_FAILED]);
    expect(events.some((event) => event.kind === "artifactUpdate")).toBe(false);
    expect(progress.get("task-1")?.events).toEqual([]);
    const finalEvent = events.at(-1);
    expect(finalEvent?.kind).toBe("statusUpdate");
    if (finalEvent?.kind === "statusUpdate") {
      expect(finalEvent.data.status?.message?.parts[0]?.content).toMatchObject({
        value: "DSH prompt exceeded 25 ms.",
      });
    }
  });

  it("keeps separate task timelines in one context across completed, rejected, and failed tasks", async () => {
    const progress = new TaskProgressStore();
    const dsh = {
      run: vi.fn(async (
        prompt: string,
        _signal?: AbortSignal,
        _contextId?: string,
        onProgress?: (update: DshProgressUpdate) => void,
      ) => {
        onProgress?.({ kind: "assistant", text: `Progress: ${prompt}` });
        if (prompt === "reject") throw new DshPermissionRejectedError();
        if (prompt === "fail") throw new Error("private failure");
        return `Result: ${prompt}`;
      }),
    };
    const executor = new DshAgentExecutor(dsh, progress);
    for (const [taskId, prompt] of [
      ["task-complete", "complete"],
      ["task-reject", "reject"],
      ["task-fail", "fail"],
    ] as const) {
      const input = requestContext(prompt);
      (input as unknown as { taskId: string }).taskId = taskId;
      (input as unknown as { context: { state: Map<string, unknown> } }).context = {
        state: new Map([[CONTEXT_ID_PROVIDED_STATE_KEY, true]]),
      };
      await executor.execute(input, new DefaultExecutionEventBus());
      expect(progress.get(taskId)?.events).toMatchObject([
        { kind: "assistant", text: `Progress: ${prompt}` },
      ]);
      progress.add(taskId, { kind: "assistant", text: "late event" });
      expect(progress.get(taskId)?.events).toHaveLength(1);
    }
    expect(dsh.run.mock.calls.map((call) => call[2])).toEqual([
      "context-1", "context-1", "context-1",
    ]);
  });
});
