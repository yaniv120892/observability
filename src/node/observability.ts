import type * as SentryNode from '@sentry/node';
import type { Logger } from 'pino';
import { loadObservabilityConfig } from '../config.js';
import { captureQuietly, toSentryCaptureContext } from '../error-report.js';
import { pingHeartbeat } from '../heartbeat.js';
import { createLogger } from '../logger.js';
import { OpsAlerter } from '../ops-alerter.js';
import { RemoteLogBuffer } from '../remote-log-buffer.js';
import { scrubRequestUrls } from '../sentry-breadcrumbs.js';
import type { NodeObservability, NodeObservabilityOptions } from './observability.types.js';

type SentryModule = typeof SentryNode;

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const SENTRY_FLUSH_TIMEOUT_MS = 2000;

/**
 * For a long-running Node process. Every integration is inert until its variables are set, and
 * every method resolves rather than throws: reporting must never fail the path that reports.
 */
export async function createNodeObservability({
  service,
  environment = process.env,
  secretKeys,
  alertCounter,
  flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS,
  fetchImplementation = fetch,
}: NodeObservabilityOptions): Promise<NodeObservability> {
  const config = loadObservabilityConfig(environment);
  const remote = config.betterStack
    ? new RemoteLogBuffer({
        ...config.betterStack,
        shipLevel: 'info',
        service,
        fetchImplementation,
      })
    : null;
  const timer = remote ? setInterval(() => void remote.flush(), flushIntervalMs) : undefined;
  // The periodic flush must never be what keeps a stopping process alive.
  timer?.unref();

  const logger = createLogger({
    service,
    level: config.logLevel,
    secretKeys,
    destinations: remote
      ? [process.stdout, { write: (line: string) => shipOrBuffer({ remote, line }) }]
      : [process.stdout],
  });
  const sentry = await startSentry({
    dsn: config.sentryDsn,
    environment: config.environment,
    logger,
  });
  const alerter = new OpsAlerter({
    service,
    telegram: config.telegram,
    logger,
    counter: alertCounter,
    fetchImplementation,
  });

  return {
    logger,
    integrations: {
      betterStack: remote !== null,
      sentry: sentry !== null,
      telegram: config.telegram !== null,
    },
    reportError({ error, where, context = {} }) {
      logger.error({ err: error, ...context }, where);
      if (sentry) {
        captureQuietly(() =>
          sentry.captureException(error, toSentryCaptureContext({ where, context, secretKeys })),
        );
      }
    },
    async notifyOpsAlert(alert) {
      await alerter.alert(alert);
    },
    async pingHeartbeat(urlVariableName) {
      await pingHeartbeat({
        name: urlVariableName,
        url: environment[urlVariableName],
        logger,
        fetchImplementation,
      });
    },
    async shutdown() {
      clearInterval(timer);
      await Promise.all([remote?.flush(), sentry?.flush(SENTRY_FLUSH_TIMEOUT_MS)]);
    },
  };
}

function shipOrBuffer({ remote, line }: { remote: RemoteLogBuffer; line: string }): void {
  if (remote.write(line) === 'urgent') {
    void remote.flush();
  }
}

/** Imported only with a DSN set, so a process without one pays none of the SDK's memory. */
async function startSentry({
  dsn,
  environment,
  logger,
}: {
  dsn: string | null;
  environment: string;
  logger: Logger;
}): Promise<SentryModule | null> {
  if (!dsn) {
    return null;
  }
  try {
    const sentry = await import('@sentry/node');
    // No default integrations: they bring tracing, HTTP instrumentation and request data.
    sentry.initWithoutDefaultIntegrations({
      dsn,
      environment,
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
      },
      // No integration here records requests yet; this keeps one added later from leaking URLs.
      beforeBreadcrumb: scrubRequestUrls,
      integrations: [
        sentry.eventFiltersIntegration(),
        sentry.functionToStringIntegration(),
        sentry.linkedErrorsIntegration(),
        sentry.dedupeIntegration(),
        sentry.nodeContextIntegration(),
      ],
    });
    return sentry;
  } catch (error) {
    logger.error({ err: error }, 'sentry_failed_to_start');
    return null;
  }
}
