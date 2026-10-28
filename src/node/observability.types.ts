import type { Level, Logger } from 'pino';
import type { ErrorMessage } from '../error-message.types.js';
import type { ErrorReport } from '../error-report.types.js';
import type { DeepHealth, DeepHealthOptions, LivenessHealth } from '../health.types.js';
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
  /**
   * Ships buffered log records and product events, and resolves once every send has landed. A serverless function awaits
   * it at the end of each invocation's work, since nothing else flushes there; safe to call often.
   */
  flushRemoteLogs(): Promise<void>;
  /** Logs the error and, when Sentry is on, sends it there tagged with where it was caught. */
  reportError(report: ErrorReport): void;
  notifyOpsAlert(alert: OpsAlert): Promise<void>;
  pingHeartbeat(urlVariableName: string): Promise<void>;
  checkLiveness(): LivenessHealth;
  createDeepHealthCheck(options: DeepHealthOptions): () => Promise<DeepHealth>;
  /** Queues a product event; it ships with the logs on the next flush and on shutdown. */
  captureEvent(event: AnalyticsEvent): void;
  /** Ships whatever is still buffered; await it before the process exits. */
  shutdown(): Promise<void>;
};

/** Hands the platform a promise it must let settle before freezing the function. */
export type WaitUntil = (promise: Promise<unknown>) => void;

type SharedNodeObservabilityOptions = {
  service: string;
  environment?: Record<string, string | undefined>;
  secretKeys?: string[];
  alertCounter?: AlertCounter;
  /**
   * Records below this level reach Better Stack only when marked `ship: true`. Defaults to `info`
   * for a long-running process and `warn` on serverless, where every invocation would ship.
   */
  shipLevel?: Level;
  /** Rewrites error messages in logs, Sentry events and ops alerts; see `ErrorMessage`. */
  errorMessage?: ErrorMessage;
  fetchImplementation?: typeof fetch;
};

export type LongRunningNodeObservabilityOptions = SharedNodeObservabilityOptions & {
  mode?: 'long-running';
  /** A long-running process has no request to ride on, so it ships on a timer instead. */
  flushIntervalMs?: number;
};

/**
 * A function frozen between invocations never fires a timer, so nothing ships on one: the app
 * awaits `flushRemoteLogs()`, and an error's immediate send is handed to `waitUntil`.
 */
export type ServerlessNodeObservabilityOptions = SharedNodeObservabilityOptions & {
  mode: 'serverless';
  waitUntil?: WaitUntil;
};

export type NodeObservabilityOptions =
  LongRunningNodeObservabilityOptions | ServerlessNodeObservabilityOptions;
