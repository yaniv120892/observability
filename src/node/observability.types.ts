import type { Logger } from 'pino';
import type { ErrorReport } from '../error-report.types.js';
import type { AlertCounter, OpsAlert } from '../ops-alerter.types.js';
import type { AnalyticsEvent } from '../product-analytics.types.js';

/** Which integrations are live: Sentry counts only once its SDK has started. */
export type ActiveIntegrations = {
  betterStack: boolean;
  sentry: boolean;
  telegram: boolean;
  productAnalytics: boolean;
};

export type NodeObservability = {
  logger: Logger;
  integrations: ActiveIntegrations;
  /** Logs the error and, when Sentry is on, sends it there tagged with where it was caught. */
  reportError(report: ErrorReport): void;
  notifyOpsAlert(alert: OpsAlert): Promise<void>;
  pingHeartbeat(urlVariableName: string): Promise<void>;
  /** Queues a product event; it ships with the logs on the flush timer and on shutdown. */
  captureEvent(event: AnalyticsEvent): void;
  /** Ships whatever is still buffered; await it before the process exits. */
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
