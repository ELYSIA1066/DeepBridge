export const DEFAULT_CONTEXT_IDLE_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_TASK_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_RETAINED_TASKS = 500;
export const DEFAULT_RETENTION_CLEANUP_INTERVAL_MS = 60 * 1000;
export const DEFAULT_DSH_START_TIMEOUT_MS = 15_000;
export const DEFAULT_DSH_SESSION_TIMEOUT_MS = 15_000;
export const DEFAULT_DSH_PROMPT_TIMEOUT_MS = 120_000;
export const DEFAULT_DSH_CANCEL_TIMEOUT_MS = 5_000;
export const DEFAULT_DSH_CLOSE_TIMEOUT_MS = 5_000;
export const DEFAULT_DSH_TERMINATE_GRACE_MS = 3_000;

export type AppConfig = {
  host: string;
  port: number;
  dshCommand: string;
  contextIdleTtlMs: number;
  taskRetentionMs: number;
  maxRetainedTasks: number;
  retentionCleanupIntervalMs: number;
  dshStartTimeoutMs: number;
  dshSessionTimeoutMs: number;
  dshPromptTimeoutMs: number;
  dshCancelTimeoutMs: number;
  dshCloseTimeoutMs: number;
  dshTerminateGraceMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const portValue = env.A2A_PORT?.trim() || "41241";
  const port = Number(portValue);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("A2A_PORT must be an integer between 1 and 65535.");
  }

  const contextIdleTtlValue =
    env.CONTEXT_IDLE_TTL_MS?.trim() || String(DEFAULT_CONTEXT_IDLE_TTL_MS);
  const contextIdleTtlMs = Number(contextIdleTtlValue);
  if (!Number.isSafeInteger(contextIdleTtlMs) || contextIdleTtlMs < 1) {
    throw new Error("CONTEXT_IDLE_TTL_MS must be a positive safe integer.");
  }

  const taskRetentionMs = positiveIntegerOrDefault(
    env.A2A_TASK_RETENTION_MS,
    DEFAULT_TASK_RETENTION_MS,
  );
  const maxRetainedTasks = positiveIntegerOrDefault(
    env.A2A_MAX_RETAINED_TASKS,
    DEFAULT_MAX_RETAINED_TASKS,
  );
  const retentionCleanupIntervalMs = positiveIntegerOrDefault(
    env.A2A_RETENTION_CLEANUP_INTERVAL_MS,
    DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
  );
  const dshStartTimeoutMs = positiveIntegerOrDefault(
    env.DSH_START_TIMEOUT_MS,
    DEFAULT_DSH_START_TIMEOUT_MS,
  );
  const dshSessionTimeoutMs = positiveIntegerOrDefault(
    env.DSH_SESSION_TIMEOUT_MS,
    DEFAULT_DSH_SESSION_TIMEOUT_MS,
  );
  const dshPromptTimeoutMs = positiveIntegerOrDefault(
    env.DSH_PROMPT_TIMEOUT_MS,
    DEFAULT_DSH_PROMPT_TIMEOUT_MS,
  );
  const dshCancelTimeoutMs = positiveIntegerOrDefault(
    env.DSH_CANCEL_TIMEOUT_MS,
    DEFAULT_DSH_CANCEL_TIMEOUT_MS,
  );
  const dshCloseTimeoutMs = positiveIntegerOrDefault(
    env.DSH_CLOSE_TIMEOUT_MS,
    DEFAULT_DSH_CLOSE_TIMEOUT_MS,
  );
  const dshTerminateGraceMs = positiveIntegerOrDefault(
    env.DSH_TERMINATE_GRACE_MS,
    DEFAULT_DSH_TERMINATE_GRACE_MS,
  );

  return {
    host: env.A2A_HOST?.trim() || "127.0.0.1",
    port,
    dshCommand: env.DSH_COMMAND?.trim() || "dsh",
    contextIdleTtlMs,
    taskRetentionMs,
    maxRetainedTasks,
    retentionCleanupIntervalMs,
    dshStartTimeoutMs,
    dshSessionTimeoutMs,
    dshPromptTimeoutMs,
    dshCancelTimeoutMs,
    dshCloseTimeoutMs,
    dshTerminateGraceMs,
  };
}

function positiveIntegerOrDefault(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadA2aBridgeUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.A2A_BRIDGE_URL?.trim() || "http://127.0.0.1:41241";
}
