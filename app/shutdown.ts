type ShutdownSignalTarget = Pick<NodeJS.Process, "once">;
type ShutdownInput = Pick<NodeJS.ReadStream, "unref">;

export function registerShutdownSignals(
  signalTarget: ShutdownSignalTarget,
  input: ShutdownInput,
  shutdown: (signal: NodeJS.Signals) => void,
): void {
  const handle = (signal: NodeJS.Signals): void => {
    input.unref();
    shutdown(signal);
  };

  signalTarget.once("SIGINT", () => handle("SIGINT"));
  signalTarget.once("SIGTERM", () => handle("SIGTERM"));
}
