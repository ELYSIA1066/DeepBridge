import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BridgeLifecycle,
  BridgeStartupError,
  BridgeUnavailableError,
  type A2aClient,
} from "../app/bridge.js";

class MockBridgeProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  exitOnTerm = true;

  kill = vi.fn((signal: NodeJS.Signals = "SIGTERM") => {
    this.signals.push(signal);
    if (signal === "SIGKILL" || (signal === "SIGTERM" && this.exitOnTerm)) {
      this.signalCode = signal;
      queueMicrotask(() => this.emit("exit", null, signal));
    }
    return true;
  });

  exitUnexpectedly(): void {
    this.exitCode = 1;
    this.emit("exit", 1, null);
  }
}

function bridgeClient(): A2aClient {
  return { sendMessage: vi.fn() } as unknown as A2aClient;
}

describe("BridgeLifecycle", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reuses a healthy external A2A Bridge and never terminates it", async () => {
    const client = bridgeClient();
    const createClient = vi.fn(async () => client);
    const spawnBridge = vi.fn();
    const lifecycle = new BridgeLifecycle({
      bridgeUrl: "http://127.0.0.1:41241",
      createClient,
      spawnBridge,
    });

    await expect(lifecycle.ensureReady()).resolves.toBe(client);
    expect(lifecycle.hasOwnedBridge).toBe(false);
    expect(spawnBridge).not.toHaveBeenCalled();
    await lifecycle.closeOwnedBridge();
    expect(spawnBridge).not.toHaveBeenCalled();
  });

  it("starts one owned local Bridge and forwards the DSH environment", async () => {
    const client = bridgeClient();
    const child = new MockBridgeProcess();
    const createClient = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(client);
    const spawnBridge = vi.fn(() => child as unknown as ChildProcess);
    const env = {
      PATH: "path-value",
      DSH_COMMAND: "D:\\DSH\\node_modules\\.bin\\dsh.cmd",
      DSH_HOME: "D:\\DSH\\home",
    };
    const lifecycle = new BridgeLifecycle({
      bridgeUrl: "http://127.0.0.1:41241",
      createClient,
      spawnBridge,
      projectRoot: "D:\\project",
      env,
      readinessAttempts: 3,
      readinessIntervalMs: 0,
      shutdownGraceMs: 10,
      shutdownForceMs: 10,
    });

    await expect(lifecycle.ensureReady()).resolves.toBe(client);
    expect(lifecycle.hasOwnedBridge).toBe(true);
    expect(spawnBridge).toHaveBeenCalledTimes(1);
    expect(spawnBridge).toHaveBeenCalledWith("D:\\project", expect.objectContaining({
      DSH_COMMAND: env.DSH_COMMAND,
      DSH_HOME: env.DSH_HOME,
      A2A_HOST: "127.0.0.1",
      A2A_PORT: "41241",
    }));

    await lifecycle.closeOwnedBridge();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(lifecycle.hasOwnedBridge).toBe(false);
  });

  it("shares one startup across concurrent readiness requests", async () => {
    const client = bridgeClient();
    const child = new MockBridgeProcess();
    let releaseReadiness!: (client: A2aClient) => void;
    const readiness = new Promise<A2aClient>((resolve) => (releaseReadiness = resolve));
    const createClient = vi.fn()
      .mockRejectedValueOnce(new Error("unavailable A"))
      .mockRejectedValueOnce(new Error("unavailable B"))
      .mockReturnValue(readiness);
    const spawnBridge = vi.fn(() => child as unknown as ChildProcess);
    const lifecycle = new BridgeLifecycle({
      bridgeUrl: "http://localhost:41241",
      createClient,
      spawnBridge,
      readinessAttempts: 2,
      readinessIntervalMs: 0,
    });

    const calls = [lifecycle.ensureReady(), lifecycle.ensureReady()];
    await vi.waitFor(() => expect(createClient).toHaveBeenCalledTimes(3));
    expect(spawnBridge).toHaveBeenCalledTimes(1);
    releaseReadiness(client);
    await expect(Promise.all(calls)).resolves.toEqual([client, client]);
    expect(lifecycle.hasOwnedBridge).toBe(true);
    await lifecycle.closeOwnedBridge();
  });

  it("returns a safe startup error and cleans the owned process when readiness times out", async () => {
    const child = new MockBridgeProcess();
    const createClient = vi.fn().mockRejectedValue(new Error("private endpoint detail"));
    const spawnBridge = vi.fn(() => child as unknown as ChildProcess);
    const lifecycle = new BridgeLifecycle({
      bridgeUrl: "http://127.0.0.1:41241",
      createClient,
      spawnBridge,
      readinessAttempts: 2,
      readinessIntervalMs: 0,
      shutdownGraceMs: 10,
      shutdownForceMs: 10,
    });

    await expect(lifecycle.ensureReady()).rejects.toBeInstanceOf(BridgeStartupError);
    expect(spawnBridge).toHaveBeenCalledTimes(1);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(lifecycle.hasOwnedBridge).toBe(false);
  });

  it("does not auto-start for an unavailable non-local Bridge URL", async () => {
    const spawnBridge = vi.fn();
    const lifecycle = new BridgeLifecycle({
      bridgeUrl: "https://bridge.example.test/",
      createClient: vi.fn().mockRejectedValue(new Error("unavailable")),
      spawnBridge,
    });

    await expect(lifecycle.ensureReady()).rejects.toBeInstanceOf(BridgeUnavailableError);
    expect(spawnBridge).not.toHaveBeenCalled();
  });

  it("restarts an owned Bridge on the next call after the owned process crashes", async () => {
    const client = bridgeClient();
    const children = [new MockBridgeProcess(), new MockBridgeProcess()];
    let discoveryCount = 0;
    const createClient = vi.fn(async () => {
      discoveryCount += 1;
      if (discoveryCount === 1 || discoveryCount === 3) {
        throw new Error(discoveryCount === 1 ? "unavailable" : "bridge crashed");
      }
      return client;
    });
    let spawnedChildren = 0;
    const spawnBridge = vi.fn(() => children[spawnedChildren++] as unknown as ChildProcess);
    const lifecycle = new BridgeLifecycle({
      bridgeUrl: "http://127.0.0.1:41241",
      createClient,
      spawnBridge,
      readinessAttempts: 2,
      readinessIntervalMs: 0,
    });

    await lifecycle.ensureReady();
    children[0]?.exitUnexpectedly();
    await expect(lifecycle.ensureReady()).resolves.toBe(client);
    expect(discoveryCount).toBe(4);
    expect(spawnBridge).toHaveBeenCalledTimes(2);
    expect(createClient).toHaveBeenCalledTimes(4);
    await lifecycle.closeOwnedBridge();
  });
});
