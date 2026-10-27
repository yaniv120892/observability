import pino, { type DestinationStream, type Logger } from 'pino';

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

type CreateLoggerOptions = {
  service: string;
  level: string;
  destinations: DestinationStream[];
  /** Field names to redact on top of the defaults, at any of the first three depths. */
  secretKeys?: string[];
  /** Human-readable output through pino-pretty, for a local dev server. */
  pretty?: boolean;
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
}: CreateLoggerOptions): Logger {
  const options: pino.LoggerOptions = {
    level,
    base: { service },
    redact: {
      paths: [...DEFAULT_SECRET_KEYS, ...secretKeys].flatMap((key) => [
        key,
        `*.${key}`,
        `*.*.${key}`,
      ]),
      censor: REDACTED,
    },
  };
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
