import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_IDLE_TTL_MS,
  DEFAULT_DSH_CANCEL_TIMEOUT_MS,
  DEFAULT_DSH_CLOSE_TIMEOUT_MS,
  DEFAULT_DSH_PROMPT_TIMEOUT_MS,
  DEFAULT_DSH_SESSION_TIMEOUT_MS,
  DEFAULT_DSH_START_TIMEOUT_MS,
  DEFAULT_DSH_TERMINATE_GRACE_MS,
  DEFAULT_MAX_RETAINED_TASKS,
  DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
  DEFAULT_TASK_RETENTION_MS,
  loadConfig,
} from "../app/config.js";

describe("bridge configuration", () => {
  it("defaults context idle cleanup to thirty minutes", () => {
    expect(loadConfig({}).contextIdleTtlMs).toBe(30 * 60 * 1000);
    expect(DEFAULT_CONTEXT_IDLE_TTL_MS).toBe(30 * 60 * 1000);
  });

  it("defaults terminal task retention to one day, 500 tasks, and one minute cleanup", () => {
    expect(loadConfig({})).toMatchObject({
      taskRetentionMs: 24 * 60 * 60 * 1000,
      maxRetainedTasks: 500,
      retentionCleanupIntervalMs: 60 * 1000,
    });
    expect(DEFAULT_TASK_RETENTION_MS).toBe(24 * 60 * 60 * 1000);
    expect(DEFAULT_MAX_RETAINED_TASKS).toBe(500);
    expect(DEFAULT_RETENTION_CLEANUP_INTERVAL_MS).toBe(60 * 1000);
  });

  it("defaults ACP operation timeouts to bounded phase-specific values", () => {
    expect(loadConfig({})).toMatchObject({
      dshStartTimeoutMs: 15_000,
      dshSessionTimeoutMs: 15_000,
      dshPromptTimeoutMs: 120_000,
      dshCancelTimeoutMs: 5_000,
      dshCloseTimeoutMs: 5_000,
      dshTerminateGraceMs: 3_000,
    });
    expect(DEFAULT_DSH_START_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_DSH_SESSION_TIMEOUT_MS).toBe(15_000);
    expect(DEFAULT_DSH_PROMPT_TIMEOUT_MS).toBe(120_000);
    expect(DEFAULT_DSH_CANCEL_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_DSH_CLOSE_TIMEOUT_MS).toBe(5_000);
    expect(DEFAULT_DSH_TERMINATE_GRACE_MS).toBe(3_000);
  });

  it("accepts valid ACP operation timeout overrides", () => {
    expect(loadConfig({
      DSH_START_TIMEOUT_MS: "1000",
      DSH_SESSION_TIMEOUT_MS: "2000",
      DSH_PROMPT_TIMEOUT_MS: "3000",
      DSH_CANCEL_TIMEOUT_MS: "4000",
      DSH_CLOSE_TIMEOUT_MS: "5000",
      DSH_TERMINATE_GRACE_MS: "6000",
    })).toMatchObject({
      dshStartTimeoutMs: 1000,
      dshSessionTimeoutMs: 2000,
      dshPromptTimeoutMs: 3000,
      dshCancelTimeoutMs: 4000,
      dshCloseTimeoutMs: 5000,
      dshTerminateGraceMs: 6000,
    });
  });

  it.each(["", "0", "-1", "1.5", "invalid", "NaN", "9007199254740992"])(
    "falls back to safe ACP timeout defaults for invalid value %s",
    (value) => {
      expect(loadConfig({
        DSH_START_TIMEOUT_MS: value,
        DSH_SESSION_TIMEOUT_MS: value,
        DSH_PROMPT_TIMEOUT_MS: value,
        DSH_CANCEL_TIMEOUT_MS: value,
        DSH_CLOSE_TIMEOUT_MS: value,
        DSH_TERMINATE_GRACE_MS: value,
      })).toMatchObject({
        dshStartTimeoutMs: DEFAULT_DSH_START_TIMEOUT_MS,
        dshSessionTimeoutMs: DEFAULT_DSH_SESSION_TIMEOUT_MS,
        dshPromptTimeoutMs: DEFAULT_DSH_PROMPT_TIMEOUT_MS,
        dshCancelTimeoutMs: DEFAULT_DSH_CANCEL_TIMEOUT_MS,
        dshCloseTimeoutMs: DEFAULT_DSH_CLOSE_TIMEOUT_MS,
        dshTerminateGraceMs: DEFAULT_DSH_TERMINATE_GRACE_MS,
      });
    },
  );

  it("accepts positive integer task retention settings", () => {
    expect(loadConfig({
      A2A_TASK_RETENTION_MS: "120000",
      A2A_MAX_RETAINED_TASKS: "12",
      A2A_RETENTION_CLEANUP_INTERVAL_MS: "5000",
    })).toMatchObject({
      taskRetentionMs: 120000,
      maxRetainedTasks: 12,
      retentionCleanupIntervalMs: 5000,
    });
  });

  it.each(["0", "-1", "1.5", "invalid", "NaN", "9007199254740992"])(
    "falls back to safe task retention defaults for invalid setting %s",
    (value) => {
      expect(loadConfig({
        A2A_TASK_RETENTION_MS: value,
        A2A_MAX_RETAINED_TASKS: value,
        A2A_RETENTION_CLEANUP_INTERVAL_MS: value,
      })).toMatchObject({
        taskRetentionMs: DEFAULT_TASK_RETENTION_MS,
        maxRetainedTasks: DEFAULT_MAX_RETAINED_TASKS,
        retentionCleanupIntervalMs: DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
      });
    },
  );

  it("accepts a positive integer idle timeout", () => {
    expect(loadConfig({ CONTEXT_IDLE_TTL_MS: "2500" }).contextIdleTtlMs).toBe(2500);
  });

  it.each(["0", "-1", "1.5", "invalid", "9007199254740992"])(
    "rejects invalid idle timeout %s",
    (value) => {
      expect(() => loadConfig({ CONTEXT_IDLE_TTL_MS: value })).toThrow(
        "CONTEXT_IDLE_TTL_MS must be a positive safe integer.",
      );
    },
  );
});
