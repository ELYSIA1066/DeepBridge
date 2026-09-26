import { describe, expect, it, vi } from "vitest";
import { registerShutdownSignals } from "../app/shutdown.js";

describe("Bridge shutdown signals", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "releases the stdin event-loop reference before handling %s",
    (signal) => {
      const handlers = new Map<NodeJS.Signals, () => void>();
      const processSignals = {
        once: vi.fn((name: NodeJS.Signals, handler: () => void) => {
          handlers.set(name, handler);
          return processSignals;
        }),
      } as unknown as Pick<NodeJS.Process, "once">;
      const order: string[] = [];
      const input = {
        unref: vi.fn(() => order.push("unref")),
      } as unknown as Pick<NodeJS.ReadStream, "unref">;
      const shutdown = vi.fn((received: NodeJS.Signals) => order.push(received));

      registerShutdownSignals(processSignals, input, shutdown);
      handlers.get(signal)?.();

      expect(input.unref).toHaveBeenCalledOnce();
      expect(shutdown).toHaveBeenCalledWith(signal);
      expect(order).toEqual(["unref", signal]);
    },
  );
});
