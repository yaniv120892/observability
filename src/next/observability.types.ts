import type { Instrumentation } from 'next';
import type { Logger } from 'pino';
import type { ErrorReport } from '../error-report.types.js';
import type { AlertCounter, OpsAlert } from '../ops-alerter.types.js';
import type { DeepHealthOptions } from './health.types.js';

export type NextObservability = {
  logger: Logger;
  /** Ships buffered records now; a request that logged flushes by itself, a script calls this. */
  flushRemoteLogs(): Promise<void>;
  /** For a path that catches its error and returns a fallback, where no request hook sees it. */
  reportError(report: ErrorReport): void;
  notifyOpsAlert(alert: OpsAlert): Promise<void>;
  /** Sends once the response is out, so a slow Telegram never delays the request. */
  scheduleOpsAlert(alert: OpsAlert): void;
  pingHeartbeat(urlVariableName: string): Promise<void>;
  onRequestError: Instrumentation.onRequestError;
  healthRoute(): Response;
  createDeepHealthRoute(options: DeepHealthOptions): () => Promise<Response>;
};

export type NextObservabilityOptions = {
  service: string;
  secretKeys?: string[];
  /** Defaults to a per-instance count; pass a shared store's counter to cap across instances. */
  alertCounter?: AlertCounter;
};
