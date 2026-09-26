import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { Role, TaskState, type Task } from "@a2a-js/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  BridgeLifecycle,
  BridgeStartupError,
  BridgeUnavailableError,
  type A2aClient,
  type A2aClientFactory,
} from "./bridge.js";
import { loadA2aBridgeUrl } from "./config.js";

export type { A2aClient, A2aClientFactory } from "./bridge.js";

export interface McpServerOptions {
  bridgeUrl?: string;
  clientFactory?: A2aClientFactory;
  bridgeLifecycle?: Pick<BridgeLifecycle, "ensureReady">;
  createContextId?: () => string;
  openDashboardUrl?: (url: string) => Promise<void>;
}

const execFileAsync = promisify(execFile);

const outputSchema = z.object({
  status: z.enum(["completed", "rejected", "failed", "canceled"]),
  context_id: z.string(),
  task_id: z.string().optional(),
  dashboard_url: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});

type DelegateOutput = z.infer<typeof outputSchema>;

export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const bridgeUrl = options.bridgeUrl ?? loadA2aBridgeUrl();
  const bridgeLifecycle =
    options.bridgeLifecycle ??
    new BridgeLifecycle({
      bridgeUrl,
      ...(options.clientFactory ? { createClient: options.clientFactory } : {}),
    });
  const createContextId = options.createContextId ?? randomUUID;
  const openDashboardUrl = options.openDashboardUrl ?? openInDefaultBrowser;

  const server = new McpServer(
    { name: "deepseek-agent", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "delegate_to_deepseek",
    {
      description:
        "Delegate an independent software-engineering or technical reasoning task to a DeepSeek Harness sub-agent. Use it when an independent second opinion, code review, debugging analysis, architecture analysis, or deeper technical investigation would be useful. For follow-up work on the same delegated task, reuse the returned context_id so the same DeepSeek Harness session retains its context. For a new independent task, omit context_id to create a new sub-agent context. Only one task may be active per context_id at a time.",
      inputSchema: z.object({
        task: z
          .string()
          .refine((value) => value.trim().length > 0, "task must be a non-empty string")
          .describe("Natural-language task for the DeepSeek Harness sub-agent."),
        context_id: z
          .string()
          .min(1)
          .optional()
          .describe("Reuse this A2A context ID to continue a previous DeepSeek session."),
      }),
      outputSchema,
    },
    async ({ task, context_id }) => {
      const contextId = context_id ?? createContextId();
      let client: A2aClient;

      try {
        client = await bridgeLifecycle.ensureReady();
      } catch (error) {
        logA2aError("bridge_not_ready", error);
        return toolResult(
          failedOutput(contextId, bridgeFailureMessage(error)),
        );
      }

      try {
        const result = await client.sendMessage({
          tenant: "",
          message: {
            messageId: randomUUID(),
            contextId,
            taskId: "",
            role: Role.ROLE_USER,
            parts: [
              {
                content: { $case: "text", value: task },
                metadata: undefined,
                filename: "",
                mediaType: "text/plain",
              },
            ],
            metadata: undefined,
            extensions: [],
            referenceTaskIds: [],
          },
          configuration: {
            acceptedOutputModes: ["text/markdown"],
            taskPushNotificationConfig: undefined,
            returnImmediately: false,
          },
          metadata: undefined,
        });

        if (!("status" in result) || !result.status) {
          logA2aError("unexpected_a2a_response", new Error("A2A response did not contain task status."));
          return toolResult(failedOutput(contextId, "DeepSeek Harness task failed."));
        }

        return toolResult(mapTaskResult(result, contextId, bridgeUrl));
      } catch (error) {
        logA2aError("send_message_failed", error);
        return toolResult(
          failedOutput(
            contextId,
            bridgeFailureMessage(error),
          ),
        );
      }
    },
  );

  server.registerTool(
    "open_bridge_dashboard",
    {
      description:
        "Open the local Bridge task dashboard in the default browser. The read-only dashboard shows A2A tasks, including Codex delegations, and their status and final results. If the user wants it inside Codex, use the returned URL with Codex's browser-panel action.",
      inputSchema: z.object({
        task_id: z.string().min(1).optional().describe("Open this A2A task directly in the dashboard."),
      }),
      outputSchema: z.object({
        status: z.enum(["opened", "failed"]),
        url: z.string().optional(),
        error: z.string().optional(),
      }),
    },
    async ({ task_id }) => {
      let dashboardUrl: string;
      try {
        dashboardUrl = localDashboardUrl(bridgeUrl);
      } catch {
        return dashboardToolResult({
          status: "failed",
          error: "The Bridge dashboard requires a local loopback A2A_BRIDGE_URL.",
        });
      }

      try {
        await bridgeLifecycle.ensureReady();
        const response = await fetch(dashboardUrl, {
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        const isDashboardPage =
          response.ok && response.headers.get("content-type")?.includes("text/html");
        await response.body?.cancel();
        if (!isDashboardPage) {
          return dashboardToolResult({
            status: "failed",
            url: dashboardUrl,
            error: "The Bridge is running, but its dashboard is unavailable.",
          });
        }
      } catch (error) {
        logA2aError("dashboard_not_ready", error);
        return dashboardToolResult({
          status: "failed",
          url: dashboardUrl,
          error: bridgeFailureMessage(error),
        });
      }

      const url = task_id ? dashboardTaskUrl(dashboardUrl, task_id) : dashboardUrl;
      try {
        await openDashboardUrl(url);
        return dashboardToolResult({ status: "opened", url });
      } catch (error) {
        logA2aError("dashboard_open_failed", error);
        return dashboardToolResult({
          status: "failed",
          url,
          error: "Could not open the default browser. Open the dashboard URL manually.",
        });
      }
    },
  );

  return server;
}

type DashboardOutput = {
  status: "opened" | "failed";
  url?: string;
  error?: string;
};

function dashboardToolResult(output: DashboardOutput) {
  const message = output.status === "opened"
    ? `Bridge task dashboard opened: [Open dashboard](${output.url})`
    : `${output.error ?? "Could not open the Bridge task dashboard."}${output.url ? ` Dashboard URL: ${output.url}` : ""}`;
  return {
    content: [{ type: "text" as const, text: message }],
    structuredContent: output,
  };
}

function localDashboardUrl(bridgeUrl: string): string {
  const url = new URL(bridgeUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(hostname) ||
    url.pathname !== "/" ||
    url.search || url.hash || url.username || url.password
  ) {
    throw new Error("Bridge URL is not a local loopback origin.");
  }
  return new URL("ui/", url).href;
}

function dashboardTaskUrl(dashboardUrl: string, taskId: string): string {
  const url = new URL(dashboardUrl);
  url.searchParams.set("task", taskId);
  return url.href;
}

function taskDashboardUrl(bridgeUrl: string, taskId: string): string | undefined {
  try {
    return dashboardTaskUrl(localDashboardUrl(bridgeUrl), taskId);
  } catch {
    return undefined;
  }
}

async function openInDefaultBrowser(url: string): Promise<void> {
  const [command, args] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]] as const
    : process.platform === "darwin"
      ? ["open", [url]] as const
      : ["xdg-open", [url]] as const;
  await execFileAsync(command, args, { windowsHide: true });
}

function mapTaskResult(task: Task, contextId: string, bridgeUrl: string): DelegateOutput {
  const dashboardUrl = taskDashboardUrl(bridgeUrl, task.id);
  const taskDetails = {
    task_id: task.id,
    ...(dashboardUrl ? { dashboard_url: dashboardUrl } : {}),
  };
  switch (task.status?.state) {
    case TaskState.TASK_STATE_COMPLETED:
      return {
        status: "completed",
        context_id: contextId,
        ...taskDetails,
        result: task.artifacts
          .flatMap((artifact) => artifact.parts)
          .flatMap((part) =>
            part.content?.$case === "text" ? [part.content.value] : [],
          )
          .join("\n"),
      };
    case TaskState.TASK_STATE_REJECTED:
      return {
        status: "rejected",
        context_id: contextId,
        ...taskDetails,
        error: "The requested operation was rejected by the bridge policy.",
      };
    case TaskState.TASK_STATE_FAILED:
      return { ...failedOutput(contextId, failedTaskMessage(task)), ...taskDetails };
    case TaskState.TASK_STATE_CANCELED:
      return { status: "canceled", context_id: contextId, ...taskDetails };
    default:
      logA2aError("unexpected_task_state", new Error("A2A returned a non-terminal task state."));
      return { ...failedOutput(contextId, "DeepSeek Harness task failed."), ...taskDetails };
  }
}

function failedTaskMessage(task: Task): string {
  const message = (task.status?.message?.parts ?? [])
    .flatMap((part) => part.content?.$case === "text" ? [part.content.value] : [])
    .join("\n")
    .trim();

  if (/^DSH (?:startup|session creation|prompt|cancel|close|terminate) exceeded \d+ ms\.$/.test(message)) {
    return message;
  }
  if (/^Context [\s\S]{1,256} is currently busy\.$/.test(message)) {
    return "A task is already active in this context.";
  }
  return "DeepSeek Harness task failed.";
}

function failedOutput(contextId: string, error: string): DelegateOutput {
  return { status: "failed", context_id: contextId, error };
}

function bridgeFailureMessage(error: unknown): string {
  if (error instanceof BridgeStartupError) return error.publicMessage;
  if (error instanceof BridgeUnavailableError || isBridgeUnavailable(error)) {
    return "A2A Bridge unavailable.";
  }
  return "DeepSeek Harness task failed.";
}

function toolResult(output: DelegateOutput) {
  const message =
    output.result ??
    output.error ??
    (output.status === "canceled" ? "DeepSeek task was canceled." : "");
  const text = output.dashboard_url
    ? `${message}\n\n[在看板查看任务](${output.dashboard_url})`
    : message;
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: output,
  };
}

function isBridgeUnavailable(error: unknown): boolean {
  const networkCodes = new Set([
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
  ]);
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error && /^(fetch failed|failed to fetch|network error)$/i.test(current.message)) {
      return true;
    }
    if (typeof current === "object") {
      const candidate = current as { code?: unknown; cause?: unknown };
      if (typeof candidate.code === "string" && networkCodes.has(candidate.code)) return true;
      current = candidate.cause;
    } else {
      current = undefined;
    }
  }

  return false;
}

function logA2aError(event: string, error: unknown): void {
  const rootCause = findRootCause(error);
  const message = rootCause instanceof Error ? sanitizeForLog(rootCause.message) : "Unknown error";
  const errorType = rootCause instanceof Error ? rootCause.name : "UnknownError";
  console.error(
    JSON.stringify({ component: "mcp-server", event, errorType, error: message.slice(0, 300) }),
  );
}

function findRootCause(error: unknown): unknown {
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && current.cause !== undefined && !seen.has(current.cause)) {
    seen.add(current);
    current = current.cause;
  }
  return current;
}

function sanitizeForLog(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(api[-_ ]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]");
}

function isMainModule(): boolean {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  const bridgeLifecycle = new BridgeLifecycle({ bridgeUrl: loadA2aBridgeUrl() });
  const handle = serveStdio(() => createMcpServer({ bridgeLifecycle }), {
    onerror: (error) => logA2aError("stdio_server_error", error),
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): void => {
    if (shutdownPromise) return;
    shutdownPromise = handle
      .close()
      .catch((error: unknown) => logA2aError("stdio_shutdown_failed", error))
      .then(() => bridgeLifecycle.closeOwnedBridge());
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
