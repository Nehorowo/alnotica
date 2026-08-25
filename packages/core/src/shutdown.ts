/**
 * Graceful shutdown and last-resort error handling.
 *
 * A process left half-alive after an unhandled rejection is worse than one that
 * exits: the container restarts a dead process, but a zombie keeps holding its
 * database connections and its share of the queue while doing nothing.
 */
import process from 'node:process';
import type { Logger } from 'pino';

export type ShutdownHook = () => Promise<void> | void;

export interface ShutdownController {
  /** True once a signal has arrived; loops check it to stop taking new work. */
  readonly stopping: boolean;
  onShutdown(hook: ShutdownHook): void;
  shutdown(reason: string, code?: number): Promise<void>;
}

export function installShutdownHandlers(
  logger: Logger,
  options: { timeoutMs?: number } = {},
): ShutdownController {
  const hooks: ShutdownHook[] = [];
  const timeoutMs = options.timeoutMs ?? 20_000;
  let stopping = false;

  async function shutdown(reason: string, code = 0): Promise<void> {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, 'shutting down');

    const timer = setTimeout(() => {
      logger.error({ reason, timeoutMs }, 'shutdown timed out, exiting hard');
      process.exit(code === 0 ? 1 : code);
    }, timeoutMs);
    timer.unref();

    for (const hook of hooks.reverse()) {
      try {
        await hook();
      } catch (err) {
        logger.error({ err }, 'shutdown hook failed');
      }
    }
    clearTimeout(timer);
    logger.info({ reason }, 'shutdown complete');
    process.exit(code);
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  return {
    get stopping() {
      return stopping;
    },
    onShutdown(hook: ShutdownHook) {
      hooks.push(hook);
    },
    shutdown,
  };
}

/** Sleep that resolves early when the process is going down. */
export function sleep(ms: number, controller?: ShutdownController): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (controller?.stopping) {
      clearTimeout(timer);
      resolve();
    }
  });
}
