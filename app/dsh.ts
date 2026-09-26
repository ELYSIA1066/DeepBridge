import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import spawn from "cross-spawn";
import {
  DEFAULT_CONTEXT_IDLE_TTL_MS,
  DEFAULT_DSH_CANCEL_TIMEOUT_MS,
  DEFAULT_DSH_CLOSE_TIMEOUT_MS,
  DEFAULT_DSH_PROMPT_TIMEOUT_MS,
  DEFAULT_DSH_SESSION_TIMEOUT_MS,
  DEFAULT_DSH_START_TIMEOUT_MS,
  DEFAULT_DSH_TERMINATE_GRACE_MS,
} from "./config.js";
import type { DshProgressUpdate } from "./progress.js";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type ActiveSession,
  type ClientConnection,
} from "@agentclientprotocol/sdk";

export type DshFailureStage = "startup" | "session" | "execution";
export type DshOperationPhase = "startup" | "session" | "prompt" | "cancel" | "close" | "terminate";

const FAILURE_MESSAGES: Record<DshFailureStage, string> = {
  startup: "DeepSeek Harness ACP unavailable",
  session: "Failed to create DeepSeek Harness session",
  execution: "DeepSeek Harness task execution failed",
};

export class DshAdapterError extends Error {
  readonly publicMessage: string;
  readonly stage: DshFailureStage;

  constructor(stage: DshFailureStage, cause: unknown) {
    super(FAILURE_MESSAGES[stage], { cause });
    this.name = "DshAdapterError";
    this.publicMessage = FAILURE_MESSAGES[stage];
    this.stage = stage;
  }
}

export class DshOperationTimeoutError extends Error {
  readonly phase: DshOperationPhase;
  readonly timeoutMs: number;

  constructor(phase: DshOperationPhase, timeoutMs: number) {
    const operation = phase === "session" ? "session creation" : phase;
    super(`DSH ${operation} exceeded ${timeoutMs} ms.`);
    this.name = "DshOperationTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export class DshPermissionRejectedError extends Error {
  constructor() {
    super("DSH operation rejected by bridge permission policy");
    this.name = "DshPermissionRejectedError";
  }
}

export class DshContextBusyError extends Error {
  constructor(contextId: string) {
    super(`Context ${contextId} is currently busy.`);
    this.name = "DshContextBusyError";
  }
}

type DshAdapterOptions = {
  command: string;
  cwd?: string;
  spawnProcess?: typeof spawn;
  contextIdleTtlMs?: number;
  now?: () => number;
  startTimeoutMs?: number;
  sessionTimeoutMs?: number;
  promptTimeoutMs?: number;
  cancelTimeoutMs?: number;
  closeTimeoutMs?: number;
  terminateGraceMs?: number;
};

type TimeoutCallback = (error: DshOperationTimeoutError) => void;
type ProgressCallback = (update: DshProgressUpdate) => void;

type DshTimeouts = {
  startMs: number;
  sessionMs: number;
  promptMs: number;
  cancelMs: number;
  closeMs: number;
  terminateGraceMs: number;
};

type PersistentContext = {
  session: DshSession;
  lastUsedAt: number;
};

export class DshAdapter {
  private readonly cwd: string;
  private readonly spawnProcess: typeof spawn;
  private readonly contextIdleTtlMs: number;
  private readonly now: () => number;
  private readonly timeouts: DshTimeouts;
  private readonly contextSessions = new Map<string, PersistentContext>();
  private readonly busyContexts = new Set<string>();
  private readonly ownedSessions = new Set<DshSession>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | undefined;

  constructor(private readonly options: DshAdapterOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.contextIdleTtlMs = options.contextIdleTtlMs ?? DEFAULT_CONTEXT_IDLE_TTL_MS;
    this.now = options.now ?? Date.now;
    this.timeouts = {
      startMs: positiveTimeout(options.startTimeoutMs, DEFAULT_DSH_START_TIMEOUT_MS),
      sessionMs: positiveTimeout(options.sessionTimeoutMs, DEFAULT_DSH_SESSION_TIMEOUT_MS),
      promptMs: positiveTimeout(options.promptTimeoutMs, DEFAULT_DSH_PROMPT_TIMEOUT_MS),
      cancelMs: positiveTimeout(options.cancelTimeoutMs, DEFAULT_DSH_CANCEL_TIMEOUT_MS),
      closeMs: positiveTimeout(options.closeTimeoutMs, DEFAULT_DSH_CLOSE_TIMEOUT_MS),
      terminateGraceMs: positiveTimeout(options.terminateGraceMs, DEFAULT_DSH_TERMINATE_GRACE_MS),
    };
  }

  async run(
    taskText: string,
    signal?: AbortSignal,
    contextId?: string,
    onProgress?: ProgressCallback,
    onTimeout?: TimeoutCallback,
  ): Promise<string> {
    if (this.shuttingDown) {
      throw new DshAdapterError("startup", new Error("The bridge is shutting down."));
    }
    if (signal?.aborted) throw abortError(signal.reason);

    await this.cleanupExpiredContexts();
    if (this.shuttingDown) {
      throw new DshAdapterError("startup", new Error("The bridge is shutting down."));
    }
    if (signal?.aborted) throw abortError(signal.reason);
    if (!contextId) return this.runOnce(taskText, signal, onProgress, onTimeout);
    if (this.busyContexts.has(contextId)) throw new DshContextBusyError(contextId);

    this.busyContexts.add(contextId);
    let entry = this.contextSessions.get(contextId);
    let session = entry?.session;
    try {
      if (session && !session.isHealthy) {
        if (this.contextSessions.get(contextId) === entry) this.contextSessions.delete(contextId);
        await this.releaseSession(session);
        entry = undefined;
        session = undefined;
      }

      if (!session) {
        session = await this.createSession((closedSession) => {
          if (this.contextSessions.get(contextId)?.session === closedSession) {
            this.contextSessions.delete(contextId);
            void this.releaseSession(closedSession);
          }
        }, onTimeout, signal);
        if (this.shuttingDown) {
          await this.releaseSession(session);
          throw new DshAdapterError("startup", new Error("The bridge is shutting down."));
        }
        if (!session.isHealthy) {
          await this.releaseSession(session);
          throw new DshAdapterError("startup", new Error("The DSH ACP process exited during startup."));
        }
        entry = { session, lastUsedAt: this.now() };
        this.contextSessions.set(contextId, entry);
      }

      if (entry) entry.lastUsedAt = this.now();
      return await session.prompt(taskText, signal, onProgress, onTimeout);
    } catch (error) {
      const retainPromptSession = error instanceof DshOperationTimeoutError && error.phase === "prompt";
      const keepSession = Boolean(session?.isHealthy) && (
        error instanceof DshPermissionRejectedError || signal?.aborted === true || retainPromptSession
      );
      if (error instanceof DshPermissionRejectedError) logPermissionRejected(session?.sessionId);
      if (session && !keepSession) {
        if (this.contextSessions.get(contextId)?.session === session) this.contextSessions.delete(contextId);
        await this.releaseSession(session);
      }
      throw error;
    } finally {
      if (entry && this.contextSessions.get(contextId) === entry) {
        if (entry.session.isHealthy) entry.lastUsedAt = this.now();
        else this.contextSessions.delete(contextId);
      }
      this.busyContexts.delete(contextId);
    }
  }

  private async cleanupExpiredContexts(): Promise<void> {
    const now = this.now();
    for (const [contextId, entry] of this.contextSessions) {
      if (this.busyContexts.has(contextId)) continue;
      if (now - entry.lastUsedAt <= this.contextIdleTtlMs) continue;

      if (this.contextSessions.get(contextId) === entry) {
        this.contextSessions.delete(contextId);
        await this.releaseSession(entry.session);
        console.info(
          JSON.stringify({ component: "dsh-adapter", event: "context_expired", contextId }),
        );
      }
    }
  }

  async closeAll(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shuttingDown = true;
    this.contextSessions.clear();
    this.shutdownPromise = Promise.all(
      [...this.ownedSessions].map((session) => this.releaseSession(session)),
    ).then(() => undefined);
    return this.shutdownPromise;
  }

  private async runOnce(
    taskText: string,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
    onTimeout?: TimeoutCallback,
  ): Promise<string> {
    const session = await this.createSession(undefined, onTimeout, signal);
    try {
      return await session.prompt(taskText, signal, onProgress, onTimeout);
    } catch (error) {
      if (error instanceof DshPermissionRejectedError) logPermissionRejected(session.sessionId);
      throw error;
    } finally {
      await this.releaseSession(session);
    }
  }

  private async createSession(
    onUnexpectedClose?: (session: DshSession) => void,
    onTimeout?: TimeoutCallback,
    signal?: AbortSignal,
  ): Promise<DshSession> {
    const session = new DshSession({
      command: this.options.command,
      cwd: this.cwd,
      spawnProcess: this.spawnProcess,
      timeouts: this.timeouts,
      ...(onUnexpectedClose ? { onUnexpectedClose } : {}),
    });
    this.ownedSessions.add(session);

    try {
      await session.start(onTimeout, signal);
      return session;
    } catch (cause) {
      await this.releaseSession(session);
      if (signal?.aborted) throw abortError(signal.reason);
      if (cause instanceof DshOperationTimeoutError || cause instanceof DshAdapterError) throw cause;
      throw new DshAdapterError(session.failureStage, cause);
    }
  }

  private async releaseSession(session: DshSession): Promise<void> {
    try {
      await session.close();
    } finally {
      this.ownedSessions.delete(session);
    }
  }
}

type DshSessionOptions = {
  command: string;
  cwd: string;
  spawnProcess: typeof spawn;
  timeouts: DshTimeouts;
  onUnexpectedClose?: (session: DshSession) => void;
};

type PromptInterruption = "user" | "timeout" | "shutdown";
type PromptOperationState = "running" | "settled" | PromptInterruption;
type PromptResponse = Awaited<ReturnType<ActiveSession["prompt"]>>;

type PromptOperation = {
  id: number;
  state: PromptOperationState;
  cancellation: AbortController;
  interrupted: Promise<PromptInterruption>;
  resolveInterrupted: (reason: PromptInterruption) => void;
  work?: Promise<string>;
  workSettled: boolean;
  response?: PromptResponse;
  updatesStopped: boolean;
  timeoutError?: DshOperationTimeoutError;
  escalation?: Promise<void>;
};

class DshSession {
  private readonly options: DshSessionOptions;
  private child: ChildProcess | undefined;
  private connection: ClientConnection | undefined;
  private activeSession: ActiveSession | undefined;
  private supportsSessionClose = false;
  private permissionRejected = false;
  private processFailure: Error | undefined;
  private activePrompt: PromptOperation | undefined;
  private closePromise: Promise<void> | undefined;
  private disposalPromise: Promise<void> | undefined;
  private closing = false;
  private closeNotified = false;
  private nextOperationId = 1;
  failureStage: DshFailureStage = "startup";
  sessionId: string | undefined;

  constructor(options: DshSessionOptions) {
    this.options = options;
  }

  get isHealthy(): boolean {
    return !this.closing && !this.processFailure && !this.activePrompt &&
      this.connectionIsAlive() && this.processIsAlive() && Boolean(this.activeSession);
  }

  async start(onTimeout?: TimeoutCallback, callerSignal?: AbortSignal): Promise<void> {
    const onCallerAbort = () => {
      void this.close();
    };
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      if (callerSignal?.aborted) throw abortError(callerSignal.reason);
      await runWithPhaseTimeout(
        "startup",
        this.options.timeouts.startMs,
        (signal) => this.startTransport(signal),
        async (error) => {
          notifyTimeout(onTimeout, error);
          await this.close();
        },
      );

      if (callerSignal?.aborted) throw abortError(callerSignal.reason);
      this.failureStage = "session";
      await runWithPhaseTimeout(
        "session",
        this.options.timeouts.sessionMs,
        (signal) => this.createAcpSession(signal),
        async (error) => {
          notifyTimeout(onTimeout, error);
          await this.close();
        },
      );
      if (callerSignal?.aborted) throw abortError(callerSignal.reason);
      if (!this.isHealthy) throw new Error("The DSH ACP process exited during startup.");
    } catch (cause) {
      await this.close();
      if (callerSignal?.aborted) throw abortError(callerSignal.reason);
      if (cause instanceof DshOperationTimeoutError || cause instanceof DshAdapterError) throw cause;
      throw new DshAdapterError(this.failureStage, cause);
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async startTransport(signal: AbortSignal): Promise<void> {
    this.child = this.options.spawnProcess(
      this.options.command,
      ["--profile", "acp"],
      {
        cwd: this.options.cwd,
        env: { ...process.env, DSH_PERMISSION_MODE: "read-only" },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.child.on("error", (error) => this.markUnexpectedClose(error));
    this.child.once("close", (code, exitSignal) => {
      const details = exitSignal ? `signal ${exitSignal}` : `exit code ${String(code)}`;
      this.markUnexpectedClose(new Error(`DeepSeek Harness ACP process exited with ${details}.`));
    });
    this.child.stderr?.resume();
    await waitForSpawn(this.child);

    if (this.closing || signal.aborted) throw new Error("DSH session was closed during startup.");
    if (!this.child.stdin || !this.child.stdout) {
      throw new Error("DeepSeek Harness ACP process did not expose stdio.");
    }

    const stream = ndJsonStream(
      Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>,
    );
    const acpClient = client({ name: "DeepSeek Harness A2A Bridge" });

    acpClient.onRequest(methods.client.session.requestPermission, ({ params }) => {
      this.permissionRejected = true;
      const rejectOnce = params.options.find((option) => option.kind === "reject_once");
      if (rejectOnce) {
        return {
          outcome: { outcome: "selected" as const, optionId: rejectOnce.optionId },
        };
      }

      return { outcome: { outcome: "cancelled" as const } };
    });

    this.connection = acpClient.connect(stream);
    void this.connection.closed.then(() => {
      if (!this.closing) {
        this.markUnexpectedClose(new Error("DeepSeek Harness ACP connection closed unexpectedly."));
      }
    });

    const initialization = await this.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "DeepSeek Harness A2A Bridge", version: "0.1.0" },
    }, { cancellationSignal: signal });
    if (signal.aborted || this.closing) throw new Error("DSH ACP startup was canceled.");
    this.supportsSessionClose = Boolean(
      initialization.agentCapabilities?.sessionCapabilities?.close,
    );
  }

  private async createAcpSession(signal: AbortSignal): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.signal.aborted) throw new Error("DSH ACP transport is not connected.");
    const session = await connection.agent
      .buildSession({ cwd: this.options.cwd, mcpServers: [] })
      .start({ cancellationSignal: signal });
    if (signal.aborted || this.closing) {
      session.dispose();
      throw new Error("DSH ACP session creation was canceled.");
    }
    this.activeSession = session;
    this.sessionId = session.sessionId;
    console.info(
      JSON.stringify({ component: "dsh-adapter", event: "session_created", sessionId: this.sessionId }),
    );
  }

  async prompt(
    taskText: string,
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
    onTimeout?: TimeoutCallback,
  ): Promise<string> {
    if (!this.isHealthy || !this.activeSession) {
      throw new DshAdapterError("execution", this.processFailure ?? new Error("DSH session is not available."));
    }
    if (signal?.aborted) throw abortError(signal.reason);

    this.failureStage = "execution";
    this.permissionRejected = false;
    const operation = createPromptOperation(this.nextOperationId++);
    this.activePrompt = operation;
    operation.work = this.runPromptExchange(taskText, operation, onProgress).finally(() => {
      operation.workSettled = true;
    });
    void operation.work.catch(() => undefined);

    let timer: NodeJS.Timeout | undefined;
    const onCallerAbort = () => {
      this.requestInterruption(operation, "user", signal?.reason);
    };
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (signal?.aborted) onCallerAbort();

    if (operation.state === "running") {
      timer = setTimeout(() => {
        const error = new DshOperationTimeoutError("prompt", this.options.timeouts.promptMs);
        if (this.requestInterruption(operation, "timeout", error)) notifyTimeout(onTimeout, error);
      }, this.options.timeouts.promptMs);
      timer.unref?.();
    }

    const outcome = await Promise.race([
      operation.work.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      operation.interrupted.then((reason) => ({ kind: "interrupted" as const, reason })),
    ]);

    try {
      if (operation.state === "user" || operation.state === "timeout" || operation.state === "shutdown") {
        await this.ensureEscalation(operation);
        if (operation.state === "timeout") {
          throw operation.timeoutError ?? new DshOperationTimeoutError("prompt", this.options.timeouts.promptMs);
        }
        if (operation.state === "user") throw abortError(signal?.reason);
        throw new DshAdapterError(
          "execution",
          this.processFailure ?? new Error("DSH session closed while a prompt was running."),
        );
      }

      operation.state = "settled";
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "interrupted") {
        throw new DshAdapterError("execution", new Error("Prompt interruption state was inconsistent."));
      }
      return outcome.value;
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
      if (this.activePrompt === operation) this.activePrompt = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    const activePrompt = this.activePrompt;
    if (activePrompt?.state === "running") {
      this.requestInterruption(activePrompt, "shutdown", new Error("Bridge shutdown."));
    }
    this.closePromise = (async () => {
      if (activePrompt) await this.ensureEscalation(activePrompt);
      else await this.disposeOwnedResources();
    })();
    return this.closePromise;
  }

  private async runPromptExchange(
    taskText: string,
    operation: PromptOperation,
    onProgress?: ProgressCallback,
  ): Promise<string> {
    const session = this.activeSession;
    if (!session) throw new DshAdapterError("execution", new Error("DSH session is not available."));

    try {
      const promptResponse = session.prompt(taskText, {
        cancellationSignal: operation.cancellation.signal,
      }).then((response) => {
        operation.response = response;
        return response;
      });
      const textResponse = this.readUpdates((update) => {
        if (operation.state === "running") this.reportProgress(onProgress, update);
      }).then((text) => {
        operation.updatesStopped = true;
        return text;
      });
      const [response, text] = await Promise.all([promptResponse, textResponse]);

      if (this.processFailure) throw this.processFailure;
      if (this.permissionRejected) throw new DshPermissionRejectedError();
      if (response.stopReason === "cancelled") {
        if (operation.state !== "running") throw abortError(operation.cancellation.signal.reason);
        throw new Error("The ACP prompt was cancelled without a task cancellation request.");
      }
      if (!text.trim()) throw new Error("The ACP session completed without assistant text.");
      return text;
    } catch (cause) {
      if (this.processFailure) throw new DshAdapterError("execution", this.processFailure);
      if (this.permissionRejected) throw new DshPermissionRejectedError();
      if (operation.state !== "running") throw abortError(operation.cancellation.signal.reason);
      throw cause instanceof DshPermissionRejectedError
        ? cause
        : new DshAdapterError("execution", cause);
    }
  }

  private async readUpdates(onProgress?: ProgressCallback): Promise<string> {
    let text = "";
    for (;;) {
      const message = await this.activeSession!.nextUpdate();
      if (message.kind === "stop") return text;

      const update = message.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        text += update.content.text;
        onProgress?.({ kind: "assistant", text: update.content.text });
      } else if (update.sessionUpdate === "tool_call") {
        onProgress?.({
          kind: "tool",
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status ?? "in_progress",
        });
      } else if (update.sessionUpdate === "tool_call_update" && update.status) {
        onProgress?.({
          kind: "tool",
          toolCallId: update.toolCallId,
          ...(update.title ? { title: update.title } : {}),
          status: update.status,
        });
      }
    }
  }

  private reportProgress(onProgress: ProgressCallback | undefined, update: DshProgressUpdate): void {
    try {
      onProgress?.(update);
    } catch {
      // Dashboard recording must not alter the ACP task outcome.
    }
  }

  private requestInterruption(
    operation: PromptOperation,
    reason: PromptInterruption,
    detail?: unknown,
  ): boolean {
    if (operation.state !== "running") return false;
    operation.state = reason;
    if (reason === "timeout" && detail instanceof DshOperationTimeoutError) {
      operation.timeoutError = detail;
    }
    operation.cancellation.abort(detail ?? new Error(`Prompt ${reason}.`));
    operation.resolveInterrupted(reason);
    return true;
  }

  private ensureEscalation(operation: PromptOperation): Promise<void> {
    if (!operation.escalation) operation.escalation = this.escalatePrompt(operation);
    return operation.escalation;
  }

  private async escalatePrompt(operation: PromptOperation): Promise<void> {
    const connection = this.connection;
    const session = this.activeSession;
    let cancellationSentAndSettled = false;
    if (connection && session && !connection.signal.aborted && this.processIsAlive()) {
      const cancellation = (async () => {
        await connection.agent.notify(methods.agent.session.cancel, { sessionId: session.sessionId });
        await operation.work?.then(() => undefined, () => undefined);
      })();
      const result = await settlesWithin(cancellation, this.options.timeouts.cancelMs);
      cancellationSentAndSettled = result.settled && result.ok;
    }

    if (cancellationSentAndSettled && this.canReuseAfterInterruption(operation)) {
      console.info(JSON.stringify({
        component: "dsh-adapter",
        event: "prompt_canceled",
        sessionId: this.sessionId,
        operationId: operation.id,
        reusable: true,
      }));
      return;
    }

    console.warn(JSON.stringify({
      component: "dsh-adapter",
      event: "prompt_cancel_escalating",
      sessionId: this.sessionId,
      operationId: operation.id,
      cancelConfirmed: cancellationSentAndSettled,
    }));
    await this.disposeOwnedResources();
  }

  private canReuseAfterInterruption(operation: PromptOperation): boolean {
    return !this.closing && !this.processFailure && operation.workSettled &&
      operation.response !== undefined && operation.updatesStopped &&
      this.connectionIsAlive() && this.processIsAlive() && Boolean(this.activeSession);
  }

  private disposeOwnedResources(): Promise<void> {
    if (!this.disposalPromise) {
      this.closing = true;
      this.disposalPromise = this.doDisposeOwnedResources();
    }
    return this.disposalPromise;
  }

  private async doDisposeOwnedResources(): Promise<void> {
    const session = this.activeSession;
    const connection = this.connection;
    const child = this.child;

    if (session && connection && !connection.signal.aborted && this.supportsSessionClose) {
      const cancellation = new AbortController();
      const closeRequest = connection.agent.request(
        methods.agent.session.close,
        { sessionId: session.sessionId },
        { cancellationSignal: cancellation.signal },
      );
      const result = await settlesWithin(closeRequest, this.options.timeouts.closeMs);
      if (result.settled && result.ok) {
        console.info(JSON.stringify({ component: "dsh-adapter", event: "session_closed", sessionId: session.sessionId }));
      } else {
        if (!result.settled) cancellation.abort(new DshOperationTimeoutError("close", this.options.timeouts.closeMs));
        const error = result.settled ? result.error : new DshOperationTimeoutError("close", this.options.timeouts.closeMs);
        logCleanupFailure("session_close_failed", "close", error, session.sessionId);
      }
    } else if (session && !this.supportsSessionClose) {
      console.info(JSON.stringify({
        component: "dsh-adapter",
        event: "session_close_unsupported",
        sessionId: session.sessionId,
      }));
    }

    try {
      session?.dispose();
    } catch (error) {
      logCleanupFailure("session_dispose_failed", "close", error, session?.sessionId);
    }
    try {
      connection?.close(new Error("DSH ACP session disposed."));
    } catch (error) {
      logCleanupFailure("transport_close_failed", "close", error, session?.sessionId);
    }
    if (child) await stopChild(child, this.options.timeouts.terminateGraceMs, session?.sessionId);

    this.activeSession = undefined;
    this.connection = undefined;
    this.child = undefined;
  }

  private connectionIsAlive(): boolean {
    return Boolean(this.connection && !this.connection.signal.aborted);
  }

  private processIsAlive(): boolean {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  private markUnexpectedClose(error: Error): void {
    if (this.closing || this.processFailure) return;
    this.processFailure = error;
    this.connection?.close(error);
    if (!this.closeNotified) {
      this.closeNotified = true;
      this.options.onUnexpectedClose?.(this);
    }
  }
}

function createPromptOperation(id: number): PromptOperation {
  let resolveInterrupted!: (reason: PromptInterruption) => void;
  const interrupted = new Promise<PromptInterruption>((resolve) => (resolveInterrupted = resolve));
  return {
    id,
    state: "running",
    cancellation: new AbortController(),
    interrupted,
    resolveInterrupted,
    workSettled: false,
    updatesStopped: false,
  };
}

async function runWithPhaseTimeout<T>(
  phase: "startup" | "session",
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
  onTimeout: (error: DshOperationTimeoutError) => Promise<void>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let resolveTimeout!: (error: DshOperationTimeoutError) => void;
  const timeout = new Promise<DshOperationTimeoutError>((resolve) => (resolveTimeout = resolve));
  const running = Promise.resolve().then(() => operation(controller.signal));
  void running.catch(() => undefined);
  timer = setTimeout(() => {
    const error = new DshOperationTimeoutError(phase, timeoutMs);
    controller.abort(error);
    resolveTimeout(error);
  }, timeoutMs);
  timer.unref?.();

  try {
    const result = await Promise.race([
      running.then(
        (value) => ({ kind: "value" as const, value }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      timeout.then((error) => ({ kind: "timeout" as const, error })),
    ]);
    if (result.kind === "timeout") {
      try {
        await onTimeout(result.error);
      } catch (error) {
        logCleanupFailure("timeout_cleanup_failed", phase, error);
      }
      throw result.error;
    }
    if (result.kind === "error") throw result.error;
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Settlement<T> =
  | { settled: true; ok: true; value: T }
  | { settled: true; ok: false; error: unknown }
  | { settled: false };

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<Settlement<T>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Settlement<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs);
    timer.unref?.();
  });
  const settled: Promise<Settlement<T>> = promise.then(
    (value) => ({ settled: true, ok: true, value }),
    (error: unknown): Settlement<T> => ({ settled: true, ok: false, error }),
  );
  try {
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  if (child.pid !== undefined) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`DeepSeek Harness ACP process closed before spawn (${String(code)}, ${String(signal)}).`));
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("close", onClose);
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function stopChild(child: ChildProcess, graceMs: number, sessionId?: string): Promise<void> {
  if (isChildClosed(child)) return;

  try {
    child.stdin?.end();
  } catch (error) {
    logCleanupFailure("process_stdin_close_failed", "terminate", error, sessionId);
  }
  if (await waitForChildClose(child, graceMs)) return;
  try {
    child.kill("SIGTERM");
  } catch (error) {
    logCleanupFailure("process_terminate_failed", "terminate", error, sessionId);
  }
  if (await waitForChildClose(child, graceMs)) return;

  console.warn(JSON.stringify({
    component: "dsh-adapter",
    event: "process_force_kill",
    sessionId,
    graceMs,
  }));
  try {
    child.kill("SIGKILL");
  } catch (error) {
    logCleanupFailure("process_force_kill_failed", "terminate", error, sessionId);
  }
  if (!(await waitForChildClose(child, graceMs))) {
    logCleanupFailure(
      "process_exit_unconfirmed",
      "terminate",
      new DshOperationTimeoutError("terminate", graceMs),
      sessionId,
    );
  }
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isChildClosed(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (closed: boolean) => {
      if (timer) clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    child.once("close", onClose);
    if (isChildClosed(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
  });
}

function isChildClosed(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}

function notifyTimeout(onTimeout: TimeoutCallback | undefined, error: DshOperationTimeoutError): void {
  try {
    onTimeout?.(error);
  } catch {
    // A task-state observer must not interrupt DSH cleanup.
  }
}

function logPermissionRejected(sessionId: string | undefined): void {
  console.info(
    JSON.stringify({
      component: "dsh-adapter",
      event: "permission_rejected",
      ...(sessionId ? { sessionId } : {}),
    }),
  );
}

function logCleanupFailure(
  event: string,
  phase: DshOperationPhase,
  cause: unknown,
  sessionId?: string,
): void {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  console.error(JSON.stringify({
    component: "dsh-adapter",
    event,
    phase,
    ...(sessionId ? { sessionId } : {}),
    errorType: error.name,
    error: sanitizeForLog(error.message).slice(0, 300),
  }));
}

function abortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

function sanitizeForLog(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[-_ ]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .slice(0, 300);
}
