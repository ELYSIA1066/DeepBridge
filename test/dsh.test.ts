import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import {
  agent,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DshAdapter,
  DshAdapterError,
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

describe("DshAdapter", () => {
  it("rejects a permission request after reading the final response and closing the ACP session", async () => {
    const child = new MockChildProcess();
    const prompts: string[] = [];
    const sessionRequests: Array<{ cwd: string; mcpServers: unknown[] }> = [];
    const permissionDecisions: unknown[] = [];

    const closedSessions: string[] = [];
    const dsh = agent({ name: "Mock DSH ACP" })
      .onRequest(methods.agent.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      }))
      .onRequest(methods.agent.session.new, ({ params }) => {
        sessionRequests.push(params);
        return { sessionId: "session-1" };
      })
      .onRequest(methods.agent.session.close, ({ params }) => {
        closedSessions.push(params.sessionId);
        return {};
      })
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        prompts.push(
          params.prompt
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
        );
        const permission = await client.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: "dangerous-tool" },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject once", kind: "reject_once" },
          ],
        });
        permissionDecisions.push(permission.outcome);
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world" },
          },
        });
        return { stopReason: "end_turn" };
      });

    dsh.connect(
      ndJsonStream(
        Writable.toWeb(child.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>,
      ),
    );
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof crossSpawn;
    queueMicrotask(() => {
      child.pid = 42;
      child.emit("spawn");
    });

    const adapter = new DshAdapter({
      command: "dsh-test",
      cwd: "C:\\workspace",
      spawnProcess,
    });

    await expect(adapter.run("hello")).rejects.toBeInstanceOf(DshPermissionRejectedError);
    expect(spawnProcess).toHaveBeenCalledWith(
      "dsh-test",
      ["--profile", "acp"],
      expect.objectContaining({
        cwd: "C:\\workspace",
        env: expect.objectContaining({ DSH_PERMISSION_MODE: "read-only" }),
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(sessionRequests).toEqual([{ cwd: "C:\\workspace", mcpServers: [] }]);
    expect(closedSessions).toEqual(["session-1"]);
    expect(prompts).toEqual(["hello"]);
    expect(permissionDecisions).toEqual([{ outcome: "selected", optionId: "reject" }]);
    expect(child.exitCode).toBe(0);
    expect(child.killed).toBe(false);
  });

  it("completes normally when a tool-level denial is followed by a final assistant response", async () => {
    const child = new MockChildProcess();
    const dsh = agent({ name: "Mock DSH ACP" })
      .onRequest(methods.agent.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "session-tool-denial" }))
      .onRequest(methods.agent.session.close, () => ({}))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "write-1",
            title: "write",
            status: "in_progress",
          },
        });
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "write-1",
            status: "failed",
          },
        });
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Read-only policy denied the write. TOOL_DENIAL_HANDLED" },
          },
        });
        return { stopReason: "end_turn" };
      });

    dsh.connect(
      ndJsonStream(
        Writable.toWeb(child.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>,
      ),
    );
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof crossSpawn;
    queueMicrotask(() => {
      child.pid = 44;
      child.emit("spawn");
    });

    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });
    const progress: Array<{ kind: string; status?: string; text?: string }> = [];

    await expect(adapter.run("attempt one write", undefined, undefined, (update) => {
      progress.push(update.kind === "assistant"
        ? { kind: update.kind, text: update.text }
        : { kind: update.kind, status: update.status });
    })).resolves.toBe("Read-only policy denied the write. TOOL_DENIAL_HANDLED");
    expect(progress).toEqual([
      { kind: "tool", status: "in_progress" },
      { kind: "tool", status: "failed" },
      { kind: "assistant", text: "Read-only policy denied the write. TOOL_DENIAL_HANDLED" },
    ]);
    expect(child.exitCode).toBe(0);
  });

  it("maps session creation errors to a brief public failure", async () => {
    const child = new MockChildProcess();
    const dsh = agent({ name: "Mock DSH ACP" })
      .onRequest(methods.agent.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        agentCapabilities: {},
      }))
      .onRequest(methods.agent.session.new, () => {
        throw new Error("private runtime detail");
      });

    dsh.connect(
      ndJsonStream(
        Writable.toWeb(child.stdout) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>,
      ),
    );
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof crossSpawn;
    queueMicrotask(() => {
      child.pid = 43;
      child.emit("spawn");
    });

    const adapter = new DshAdapter({ command: "dsh-test", cwd: "C:\\workspace", spawnProcess });
    const runPromise = adapter.run("hello");
    await expect(runPromise).rejects.toBeInstanceOf(DshAdapterError);
    await expect(runPromise).rejects.toMatchObject({
      name: "DshAdapterError",
      stage: "session",
      publicMessage: "Failed to create DeepSeek Harness session",
    });
  });

  it("projects only assistant text and tool status while preserving the final result", async () => {
    const child = new MockChildProcess();
    const dsh = agent({ name: "Progress test DSH" })
      .onRequest(methods.agent.initialize, ({ params }) => ({
        protocolVersion: params.protocolVersion,
        agentCapabilities: { sessionCapabilities: { close: {} } },
      }))
      .onRequest(methods.agent.session.new, () => ({ sessionId: "progress-session" }))
      .onRequest(methods.agent.session.close, () => ({}))
      .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
        for (const update of [
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } },
          { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "private thought" } },
          {
            sessionUpdate: "tool_call", toolCallId: "private-id", title: "read_file",
            status: "in_progress", rawInput: { secret: "private arguments" },
          },
          {
            sessionUpdate: "tool_call_update", toolCallId: "private-id", status: "completed",
            rawOutput: { secret: "private result" },
          },
          { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } },
        ] as const) {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update,
          });
        }
        return { stopReason: "end_turn" };
      });
    dsh.connect(ndJsonStream(
      Writable.toWeb(child.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdin) as ReadableStream<Uint8Array>,
    ));
    const spawnProcess = vi.fn(() => child as unknown as ChildProcess) as unknown as typeof crossSpawn;
    queueMicrotask(() => {
      child.pid = 44;
      child.emit("spawn");
    });
    const adapter = new DshAdapter({ command: "dsh-test", spawnProcess });
    const progress: unknown[] = [];
    const result = await adapter.run("hello", undefined, undefined, (update) => {
      progress.push(update);
      if (progress.length === 1) throw new Error("Dashboard storage failed");
    });
    expect(result).toBe("Hello world");
    expect(progress).toEqual([
      { kind: "assistant", text: "Hello " },
      { kind: "tool", toolCallId: "private-id", title: "read_file", status: "in_progress" },
      { kind: "tool", toolCallId: "private-id", status: "completed" },
      { kind: "assistant", text: "world" },
    ]);
    expect(JSON.stringify(progress)).not.toContain("private thought");
    expect(JSON.stringify(progress)).not.toContain("private arguments");
    expect(JSON.stringify(progress)).not.toContain("private result");
  });
});
