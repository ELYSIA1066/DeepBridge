import { Role, TaskState, type Message, type Task } from "@a2a-js/sdk";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeStartupError } from "../app/bridge.js";
import { createMcpServer, type A2aClientFactory, type McpServerOptions } from "../app/mcp.js";

type ToolOutput = {
  status: "completed" | "rejected" | "failed" | "canceled";
  context_id: string;
  task_id?: string;
  dashboard_url?: string;
  result?: string;
  error?: string;
};

const connectedServers: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];

afterEach(async () => {
  await Promise.all(
    connectedServers.splice(0).map(async ({ client, server }) => {
      await Promise.all([client.close(), server.close()]);
    }),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("delegate_to_deepseek MCP tool", () => {
  it("exposes the delegation and dashboard tools and sends a provided context unchanged through A2A", async () => {
    const sendMessage = vi.fn().mockResolvedValue(task(TaskState.TASK_STATE_COMPLETED, "Architecture result"));
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    const { client } = await connect(createTestServer({
      bridgeUrl: "http://bridge.test/",
      clientFactory,
      createContextId: () => "generated-context",
    }));

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "delegate_to_deepseek",
      "open_bridge_dashboard",
    ]);
    expect(tools.tools[0]?.description).toContain("reuse the returned context_id");

    const result = await call(client, { task: "Review architecture", context_id: "ctx-1" });

    expect(result).toEqual({
      status: "completed",
      context_id: "ctx-1",
      task_id: "task-1",
      result: "Architecture result",
    });
    expect(clientFactory).toHaveBeenCalledWith("http://bridge.test/");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const request = sendMessage.mock.calls[0]?.[0];
    expect(request?.message?.contextId).toBe("ctx-1");
    expect(request?.message?.role).toBe(Role.ROLE_USER);
    expect(request?.message?.parts[0]?.content).toEqual({
      $case: "text",
      value: "Review architecture",
    });
    expect(request?.configuration?.returnImmediately).toBe(false);
  });

  it("generates an explicit A2A context ID when omitted and returns it", async () => {
    const sendMessage = vi.fn().mockResolvedValue(task(TaskState.TASK_STATE_COMPLETED, "STORED"));
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    const { client } = await connect(
      createTestServer({ clientFactory, createContextId: () => "generated-context" }),
    );

    const result = await call(client, { task: "Remember this" });

    expect(result).toEqual({
      status: "completed",
      context_id: "generated-context",
      task_id: "task-1",
      dashboard_url: "http://127.0.0.1:41241/ui/?task=task-1",
      result: "STORED",
    });
    expect(sendMessage.mock.calls[0]?.[0].message?.contextId).toBe("generated-context");
  });

  it("links separate tasks in the same context to separate dashboard entries", async () => {
    const sendMessage = vi.fn()
      .mockResolvedValueOnce(task(TaskState.TASK_STATE_COMPLETED, "first", "first/task"))
      .mockResolvedValueOnce(task(TaskState.TASK_STATE_COMPLETED, "second", "second task"));
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    const { client } = await connect(createTestServer({ clientFactory }));

    const first = await call(client, { task: "First", context_id: "shared" });
    const second = await call(client, { task: "Second", context_id: "shared" });

    expect(first.context_id).toBe(second.context_id);
    expect(first.task_id).toBe("first/task");
    expect(second.task_id).toBe("second task");
    expect(first.dashboard_url).toBe("http://127.0.0.1:41241/ui/?task=first%2Ftask");
    expect(second.dashboard_url).toBe("http://127.0.0.1:41241/ui/?task=second+task");
  });

  it.each([
    [TaskState.TASK_STATE_REJECTED, "rejected", "The requested operation was rejected by the bridge policy."],
    [TaskState.TASK_STATE_FAILED, "failed", "DeepSeek Harness task failed."],
    [TaskState.TASK_STATE_CANCELED, "canceled", undefined],
  ] as const)("maps A2A state %s without inferring from text", async (state, expectedStatus, error) => {
    const sendMessage = vi.fn().mockResolvedValue(task(state, "This says completed but is not the state"));
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    const { client } = await connect(createTestServer({ clientFactory }));

    const result = await call(client, { task: "Do work", context_id: "ctx-state" });

    expect(result.status).toBe(expectedStatus);
    expect(result.context_id).toBe("ctx-state");
    expect(result.task_id).toBe("task-1");
    expect(result.dashboard_url).toBe("http://127.0.0.1:41241/ui/?task=task-1");
    if (error) expect(result.error).toBe(error);
    else expect(result).not.toHaveProperty("error");
    expect(result).not.toHaveProperty("result");
  });

  it("surfaces the safe timeout detail from a failed A2A task", async () => {
    const sendMessage = vi.fn().mockResolvedValue(
      task(TaskState.TASK_STATE_FAILED, "", "timeout-task", "DSH prompt exceeded 15000 ms."),
    );
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    const { client } = await connect(createTestServer({ clientFactory }));

    const result = await call(client, { task: "Long task", context_id: "ctx-timeout" });

    expect(result).toEqual({
      status: "failed",
      context_id: "ctx-timeout",
      task_id: "timeout-task",
      dashboard_url: "http://127.0.0.1:41241/ui/?task=timeout-task",
      error: "DSH prompt exceeded 15000 ms.",
    });
  });

  it("maps a busy-context failure to a clear safe message", async () => {
    const sendMessage = vi.fn().mockResolvedValue(
      task(TaskState.TASK_STATE_FAILED, "", "busy-task", "Context ctx-secret-value is currently busy."),
    );
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    const { client } = await connect(createTestServer({ clientFactory }));

    const result = await call(client, { task: "Second task", context_id: "ctx-secret-value" });

    expect(result.error).toBe("A task is already active in this context.");
    expect(result.error).not.toContain("ctx-secret-value");
  });

  it("does not expose unrecognized failure status text", async () => {
    const sendMessage = vi.fn().mockResolvedValue(
      task(TaskState.TASK_STATE_FAILED, "", "private-failure", "internal provider error: secret-value"),
    );
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    const { client } = await connect(createTestServer({ clientFactory }));

    const result = await call(client, { task: "Fail safely", context_id: "ctx-private" });

    expect(result.error).toBe("DeepSeek Harness task failed.");
  });

  it("returns a safe failure when the A2A Bridge is unavailable", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:41241"), {
      code: "ECONNREFUSED",
    });
    const clientFactory = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause });
    }) as unknown as A2aClientFactory;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = await connect(createTestServer({ clientFactory }));

    const result = await call(client, { task: "Do work", context_id: "ctx-unavailable" });

    expect(result).toEqual({
      status: "failed",
      context_id: "ctx-unavailable",
      error: "A2A Bridge unavailable.",
    });
    expect(result).not.toHaveProperty("task_id");
    expect(result).not.toHaveProperty("dashboard_url");
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
    expect(log).toHaveBeenCalled();
  });

  it("does not invent a task ID when sending fails before A2A returns a task", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("connection closed"));
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = await connect(createTestServer({ clientFactory }));

    const result = await call(client, { task: "Do work", context_id: "ctx-send-failure" });

    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("task_id");
    expect(result).not.toHaveProperty("dashboard_url");
  });

  it("rejects an empty task before making an A2A request", async () => {
    const sendMessage = vi.fn();
    const clientFactory = vi.fn(async () => ({ sendMessage })) as unknown as A2aClientFactory;
    const { client } = await connect(createTestServer({ clientFactory }));

    const result = await client.callTool({
      name: "delegate_to_deepseek",
      arguments: { task: "   " },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringMatching(/task must be a non-empty string/i) }),
      ]),
    );
    expect(clientFactory).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("returns a safe startup failure and keeps the MCP server usable", async () => {
    const clientFactory = vi.fn(async () => ({ sendMessage: vi.fn() })) as unknown as A2aClientFactory;
    const { client } = await connect(createTestServer({
      clientFactory,
      bridgeLifecycle: {
        ensureReady: async () => {
          throw new BridgeStartupError(new Error("private cause"));
        },
      },
    }));

    await expect(call(client, { task: "Do work", context_id: "ctx-start-failure" })).resolves.toEqual({
      status: "failed",
      context_id: "ctx-start-failure",
      error: "Bridge failed to start.",
    });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("delegate_to_deepseek");
    expect(clientFactory).not.toHaveBeenCalled();
  });
});

describe("open_bridge_dashboard MCP tool", () => {
  it("opens the homepage without arguments and a specific task when provided", async () => {
    const clientFactory = vi.fn(async () => ({ sendMessage: vi.fn() })) as unknown as A2aClientFactory;
    const openDashboardUrl = vi.fn(async (_url: string) => undefined);
    const fetchMock = vi.fn(async (_url: string) => new Response("<html></html>", {
      headers: { "Content-Type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = await connect(createTestServer({ clientFactory, openDashboardUrl }));

    const home = await client.callTool({ name: "open_bridge_dashboard", arguments: {} });
    const focused = await client.callTool({
      name: "open_bridge_dashboard",
      arguments: { task_id: "older/task" },
    });

    expect(home.structuredContent).toEqual({
      status: "opened",
      url: "http://127.0.0.1:41241/ui/",
    });
    expect(focused.structuredContent).toEqual({
      status: "opened",
      url: "http://127.0.0.1:41241/ui/?task=older%2Ftask",
    });
    expect(openDashboardUrl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:41241/ui/",
      "http://127.0.0.1:41241/ui/?task=older%2Ftask",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url === "http://127.0.0.1:41241/ui/")).toBe(true);
  });
});

function createTestServer(
  options: McpServerOptions & { clientFactory: A2aClientFactory },
): ReturnType<typeof createMcpServer> {
  const bridgeUrl = options.bridgeUrl ?? "http://127.0.0.1:41241";
  return createMcpServer({
    ...options,
    bridgeUrl,
    bridgeLifecycle: options.bridgeLifecycle ?? {
      ensureReady: () => options.clientFactory(bridgeUrl),
    },
  });
}

async function connect(server: ReturnType<typeof createMcpServer>): Promise<{ client: Client }> {
  const client = new Client({ name: "bridge-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  connectedServers.push({ client, server });
  return { client };
}

async function call(client: Client, args: Record<string, string>): Promise<ToolOutput> {
  const response = await client.callTool({ name: "delegate_to_deepseek", arguments: args });
  expect(response.structuredContent).toBeDefined();
  return response.structuredContent as ToolOutput;
}

function task(state: TaskState, text: string, id = "task-1", statusText?: string): Task {
  const message: Message | undefined = statusText
    ? {
        messageId: `status-${id}`,
        taskId: id,
        contextId: "ctx-from-a2a",
        role: Role.ROLE_AGENT,
        parts: [
          {
            content: { $case: "text", value: statusText },
            metadata: undefined,
            filename: "",
            mediaType: "text/plain",
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      }
    : undefined;

  return {
    id,
    contextId: "ctx-from-a2a",
    status: { state, message, timestamp: new Date().toISOString() },
    artifacts: [
      {
        artifactId: "artifact-1",
        name: "result",
        description: "",
        parts: [
          {
            content: { $case: "text", value: text },
            metadata: undefined,
            filename: "",
            mediaType: "text/markdown",
          },
        ],
        metadata: undefined,
        extensions: [],
      },
    ],
    history: [],
    metadata: undefined,
  };
}
