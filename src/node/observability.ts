import type * as SentryNode from '@sentry/node';
import type { Level, Logger } from 'pino';
import { loadObservabilityConfig } from '../config.js';
import { withholdingEventProcessor } from '../error-message.js';
import type { ErrorMessage } from '../error-message.types.js';
import { captureQuietly, toSentryCaptureContext } from '../error-report.js';
import { checkLiveness, createDeepHealthCheck } from '../health.js';
import { pingHeartbeat } from '../heartbeat.js';
import { createLogger } from '../logger.js';
import { OpsAlerter } from '../ops-alerter.js';
import { ProductAnalytics } from '../product-analytics.js';
import { RemoteLogBuffer } from '../remote-log-buffer.js';
import { scrubRequestUrls } from '../sentry-breadcrumbs.js';
import type {
  NodeObservability,
  NodeObservabilityOptions,
  WaitUntil,
} from './observability.types.js';

type SentryModule = typeof SentryNode;

const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const SENTRY_FLUSH_TIMEOUT_MS = 2000;

/**
 * For a long-running Node process, or with `mode: 'serverless'` for one that runs as a function.
 * Every integration is inert until its variables are set, and every method resolves rather than
 * throws: reporting must never fail the path that reports.
 */
export async function createNodeObservability(
  options: NodeObservabilityOptions,
): Promise<NodeObservability> {
  const {
    service,
    environment = process.env,
    secretKeys,
    alertCounter,
    errorMessage,
    fetchImplementation = fetch,
  } = options;
  const isServerless = options.mode === 'serverless';
  const keepAlive = keepAliveWith(isServerless ? options.waitUntil : undefined);
  const flushIntervalMs = isServerless
    ? null
    : (options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
  const config = loadObservabilityConfig(environment);
  const remote = config.betterStack
    ? new RemoteLogBuffer({
        ...config.betterStack,
        shipLevel: options.shipLevel ?? defaultShipLevel(isServerless),
        service,
        fetchImplementation,
      })
    : null;
  const logger = createLogger({
    service,
    level: config.logLevel,
    secretKeys,
    errorMessage,
    destinations: remote
      ? [process.stdout, { write: (line: string) => shipOrBuffer({ remote, line, keepAlive }) }]
      : [process.stdout],
  });
  const sentry = await startSentry({
    dsn: config.sentryDsn,
    environment: config.environment,
    errorMessage,
    logger,
  });
  const analytics = new ProductAnalytics({
    service,
    environment: config.environment,
    config: config.productAnalytics,
    logger,
    fetchImplementation,
  });
  async function flushBuffers(): Promise<void> {
    await Promise.all([remote?.flush(), analytics.flush()]);
  }
  const timer = startFlushTimer({
    hasBuffers: remote !== null || analytics.isEnabled,
    flushBuffers,
    flushIntervalMs,
  });
  const alerter = new OpsAlerter({
    service,
    telegram: config.telegram,
    logger,
    counter: alertCounter,
    errorMessage,
    fetchImplementation,
  });

  return {
    logger,
    integrations: {
      betterStack: remote !== null,
      sentry: sentry !== null,
      telegram: config.telegram !== null,
      productAnalytics: analytics.isEnabled,
    },
    flushRemoteLogs: flushBuffers,
    reportError({ error, where, context = {} }) {
      logger.error({ err: error, ...context }, where);
      if (sentry) {
        captureQuietly(() =>
          sentry.captureException(error, toSentryCaptureContext({ where, context, secretKeys })),
        );
        if (isServerless) {
          keepAlive(sentry.flush(SENTRY_FLUSH_TIMEOUT_MS));
        }
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
    checkLiveness,
    createDeepHealthCheck(deepHealthOptions) {
      return createDeepHealthCheck({ ...deepHealthOptions, logger });
    },
    captureEvent(event) {
      analytics.capture(event);
    },
    async shutdown() {
      clearInterval(timer);
      await Promise.all([flushBuffers(), sentry?.flush(SENTRY_FLUSH_TIMEOUT_MS)]);
    },
  };
}

/** Every serverless invocation would otherwise ship its `info` lines, as on Next. */
function defaultShipLevel(isServerless: boolean): Level {
  return isServerless ? 'warn' : 'info';
}

/** `flushIntervalMs` is null on serverless, where a frozen function would never fire the timer. */
function startFlushTimer({
  hasBuffers,
  flushBuffers,
  flushIntervalMs,
}: {
  hasBuffers: boolean;
  flushBuffers: () => Promise<void>;
  flushIntervalMs: number | null;
}): NodeJS.Timeout | undefined {
  const hasNothingToFlushOnATimer = !hasBuffers || flushIntervalMs === null;
  if (hasNothingToFlushOnATimer) {
    return undefined;
  }
  const timer = setInterval(() => void flushBuffers(), flushIntervalMs);
  // The periodic flush must never be what keeps a stopping process alive.
  timer.unref();
  return timer;
}

/** Without `waitUntil` the send still starts; it only has nothing holding the function open. */
function keepAliveWith(waitUntil: WaitUntil | undefined): WaitUntil {
  if (!waitUntil) {
    return function keepNothingAlive() {
      return undefined;
    };
  }
  return function keepAlive(promise) {
    try {
      waitUntil(promise);
    } catch {
      // Outside a request scope there is no invocation to extend.
    }
  };
}

function shipOrBuffer({
  remote,
  line,
  keepAlive,
}: {
  remote: RemoteLogBuffer;
  line: string;
  keepAlive: WaitUntil;
}): void {
  if (remote.write(line) === 'urgent') {
    keepAlive(remote.flush());
  }
}

/** Imported only with a DSN set, so a process without one pays none of the SDK's memory. */
async function startSentry({
  dsn,
  environment,
  errorMessage,
  logger,
}: {
  dsn: string | null;
  environment: string;
  errorMessage: ErrorMessage | undefined;
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
      ...(errorMessage && { beforeSend: withholdingEventProcessor(errorMessage) }),
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
