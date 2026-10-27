import type { Instrumentation } from 'next';
import type { Logger } from 'pino';
import type { AlertCounter, OpsAlert } from '../ops-alerter.types.js';
import type { DeepHealthOptions } from './health.types.js';

export type NextObservability = {
  logger: Logger;
  /** Ships buffered records now. Called for you after a request that logged; call it from a cron's end. */
  flushRemoteLogs(): Promise<void>;
  /** For a path that catches its error and returns a fallback, where no request hook sees it. */
  reportSwallowedError(error: unknown, context: { where: string } & Record<string, unknown>): void;
  notifyOpsAlert(alert: OpsAlert): Promise<void>;
  /** Sends once the response is out, so a slow Telegram never delays the request. */
  scheduleOpsAlert(alert: OpsAlert): void;
  /** Pings the Better Stack heartbeat whose URL is in `envVar`. */
  pingHeartbeat(envVar: string): Promise<void>;
  onRequestError: Instrumentation.onRequestError;
  healthRoute: () => Response;
  createDeepHealthRoute(options: DeepHealthOptions): () => Promise<Response>;
};

export type NextObservabilityOptions = {
  service: string;
  secretKeys?: string[];
  /** Defaults to a per-instance count; pass a shared store's counter to cap across instances. */
  alertCounter?: AlertCounter;
};
