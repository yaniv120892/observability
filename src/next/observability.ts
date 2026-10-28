import * as Sentry from '@sentry/nextjs';
import { after } from 'next/server.js';
import { loadObservabilityConfig } from '../config.js';
import { captureQuietly, toSentryCaptureContext } from '../error-report.js';
import { pingHeartbeat } from '../heartbeat.js';
import { createLogger } from '../logger.js';
import { OpsAlerter } from '../ops-alerter.js';
import { ProductAnalytics } from '../product-analytics.js';
import { RemoteLogBuffer } from '../remote-log-buffer.js';
import { createDeepHealthRoute, healthRoute } from './health.js';
import type { NextObservability, NextObservabilityOptions } from './observability.types.js';

/**
 * An `after` hook that has not run within a function's maximum duration was lost with its
 * invocation; past this, the next record schedules a fresh one rather than waiting forever.
 */
const STALE_FLUSH_MS = 60_000;

declare global {
  var observabilityByService: Map<string, NextObservability> | undefined;
}

/** Cached per service on `globalThis`, so dev-server reloads reuse one logger and one buffer. */
export function createNextObservability(options: NextObservabilityOptions): NextObservability {
  globalThis.observabilityByService ??= new Map();
  const existing = globalThis.observabilityByService.get(options.service);
  if (existing) {
    return existing;
  }
  const observability = build(options);
  globalThis.observabilityByService.set(options.service, observability);
  return observability;
}

function build({ service, secretKeys, alertCounter }: NextObservabilityOptions): NextObservability {
  const config = loadObservabilityConfig();
  const isDevelopment = process.env.NODE_ENV === 'development';
  const remote =
    config.betterStack && !isDevelopment
      ? new RemoteLogBuffer({ ...config.betterStack, shipLevel: 'warn', service })
      : null;
  const flusher = remote ? new RequestScopedFlusher(remote) : null;
  // Not a pino transport in production: its worker thread is unreliable on serverless functions.
  const logger = createLogger({
    service,
    level: config.logLevel,
    secretKeys,
    pretty: isDevelopment,
    destinations: flusher
      ? [process.stdout, { write: (line: string) => flusher.write(line) }]
      : [process.stdout],
  });
  const alerter = new OpsAlerter({
    service,
    telegram: config.telegram,
    logger,
    counter: alertCounter,
  });
  const analyticsConfig = isDevelopment ? null : config.productAnalytics;
  const analytics = new ProductAnalytics({
    service,
    environment: config.environment,
    config: analyticsConfig,
    logger,
  });
  const analyticsFlusher = new AfterResponseFlusher(() => analytics.flush());

  return {
    logger,
    async flushRemoteLogs() {
      await remote?.flush();
    },
    reportError({ error, where, context = {} }) {
      logger.error({ err: error, ...context }, where);
      // Synchronous, so the SDK holds the event before this returns: an import still pending when
      // a serverless function freezes after its response loses the event with it.
      captureQuietly(() =>
        Sentry.captureException(error, toSentryCaptureContext({ where, context, secretKeys })),
      );
    },
    async notifyOpsAlert(alert) {
      await alerter.alert(alert);
    },
    scheduleOpsAlert(alert) {
      runAfterResponse(() => alerter.alert(alert));
    },
    async pingHeartbeat(urlVariableName) {
      await pingHeartbeat({ name: urlVariableName, url: process.env[urlVariableName], logger });
    },
    captureEvent(event) {
      if (!analytics.isEnabled) {
        return;
      }
      analytics.capture(event);
      analyticsFlusher.schedule();
    },
    async onRequestError(error, request, context) {
      // The query string can carry tokens, and redaction works by field name, not by URL.
      const [path] = request.path.split('?');
      logger.error(
        {
          err: error,
          method: request.method,
          path,
          route: context.routePath,
          routeType: context.routeType,
        },
        'unhandled_request_error',
      );
      captureQuietly(() => Sentry.captureRequestError(error, request, context));
      // Awaited rather than deferred: Next asks for every async task here to be awaited, and
      // `after` is not always available in this scope.
      await alerter.alert({
        alertType: `5xx ${request.method} ${context.routePath}`,
        title: `5xx on ${request.method} ${path}`,
        error,
        context: { routeType: context.routeType },
      });
      await remote?.flush();
    },
    healthRoute,
    createDeepHealthRoute(deepHealthOptions) {
      return createDeepHealthRoute({ ...deepHealthOptions, logger });
    },
  };
}

/**
 * Registers one `after` hook for every flush requested while it is pending, so a request that
 * records ten things sends one batch. Past `STALE_FLUSH_MS` the hook is presumed lost with its
 * invocation and the next request schedules a fresh one.
 */
class AfterResponseFlusher {
  private readonly flush: () => Promise<void>;
  private flushScheduledAt: number | null = null;

  public constructor(flush: () => Promise<void>) {
    this.flush = flush;
  }

  public schedule(): void {
    const isScheduled =
      this.flushScheduledAt !== null && Date.now() - this.flushScheduledAt < STALE_FLUSH_MS;
    if (isScheduled) {
      return;
    }
    this.flushScheduledAt = Date.now();
    runAfterResponse(() => this.flushFromHook());
  }

  private async flushFromHook(): Promise<void> {
    this.flushScheduledAt = null;
    await this.flush();
  }
}

/**
 * There is no shared route wrapper to flush from, so the first shippable record of a request
 * registers an `after` hook itself, and a concurrent request's records ride on the same hook. An
 * urgent record starts its send at once, and the hook keeps the invocation alive until it lands.
 */
class RequestScopedFlusher {
  private readonly remote: RemoteLogBuffer;
  private readonly flusher: AfterResponseFlusher;

  public constructor(remote: RemoteLogBuffer) {
    this.remote = remote;
    this.flusher = new AfterResponseFlusher(() => remote.flush());
  }

  public write(line: string): void {
    const outcome = this.remote.write(line);
    if (outcome === 'skipped') {
      return;
    }
    if (outcome === 'urgent') {
      void this.remote.flush();
    }
    this.flusher.schedule();
  }
}

function runAfterResponse(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    // Outside a request scope (start-up, a script) nothing would run the hook.
    void task();
  }
}
