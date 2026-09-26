import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "@a2a-js/sdk/client";
import { ClientFactory } from "@a2a-js/sdk/client";

export type A2aClient = Pick<Client, "sendMessage">;
export type A2aClientFactory = (bridgeUrl: string) => Promise<A2aClient>;
export type BridgeSpawner = (projectRoot: string, env: NodeJS.ProcessEnv) => ChildProcess;

export class BridgeUnavailableError extends Error {
  readonly publicMessage = "A2A Bridge unavailable.";

  constructor(cause?: unknown) {
    super("A2A Bridge unavailable.", cause === undefined ? undefined : { cause });
    this.name = "BridgeUnavailableError";
  }
}

export class BridgeStartupError extends Error {
  readonly publicMessage = "Bridge failed to start.";

  constructor(cause?: unknown) {
    super("Bridge failed to start.", cause === undefined ? undefined : { cause });
    this.name = "BridgeStartupError";
  }
}

export interface BridgeLifecycleOptions {
  bridgeUrl: string;
  createClient?: A2aClientFactory;
  spawnBridge?: BridgeSpawner;
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  readinessAttempts?: number;
  readinessIntervalMs?: number;
  shutdownGraceMs?: number;
  shutdownForceMs?: number;
}

export class BridgeLifecycle {
  private readonly createClient: A2aClientFactory;
  private readonly spawnBridge: BridgeSpawner;
  private readonly projectRoot: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly readinessAttempts: number;
  private readonly readinessIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly shutdownForceMs: number;
  private ownedBridge: ChildProcess | undefined;
  private bridgeStartPromise: Promise<A2aClient> | undefined;
  private closePromise: Promise<void> | undefined;
  private closed = false;
  private spawnError: Error | undefined;

  constructor(private readonly options: BridgeLifecycleOptions) {
    this.createClient = options.createClient ?? defaultA2aClientFactory;
    this.spawnBridge = options.spawnBridge ?? spawnLocalBridge;
    this.projectRoot = options.projectRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
    this.env = options.env ?? process.env;
    this.readinessAttempts = options.readinessAttempts ?? 20;
    this.readinessIntervalMs = options.readinessIntervalMs ?? 250;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 3000;
    this.shutdownForceMs = options.shutdownForceMs ?? 1000;
  }

  get hasOwnedBridge(): boolean {
    return this.ownedBridge !== undefined && !hasExited(this.ownedBridge);
  }

  async ensureReady(): Promise<A2aClient> {
    if (this.closed) throw new BridgeUnavailableError(new Error("MCP server is shutting down."));

    try {
      return await this.createClient(this.options.bridgeUrl);
    } catch (discoveryError) {
      if (!isLocalBridgeUrl(this.options.bridgeUrl)) {
        throw new BridgeUnavailableError(discoveryError);
      }
      return this.ensureOwnedBridgeReady();
    }
  }

  async closeOwnedBridge(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.bridgeStartPromise?.catch(() => undefined);
      const child = this.ownedBridge;
      this.ownedBridge = undefined;
      this.bridgeStartPromise = undefined;
      await terminateOwnedProcess(child, this.shutdownGraceMs, this.shutdownForceMs);
    })();
    return this.closePromise;
  }

  private async ensureOwnedBridgeReady(): Promise<A2aClient> {
    if (this.bridgeStartPromise && this.ownedBridge && !hasExited(this.ownedBridge)) {
      return this.bridgeStartPromise;
    }

    if (this.ownedBridge && hasExited(this.ownedBridge)) this.ownedBridge = undefined;
    this.bridgeStartPromise = undefined;

    const startPromise = this.startAndWaitForReady();
    this.bridgeStartPromise = startPromise;
    try {
      return await startPromise;
    } catch (cause) {
      if (this.bridgeStartPromise === startPromise) this.bridgeStartPromise = undefined;
      await terminateOwnedProcess(this.ownedBridge, this.shutdownGraceMs, this.shutdownForceMs);
      if (this.ownedBridge && hasExited(this.ownedBridge)) this.ownedBridge = undefined;
      throw new BridgeStartupError(cause);
    }
  }

  private async startAndWaitForReady(): Promise<A2aClient> {
    if (this.closed) throw new Error("MCP server is shutting down.");

    const child = this.spawnBridge(this.projectRoot, bridgeEnvironment(this.env, this.options.bridgeUrl));
    this.ownedBridge = child;
    this.spawnError = undefined;
    child.on("error", (error) => {
      this.spawnError = error;
    });
    child.once("exit", () => {
      if (this.ownedBridge === child) {
        this.ownedBridge = undefined;
        this.bridgeStartPromise = undefined;
      }
    });

    let lastDiscoveryError: unknown;
    for (let attempt = 0; attempt < this.readinessAttempts; attempt += 1) {
      if (this.closed) throw new Error("MCP server is shutting down.");
      if (this.spawnError) throw this.spawnError;
      if (hasExited(child)) throw new Error("Owned Bridge exited before becoming ready.");

      try {
        return await this.createClient(this.options.bridgeUrl);
      } catch (error) {
        lastDiscoveryError = error;
      }

      if (attempt + 1 < this.readinessAttempts) {
        await delay(this.readinessIntervalMs);
      }
    }

    throw new Error("Timed out waiting for the A2A Bridge Agent Card.", {
      cause: lastDiscoveryError,
    });
  }
}

function defaultA2aClientFactory(bridgeUrl: string): Promise<A2aClient> {
  return new ClientFactory().createFromUrl(bridgeUrl);
}

function spawnLocalBridge(projectRoot: string, env: NodeJS.ProcessEnv): ChildProcess {
  const tsxCli = resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const bridgeEntry = resolve(projectRoot, "app", "main.ts");
  return spawn(process.execPath, [tsxCli, bridgeEntry], {
    cwd: projectRoot,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
}

function bridgeEnvironment(env: NodeJS.ProcessEnv, bridgeUrl: string): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  const url = new URL(bridgeUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  if (!childEnv.A2A_HOST?.trim()) childEnv.A2A_HOST = host;
  if (!childEnv.A2A_PORT?.trim()) childEnv.A2A_PORT = port;
  return childEnv;
}

function isLocalBridgeUrl(bridgeUrl: string): boolean {
  try {
    const url = new URL(bridgeUrl);
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      url.protocol === "http:" &&
      (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") &&
      (url.pathname === "" || url.pathname === "/") &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function terminateOwnedProcess(
  child: ChildProcess | undefined,
  graceMs: number,
  forceMs: number,
): Promise<void> {
  if (!child || hasExited(child)) return;

  await signalAndWait(child, "SIGTERM", graceMs);
  if (!hasExited(child)) await signalAndWait(child, "SIGKILL", forceMs);
}

async function signalAndWait(
  child: ChildProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
): Promise<void> {
  if (hasExited(child)) return;
  const exited = waitForExit(child, timeoutMs);
  try {
    child.kill(signal);
  } catch {
    return;
  }
  await exited;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (hasExited(child)) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(finish, timeoutMs);
    const onExit = () => finish();
    function finish(): void {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolvePromise();
    }
    child.once("exit", onExit);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
