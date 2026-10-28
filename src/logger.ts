import pino, { type DestinationStream, type Logger } from 'pino';
import { withholdErrorMessages } from './error-message.js';
import type { ErrorMessage } from './error-message.types.js';

// Redaction matches keys exactly, so header names appear in both of the cases they arrive in.
const DEFAULT_SECRET_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'botToken',
  'sourceToken',
  'secret',
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
];

export const REDACTED = '[redacted]';

/** Matches the `key`, `*.key` and `*.*.key` paths the logger redacts. */
const REDACTION_DEPTH = 3;

type CreateLoggerOptions = {
  service: string;
  level: string;
  destinations: DestinationStream[];
  /** Field names to redact on top of the defaults, at any of the first three depths. */
  secretKeys?: string[];
  /** Human-readable output through pino-pretty, for a local dev server. */
  pretty?: boolean;
  /** Rewrites the message of every error logged as `err`; see `ErrorMessage`. */
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
  errorMessage,
}: CreateLoggerOptions): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service },
    redact: {
      paths: allSecretKeys(secretKeys).flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
      censor: REDACTED,
    },
  };
  if (errorMessage) {
    options.serializers = {
      err: (value: unknown) =>
        value instanceof Error
          ? pino.stdSerializers.err(withholdErrorMessages({ error: value, errorMessage }))
          : value,
    };
  }
  if (pretty) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  // A label, not pino's number: it reads the same in a terminal and in Better Stack.
  options.formatters = { level: (label) => ({ level: label }) };
  const [onlyDestination, ...otherDestinations] = destinations;
  const hasOneDestination = onlyDestination !== undefined && otherDestinations.length === 0;
  if (hasOneDestination) {
    return pino(options, onlyDestination);
  }
  // Every stream at the lowest level: the remote stream filters for itself, so a `ship: true`
  // info record can still reach Better Stack.
  return pino(
    options,
    pino.multistream(destinations.map((stream) => ({ stream, level: 'trace' }))),
  );
}

/**
 * A copy of `context` with the logger's secret keys censored at the same depths, for a sink that
 * does not go through pino, such as a Sentry event.
 */
export function redactSecrets({
  context,
  secretKeys = [],
}: {
  context: Record<string, unknown>;
  secretKeys?: string[];
}): Record<string, unknown> {
  return redactEntries({ object: context, keys: new Set(allSecretKeys(secretKeys)), depth: 0 });
}

function allSecretKeys(secretKeys: string[]): string[] {
  return [...DEFAULT_SECRET_KEYS, ...secretKeys];
}

function redactEntries({
  object,
  keys,
  depth,
}: {
  object: object;
  keys: Set<string>;
  depth: number;
}): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [
      key,
      keys.has(key) ? REDACTED : redactNested({ value, keys, depth: depth + 1 }),
    ]),
  );
}

function redactNested({
  value,
  keys,
  depth,
}: {
  value: unknown;
  keys: Set<string>;
  depth: number;
}): unknown {
  if (depth >= REDACTION_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => redactNested({ value: item, keys, depth: depth + 1 }));
  }
  // A Date, Error or URL keeps its class, so Sentry still serializes it as one.
  if (isPlainObject(value)) {
    return redactEntries({ object: value, keys, depth });
  }
  return value;
}

function isPlainObject(value: unknown): value is object {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
