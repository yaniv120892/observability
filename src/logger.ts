import pino, { type DestinationStream, type Logger } from 'pino';

const DEFAULT_SECRET_KEYS = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'botToken',
  'sourceToken',
  'secret',
  'authorization',
  'cookie',
];

export const REDACTED = '[redacted]';

type CreateLoggerOptions = {
  service: string;
  level: string;
  destinations: DestinationStream[];
  /** Field names to redact on top of the defaults, at any of the first three depths. */
  secretKeys?: string[];
};

export function redactedPaths(secretKeys: string[]): string[] {
  return secretKeys.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]);
}

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
}: CreateLoggerOptions): Logger {
  return pino(
    {
      level,
      base: { service },
      redact: { paths: redactedPaths([...DEFAULT_SECRET_KEYS, ...secretKeys]), censor: REDACTED },
      // A label, not pino's number: it reads the same in a terminal and in Better Stack.
      formatters: { level: (label) => ({ level: label }) },
    },
    // Every stream at the lowest level: the remote stream filters for itself, so a `ship: true`
    // info record can still reach Better Stack.
    pino.multistream(destinations.map((stream) => ({ stream, level: 'trace' }))),
  );
}
