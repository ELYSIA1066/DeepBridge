import { randomUUID } from "node:crypto";
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Part,
  type Task,
  type TaskStatus,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";
import {
  DshAdapter,
  DshAdapterError,
  DshContextBusyError,
  DshOperationTimeoutError,
  DshPermissionRejectedError,
} from "./dsh.js";
import { TaskProgressStore } from "./progress.js";

type DshRunner = Pick<DshAdapter, "run">;
export const CONTEXT_ID_PROVIDED_STATE_KEY = "dsh-bridge-context-id-provided";

type ActiveTask = {
  taskId: string;
  contextId: string;
  controller: AbortController;
  eventBus: ExecutionEventBus;
  terminal: boolean;
  cancelRequested: boolean;
  settled: Promise<void>;
  resolveSettled: () => void;
};

export class DshAgentExecutor implements AgentExecutor {
  private readonly activeTasks = new Map<string, ActiveTask>();

  constructor(
    private readonly dsh: DshRunner,
    private readonly progress?: TaskProgressStore,
  ) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    const controller = new AbortController();
    let resolveSettled!: () => void;
    const active: ActiveTask = {
      taskId,
      contextId,
      controller,
      eventBus,
      terminal: false,
      cancelRequested: false,
      settled: new Promise<void>((resolve) => (resolveSettled = resolve)),
      resolveSettled: () => resolveSettled(),
    };
    this.activeTasks.set(taskId, active);
    const task: Task = {
      id: taskId,
      contextId,
      status: status(TaskState.TASK_STATE_SUBMITTED),
      artifacts: requestContext.task?.artifacts ?? [],
      history: [...(requestContext.task?.history ?? []), requestContext.userMessage],
      metadata: requestContext.task?.metadata,
    };

    const startedAt = Date.now();
    this.progress?.start(taskId);

    try {
      eventBus.publish(AgentEvent.task(task));
      const prompt = extractTextPrompt(requestContext.userMessage.parts);
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: status(TaskState.TASK_STATE_WORKING),
          metadata: undefined,
        }),
      );

      const contextIdForSession = hasProvidedContextId(requestContext) ? contextId : undefined;
      const resultText = await this.dsh.run(
        prompt,
        controller.signal,
        contextIdForSession,
        this.progress ? (update) => this.progress?.add(taskId, update) : undefined,
        (error) => this.publishTerminal(
          active,
          TaskState.TASK_STATE_FAILED,
          error.message,
        ),
      );
      if (active.terminal || controller.signal.aborted) return;

      const artifact: Artifact = {
        artifactId: randomUUID(),
        name: "result",
        description: "Final text from DeepSeek Harness",
        parts: [textPart(resultText, "text/markdown")],
        metadata: undefined,
        extensions: [],
      };

      if (!this.markTerminal(active)) return;
      eventBus.publish(AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact,
        append: false,
        lastChunk: true,
        metadata: undefined,
      }));
      eventBus.publish(AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: status(TaskState.TASK_STATE_COMPLETED),
        metadata: undefined,
      }));
      this.progress?.finish(taskId);
      console.info(
        JSON.stringify({
          component: "a2a-agent",
          taskId,
          state: "completed",
          durationMs: Date.now() - startedAt,
        }),
      );
    } catch (error) {
      if (active.terminal) return;
      const canceled = active.cancelRequested || controller.signal.aborted;
      const permissionRejected = !canceled && error instanceof DshPermissionRejectedError;
      const message = canceled
        ? "Task was canceled."
        : permissionRejected
          ? "The requested operation requires permission that is disabled by the bridge policy."
          : publicErrorMessage(error);
      this.publishTerminal(
        active,
        canceled
          ? TaskState.TASK_STATE_CANCELED
          : permissionRejected
            ? TaskState.TASK_STATE_REJECTED
            : TaskState.TASK_STATE_FAILED,
        message,
      );
      console[canceled || permissionRejected ? "info" : "error"](
        JSON.stringify({
          component: "a2a-agent",
          taskId,
          state: canceled ? "canceled" : permissionRejected ? "rejected" : "failed",
          ...(!canceled && !permissionRejected && {
            errorType: error instanceof Error ? error.name : "UnknownError",
          }),
          durationMs: Date.now() - startedAt,
        }),
      );
    } finally {
      this.progress?.finish(taskId);
      if (this.activeTasks.get(taskId) === active) this.activeTasks.delete(taskId);
      active.resolveSettled();
    }
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    const active = this.activeTasks.get(taskId);
    if (!active || active.terminal) return;

    active.cancelRequested = true;
    active.controller.abort(new DOMException("Task was canceled.", "AbortError"));
    this.publishTerminal(active, TaskState.TASK_STATE_CANCELED, "Task was canceled.");
    await active.settled;
  }

  private markTerminal(active: ActiveTask): boolean {
    if (active.terminal) return false;
    active.terminal = true;
    return true;
  }

  private publishTerminal(active: ActiveTask, state: TaskState, message: string): boolean {
    if (!this.markTerminal(active)) return false;
    active.eventBus.publish(AgentEvent.statusUpdate({
      taskId: active.taskId,
      contextId: active.contextId,
      status: status(state, agentMessage(message, active.taskId, active.contextId)),
      metadata: undefined,
    }));
    this.progress?.finish(active.taskId);
    return true;
  }
}

function extractTextPrompt(parts: Part[]): string {
  if (parts.length === 0 || parts.some((part) => part.content?.$case !== "text")) {
    throw new Error("Only text input is supported. Send at least one text part.");
  }

  const prompt = parts
    .map((part) => (part.content?.$case === "text" ? part.content.value : ""))
    .join("\n")
    .trim();

  if (!prompt) {
    throw new Error("The A2A message must contain non-empty text.");
  }

  return prompt;
}

function status(state: TaskState, message?: Message): TaskStatus {
  return {
    state,
    message,
    timestamp: new Date().toISOString(),
  };
}

function agentMessage(text: string, taskId: string, contextId: string): Message {
  return {
    messageId: randomUUID(),
    taskId,
    contextId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text, "text/plain")],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function textPart(text: string, mediaType: string): Part {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType,
  };
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof DshOperationTimeoutError) return error.message;
  if (error instanceof DshAdapterError) return error.publicMessage;
  if (error instanceof DshContextBusyError) return error.message;
  if (error instanceof Error && error.message.startsWith("Only text input")) return error.message;
  if (error instanceof Error && error.message.startsWith("The A2A message")) return error.message;
  return "DeepSeek Harness task execution failed";
}

function hasProvidedContextId(requestContext: RequestContext): boolean {
  return (
    requestContext.context?.state.get(CONTEXT_ID_PROVIDED_STATE_KEY) === true ||
    Boolean(requestContext.task?.contextId)
  );
}
