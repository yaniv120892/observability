import type { Logger } from 'pino';
import type { AlertCounter, OpsAlert } from '../ops-alerter.types.js';

export type ErrorContext = {
  /** Where the error was caught; becomes the Sentry tag and the log message. */
  where: string;
} & Record<string, string | number | null | undefined>;

export type NodeObservability = {
  logger: Logger;
  /** Logs the error and, when Sentry is on, sends it there tagged with where it was caught. */
  reportError(error: unknown, context: ErrorContext): void;
  alertOwner(alert: OpsAlert): Promise<void>;
  pingHeartbeat(heartbeat: { name: string; url: string | undefined }): Promise<void>;
  /** Ships whatever is still buffered; call it before the process exits. */
  shutdown(): Promise<void>;
};

export type NodeObservabilityOptions = {
  service: string;
  environment?: Record<string, string | undefined>;
  secretKeys?: string[];
  alertCounter?: AlertCounter;
  /** A long-running process has no request to ride on, so it ships on a timer instead. */
  flushIntervalMs?: number;
  fetchImplementation?: typeof fetch;
};
