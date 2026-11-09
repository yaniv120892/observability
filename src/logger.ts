import pino, { type DestinationStream, type Logger } from 'pino';
import {
  rewrittenMessage,
  withholdPrismaMessages,
  withholdSerializedError,
} from './error-message.js';
import type { ErrorMessage } from './error-message.types.js';
import { createRedactor } from './redaction.js';

type LogMethodHook = NonNullable<NonNullable<pino.LoggerOptions['hooks']>['logMethod']>;

type CreateLoggerOptions = {
  service: string;
  level: string;
  destinations: DestinationStream[];
  /** Exact field names, in any case, to redact on top of the default patterns; see `redactSecrets`. */
  secretKeys?: string[];
  /** Human-readable output through pino-pretty, for a local dev server. */
  pretty?: boolean;
  /**
   * Rewrites the message of every logged error, in `err` and in the `msg` it lends; see
   * `ErrorMessage`. Defaults to `withholdPrismaMessages`.
   */
  errorMessage?: ErrorMessage;
};

/**
 * Log an event name as the message and the details as fields —
 * `logger.warn({ route }, 'cross_site_request_refused')` — and pass an unexpected error as `err`
 * so its stack is kept.
 */
export function createLogger({
  service,
  level,
  destinations,
  secretKeys = [],
  pretty = false,
  errorMessage = withholdPrismaMessages,
}: CreateLoggerOptions): Logger {
  const redact = createRedactor(secretKeys);
  const options: pino.LoggerOptions = {
    level,
    base: { service },
    serializers: {
      err: function serializeWithheldError(value: unknown) {
        return value instanceof Error
          ? withholdSerializedError({
              serialized: pino.stdSerializers.err(value),
              error: value,
              errorMessage,
            })
          : value;
      },
    },
    hooks: { logMethod: withholdDefaultMessage(errorMessage) },
    // pino's own `redact` matches exact paths only, so a key spelled another way would slip past.
    formatters: { log: redact },
  };
  if (pretty) {
    return withRedactedChildBindings({
      logger: pino({
        ...options,
        transport: { target: 'pino-pretty', options: { colorize: true } },
      }),
      redact,
    });
  }
  // A label, not pino's number: it reads the same in a terminal and in Better Stack.
  options.formatters = { ...options.formatters, level: (label) => ({ level: label }) };
  const [onlyDestination, ...otherDestinations] = destinations;
  const hasOneDestination = onlyDestination !== undefined && otherDestinations.length === 0;
  if (hasOneDestination) {
    return withRedactedChildBindings({ logger: pino(options, onlyDestination), redact });
  }
  // Every stream at the lowest level: the remote stream filters for itself, so a `ship: true`
  // info record can still reach Better Stack.
  const logger = pino(
    options,
    pino.multistream(destinations.map((stream) => ({ stream, level: 'trace' }))),
  );
  return withRedactedChildBindings({ logger, redact });
}

/**
 * pino gives a child's bindings no formatter of the parent's, so they are redacted on the way in.
 * A child inherits the override from its parent, so a grandchild's bindings are redacted too.
 */
function withRedactedChildBindings({
  logger,
  redact,
}: {
  logger: Logger;
  redact: (object: Record<string, unknown>) => Record<string, unknown>;
}): Logger {
  const createChild = logger.child;
  logger.child = function childWithRedactedBindings<ChildCustomLevels extends string = never>(
    this: Logger,
    bindings: pino.Bindings,
    options?: pino.ChildLoggerOptions<ChildCustomLevels>,
  ): pino.Logger<ChildCustomLevels> {
    const createRedactedChild = createChild.bind(this);
    return createRedactedChild<ChildCustomLevels>(redact(bindings), options);
  };
  return logger;
}

/**
 * Logged without a message string, an error lends its own message to the line's `msg`, which the
 * `err` serializer never sees; this passes the rewritten one instead.
 */
function withholdDefaultMessage(errorMessage: ErrorMessage): LogMethodHook {
  return function logWithWithheldMessage(args, method) {
    const [mergingObject] = args;
    const error = loggedError(mergingObject);
    if (args.length === 1 && error) {
      method.apply(this, [mergingObject, rewrittenMessage({ error, errorMessage })]);
      return;
    }
    method.apply(this, args);
  };
}

function loggedError(mergingObject: unknown): Error | null {
  if (mergingObject instanceof Error) {
    return mergingObject;
  }
  const isObject = typeof mergingObject === 'object' && mergingObject !== null;
  if (isObject && 'err' in mergingObject && mergingObject.err instanceof Error) {
    return mergingObject.err;
  }
  return null;
}
