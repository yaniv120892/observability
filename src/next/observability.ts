import type { Instrumentation } from 'next';
import { after } from 'next/server';
import pino from 'pino';
import { loadObservabilityConfig } from '../config.js';
import { pingHeartbeat } from '../heartbeat.js';
import { createLogger, redactedPaths } from '../logger.js';
import { OpsAlerter } from '../ops-alerter.js';
import { RemoteLogBuffer } from '../remote-log-buffer.js';
import type { OpsAlert } from '../ops-alerter.types.js';
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

function build({
  service,
  secretKeys = [],
  alertCounter,
}: NextObservabilityOptions): NextObservability {
  const config = loadObservabilityConfig();
  const isDevelopment = process.env.NODE_ENV === 'development';
  const remote =
    config.betterStack && !isDevelopment
      ? new RemoteLogBuffer({ ...config.betterStack, shipLevel: 'warn' })
      : null;
  const flusher = remote ? new RequestScopedFlusher(remote) : null;

  // Not a pino transport in production: its worker thread is unreliable on serverless functions.
  const logger = isDevelopment
    ? pino({
        level: config.logLevel,
        base: { service },
        redact: redactedPaths(secretKeys),
        transport: { target: 'pino-pretty', options: { colorize: true } },
      })
    : createLogger({
        service,
        level: config.logLevel,
        secretKeys,
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
  const flushRemoteLogs = async (): Promise<void> => {
    await flusher?.flush();
  };

  const notifyOpsAlert = (alert: OpsAlert): Promise<void> => alerter.alert(alert);

  return {
    logger,
    flushRemoteLogs,
    reportSwallowedError(error, { where, ...context }) {
      logger.error({ err: error, ...context }, where);
      void captureInSentry({ error, where });
    },
    notifyOpsAlert,
    scheduleOpsAlert(alert) {
      runAfterResponse(() => notifyOpsAlert(alert));
    },
    pingHeartbeat: (envVar) => pingHeartbeat({ name: envVar, url: process.env[envVar], logger }),
    async onRequestError(error, request, context) {
      await captureRequestErrorInSentry({ error, request, context });
      logger.error(
        {
          err: error,
          method: request.method,
          path: request.path,
          route: context.routePath,
          routeType: context.routeType,
        },
        'unhandled_request_error',
      );
      // Awaited rather than deferred: Next asks for every async task here to be awaited, and
      // `after` is not always available in this scope.
      await notifyOpsAlert({
        alertType: `5xx ${request.method} ${context.routePath}`,
        title: `5xx on ${request.method} ${request.path.split('?')[0]}`,
        error,
        context: { routeType: context.routeType },
      });
      // Last, so the batch includes anything the alert logged.
      await flushRemoteLogs();
    },
    healthRoute: () => healthRoute(flushRemoteLogs),
    createDeepHealthRoute: (deepHealthOptions) =>
      createDeepHealthRoute({ ...deepHealthOptions, logger, flushRemoteLogs }),
  };
}

/**
 * There is no shared route wrapper to flush from, so the first shippable record of a request
 * registers the flush itself; a concurrent request's records ride on the same hook. An error is
 * often followed by the invocation dying, so it goes out at once.
 */
class RequestScopedFlusher {
  private readonly remote: RemoteLogBuffer;
  private flushScheduledAt: number | null = null;
  private urgentFlush: Promise<void> | null = null;

  constructor(remote: RemoteLogBuffer) {
    this.remote = remote;
  }

  public write(line: string): void {
    switch (this.remote.write(line)) {
      case 'urgent':
        this.flushUrgently();
        break;
      case 'buffered':
        this.scheduleFlush();
        break;
      default:
        break;
    }
  }

  public async flush(): Promise<void> {
    this.flushScheduledAt = null;
    await this.remote.flush();
  }

  private flushUrgently(): void {
    this.urgentFlush ??= this.flushOnce();
  }

  private async flushOnce(): Promise<void> {
    try {
      await this.flush();
    } finally {
      this.urgentFlush = null;
    }
  }

  private scheduleFlush(): void {
    const isScheduled =
      this.flushScheduledAt !== null && Date.now() - this.flushScheduledAt < STALE_FLUSH_MS;
    if (isScheduled) {
      return;
    }
    this.flushScheduledAt = Date.now();
    runAfterResponse(() => this.flush());
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

async function captureInSentry({ error, where }: { error: unknown; where: string }): Promise<void> {
  try {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureException(error, { tags: { where } });
  } catch {
    // Sentry is optional; the error is already logged.
  }
}

async function captureRequestErrorInSentry({
  error,
  request,
  context,
}: {
  error: unknown;
  request: Parameters<Instrumentation.onRequestError>[1];
  context: Parameters<Instrumentation.onRequestError>[2];
}): Promise<void> {
  try {
    const Sentry = await import('@sentry/nextjs');
    Sentry.captureRequestError(error, request, context);
  } catch {
    // Sentry is optional; the error is logged next.
  }
}
