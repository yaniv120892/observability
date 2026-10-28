import type * as SentryNode from '@sentry/node';
import type { Logger } from 'pino';
import { loadObservabilityConfig } from '../config.js';
import { withholdEventMessages } from '../error-message.js';
import type { ErrorMessage } from '../error-message.types.js';
import { captureQuietly, toSentryCaptureContext } from '../error-report.js';
import { checkLiveness, createDeepHealthCheck } from '../health.js';
import { pingHeartbeat } from '../heartbeat.js';
import { createLogger } from '../logger.js';
import { OpsAlerter } from '../ops-alerter.js';
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
  const config = loadObservabilityConfig(environment);
  const remote = config.betterStack
    ? new RemoteLogBuffer({
        ...config.betterStack,
        shipLevel: options.shipLevel ?? (isServerless ? 'warn' : 'info'),
        service,
        fetchImplementation,
      })
    : null;
  const timer = startFlushTimer({ remote, options });

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
    },
    async flushRemoteLogs() {
      await remote?.flush();
    },
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
    async shutdown() {
      clearInterval(timer);
      await Promise.all([remote?.flush(), sentry?.flush(SENTRY_FLUSH_TIMEOUT_MS)]);
    },
  };
}

function startFlushTimer({
  remote,
  options,
}: {
  remote: RemoteLogBuffer | null;
  options: NodeObservabilityOptions;
}): NodeJS.Timeout | undefined {
  if (!remote || options.mode === 'serverless') {
    return undefined;
  }
  const timer = setInterval(
    () => void remote.flush(),
    options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
  );
  // The periodic flush must never be what keeps a stopping process alive.
  timer.unref();
  return timer;
}

/** Without `waitUntil` the send still starts; it only has nothing holding the function open. */
function keepAliveWith(waitUntil: WaitUntil | undefined): WaitUntil {
  return function keepAlive(promise) {
    if (!waitUntil) {
      return;
    }
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
      ...(errorMessage && {
        beforeSend: (event, hint) =>
          withholdEventMessages({ event, originalException: hint.originalException, errorMessage }),
      }),
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
