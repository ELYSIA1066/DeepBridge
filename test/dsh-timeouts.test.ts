import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import {
  agent,
  methods,
  ndJsonStream,
  type AgentContext,
} from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshAdapter } from "../app/dsh.js";

type PromptResult = { text: string; stopReason?: "end_turn" | "cancelled" };
type PromptBehavior = (input: {
  prompt: string;
  client: AgentContext;
  signal: AbortSignal;
}) => Promise<PromptResult>;

type HarnessOptions = {
  neverSpawn?: boolean;
  neverInitialize?: boolean;
  neverSession?: boolean;
  neverClose?: boolean;
  exitOnEof?: boolean;
  exitOnTerm?: boolean;
  exitOnKill?: boolean;
  prompt?: PromptBehavior;
};

class MockChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(private readonly options: HarnessOptions) {
    super();
    this.stdin.once("finish", () => {
      if (options.exitOnEof !== false) this.finish(0, null);
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.options.exitOnTerm !== false) this.finish(null, signal);
    if (signal === "SIGKILL" && this.options.exitOnKill !== false) this.finish(null, signal);
    return true;
  }

  finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", code, signal));
  }
}

type MockHarness = {
  child: MockChildProcess;
  createdSessions: string[];
  closedSessions: string[];
  cancelNotifications: string[];
  prompts: string[];
};

function connectHarness(options: HarnessOptions, index: number): MockHarness {
  const harness: MockHarness = {
    child: new MockChildProcess(options),
    createdSessions: [],
    closedSessions: [],
    cancelNotifications: [],
    prompts: [],
  };
  const server = agent({ name: "Timeout test DSH" })
    .onRequest(methods.agent.initialize, ({ params }) => {
      if (options.neverInitialize) return new Promise<never>(() => undefined);
      return {
        protocolVersion: params.protocolVersion,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      };
    })
    .onRequest(methods.agent.session.new, () => {
      if (options.neverSession) return new Promise<never>(() => undefined);
      const sessionId = "timeout-session-" + (index + 1);
      harness.createdSessions.push(sessionId);
      return { sessionId };
    })
    .onRequest(methods.agent.session.close, ({ params }) => {
      harness.closedSessions.push(params.sessionId);
      if (options.neverClose) return new Promise<never>(() => undefined);
      return {};
    })
    .onNotification(methods.agent.session.cancel, ({ params }) => {
      harness.cancelNotifications.push(params.sessionId);
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
      const prompt = params.prompt
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      harness.prompts.push(prompt);
      const result = await (options.prompt?.({ prompt, client, signal }) ?? Promise.resolve({
        text: "answer:" + prompt,
        stopReason: "end_turn" as const,
      }));
      if (result.text) {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: result.text },
          },
        });
      }
      return { stopReason: result.stopReason ?? "end_turn" };
    });

  server.connect(ndJsonStream(
    Writable.toWeb(harness.child.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(harness.child.stdin) as ReadableStream<Uint8Array>,
  ));
  if (!options.neverSpawn) {
    queueMicrotask(() => {
      harness.child.pid = 200 + index;
      harness.child.emit("spawn");
    });
  }
  return harness;
}

function setupHarnesses(optionsFor: (index: number) => HarnessOptions) {
  const harnesses: MockHarness[] = [];
  const spawnProcess = vi.fn(() => {
    const harness = connectHarness(optionsFor(harnesses.length), harnesses.length);
    harnesses.push(harness);
    return harness.child as unknown as ChildProcess;
  }) as unknown as typeof crossSpawn;
  const adapter = new DshAdapter({
    command: "dsh-timeout-test",
    cwd: "C:\\workspace",
    spawnProcess,
    startTimeoutMs: 100,
    sessionTimeoutMs: 100,
    promptTimeoutMs: 100,
    cancelTimeoutMs: 20,
    closeTimeoutMs: 20,
    terminateGraceMs: 20,
  });
  return { adapter, harnesses, spawnProcess };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DSH ACP operation timeouts", () => {
  it("R2-1 bounds startup, cleans up the child, and clears the startup timer", async () => {
    vi.useFakeTimers();
    const { adapter, harnesses } = setupHarnesses(() => ({ neverSpawn: true }));
    const run = adapter.run("startup hangs", undefined, "ctx-start");
    const rejected = expect(run).rejects.toMatchObject({
      name: "DshOperationTimeoutError",
      phase: "startup",
      timeoutMs: 100,
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(harnesses[0]?.child.exitCode).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await adapter.closeAll();
  });

  it("R2-1 bounds the ACP initialize handshake as part of startup", async () => {
    vi.useFakeTimers();
    const { adapter, harnesses } = setupHarnesses(() => ({ neverInitialize: true }));
    const run = adapter.run("handshake hangs", undefined, "ctx-handshake");
    const rejected = expect(run).rejects.toMatchObject({
      name: "DshOperationTimeoutError",
      phase: "startup",
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(100);

    await rejected;
    expect(harnesses[0]?.createdSessions).toEqual([]);
    expect(harnesses[0]?.child.exitCode).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await adapter.closeAll();
  });

  it("cancels startup promptly and releases the same context lock", async () => {
    vi.useFakeTimers();
    const { adapter, harnesses } = setupHarnesses((index) =>
      index === 0 ? { neverInitialize: true } : {},
    );
    const controller = new AbortController();
    const run = adapter.run("cancel during startup", controller.signal, "ctx-start-cancel");
    await flushMicrotasks();
    controller.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(harnesses[0]?.child.exitCode).toBe(0);
    await expect(adapter.run("next task", undefined, "ctx-start-cancel"))
      .resolves.toBe("answer:next task");
    expect(harnesses).toHaveLength(2);
    await adapter.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R2-2 bounds session creation and releases the context for a fresh session", async () => {
    vi.useFakeTimers();
    const { adapter, harnesses, spawnProcess } = setupHarnesses((index) =>
      index === 0 ? { neverSession: true } : {},
    );
    const run = adapter.run("session hangs", undefined, "ctx-session");
    const rejected = expect(run).rejects.toMatchObject({
      name: "DshOperationTimeoutError",
      phase: "session",
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(220);
    await rejected;
    expect(harnesses[0]?.createdSessions).toEqual([]);
    expect(harnesses[0]?.child.exitCode).toBe(0);

    await expect(adapter.run("fresh", undefined, "ctx-session")).resolves.toBe("answer:fresh");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(harnesses[1]?.createdSessions).toHaveLength(1);
    await adapter.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R2-3/R2-4 fails a timed-out prompt but reuses a session after confirmed cancellation", async () => {
    vi.useFakeTimers();
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => (promptStarted = resolve));
    const { adapter, harnesses, spawnProcess } = setupHarnesses(() => ({
      prompt: async ({ signal }) => {
        if (harnesses.length === 1 && harnesses[0]?.prompts.length === 1) {
          promptStarted();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { text: "late canceled response", stopReason: "cancelled" };
        }
        return { text: "continued", stopReason: "end_turn" };
      },
    }));

    const run = adapter.run("slow", undefined, "ctx-timeout");
    const rejected = expect(run).rejects.toMatchObject({
      name: "DshOperationTimeoutError",
      phase: "prompt",
      timeoutMs: 100,
    });
    await started;
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(harnesses[0]?.cancelNotifications).toEqual(harnesses[0]?.createdSessions);
    expect(harnesses[0]?.closedSessions).toEqual([]);
    await expect(adapter.run("follow-up", undefined, "ctx-timeout")).resolves.toBe("continued");
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await adapter.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("R2-5/R2-6/R2-7 escalates through cancel, close, terminate, and force kill", async () => {
    vi.useFakeTimers();
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => (promptStarted = resolve));
    const { adapter, harnesses, spawnProcess } = setupHarnesses((index) => index === 0
      ? {
          neverClose: true,
          exitOnEof: false,
          exitOnTerm: false,
          prompt: async () => {
            promptStarted();
            return new Promise<PromptResult>(() => undefined);
          },
        }
      : {});
    const run = adapter.run("never responds", undefined, "ctx-escalation");
    const rejected = expect(run).rejects.toMatchObject({ phase: "prompt" });
    await started;
    vi.spyOn(harnesses[0]!.child.stdin, "end").mockImplementation(() => {
      throw new Error("stdin was already closed");
    });
    const cleanupLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await vi.advanceTimersByTimeAsync(220);

    await rejected;
    expect(cleanupLog).toHaveBeenCalledWith(
      expect.stringContaining('"event":"process_stdin_close_failed"'),
    );
    expect(harnesses[0]?.cancelNotifications).toEqual(harnesses[0]?.createdSessions);
    expect(harnesses[0]?.closedSessions).toEqual(harnesses[0]?.createdSessions);
    expect(harnesses[0]?.child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harnesses[0]?.child.signalCode).toBe("SIGKILL");

    await expect(adapter.run("recovered", undefined, "ctx-escalation"))
      .resolves.toBe("answer:recovered");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    await adapter.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reuse a session when the ACP connection health is unknown", async () => {
    vi.useFakeTimers();
    let promptStarted!: () => void;
    const started = new Promise<void>((resolve) => (promptStarted = resolve));
    const { adapter, harnesses, spawnProcess } = setupHarnesses((index) => index === 0
      ? {
          prompt: async () => {
            promptStarted();
            return new Promise<PromptResult>(() => undefined);
          },
        }
      : {});
    const run = adapter.run("disconnecting", undefined, "ctx-unhealthy");
    await started;
    harnesses[0]?.child.finish(1, null);
    await expect(run).rejects.toBeDefined();

    await expect(adapter.run("new session", undefined, "ctx-unhealthy"))
      .resolves.toBe("answer:new session");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    await adapter.closeAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});
