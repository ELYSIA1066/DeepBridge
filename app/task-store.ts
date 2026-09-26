import { TaskState, type ListTasksRequest, type ListTasksResponse, type Task } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import { resolveUserScope, type ServerCallContext, type TaskStore } from "@a2a-js/sdk/server";
import {
  DEFAULT_MAX_RETAINED_TASKS,
  DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
  DEFAULT_TASK_RETENTION_MS,
} from "./config.js";
import { TaskProgressStore } from "./progress.js";

const DEFAULT_PAGE_SIZE = 50;

type StoredTask = {
  task: Task;
  terminalAt?: number;
  terminalSequence?: number;
};

type TaskBucket = Map<string, StoredTask>;
type OwnerBuckets = Map<string, TaskBucket>;

export type TaskRetentionOptions = {
  retentionMs?: number;
  maxRetainedTasks?: number;
  cleanupIntervalMs?: number;
  now?: () => number;
};

export type TaskRetentionCandidate = {
  key: string;
  terminalAt: number;
  sequence: number;
};

export type TaskRetentionPlan = {
  expiredKeys: string[];
  maxLimitKeys: string[];
};

export type TaskRetentionCleanupResult = {
  ttlRemoved: number;
  maxRemoved: number;
  totalRemoved: number;
};

/** Plans removals in two phases: TTL first, then oldest remaining terminal tasks. */
export function planTaskRetention(
  candidates: readonly TaskRetentionCandidate[],
  now: number,
  retentionMs: number,
  maxRetainedTasks: number,
): TaskRetentionPlan {
  const expired = candidates.filter((candidate) => now - candidate.terminalAt >= retentionMs);
  const expiredKeys = new Set(expired.map((candidate) => candidate.key));
  const remaining = candidates.filter((candidate) => !expiredKeys.has(candidate.key));
  const excess = Math.max(0, remaining.length - maxRetainedTasks);
  const maxLimitKeys = remaining
    .slice()
    .sort((left, right) =>
      left.terminalAt - right.terminalAt || left.sequence - right.sequence,
    )
    .slice(0, excess)
    .map((candidate) => candidate.key);

  return { expiredKeys: [...expiredKeys], maxLimitKeys };
}

/**
 * Bounded in-memory implementation of the A2A SDK's public TaskStore contract.
 * The SDK's InMemoryTaskStore has no public delete API, so this keeps its visible
 * behavior while allowing terminal tasks and their progress to be removed together.
 */
export class RetainedTaskStore implements TaskStore {
  private readonly tenants = new Map<string, OwnerBuckets>();
  private readonly retentionMs: number;
  private readonly maxRetainedTasks: number;
  private readonly now: () => number;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private nextTerminalSequence = 1;
  private closed = false;

  constructor(
    private readonly progress: TaskProgressStore,
    options: TaskRetentionOptions = {},
  ) {
    this.retentionMs = positiveIntegerOrDefault(options.retentionMs, DEFAULT_TASK_RETENTION_MS);
    this.maxRetainedTasks = positiveIntegerOrDefault(
      options.maxRetainedTasks,
      DEFAULT_MAX_RETAINED_TASKS,
    );
    const cleanupIntervalMs = positiveIntegerOrDefault(
      options.cleanupIntervalMs,
      DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
    );
    this.now = options.now ?? Date.now;
    this.cleanupTimer = setInterval(() => this.runCleanup(), cleanupIntervalMs);
    this.cleanupTimer.unref?.();
  }

  async load(taskId: string, context: ServerCallContext): Promise<Task | undefined> {
    const stored = this.getBucket(context)?.get(taskId);
    return stored ? structuredClone(stored.task) : undefined;
  }

  async save(task: Task, context: ServerCallContext): Promise<void> {
    if (this.closed) return;

    const bucket = this.getOrCreateBucket(context);
    const previous = bucket.get(task.id);
    const copy = structuredClone(task);
    const terminal = isTerminalState(copy.status?.state);

    if (terminal) {
      const terminalAt = previous?.terminalAt ?? parseTimestamp(copy.status?.timestamp) ?? this.now();
      const terminalSequence = previous?.terminalSequence ?? this.nextTerminalSequence++;
      bucket.set(task.id, { task: copy, terminalAt, terminalSequence });
      if (previous?.terminalAt === undefined) this.runCleanup();
      return;
    }

    bucket.set(task.id, { task: copy });
  }

  async list(params: ListTasksRequest, context: ServerCallContext): Promise<ListTasksResponse> {
    const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const bucket = this.getBucket(context);
    let tasks = bucket ? [...bucket.values()].map(({ task }) => task) : [];

    if (params.contextId) tasks = tasks.filter((task) => task.contextId === params.contextId);
    if (params.status !== undefined && params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
      tasks = tasks.filter((task) => task.status?.state === params.status);
    }
    if (params.statusTimestampAfter) {
      const filterTime = new Date(params.statusTimestampAfter).getTime();
      tasks = tasks.filter((task) =>
        task.status?.timestamp && new Date(task.status.timestamp).getTime() > filterTime,
      );
    }

    tasks.sort((left, right) => {
      const leftTime = left.status?.timestamp || "";
      const rightTime = right.status?.timestamp || "";
      if (rightTime !== leftTime) return rightTime.localeCompare(leftTime);
      return right.id.localeCompare(left.id);
    });

    const totalSize = tasks.length;
    if (params.pageToken) {
      let decoded: string;
      try {
        decoded = Buffer.from(params.pageToken, "base64").toString("utf-8");
      } catch {
        throw new RequestMalformedError("Token is not a valid base64-encoded cursor.");
      }
      const [cursorTimestamp, ...idParts] = decoded.split("|");
      if (idParts.length === 0) throw new RequestMalformedError("Invalid page token format.");
      const cursorId = idParts.join("|");
      const cursorIndex = tasks.findIndex((task) =>
        (task.status?.timestamp || "") === cursorTimestamp && task.id === cursorId,
      );
      tasks = cursorIndex === -1 ? [] : tasks.slice(cursorIndex + 1);
    }

    const page = tasks.slice(0, pageSize);
    const resultTasks = page.map((task) => {
      const copy = structuredClone(task);
      if (!params.includeArtifacts) copy.artifacts = [];
      return copy;
    });
    let nextPageToken = "";
    if (page.length > 0 && tasks.length > page.length) {
      const last = page[page.length - 1]!;
      nextPageToken = Buffer.from(`${last.status?.timestamp || ""}|${last.id}`).toString("base64");
    }

    return { tasks: resultTasks, nextPageToken, pageSize, totalSize };
  }

  cleanupRetainedTasks(now = this.now()): TaskRetentionCleanupResult {
    if (this.closed) return { ttlRemoved: 0, maxRemoved: 0, totalRemoved: 0 };

    const entries: Array<{
      candidate: TaskRetentionCandidate;
      tenant: string;
      owner: string;
      taskId: string;
    }> = [];

    for (const [tenant, owners] of this.tenants) {
      for (const [owner, bucket] of owners) {
        for (const [taskId, stored] of bucket) {
          if (!isTerminalState(stored.task.status?.state)) continue;
          if (stored.terminalAt === undefined) {
            stored.terminalAt = parseTimestamp(stored.task.status?.timestamp) ?? now;
            stored.terminalSequence = this.nextTerminalSequence++;
          }
          const key = JSON.stringify([tenant, owner, taskId]);
          entries.push({
            candidate: {
              key,
              terminalAt: stored.terminalAt,
              sequence: stored.terminalSequence ?? 0,
            },
            tenant,
            owner,
            taskId,
          });
        }
      }
    }

    const plan = planTaskRetention(
      entries.map(({ candidate }) => candidate),
      now,
      this.retentionMs,
      this.maxRetainedTasks,
    );
    const expiredKeys = new Set(plan.expiredKeys);
    const maxLimitKeys = new Set(plan.maxLimitKeys);
    let ttlRemoved = 0;
    let maxRemoved = 0;

    for (const entry of entries) {
      if (expiredKeys.has(entry.candidate.key)) {
        if (this.removeTask(entry.tenant, entry.owner, entry.taskId)) ttlRemoved += 1;
      } else if (maxLimitKeys.has(entry.candidate.key)) {
        if (this.removeTask(entry.tenant, entry.owner, entry.taskId)) maxRemoved += 1;
      }
    }

    return { ttlRemoved, maxRemoved, totalRemoved: ttlRemoved + maxRemoved };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
    this.tenants.clear();
    this.progress.clear();
  }

  private runCleanup(): void {
    const result = this.cleanupRetainedTasks();
    if (result.totalRemoved === 0) return;
    console.info(JSON.stringify({
      component: "a2a-task-store",
      event: "retention_cleanup",
      ttlRemoved: result.ttlRemoved,
      maxRemoved: result.maxRemoved,
      totalRemoved: result.totalRemoved,
    }));
  }

  private getBucket(context: ServerCallContext): TaskBucket | undefined {
    return this.tenants.get(context.tenant ?? "")?.get(resolveUserScope(context));
  }

  private getOrCreateBucket(context: ServerCallContext): TaskBucket {
    const tenantKey = context.tenant ?? "";
    let owners = this.tenants.get(tenantKey);
    if (!owners) {
      owners = new Map();
      this.tenants.set(tenantKey, owners);
    }
    const ownerKey = resolveUserScope(context);
    let bucket = owners.get(ownerKey);
    if (!bucket) {
      bucket = new Map();
      owners.set(ownerKey, bucket);
    }
    return bucket;
  }

  private removeTask(tenant: string, owner: string, taskId: string): boolean {
    const owners = this.tenants.get(tenant);
    const bucket = owners?.get(owner);
    if (!bucket?.delete(taskId)) return false;
    this.progress.delete(taskId);
    if (bucket.size === 0) owners!.delete(owner);
    if (owners?.size === 0) this.tenants.delete(tenant);
    return true;
  }
}

function isTerminalState(state: TaskState | undefined): boolean {
  return state === TaskState.TASK_STATE_COMPLETED ||
    state === TaskState.TASK_STATE_REJECTED ||
    state === TaskState.TASK_STATE_FAILED ||
    state === TaskState.TASK_STATE_CANCELED;
}

function parseTimestamp(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value! > 0 ? value! : fallback;
}
