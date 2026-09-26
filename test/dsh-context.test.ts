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
import { describe, expect, it, vi } from "vitest";
import {
  DshAdapter,
  DshContextBusyError,
  DshPermissionRejectedError,
} from "../app/dsh.js";

class MockChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;

  constructor() {
    super();
    this.stdin.once("finish", () => {
      this.exitCode = 0;
      queueMicrotask(() => this.emit("close", 0, null));
    });
  }

  kill(): boolean {
    this.killed = true;
    this.exitCode = 0;
    this.stdin.destroy();
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => this.emit("close", 0, null));
    return true;
  }
}

type PromptResult = {
  text: string;
  stopReason?: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests";
};

type MockHarness = {
  child: MockChildProcess;
  createdSessions: string[];
  closedSessions: string[];
  prompts: Array<{ sessionId: string; prompt: string }>;
};

type PromptBehavior = (input: {
  prompt: string;
  sessionId: string;
  client: AgentContext;
  signal: AbortSignal;
}) => Promise<PromptResult>;

function makeSpawner(
  behavior: (index: number) => PromptBehavior = () => async ({ prompt }) => ({ text: prompt }),
  closeBehavior?: (index: number, sessionId: string) => Promise<void>,
) {
  const harnesses: MockHarness[] = [];
  const spawnProcess = vi.fn(() => {
    const index = harnesses.length;
    const child = new MockChildProcess();
    const harness: MockHarness = {
      child,
      createdSessions: [],
      closedSessions: [],
      prompts: [],
    };
    harnesses.push(harness);

    const mockDsh = agent({ name: "Context test DSH" })
      .onRequest(methods.agent.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      }))
      .onRequest(methods.agent.session.new, () => {
        const sessionId = `session-${index + 1}`;
        harness.createdSessions.push(sessionId);
        return { sessionId };
      })
      .onRequest(methods.agent.session.close, async ({ params }) => {
        harness.closedSessions.push(params.sessionId);
        await closeBehavior?.(index, params.sessionId);
        return {};
      })
      .onRequest(methods.agent.session.prompt, async ({ params, client, signal }) => {
        const prompt = params.prompt
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        harness.prompts.push({ sessionId: params.sessionId, prompt });
        const result = await behavior(index)({
          prompt,
          sessionId: params.sessionId,
          client,
          signal,
        });
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: result.text },
          },
        });
        return { stopReason: result.stopReason ?? "end_turn" };
      });

    mockDsh.connect(
      ndJsonStream(
        Writable.toWeb(child.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>,
      ),
    );
    queueMicrotask(() => {
      child.pid = 100 + index;
      child.emit("spawn");
    });
    return child as unknown as ChildProcess;
  }) as unknown as typeof crossSpawn;

  return { spawnProcess, harnesses };
}

describe("DshAdapter context continuation", () => {
  it("reuses one ACP session for sequential tasks with the same contextId", async () => {
    const { spawnProcess, harnesses } = makeSpawner(() => async ({ prompt }) => ({ text: `answer:${prompt}` }));
    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });

    await expect(adapter.run("first", undefined, "ctx-A")).resolves.toBe("answer:first");
    expect(harnesses[0]?.closedSessions).toEqual([]);
    await expect(adapter.run("second", undefined, "ctx-A")).resolves.toBe("answer:second");

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(harnesses[0]?.createdSessions).toHaveLength(1);
    expect(harnesses[0]?.prompts.map((item) => item.sessionId)).toEqual([
      harnesses[0]?.createdSessions[0],
      harnesses[0]?.createdSessions[0],
    ]);
    await adapter.closeAll();
    expect(harnesses[0]?.closedSessions).toEqual(harnesses[0]?.createdSessions);
    expect(harnesses[0]?.child.exitCode).toBe(0);
  });

  it("isolates different contextIds and keeps requests without a context one-shot", async () => {
    const { spawnProcess, harnesses } = makeSpawner();
    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });

    await adapter.run("a", undefined, "ctx-A");
    await adapter.run("b", undefined, "ctx-B");
    await adapter.run("one-shot");

    expect(spawnProcess).toHaveBeenCalledTimes(3);
    expect(harnesses[0]?.createdSessions[0]).not.toBe(harnesses[1]?.createdSessions[0]);
    expect(harnesses[0]?.closedSessions).toEqual([]);
    expect(harnesses[1]?.closedSessions).toEqual([]);
    expect(harnesses[2]?.closedSessions).toEqual(harnesses[2]?.createdSessions);

    await adapter.closeAll();
    expect(harnesses.slice(0, 2).map((harness) => harness.closedSessions)).toEqual(
      harnesses.slice(0, 2).map((harness) => harness.createdSessions),
    );
    expect(harnesses.every((harness) => harness.child.exitCode === 0)).toBe(true);
  });

  it("retains a healthy session after permission rejection", async () => {
    const { spawnProcess, harnesses } = makeSpawner(() => async ({ prompt, sessionId, client }) => {
      if (prompt === "write attempt") {
        await client.request(methods.client.session.requestPermission, {
          sessionId,
          toolCall: { toolCallId: "blocked-write" },
          options: [
            { optionId: "reject", name: "Reject once", kind: "reject_once" },
          ],
        });
        return { text: "write blocked", stopReason: "cancelled" };
      }
      return { text: "remembered token" };
    });
    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });

    await adapter.run("remember token", undefined, "ctx-rejection");
    await expect(adapter.run("write attempt", undefined, "ctx-rejection")).rejects.toBeInstanceOf(
      DshPermissionRejectedError,
    );
    expect(harnesses[0]?.closedSessions).toEqual([]);
    await expect(adapter.run("recall token", undefined, "ctx-rejection")).resolves.toBe("remembered token");

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(harnesses[0]?.prompts.map((item) => item.sessionId)).toEqual([
      harnesses[0]?.createdSessions[0],
      harnesses[0]?.createdSessions[0],
      harnesses[0]?.createdSessions[0],
    ]);
    await adapter.closeAll();
  });

  it("evicts a context after a technical prompt failure and starts a fresh session next time", async () => {
    const { spawnProcess, harnesses } = makeSpawner((index) => async ({ prompt }) => {
      if (index === 0) throw new Error("simulated ACP failure");
      return { text: prompt };
    });
    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });

    await expect(adapter.run("fail", undefined, "ctx-failure")).rejects.toMatchObject({
      name: "DshAdapterError",
      stage: "execution",
    });
    expect(harnesses[0]?.closedSessions).toEqual(harnesses[0]?.createdSessions);
    await expect(adapter.run("recover", undefined, "ctx-failure")).resolves.toBe("recover");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(harnesses[1]?.createdSessions[0]).not.toBe(harnesses[0]?.createdSessions[0]);
    await adapter.closeAll();
  });

  it("rejects a concurrent prompt for a busy context", async () => {
    let promptStarted!: () => void;
    let releasePrompt!: () => void;
    const started = new Promise<void>((resolve) => (promptStarted = resolve));
    const gate = new Promise<void>((resolve) => (releasePrompt = resolve));
    const { spawnProcess, harnesses } = makeSpawner(() => async ({ prompt }) => {
      if (prompt === "first") {
        promptStarted();
        await gate;
      }
      return { text: prompt };
    });
    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });

    const first = adapter.run("first", undefined, "ctx-busy");
    await started;
    await expect(adapter.run("second", undefined, "ctx-busy")).rejects.toBeInstanceOf(DshContextBusyError);
    await expect(adapter.run("third", undefined, "ctx-busy")).rejects.toThrow(
      "Context ctx-busy is currently busy.",
    );
    releasePrompt();
    await expect(first).resolves.toBe("first");
    expect(harnesses[0]?.prompts.map((item) => item.prompt)).toEqual(["first"]);
    await adapter.closeAll();
  });

  it("cleans an idle context and creates a new ACP session when that context returns", async () => {
    let now = 0;
    const { spawnProcess, harnesses } = makeSpawner();
    const adapter = new DshAdapter({
      command: "dsh-test",
      spawnProcess,
      contextIdleTtlMs: 10,
      now: () => now,
    });

    await adapter.run("first", undefined, "ctx-expired");
    const oldSessionId = harnesses[0]?.createdSessions[0];
    now = 11;
    await adapter.run("one-shot");

    expect(harnesses[0]?.closedSessions).toEqual([oldSessionId]);
    expect(harnesses[0]?.child.exitCode).toBe(0);
    await adapter.run("again", undefined, "ctx-expired");

    expect(spawnProcess).toHaveBeenCalledTimes(3);
    expect(harnesses[2]?.createdSessions[0]).not.toBe(oldSessionId);
    await adapter.closeAll();
  });

  it("never cleans an expired context while its prompt is busy", async () => {
    let now = 0;
    let promptStarted!: () => void;
    let releasePrompt!: () => void;
    const started = new Promise<void>((resolve) => (promptStarted = resolve));
    const gate = new Promise<void>((resolve) => (releasePrompt = resolve));
    const { spawnProcess, harnesses } = makeSpawner(() => async ({ prompt }) => {
      if (prompt === "busy task") {
        promptStarted();
        await gate;
      }
      return { text: prompt };
    });
    const adapter = new DshAdapter({
      command: "dsh-test",
      spawnProcess,
      contextIdleTtlMs: 10,
      now: () => now,
    });

    const busyTask = adapter.run("busy task", undefined, "ctx-busy");
    await started;
    now = 11;
    await adapter.run("other context", undefined, "ctx-other");

    expect(harnesses[0]?.closedSessions).toEqual([]);
    await expect(adapter.run("overlap", undefined, "ctx-busy")).rejects.toBeInstanceOf(DshContextBusyError);
    expect(harnesses[0]?.closedSessions).toEqual([]);

    releasePrompt();
    await expect(busyTask).resolves.toBe("busy task");
    await expect(adapter.run("continue", undefined, "ctx-busy")).resolves.toBe("continue");
    expect(spawnProcess).toHaveBeenCalledTimes(2);
    expect(harnesses[0]?.createdSessions).toHaveLength(1);
    expect(harnesses[0]?.closedSessions).toEqual([]);
    await adapter.closeAll();
  });

  it("closes every owned persistent session during shutdown", async () => {
    const { spawnProcess, harnesses } = makeSpawner();
    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });
    await adapter.run("a", undefined, "ctx-A");
    await adapter.run("b", undefined, "ctx-B");

    await adapter.closeAll();

    expect(harnesses).toHaveLength(2);
    expect(harnesses.every((harness) => harness.closedSessions.length === 1)).toBe(true);
    expect(harnesses.every((harness) => harness.child.exitCode === 0)).toBe(true);
    await expect(adapter.run("after shutdown", undefined, "ctx-A")).rejects.toThrow();
  });

  it("does not start a one-shot session when shutdown begins during idle cleanup", async () => {
    let now = 0;
    let closeStarted!: () => void;
    let releaseClose!: () => void;
    const started = new Promise<void>((resolve) => (closeStarted = resolve));
    const closeGate = new Promise<void>((resolve) => (releaseClose = resolve));
    const { spawnProcess, harnesses } = makeSpawner(undefined, async (index) => {
      if (index === 0) {
        closeStarted();
        await closeGate;
      }
    });
    const adapter = new DshAdapter({
      command: "dsh-test",
      spawnProcess,
      contextIdleTtlMs: 10,
      now: () => now,
    });

    await adapter.run("seed", undefined, "ctx-expired");
    now = 11;
    const oneShot = adapter.run("must not start after shutdown");
    await started;

    const shutdown = adapter.closeAll();
    releaseClose();
    await shutdown;

    await expect(oneShot).rejects.toMatchObject({ name: "DshAdapterError", stage: "startup" });
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(harnesses[0]?.closedSessions).toEqual(harnesses[0]?.createdSessions);
    expect(harnesses[0]?.child.exitCode).toBe(0);
  });

  it("keeps a context usable when ACP acknowledges prompt cancellation", async () => {
    const { spawnProcess, harnesses } = makeSpawner(() => async ({ prompt, signal }) => {
      if (prompt === "cancel me") {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "", stopReason: "cancelled" };
      }
      return { text: "still here" };
    });
    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });
    const controller = new AbortController();
    const canceled = adapter.run("cancel me", controller.signal, "ctx-cancel");
    await vi.waitFor(() => expect(harnesses[0]?.prompts).toHaveLength(1));
    controller.abort();

    await expect(canceled).rejects.toBeDefined();
    await expect(adapter.run("continue", undefined, "ctx-cancel")).resolves.toBe("still here");
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(harnesses[0]?.prompts.map((item) => item.sessionId)).toEqual([
      harnesses[0]?.createdSessions[0],
      harnesses[0]?.createdSessions[0],
    ]);
    await adapter.closeAll();
  });
});
