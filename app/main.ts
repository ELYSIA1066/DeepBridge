import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  defaultServerCallContextBuilder,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import { CONTEXT_ID_PROVIDED_STATE_KEY, DshAgentExecutor } from "./agent.js";
import { loadConfig } from "./config.js";
import { DshAdapter } from "./dsh.js";
import { TaskProgressStore } from "./progress.js";
import { registerShutdownSignals } from "./shutdown.js";
import { RetainedTaskStore } from "./task-store.js";

const config = loadConfig();
const endpoint = `http://${config.host}:${config.port}/`;
const agentCard: AgentCard = {
  name: "DeepSeek Harness Agent",
  description: "A DeepSeek Harness based software engineering and technical analysis agent.",
  supportedInterfaces: [
    {
      url: endpoint,
      protocolBinding: "JSONRPC",
      tenant: "",
      protocolVersion: "1.0",
    },
  ],
  provider: undefined,
  version: "0.1.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [],
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/markdown"],
  skills: [
    {
      id: "software_engineering",
      name: "Software Engineering",
      description: "Software engineering and technical analysis tasks powered by DeepSeek Harness.",
      tags: ["software_engineering"],
      examples: [],
      inputModes: ["text/plain"],
      outputModes: ["text/markdown"],
      securityRequirements: [],
    },
  ],
  signatures: [],
};

const dsh = new DshAdapter({
  command: config.dshCommand,
  contextIdleTtlMs: config.contextIdleTtlMs,
  startTimeoutMs: config.dshStartTimeoutMs,
  sessionTimeoutMs: config.dshSessionTimeoutMs,
  promptTimeoutMs: config.dshPromptTimeoutMs,
  cancelTimeoutMs: config.dshCancelTimeoutMs,
  closeTimeoutMs: config.dshCloseTimeoutMs,
  terminateGraceMs: config.dshTerminateGraceMs,
});
const progress = new TaskProgressStore();
const taskStore = new RetainedTaskStore(progress, {
  retentionMs: config.taskRetentionMs,
  maxRetainedTasks: config.maxRetainedTasks,
  cleanupIntervalMs: config.retentionCleanupIntervalMs,
});
const requestHandler = new DefaultRequestHandler(
  agentCard,
  taskStore,
  new DshAgentExecutor(dsh, progress),
);

const app = express();
const bridgeInstanceId = randomUUID();
const uiDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../ui");
app.use(express.json({ limit: "1mb" }));
app.use((_request, response, next) => {
  response.setHeader("X-Bridge-Instance", bridgeInstanceId);
  next();
});
app.get("/ui/api/tasks/:taskId/progress", (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  const snapshot = progress.get(request.params.taskId);
  if (!snapshot) {
    response.status(404).json({ error: "Task not found" });
    return;
  }
  response.json(snapshot);
});
app.use("/ui", express.static(uiDirectory, {
  setHeaders: (response) => response.setHeader("Cache-Control", "no-store"),
}));
const contextIdPresenceHeader = "x-dsh-bridge-context-id-provided";
app.use((request, _response, next) => {
  const body = request.body as {
    params?: { message?: { contextId?: unknown; context_id?: unknown } };
  } | undefined;
  const message = body?.params?.message;
  const contextId = message?.contextId ?? message?.context_id;
  request.headers[contextIdPresenceHeader] =
    typeof contextId === "string" && contextId.length > 0 ? "1" : "0";
  next();
});
app.use(
  "/.well-known/agent-card.json",
  agentCardHandler({ agentCardProvider: requestHandler }),
);
app.use(
  jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
    contextBuilder: (options) => {
      const context = defaultServerCallContextBuilder(options);
      context.state.set(
        CONTEXT_ID_PROVIDED_STATE_KEY,
        options.headers[contextIdPresenceHeader] === "1",
      );
      return context;
    },
  }),
);

const server = app.listen(config.port, config.host, () => {
  console.info(
    JSON.stringify({
      component: "a2a-server",
      event: "listening",
      host: config.host,
      port: config.port,
      agent: agentCard.name,
    }),
  );
});

let shutdownPromise: Promise<void> | undefined;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shutdownPromise) return;
  console.info(JSON.stringify({ component: "a2a-server", event: "shutdown_started", signal }));
  const serverClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  shutdownPromise = Promise.all([serverClosed, dsh.closeAll()])
    .then(() => {
      taskStore.close();
      console.info(JSON.stringify({ component: "a2a-server", event: "shutdown_complete" }));
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          component: "a2a-server",
          event: "shutdown_failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      process.exitCode = 1;
    })
    .finally(() => taskStore.close());
};

server.once("close", () => {
  taskStore.close();
  void dsh.closeAll();
});
registerShutdownSignals(process, process.stdin, shutdown);
